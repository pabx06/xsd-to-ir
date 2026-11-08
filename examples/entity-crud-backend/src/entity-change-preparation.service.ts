import type { Knex } from "knex";
import { EntityIdentityValidationError } from "./entity-change-preparation.errors";
import type {
  EntityIdentityHistory,
  EntityIdentityPolicy,
  EntityUidAllocator,
  IdentityBearingValue,
  IdentityPathDefinition,
  NestedCrudMarker,
  PrepareCreateInput,
  PreparedTrackedValue,
  PrepareReplacementInput,
} from "./entity-change-preparation.types";

type UnknownRecord = Record<string, unknown>;

interface LocatedIdentity {
  value: IdentityBearingValue;
  path: readonly (string | number)[];
}

export class EntityChangePreparationService {
  public constructor(
    private readonly uidAllocator: EntityUidAllocator,
    private readonly history: EntityIdentityHistory,
  ) {}

  public async prepareCreate(input: PrepareCreateInput): Promise<PreparedTrackedValue> {
    const value = structuredClone(input.submittedValue);
    this.rejectManagedRootFields(value);
    const rootUid = await this.allocateUid(
      input.trx,
      input.context.projectId,
      input.entity.name,
      input.entity.dialectVersion,
      input.policy.root.identityType,
      input.policy.root.uid,
    );
    for (const definition of input.policy.nested) {
      const submittedItems = this.locateIdentities(value, definition.path);
      for (const item of submittedItems) {
        this.rejectNewNestedManagedFields(item);
        item.value.uid = await this.allocateUid(
          input.trx, input.context.projectId, input.entity.name,
          input.entity.dialectVersion, definition.identityType, definition.uid,
        );
        item.value.crud = "I";
      }
    }
    return { value: { ...value, uid: rootUid, crud: "I" }, rootCrud: "I", changed: true };
  }

  public async prepareReplacement(input: PrepareReplacementInput): Promise<PreparedTrackedValue> {
    const submitted = structuredClone(input.submittedValue);
    this.rejectManagedRootFields(submitted);
    const normalizedPrevious = this.removeRootManagedFields(structuredClone(input.previousValue));
    if (this.areSemanticallyEqual(normalizedPrevious, submitted)) {
      const previousRootCrud = this.readRootCrud(input.previousValue);
      return {
        value: structuredClone(input.previousValue),
        rootCrud: previousRootCrud,
        changed: false,
      };
    }
    for (const definition of input.policy.nested) {
      await this.prepareNestedPath(input, submitted, definition);
    }
    const rootEstablished = await this.history.isEstablished(input.trx, {
      projectId: input.context.projectId,
      entityName: input.entity.name,
      identityType: input.policy.root.identityType,
      uid: input.rootUid,
    });
    const rootCrud: "I" | "U" = rootEstablished ? "U" : "I";
    return { value: { ...submitted, uid: input.rootUid, crud: rootCrud }, rootCrud, changed: true };
  }

  private async prepareNestedPath(
    input: PrepareReplacementInput,
    submittedRoot: UnknownRecord,
    definition: IdentityPathDefinition,
  ): Promise<void> {
    const previousItems = this.locateIdentities(input.previousValue, definition.path);
    const submittedItems = this.locateIdentities(submittedRoot, definition.path);
    this.assertNoDuplicateSubmittedUids(submittedItems);
    const previousByUid = new Map<string, LocatedIdentity>();
    for (const previousItem of previousItems) {
      const uid = this.readRequiredUid(previousItem);
      if (previousByUid.has(uid)) {
        throw new Error(`Persisted entity contains duplicate nested UID "${uid}"`);
      }
      previousByUid.set(uid, previousItem);
    }
    const retainedUids = new Set<string>();
    for (const submittedItem of submittedItems) {
      const submittedUid = this.readOptionalUid(submittedItem);
      if (submittedUid === undefined) {
        this.rejectNewNestedManagedFields(submittedItem);
        submittedItem.value.uid = await this.allocateUid(
          input.trx, input.context.projectId, input.entity.name,
          input.entity.dialectVersion, definition.identityType, definition.uid,
        );
        submittedItem.value.crud = "I";
        continue;
      }
      const previousItem = previousByUid.get(submittedUid);
      if (!previousItem) {
        await this.rejectForeignOrForgedUid(input, definition, submittedItem, submittedUid);
      }
      // rejectForeignOrForgedUid always throws when the UID is not in previousByUid.
      if (!previousItem) continue;
      retainedUids.add(submittedUid);
      this.assertCrudWasNotChanged(previousItem, submittedItem);
      const established = await this.history.isEstablished(input.trx, {
        projectId: input.context.projectId,
        entityName: input.entity.name,
        identityType: definition.identityType,
        uid: submittedUid,
      });
      const nestedBusinessChanged = !this.areSemanticallyEqual(
        this.removeNestedManagedFields(previousItem.value),
        this.removeNestedManagedFields(submittedItem.value),
      );
      submittedItem.value.uid = submittedUid;
      submittedItem.value.crud = this.resolveNestedCrud({
        established,
        changed: nestedBusinessChanged,
        previousCrud: this.readOptionalCrud(previousItem),
      });
    }
    for (const [removedUid, previousItem] of previousByUid) {
      if (retainedUids.has(removedUid)) continue;
      await this.history.recordNestedDeletion(input.trx, {
        projectId: input.context.projectId,
        entityName: input.entity.name,
        entityId: input.entityId,
        rootUid: input.rootUid,
        identityType: definition.identityType,
        uid: removedUid,
        path: definition.path,
        previousValue: structuredClone(previousItem.value),
      });
    }
  }

  private async rejectForeignOrForgedUid(
    input: PrepareReplacementInput,
    definition: IdentityPathDefinition,
    submittedItem: LocatedIdentity,
    uid: string,
  ): Promise<never> {
    const owner = await this.history.findOwner(input.trx, {
      projectId: input.context.projectId,
      entityName: input.entity.name,
      identityType: definition.identityType,
      uid,
    });
    const pointer = this.toJsonPointer([...submittedItem.path, "uid"]);
    if (!owner) {
      throw new EntityIdentityValidationError(`Nested UID "${uid}" is not part of the existing entity.`, pointer);
    }
    if (owner.rootUid !== input.rootUid) {
      throw new EntityIdentityValidationError(`Nested UID "${uid}" belongs to another entity.`, pointer);
    }
    if (owner.identityType !== definition.identityType) {
      throw new EntityIdentityValidationError(`Nested UID "${uid}" cannot be moved to this value type.`, pointer);
    }
    throw new EntityIdentityValidationError(`Nested UID "${uid}" is not active at this path.`, pointer);
  }

  private assertNoDuplicateSubmittedUids(items: readonly LocatedIdentity[]): void {
    const pathsByUid = new Map<string, readonly (string | number)[]>();
    for (const item of items) {
      const uid = this.readOptionalUid(item);
      if (uid === undefined) continue;
      const firstPath = pathsByUid.get(uid);
      if (firstPath) {
        throw new EntityIdentityValidationError(
          `Nested UID "${uid}" occurs more than once in the submitted value.`,
          this.toJsonPointer([...item.path, "uid"]),
        );
      }
      pathsByUid.set(uid, item.path);
    }
  }

  private assertCrudWasNotChanged(previous: LocatedIdentity, submitted: LocatedIdentity): void {
    const submittedCrud = this.readOptionalCrud(submitted);
    if (submittedCrud === undefined) return;
    const previousCrud = this.readOptionalCrud(previous);
    if (submittedCrud !== previousCrud) {
      throw new EntityIdentityValidationError(
        "Nested CRUD state is managed by the backend.",
        this.toJsonPointer([...submitted.path, "crud"]),
      );
    }
  }

  private rejectNewNestedManagedFields(item: LocatedIdentity): void {
    if ("uid" in item.value) {
      throw new EntityIdentityValidationError(
        "A new nested value must not provide a UID.",
        this.toJsonPointer([...item.path, "uid"]),
      );
    }
    if ("crud" in item.value) {
      throw new EntityIdentityValidationError(
        "A new nested value must not provide a CRUD state.",
        this.toJsonPointer([...item.path, "crud"]),
      );
    }
  }

  private rejectManagedRootFields(value: UnknownRecord): void {
    const managedFields = [
      "uid", "crud", "revision", "_createdAt", "_updatedAt", "_deletedAt", "_msgSeq",
      "_created_at", "_updated_at", "_deleted_at", "_msg_seq",
    ] as const;
    for (const field of managedFields) {
      if (field in value) {
        throw new EntityIdentityValidationError(
          `Root field "${field}" is managed by the backend.`,
          this.toJsonPointer([field]),
        );
      }
    }
  }

  private removeRootManagedFields(value: UnknownRecord): UnknownRecord {
    const clone = structuredClone(value);
    delete clone.uid;
    delete clone.crud;
    delete clone.revision;
    delete clone._createdAt;
    delete clone._updatedAt;
    delete clone._deletedAt;
    delete clone._msgSeq;
    delete clone._created_at;
    delete clone._updated_at;
    delete clone._deleted_at;
    delete clone._msg_seq;
    return clone;
  }

  private removeNestedManagedFields(value: IdentityBearingValue): UnknownRecord {
    const clone: UnknownRecord = structuredClone(value);
    delete clone.uid;
    delete clone.crud;
    return clone;
  }

  private resolveNestedCrud(input: {
    established: boolean;
    changed: boolean;
    previousCrud: NestedCrudMarker | undefined;
  }): NestedCrudMarker {
    if (!input.established) return "I";
    if (input.changed) return "U";
    return input.previousCrud ?? "R";
  }

  private readOptionalUid(item: LocatedIdentity): string | undefined {
    const uid = item.value.uid;
    if (uid === undefined) return undefined;
    if (typeof uid !== "string" || uid.length === 0) {
      throw new EntityIdentityValidationError(
        "Nested UID must be a non-empty string.",
        this.toJsonPointer([...item.path, "uid"]),
      );
    }
    return uid;
  }

  private readRequiredUid(item: LocatedIdentity): string {
    const uid = this.readOptionalUid(item);
    if (uid === undefined) {
      throw new Error(`Persisted identity at "${this.toJsonPointer(item.path)}" does not have a UID`);
    }
    return uid;
  }

  private readOptionalCrud(item: LocatedIdentity): NestedCrudMarker | undefined {
    const crud = item.value.crud;
    if (crud === undefined) return undefined;
    if (crud !== "I" && crud !== "U" && crud !== "R" && crud !== "D" && crud !== "N") {
      throw new EntityIdentityValidationError(
        "Nested CRUD state is invalid.",
        this.toJsonPointer([...item.path, "crud"]),
      );
    }
    return crud;
  }

  private readRootCrud(value: UnknownRecord): "I" | "U" {
    return value.crud === "I" ? "I" : "U";
  }

  private async allocateUid(
    trx: Knex.Transaction,
    projectId: string,
    entityName: string,
    schemaIssue: string,
    identityType: string,
    uidDefinition: { prefix: string; maxLength: number; pattern: RegExp },
  ): Promise<string> {
    const uid = await this.uidAllocator.allocate(trx, {
      projectId, schemaIssue, entityName, identityType,
      prefix: uidDefinition.prefix,
      maxLength: uidDefinition.maxLength,
      pattern: uidDefinition.pattern,
    });
    if (uid.length > uidDefinition.maxLength || !uidDefinition.pattern.test(uid)) {
      throw new Error(`UID allocator returned an invalid UID for "${identityType}"`);
    }
    return uid;
  }

  private locateIdentities(root: UnknownRecord, path: readonly string[]): LocatedIdentity[] {
    let candidates: Array<{ value: unknown; path: readonly (string | number)[] }> = [
      { value: root, path: [] },
    ];
    for (const segment of path) {
      const next: typeof candidates = [];
      for (const candidate of candidates) {
        if (!this.isRecord(candidate.value)) continue;
        const child = candidate.value[segment];
        if (child === undefined || child === null) continue;
        if (Array.isArray(child)) {
          child.forEach((value, index) => next.push({
            value, path: [...candidate.path, segment, index],
          }));
        } else {
          next.push({ value: child, path: [...candidate.path, segment] });
        }
      }
      candidates = next;
    }
    return candidates.map((candidate) => {
      if (!this.isRecord(candidate.value)) {
        throw new EntityIdentityValidationError(
          "Identity-bearing value must be an object.",
          this.toJsonPointer(candidate.path),
        );
      }
      return { value: candidate.value as IdentityBearingValue, path: candidate.path };
    });
  }

  private areSemanticallyEqual(left: unknown, right: unknown): boolean {
    return this.canonicalize(left) === this.canonicalize(right);
  }

  private canonicalize(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalize(item)).join(",")}]`;
    if (this.isRecord(value)) {
      const properties = Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${this.canonicalize(value[key])}`,
      );
      return `{${properties.join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private toJsonPointer(path: readonly (string | number)[]): string {
    if (path.length === 0) return "";
    return path.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
  }
}
