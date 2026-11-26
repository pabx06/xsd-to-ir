import { isDeepStrictEqual } from "node:util";
import { EntityIdentityValidationError } from "./entity-change-preparation.errors";
import { CrudError } from "./entity-crud.errors";
import type {
  EntityIdentityHistory,
  EntityUidAllocator,
  IdentityInput,
  PrepareCreateInput,
  PreparedTrackedValue,
  PrepareReplacementInput,
} from "./entity-change-preparation.types";
import type { CrudMarker } from "./entity-crud.types";
import type { Occurrence } from "./entity-metadata";
import { pointer, type Value } from "./xsd-runtime";

const rootManaged = [
  "id",
  "uid",
  "crud",
  "revision",
  "pendingExport",
  "_createdAt",
  "_updatedAt",
  "_deletedAt",
  "_msgSeq",
  "_created_at",
  "_updated_at",
  "_deleted_at",
  "_msg_seq",
];
const withoutCrud = (value: Value) => {
  const copy = structuredClone(value);
  delete copy.crud;
  return copy;
};
const pathGroup = (item: Occurrence) =>
  JSON.stringify(item.path.filter((part) => typeof part === "string"));

export class EntityChangePreparationService {
  constructor(
    private readonly allocator: EntityUidAllocator,
    private readonly history: EntityIdentityHistory,
  ) {}
  private rejectRoot(value: Value): void {
    for (const name of rootManaged)
      if (Object.hasOwn(value, name))
        throw new EntityIdentityValidationError(
          "This field is managed by the backend.",
          pointer([name]),
        );
  }
  private key(
    input: PrepareCreateInput,
    rootUid: string,
    item: Occurrence,
  ): IdentityInput {
    return {
      entityName: input.entity.name,
      rootUid,
      identityType: item.type,
      uid: String(item.value.uid),
    };
  }
  private rejectNew(item: Occurrence): void {
    for (const field of ["uid", "crud"])
      if (Object.hasOwn(item.value, field))
        throw new EntityIdentityValidationError(
          "A new value must not provide identity or tracking.",
          pointer([...item.path, field]),
        );
  }
  private checkCrud(old: Occurrence, next: Occurrence): void {
    if (Object.hasOwn(next.value, "crud") && next.value.crud !== old.value.crud)
      throw new EntityIdentityValidationError(
        "CRUD is managed by the backend.",
        pointer([...next.path, "crud"]),
      );
    if (Object.hasOwn(old.value, "crud")) next.value.crud = old.value.crud;
  }
  async prepareCreate(
    input: PrepareCreateInput,
  ): Promise<PreparedTrackedValue> {
    this.rejectRoot(input.submittedValue);
    const value = structuredClone(input.submittedValue);
    const nodes = input.entity.metadata.identities(input.entity.name, value);
    // Reject everything before allocating; rollback is still required for all subsequent errors.
    nodes.forEach((node) => this.rejectNew(node));
    const rootUid = await this.allocator.allocate(
      input.trx,
      input.entity,
      input.entity.name,
    );
    value.uid = rootUid;
    value.crud = "I";
    for (const node of nodes) {
      if (node.path.length) {
        node.value.uid = await this.allocator.allocate(
          input.trx,
          input.entity,
          node.type,
        );
        node.value.crud = "I";
      }
      await this.history.register(
        input.trx,
        this.key(input, rootUid, node),
        false,
      );
    }
    return { value, rootCrud: "I", changed: true };
  }
  async prepareReplacement(
    input: PrepareReplacementInput,
  ): Promise<PreparedTrackedValue> {
    this.rejectRoot(input.submittedValue);
    const metadata = input.entity.metadata;
    const rootUid = input.previousValue.uid;
    if (typeof rootUid !== "string") throw new Error("Stored root has no UID.");
    const value: Value = {
      ...structuredClone(input.submittedValue),
      uid: rootUid,
      crud: input.previousValue.crud,
    };
    const previous = metadata.identities(
      input.entity.name,
      input.previousValue,
    );
    const submitted = metadata.identities(input.entity.name, value);
    const byUid = new Map<string, Occurrence>();
    for (const item of previous) {
      if (item.value.uid === undefined) continue;
      if (typeof item.value.uid !== "string" || byUid.has(item.value.uid))
        throw new Error("Stored identities are invalid or duplicated.");
      byUid.set(item.value.uid, item);
    }
    const retained = new Set<string>();
    const legacy = previous.filter((node) => node.value.uid === undefined);
    const matchedLegacy = new Set<Occurrence>();
    const newNodes: Occurrence[] = [];
    for (const item of submitted) {
      if (item.value.uid !== undefined) {
        const uid = item.value.uid;
        const old = typeof uid === "string" ? byUid.get(uid) : undefined;
        if (!old || old.type !== item.type || retained.has(uid as string))
          throw new EntityIdentityValidationError(
            "UID is foreign, duplicated, or incompatible with this value type.",
            pointer([...item.path, "uid"]),
          );
        this.checkCrud(old, item);
        retained.add(uid as string);
      } else {
        const old = legacy.find(
          (candidate) =>
            !matchedLegacy.has(candidate) &&
            candidate.type === item.type &&
            pathGroup(candidate) === pathGroup(item) &&
            isDeepStrictEqual(
              withoutCrud(candidate.value),
              withoutCrud(item.value),
            ),
        );
        if (old) {
          this.checkCrud(old, item);
          matchedLegacy.add(old);
        } else newNodes.push(item);
      }
    }
    if (legacy.some((item) => !matchedLegacy.has(item))) {
      throw new CrudError(
        "legacy_identity_required",
        "Backfill identities for this record before editing or removing existing values without UIDs. Unchanged legacy values may be retained.",
        409,
      );
    }
    newNodes.forEach((node) => this.rejectNew(node));
    if (isDeepStrictEqual(value, input.previousValue))
      return { value, rootCrud: value.crud as CrudMarker, changed: false };
    for (const node of newNodes) {
      node.value.uid = await this.allocator.allocate(
        input.trx,
        input.entity,
        node.type,
      );
      node.value.crud = "I";
      await this.history.register(
        input.trx,
        this.key(input, rootUid, node),
        false,
      );
    }
    // Compare business data without descendant tracking so a system-only change does not alter untouched siblings.
    for (const item of submitted) {
      const old = byUid.get(String(item.value.uid));
      if (
        !old ||
        !item.path.length ||
        metadata.sameBusiness(item.type, old.value, item.value)
      )
        continue;
      item.value.crud = (await this.history.isEstablished(
        input.trx,
        this.key(input, rootUid, item),
      ))
        ? "U"
        : "I";
    }
    const root = submitted.find((item) => item.path.length === 0)!;
    const rootCrud = (await this.history.isEstablished(
      input.trx,
      this.key(input, rootUid, root),
    ))
      ? "U"
      : "I";
    value.crud = rootCrud;
    // Deletions are reconciled against encoded storage; clean null can hide a retained XML UID.
    return { value, rootCrud, changed: true };
  }
  /** Explicit administrative operation. Never run this implicitly on GET or an unchanged save. */
  async prepareBackfill(
    input: Omit<PrepareReplacementInput, "submittedValue">,
  ): Promise<PreparedTrackedValue> {
    const value = structuredClone(input.previousValue);
    const nodes = input.entity.metadata.identities(input.entity.name, value);
    const rootUid = String(value.uid);
    const root = nodes.find((item) => item.path.length === 0)!;
    const established = await this.history.isEstablished(
      input.trx,
      this.key({ ...input, submittedValue: value }, rootUid, root),
    );
    let changed = false;
    for (const node of nodes)
      if (node.value.uid === undefined) {
        node.value.uid = await this.allocator.allocate(
          input.trx,
          input.entity,
          node.type,
        );
        node.value.crud = established ? "U" : "I";
        changed = true;
        await this.history.register(
          input.trx,
          this.key({ ...input, submittedValue: value }, rootUid, node),
          established,
        );
      }
    if (changed) value.crud = established ? "U" : "I";
    return { value, rootCrud: value.crud as CrudMarker, changed };
  }
}
