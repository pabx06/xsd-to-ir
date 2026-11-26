import { isDeepStrictEqual } from "node:util";
import type { Knex } from "knex";
import { CrudError, CrudValidationError } from "./entity-crud.errors";
import type { EntityDefinition } from "./entity-crud.types";
import type { EntityCrudRegistry } from "./entity-crud.registry";
import type { Occurrence } from "./entity-metadata";
import { isObject, pointer, type Value } from "./xsd-runtime";
import { StoredIdentities } from "./stored-identities";

export interface SnapshotRoot {
  key: string;
  entity: EntityDefinition;
  row: Value;
  value: Value;
}
export interface ReferenceTarget {
  rootKey: string;
  type: string;
  value: Value;
  scope: Value;
  patterns: string[];
}
/** Return undefined to use the default resolver. Resolve external/custom forms explicitly in the host. */
export type ReferenceExtension = (input: {
  trx: Knex.Transaction;
  reference: Occurrence;
  roots: readonly SnapshotRoot[];
}) => Promise<ReferenceTarget[] | undefined>;

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) && !Array.isArray(expected))
    return actual.some((item) => matches(item, expected));
  if (isObject(expected))
    return (
      isObject(actual) &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(actual, key) && matches(actual[key], value),
      )
    );
  return isDeepStrictEqual(actual, expected);
}
function businessFields(value: Value): Value {
  const { uid: _uid, crud: _crud, ...business } = value;
  return business;
}

export class ProjectReferenceSnapshot {
  private targetCache?: ReferenceTarget[];
  constructor(
    public readonly roots: SnapshotRoot[],
    private readonly extension?: ReferenceExtension,
  ) {}
  static async load(
    trx: Knex.Transaction,
    registry: EntityCrudRegistry,
    issue: string,
    extension?: ReferenceExtension,
  ) {
    const roots: SnapshotRoot[] = [];
    for (const entity of registry.getEntityDefinitions(issue)) {
      const rows: Value[] = await trx(entity.tableName)
        .select(entity.readableColumns)
        .whereNull("_deleted_at");
      const adapter = entity.createAdapter();
      for (const row of rows)
        roots.push({
          key: `${entity.name}:${row[entity.primaryKey]}`,
          entity,
          row,
          value: adapter.decodeRow(entity.name, row).value,
        });
    }
    return new ProjectReferenceSnapshot(roots, extension);
  }
  withRoot(
    root: SnapshotRoot | null,
    previousKey?: string,
  ): ProjectReferenceSnapshot {
    return new ProjectReferenceSnapshot(
      [
        ...this.roots.filter((item) => item.key !== previousKey),
        ...(root ? [root] : []),
      ],
      this.extension,
    );
  }
  private parentScope(root: SnapshotRoot, seen = new Set<string>()): Value {
    if (seen.has(root.key)) return {};
    seen.add(root.key);
    let scope: Value = {};
    for (const parent of this.roots) {
      const relation = parent.entity.ir.entities
        .get(parent.entity.name)
        ?.relations.find(
          (item) =>
            item.targetEntity === root.entity.name &&
            item.kind === "one-to-many" &&
            root.row[item.parentColumn] !== null &&
            root.row[item.parentColumn] !== undefined &&
            String(root.row[item.parentColumn]) ===
              String(parent.row[parent.entity.primaryKey]),
        );
      if (relation)
        scope = {
          ...scope,
          ...this.parentScope(parent, seen),
          ...businessFields(parent.value),
        };
    }
    return scope;
  }
  private targets(): ReferenceTarget[] {
    if (this.targetCache) return this.targetCache;
    this.targetCache = this.roots.flatMap((root) => {
      const inherited = this.parentScope(root);
      const visible = root.entity.metadata.identities(
        root.entity.name,
        root.value,
      );
      const hidden = new StoredIdentities(
        root.entity,
        root.row,
        root.value,
      ).items
        .filter((item) => item.hidden)
        .map((item) => ({
          type: item.type,
          value: { uid: item.uid },
          path: item.path,
          shape: root.entity.metadata.model.shape(item.type),
        }));
      return [...visible, ...hidden].map((item) => {
        let scope = { ...inherited };
        let ancestor: unknown = root.value;
        for (const part of item.path) {
          if (isObject(ancestor))
            scope = { ...scope, ...businessFields(ancestor) };
          ancestor =
            isObject(ancestor) || Array.isArray(ancestor)
              ? (ancestor as Value)[part]
              : undefined;
        }
        const constraints = item.shape.attributes.find(
          (field) => field.uiName === "uid",
        )?.type.constraints;
        return {
          rootKey: root.key,
          type: item.type,
          value: item.value,
          scope: { ...scope, ...item.value },
          patterns:
            constraints?.patterns ??
            (constraints?.pattern ? [constraints.pattern] : []),
        };
      });
    });
    return this.targetCache;
  }
  async resolve(
    trx: Knex.Transaction,
    reference: Occurrence,
  ): Promise<ReferenceTarget[]> {
    const extended = await this.extension?.({
      trx,
      reference,
      roots: this.roots,
    });
    if (extended !== undefined) return extended;
    const constraints = reference.shape.attributes.find(
      (field) => field.uiName === "uidRef",
    )?.type.constraints;
    const patterns =
      constraints?.patterns ??
      (constraints?.pattern ? [constraints.pattern] : []);
    if (!patterns.length || Object.hasOwn(reference.value, "uriRef")) {
      throw new CrudValidationError([
        {
          path: pointer(reference.path),
          message: `The host must configure reference resolution for ${reference.type}.`,
        },
      ]);
    }
    // S3000L reference and target UID patterns identify compatible type families.
    const targets = this.targets().filter((target) =>
      patterns.some((pattern) => target.patterns.includes(pattern)),
    );
    if (typeof reference.value.uidRef === "string")
      return targets.filter(
        (target) => target.value.uid === reference.value.uidRef,
      );
    const fields = Object.entries(reference.value).filter(
      ([key]) => !["uidRef", "uriRef"].includes(key),
    );
    if (!fields.length) return [];
    return targets.filter((target) =>
      fields.every(([key, value]) => matches(target.scope[key], value)),
    );
  }
  async validateOutgoing(
    trx: Knex.Transaction,
    root: SnapshotRoot,
  ): Promise<void> {
    for (const reference of root.entity.metadata.references(
      root.entity.name,
      root.value,
    )) {
      const targets = await this.resolve(trx, reference);
      if (targets.length !== 1)
        throw new CrudValidationError([
          {
            path: pointer(reference.path),
            message: targets.length
              ? "The reference is ambiguous."
              : "The reference does not resolve to an active record of the permitted type.",
          },
        ]);
    }
  }
  async protectIncoming(
    trx: Knex.Transaction,
    after: ProjectReferenceSnapshot,
    changedRoot: string,
  ): Promise<void> {
    for (const root of this.roots) {
      if (root.key === changedRoot) continue;
      for (const reference of root.entity.metadata.references(
        root.entity.name,
        root.value,
      )) {
        const before = await this.resolve(trx, reference);
        if (!before.some((target) => target.rootKey === changedRoot)) continue;
        const next = await after.resolve(trx, reference);
        if (
          before.length !== 1 ||
          next.length !== 1 ||
          next[0].rootKey !== before[0].rootKey ||
          next[0].type !== before[0].type ||
          (before[0].value.uid !== undefined &&
            next[0].value.uid !== before[0].value.uid)
        ) {
          throw new CrudError(
            "record_is_referenced",
            `The change would break a reference from ${root.entity.name} ${root.row[root.entity.primaryKey]} at ${pointer(reference.path)}.`,
            409,
          );
        }
      }
    }
  }
}
