import type { Knex } from "knex";
import {
  CrudError,
  CrudInvalidQueryError,
  CrudRecordNotFoundError,
  CrudSummaryNotSupportedError,
  CrudValidationError,
} from "./entity-crud.errors";
import { translateDatabaseError } from "./entity-crud.db-errors";
import type {
  CrudContext,
  CrudMarker,
  EntityDefinition,
  EntityRecordResult,
  EntitySummaryResult,
  ListEntitiesInput,
  ListResult,
} from "./entity-crud.types";
import { EntityCrudRegistry } from "./entity-crud.registry";
import { EntityChangePreparationService } from "./entity-change-preparation.service";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import { MariaDbEntityUidAllocator } from "./mariadb-entity-uid-allocator";
import {
  ProjectReferenceSnapshot,
  type ReferenceExtension,
  type SnapshotRoot,
} from "./entity-references";
import { isObject, pointer, type Adapter, type Value } from "./xsd-runtime";
import {
  StoredIdentities,
  reconcileStoredIdentities,
} from "./stored-identities";
import { toNonNegativeInteger } from "./organization-summary";

export interface CrudServiceOptions {
  references?: ReferenceExtension;
  /** Additional project/XSD rules unsupported by the generated schema belong here. */
  validateAdditional?: (
    context: CrudContext,
    value: Value,
    warnings: readonly string[],
  ) => void | Promise<void>;
}
function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string")
    throw new Error("Stored timestamp is invalid.");
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Stored timestamp is invalid.");
  return date.toISOString();
}
function scalarText(value: unknown, key: string): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => scalarText(item, key));
  return isObject(value) && typeof value[key] === "string"
    ? [value[key] as string]
    : [];
}
export class EntityCrudService {
  readonly history = new MariaDbEntityIdentityHistory();
  private readonly preparation = new EntityChangePreparationService(
    new MariaDbEntityUidAllocator(),
    this.history,
  );
  constructor(
    private readonly registry: EntityCrudRegistry,
    private readonly options: CrudServiceOptions = {},
  ) {}
  toEntityRecord(
    entity: EntityDefinition,
    row: Value,
    adapter = entity.createAdapter(),
  ): EntityRecordResult {
    const { uid, crud, ...value } = adapter.decodeRow(entity.name, row).value;
    const id = row[entity.primaryKey];
    if (
      !(
        (typeof id === "string" && id.length) ||
        (Number.isSafeInteger(id) && Number(id) >= 0)
      ) ||
      typeof uid !== "string" ||
      !["I", "U", "R", "D", "N"].includes(String(crud))
    )
      throw new Error(
        "Stored entity envelope is invalid. Configure large database IDs as strings.",
      );
    return {
      id: id as string | number,
      uid,
      crud: crud as CrudMarker,
      pendingExport: row._msg_seq === 0 || row._msg_seq === "0",
      _createdAt: timestamp(row._created_at),
      _updatedAt: timestamp(row._updated_at),
      _deletedAt: row._deleted_at === null ? null : timestamp(row._deleted_at),
      value,
    };
  }
  private column(
    entity: EntityDefinition,
    field: string,
    allowed: readonly string[],
  ): string {
    const column = entity.fieldColumns[field];
    if (!column || !allowed.includes(column))
      throw new CrudInvalidQueryError(
        `Field "${field}" cannot be used in this query for ${entity.name}.`,
      );
    return column;
  }
  async list(
    knex: Knex,
    entity: EntityDefinition,
    input: ListEntitiesInput,
  ): Promise<ListResult> {
    const { page, pageSize } = input;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      !Number.isSafeInteger((page - 1) * pageSize) ||
      !["asc", "desc"].includes(input.sortDirection)
    )
      throw new CrudInvalidQueryError("Invalid pagination or sort direction.");
    const sort = input.sortBy
      ? this.column(entity, input.sortBy, entity.sortableColumns)
      : entity.primaryKey;
    const filters = { ...input.filters };
    let search = "";
    let status = "";
    if (entity.name === "organization") {
      if (filters.search !== undefined && typeof filters.search !== "string")
        throw new CrudInvalidQueryError("Search must be text.");
      search = String(filters.search ?? "").toLocaleLowerCase("en");
      status = String(filters.status ?? "");
      if (!["", "pending", "I", "U", "R", "N"].includes(status))
        throw new CrudInvalidQueryError("Unknown change status.");
      delete filters.search;
      delete filters.status;
    }
    const resolved = Object.entries(filters)
      .filter(([, value]) => value !== "")
      .map(
        ([key, value]) =>
          [this.column(entity, key, entity.filterableColumns), value] as const,
      );
    const query = () => {
      const builder = knex(entity.tableName).whereNull("_deleted_at");
      for (const [column, value] of resolved) builder.where(column, value);
      if (status === "pending") builder.where("_msg_seq", 0);
      else if (status) builder.where("crud", status);
      return builder;
    };
    const dataQuery = query()
      .select(entity.readableColumns)
      .orderBy(sort, input.sortDirection);
    if (sort !== entity.primaryKey) dataQuery.orderBy(entity.primaryKey, "asc");
    const adapter = entity.createAdapter();
    let data: EntityRecordResult[];
    let total: number;
    if (search) {
      // Correct logical semantics for singleton/array JSON. Apply BEFORE paging, including the total.
      const rows: Value[] = await dataQuery;
      const matching = rows
        .map((row) => this.toEntityRecord(entity, row, adapter))
        .filter((record) =>
          [
            ...scalarText(record.value.name, "descr"),
            ...scalarText(record.value.orgId, "id"),
          ].some((text) => text.toLocaleLowerCase("en").includes(search)),
        );
      total = matching.length;
      data = matching.slice((page - 1) * pageSize, page * pageSize);
    } else {
      const [rows, count] = await Promise.all([
        dataQuery.limit(pageSize).offset((page - 1) * pageSize),
        query().count({ total: "*" }).first(),
      ]);
      total = toNonNegativeInteger(count?.total);
      data = rows.map((row) => this.toEntityRecord(entity, row, adapter));
    }
    return {
      data,
      metadata: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }
  async findById(
    knex: Knex,
    entity: EntityDefinition,
    id: string,
  ): Promise<EntityRecordResult> {
    const row = await this.activeRow(knex, entity, id);
    return this.toEntityRecord(entity, row);
  }
  private async activeRow(
    knex: Knex,
    entity: EntityDefinition,
    id: string,
    lock = false,
  ): Promise<Value> {
    const query = knex(entity.tableName)
      .select(entity.readableColumns)
      .where(entity.primaryKey, id)
      .whereNull("_deleted_at");
    if (lock) query.forUpdate();
    const row = await query.first();
    if (!row) throw new CrudRecordNotFoundError(entity.name, id);
    return row;
  }
  private async write<T>(
    context: CrudContext,
    action: (trx: Knex.Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await context.knex.transaction(async (trx) => {
        await this.history.lock(trx);
        return action(trx);
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
  private encode(
    adapter: Adapter,
    entity: EntityDefinition,
    value: Value,
    state?: object,
  ): Value {
    try {
      return adapter.encodeRow(entity.name, value, state);
    } catch (error) {
      throw new CrudValidationError([
        {
          path: "",
          message:
            error instanceof Error ? error.message : "Value cannot be encoded.",
        },
      ]);
    }
  }
  private async validate(
    context: CrudContext,
    value: Value,
    create: boolean,
  ): Promise<Value> {
    const result = await (
      create
        ? context.entity.preparedCreateSchema
        : context.entity.preparedReplaceSchema
    ).parseAsync(value);
    await this.options.validateAdditional?.(
      context,
      result,
      context.entity.validationWarnings(),
    );
    return result;
  }
  private async log(
    trx: Knex.Transaction,
    entity: EntityDefinition,
    operation: string,
    previous: Value | null,
    next: Value,
  ): Promise<void> {
    await trx("_entity_change_log").insert({
      entity_name: entity.name,
      entity_id: String(next[entity.primaryKey]),
      root_uid: next.uid,
      operation,
      previous_row: previous === null ? null : JSON.stringify(previous),
      next_row: JSON.stringify(next),
    });
  }
  async create(context: CrudContext, data: Value): Promise<EntityRecordResult> {
    const submittedValue = await context.entity.createSchema.parseAsync(data);
    return this.write(context, async (trx) => {
      const entity = context.entity;
      const adapter = entity.createAdapter();
      const prepared = await this.preparation.prepareCreate({
        trx,
        entity,
        submittedValue,
      });
      const value = await this.validate(
        { ...context, knex: trx },
        prepared.value,
        true,
      );
      const snapshot = await ProjectReferenceSnapshot.load(
        trx,
        this.registry,
        entity.dialectVersion,
        this.options.references,
      );
      const root: SnapshotRoot = {
        key: `${entity.name}:new`,
        entity,
        row: { [entity.primaryKey]: "new" },
        value,
      };
      await snapshot.withRoot(root).validateOutgoing(trx, root);
      const inserted = await trx(entity.tableName).insert({
        ...this.encode(adapter, entity, value),
        _msg_seq: 0,
      });
      const id = inserted[0];
      if (typeof id !== "number" && typeof id !== "string")
        throw new Error("Insert did not return a database ID.");
      const row = await this.activeRow(trx, entity, String(id));
      await this.log(trx, entity, "create", null, row);
      return this.toEntityRecord(entity, row, adapter);
    });
  }
  async replace(
    context: CrudContext,
    id: string,
    replacement: Value,
  ): Promise<EntityRecordResult> {
    const input = await context.entity.replaceSchema.parseAsync(replacement);
    return this.change(context, id, input, "replace");
  }
  async update(
    context: CrudContext,
    id: string,
    patch: Value,
  ): Promise<EntityRecordResult> {
    const input = await context.entity.updateSchema.parseAsync(patch);
    return this.change(context, id, input, "patch");
  }
  async backfillIdentities(
    context: CrudContext,
    id: string,
  ): Promise<EntityRecordResult> {
    return this.change(context, id, {}, "backfill");
  }
  private async change(
    context: CrudContext,
    id: string,
    input: Value,
    operation: "replace" | "patch" | "backfill",
  ): Promise<EntityRecordResult> {
    return this.write(context, async (trx) => {
      const entity = context.entity;
      const adapter = entity.createAdapter();
      const previous = await this.activeRow(trx, entity, id, true);
      const decoded = adapter.decodeRow(entity.name, previous);
      const { uid: _uid, crud: _crud, ...business } = decoded.value;
      const prepared =
        operation === "backfill"
          ? await this.preparation.prepareBackfill({
              trx,
              entity,
              previousValue: decoded.value,
            })
          : await this.preparation.prepareReplacement({
              trx,
              entity,
              previousValue: decoded.value,
              submittedValue:
                operation === "patch" ? { ...business, ...input } : input,
            });
      if (!prepared.changed)
        return this.toEntityRecord(entity, previous, adapter);
      const value = await this.validate(
        { ...context, knex: trx },
        prepared.value,
        false,
      );
      const before = new StoredIdentities(entity, previous, decoded.value);
      const encoded = new StoredIdentities(
        entity,
        this.encode(adapter, entity, value, decoded.state),
        value,
      );
      await reconcileStoredIdentities(
        trx,
        entity,
        this.history,
        before,
        encoded,
      );
      const snapshot = await ProjectReferenceSnapshot.load(
        trx,
        this.registry,
        entity.dialectVersion,
        this.options.references,
      );
      const key = `${entity.name}:${previous[entity.primaryKey]}`;
      const root: SnapshotRoot = {
        key,
        entity,
        row: { ...previous, ...encoded.row },
        value,
      };
      const after = snapshot.withRoot(root, key);
      await after.validateOutgoing(trx, root);
      await snapshot.protectIncoming(trx, after, key);
      const count = await trx(entity.tableName)
        .where(entity.primaryKey, id)
        .whereNull("_deleted_at")
        .update({
          ...encoded.row,
          uid: previous.uid,
          crud: prepared.rootCrud,
          _msg_seq: 0,
          _updated_at: trx.fn.now(3),
        });
      if (count !== 1) throw new CrudRecordNotFoundError(entity.name, id);
      const row = await this.activeRow(trx, entity, id);
      await this.log(trx, entity, operation, previous, row);
      return this.toEntityRecord(entity, row, adapter);
    });
  }
  async delete(context: CrudContext, id: string): Promise<void> {
    return this.write(context, async (trx) => {
      const entity = context.entity;
      const row = await this.activeRow(trx, entity, id, true);
      const value = entity.createAdapter().decodeRow(entity.name, row).value;
      const snapshot = await ProjectReferenceSnapshot.load(
        trx,
        this.registry,
        entity.dialectVersion,
        this.options.references,
      );
      const key = `${entity.name}:${row[entity.primaryKey]}`;
      await snapshot.protectIncoming(trx, snapshot.withRoot(null, key), key);
      await this.protectSqlReferences(trx, entity, id);
      for (const node of new StoredIdentities(entity, row, value).items) {
        await this.history.recordNestedDeletion(trx, {
          entityName: entity.name,
          rootUid: String(value.uid),
          identityType: node.type,
          uid: node.uid,
          path: pointer(node.path),
          previousValue: node.raw,
        });
      }
      await trx(entity.tableName)
        .where(entity.primaryKey, id)
        .update({
          _deleted_at: trx.fn.now(3),
          _updated_at: trx.fn.now(3),
          crud: "D",
          _msg_seq: 0,
        });
      const next = await trx(entity.tableName)
        .where(entity.primaryKey, id)
        .first();
      await this.log(trx, entity, "delete", row, next);
    });
  }
  private async protectSqlReferences(
    trx: Knex.Transaction,
    target: EntityDefinition,
    id: string,
  ): Promise<void> {
    for (const entity of target.ir.entities.values())
      for (const column of entity.columns) {
        const reference = column as typeof column & {
          referencesEntity?: string;
          isForeignKey?: boolean;
        };
        if (
          !reference.isForeignKey ||
          reference.referencesEntity !== target.name
        )
          continue;
        const query = trx(entity.tableName).where(column.columnName, id);
        if (entity.columns.some((item) => item.columnName === "_deleted_at"))
          query.whereNull("_deleted_at");
        if (entity.name === target.name) query.whereNot(target.primaryKey, id);
        if (await query.first())
          throw new CrudError(
            "record_is_referenced",
            `An active ${entity.name} row references this record.`,
            409,
          );
      }
  }
  async summary(
    knex: Knex,
    entity: EntityDefinition,
  ): Promise<EntitySummaryResult> {
    if (!entity.summary) throw new CrudSummaryNotSupportedError(entity.name);
    return entity.summary(knex, entity);
  }
}
