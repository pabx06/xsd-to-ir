import { isDeepStrictEqual } from "node:util";
import type { Knex } from "knex";
import type { EntityDefinition } from "./entity-crud.types";
import type { EntityIdentityHistory } from "./entity-change-preparation.types";
import { isObject, pointer, type Value } from "./xsd-runtime";

export interface StoredIdentity {
  type: string;
  path: (string | number)[];
  uid: string;
  raw: Value;
  crudKey: string;
  hidden: boolean;
  setCrud(crud: string): void;
}

/** Inventory stored XML identities, including attributes hidden by clean UI null values. */
export class StoredIdentities {
  readonly items: StoredIdentity[] = [];
  readonly row: Value;
  constructor(
    readonly entity: EntityDefinition,
    row: Value,
    clean: Value,
  ) {
    this.row = structuredClone(row);
    const visible = new Set(
      entity.metadata
        .identities(entity.name, clean)
        .map((item) => item.value.uid),
    );
    if (typeof row.uid === "string")
      this.items.push({
        type: entity.name,
        path: [],
        uid: row.uid,
        raw: { uid: row.uid, crud: row.crud },
        crudKey: "crud",
        hidden: false,
        setCrud: (crud) => {
          this.row.crud = crud;
        },
      });
    const visit = (
      type: string,
      value: unknown,
      path: (string | number)[],
      flush: () => void,
      depth: number,
    ) => {
      if (depth > 100)
        throw new Error("Stored XML value is nested too deeply.");
      if (!isObject(value)) return;
      const shape = entity.metadata.model.shape(type);
      const uidField = shape.attributes.find(
        (field) => field.uiName === "uid" && field.maxOccurs !== 0,
      );
      const crudField = shape.attributes.find(
        (field) => field.uiName === "crud" && field.maxOccurs !== 0,
      );
      const uid = uidField && value[uidField.jsonName];
      if (typeof uid === "string") {
        const crudKey = crudField?.jsonName ?? "@_crud";
        this.items.push({
          type,
          path,
          uid,
          raw: value,
          crudKey,
          hidden: !visible.has(uid),
          setCrud: (crud) => {
            value[crudKey] = crud;
            flush();
          },
        });
      }
      for (const field of shape.fields) {
        if (!field.type.valueTypeRef || field.maxOccurs === 0) continue;
        const child = value[field.jsonName];
        const next = [...path, field.uiName];
        if (Array.isArray(child))
          child.forEach((entry, index) =>
            visit(
              field.type.valueTypeRef!,
              entry,
              [...next, index],
              flush,
              depth + 1,
            ),
          );
        else
          visit(
            field.type.valueTypeRef,
            child,
            field.maxOccurs === 1 ? next : [...next, 0],
            flush,
            depth + 1,
          );
      }
    };
    for (const column of entity.metadata.model.entity(entity.name).columns) {
      if (!column.valueTypeRef || row[column.columnName] == null) continue;
      const original = row[column.columnName];
      const value =
        typeof original === "string"
          ? JSON.parse(original)
          : structuredClone(original);
      const flush = () => {
        this.row[column.columnName] = JSON.stringify(value);
      };
      if (Array.isArray(value))
        value.forEach((entry, index) =>
          visit(column.valueTypeRef!, entry, [column.name, index], flush, 0),
        );
      else
        visit(
          column.valueTypeRef,
          value,
          column.maxOccurs === 1 ? [column.name] : [column.name, 0],
          flush,
          0,
        );
    }
  }
}

/** Reconcile AFTER encoding: nil may retain a UID even when it has no UI object. */
export async function reconcileStoredIdentities(
  trx: Knex.Transaction,
  entity: EntityDefinition,
  history: EntityIdentityHistory,
  before: StoredIdentities,
  after: StoredIdentities,
): Promise<void> {
  const next = new Map(after.items.map((item) => [item.uid, item]));
  for (const old of before.items) {
    if (!old.path.length) continue;
    const key = {
      entityName: entity.name,
      rootUid: String(before.row.uid),
      identityType: old.type,
      uid: old.uid,
    };
    const current = next.get(old.uid);
    if (!current) {
      await history.isEstablished(trx, key); // Missing ownership is an error, never an implicit new identity.
      await history.recordNestedDeletion(trx, {
        ...key,
        path: pointer(old.path),
        previousValue: old.raw,
      });
    } else if (current.hidden) {
      const previous = { ...old.raw };
      delete previous[old.crudKey];
      const candidate = { ...current.raw };
      delete candidate[current.crudKey];
      if (!isDeepStrictEqual(previous, candidate))
        current.setCrud((await history.isEstablished(trx, key)) ? "U" : "I");
    }
  }
}
