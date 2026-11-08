import type { Knex } from "knex";
import { CrudInvalidQueryError, CrudRecordNotFoundError, CrudSummaryNotSupportedError } from "./entity-crud.errors";
import { translateDatabaseError } from "./entity-crud.db-errors";
import type { CrudContext, EntityDefinition, EntitySummaryResult, ListEntitiesInput } from "./entity-crud.types";
import { UIAdapter, type SQLRow } from "@sliwave/xsd-to-ir";
import { SchemaRegistryService } from "../../schema/schema-registry.service";
import assert from "node:assert/strict";
import { EntityChangePreparationService } from "./entity-change-preparation.service";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import { MariaDbEntityUidAllocator } from "./mariadb-entity-uid-allocator";

type CrudMarker = "I" | "U" | "R" | "D" | "N";
export interface EntityRecordResult<TValue extends Record<string, unknown> = Record<string, unknown>> {
  id: string | number; uid: string; crud: CrudMarker; pendingExport: boolean; _createdAt: string;
  _updatedAt: string; _deletedAt: string | null; value: TValue;
}
interface ListResult {
  data: EntityRecordResult[];
  metadata: { page: number; pageSize: number; total: number; pageCount: number };
}
export class EntityCrudService {
  public constructor(private readonly changePreparation = new EntityChangePreparationService(
    new MariaDbEntityUidAllocator(), new MariaDbEntityIdentityHistory(),
  )) {}

  private async executeWrite<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw translateDatabaseError(error); }
  }
  private createAdapter(entity: EntityDefinition): UIAdapter {
    const ir = SchemaRegistryService.getInstance().getIRRAW(entity.dialectVersion);
    return new UIAdapter(ir);
  }
  private toEntityRecord(entity: EntityDefinition, row: SQLRow, adapter = this.createAdapter(entity)): EntityRecordResult {
    const decoded = adapter.decodeRow(entity.name, row);
    const { uid, crud, ...value } = decoded.value;
    const id = row[entity.primaryKey];
    const createdAt = row._created_at;
    const updatedAt = row._updated_at;
    const deletedAt = row._deleted_at;
    assert(typeof id === "string" || typeof id === "number", `Entity "${entity.name}" has an invalid primary key`);
    assert(typeof uid === "string", `Entity "${entity.name}" has an invalid uid`);
    assert(crud === "I" || crud === "U" || crud === "R" || crud === "D" || crud === "N", `Entity "${entity.name}" has an invalid crud marker`);
    assert(typeof createdAt === "string" || createdAt instanceof Date, `Entity "${entity.name}" has an invalid creation timestamp`);
    assert(typeof updatedAt === "string" || updatedAt instanceof Date, `Entity "${entity.name}" has an invalid update timestamp`);
    assert(deletedAt === null || typeof deletedAt === "string" || deletedAt instanceof Date, `Entity "${entity.name}" has an invalid deletion timestamp`);
    return {
      id, uid, crud,
      _createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
      _updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
      _deletedAt: deletedAt instanceof Date ? deletedAt.toISOString() : deletedAt,
      pendingExport: row._msg_seq === 0 || row._msg_seq === "0", value,
    };
  }
  public async list(knex: Knex, entity: EntityDefinition, input: ListEntitiesInput): Promise<ListResult> {
    const { page, pageSize, filters } = input;
    const sortColumn = input.sortBy ? this.resolveColumn(entity, input.sortBy) : (entity.defaultSort?.column ?? entity.primaryKey);
    const sortDirection = input.sortBy ? input.sortDirection : (entity.defaultSort?.direction ?? "asc");
    this.validateSortColumn(entity, sortColumn);
    const resolvedFilters = this.resolveAndValidateFilters(entity, filters);
    const applyFilters = (query: Knex.QueryBuilder) => {
      query.whereNull("_deleted_at");
      for (const [column, value] of Object.entries(resolvedFilters)) {
        if (value === "") continue;
        query.where(column, value);
      }
      return query;
    };
    const dataQuery = applyFilters(knex(entity.tableName).select([...entity.readableColumns]))
      .orderBy(sortColumn, sortDirection).limit(pageSize).offset((page - 1) * pageSize);
    const countQuery = applyFilters(knex(entity.tableName).count<{ total: string | number }[]>({ total: "*" }));
    const [rows, countRows] = await Promise.all([dataQuery, countQuery]);
    const adapter = this.createAdapter(entity);
    const data = rows.map((row: SQLRow) => this.toEntityRecord(entity, row, adapter));
    const total = Number(countRows[0]?.total ?? 0);
    return { data, metadata: { page, pageSize, total, pageCount: total === 0 ? 0 : Math.ceil(total / pageSize) } };
  }
  public async findById(knex: Knex, entity: EntityDefinition, id: string): Promise<EntityRecordResult> {
    const record = await knex(entity.tableName).select([...entity.readableColumns])
      .where(entity.primaryKey, id).whereNull("_deleted_at").first();
    if (!record) throw new CrudRecordNotFoundError(entity.name, id);
    return this.toEntityRecord(entity, record);
  }
  public async create(context: CrudContext, data: Record<string, unknown>): Promise<EntityRecordResult> {
    return this.executeWrite(async () => {
      const { knex, entity } = context;
      return knex.transaction(async (trx) => {
        const preparedData = entity.beforeCreate ? await entity.beforeCreate(data, { ...context, knex: trx }) : data;
        const rawValues = await entity.createSchema.parseAsync(preparedData);
        const adapter = this.createAdapter(entity);
        const values = { ...adapter.encodeRow(entity.name, rawValues), crud: "I", _msg_seq: 0 };
        const insertResult = await trx(entity.tableName).insert(values);
        const insertedId = this.extractInsertedId(insertResult, entity.primaryKey);
        if (insertedId === undefined) throw new Error(`Could not determine the inserted identifier for entity "${entity.name}"`);
        const created = await trx(entity.tableName).select([...entity.readableColumns])
          .where(entity.primaryKey, insertedId).first();
        if (!created) throw new Error(`Created record could not be reloaded for entity "${entity.name}"`);
        return this.toEntityRecord(entity, created, adapter);
      });
    });
  }
  public async update(context: CrudContext, id: string, data: Record<string, unknown>): Promise<EntityRecordResult> {
    return this.executeWrite(async () => {
      const { knex, entity } = context;
      return knex.transaction(async (trx) => {
        const adapter = this.createAdapter(entity);
        const existingRow = await trx(entity.tableName).select([...entity.readableColumns])
          .where(entity.primaryKey, id).whereNull("_deleted_at").forUpdate().first();
        if (!existingRow) throw new CrudRecordNotFoundError(entity.name, id);
        const decoded = adapter.decodeRow(entity.name, existingRow);
        const updatedValue = { ...decoded.value, ...data };
        const preparedValue = entity.beforeUpdate
          ? await entity.beforeUpdate(updatedValue, { ...context, knex: trx }) : updatedValue;
        const values = { ...adapter.encodeRow(entity.name, preparedValue, decoded.state), crud: "U", _msg_seq: 0 };
        await trx(entity.tableName).where(entity.primaryKey, id).whereNull("_deleted_at").update(values);
        const updated = await trx(entity.tableName).select([...entity.readableColumns])
          .where(entity.primaryKey, id).whereNull("_deleted_at").first();
        if (!updated) throw new CrudRecordNotFoundError(entity.name, id);
        return this.toEntityRecord(entity, updated, adapter);
      });
    });
  }
  public async delete(knex: Knex, entity: EntityDefinition, id: string): Promise<void> {
    return this.executeWrite(async () => {
      const deletedCount = await knex(entity.tableName).where(entity.primaryKey, id)
        .whereNull("_deleted_at").update({ _deleted_at: knex.fn.now(), _updated_at: knex.fn.now(), crud: "D", _msg_seq: 0 });
      if (deletedCount === 0) throw new CrudRecordNotFoundError(entity.name, id);
    });
  }
  private validateSortColumn(entity: EntityDefinition, column: string): void {
    if (!entity.sortableColumns.includes(column)) {
      throw new CrudInvalidQueryError(`Field maps to column "${column}", which cannot be used to sort entity "${entity.name}", valid columns: ` + JSON.stringify(entity.sortableColumns));
    }
  }
  private resolveColumn(entity: EntityDefinition, field: string): string {
    const column = entity.fieldColumns?.[field];
    if (!column) throw new CrudInvalidQueryError(`Unknown field "${field}" for entity "${entity.name}", ` + `valid fields: ${JSON.stringify(Object.keys(entity.fieldColumns ?? {}))}`);
    return column;
  }
  private resolveAndValidateFilters(entity: EntityDefinition, filters: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
    return Object.fromEntries(Object.entries(filters).map(([field, value]) => {
      const column = this.resolveColumn(entity, field);
      this.validateFilterColumn(entity, column);
      return [column, value];
    }));
  }
  private validateFilterColumn(entity: EntityDefinition, column: string): void {
    if (!entity.filterableColumns.includes(column)) {
      throw new CrudInvalidQueryError(`Field maps to column "${column}", which cannot be used to filter entity "${entity.name}", valid columns: ` + JSON.stringify(entity.filterableColumns));
    }
  }
  private extractInsertedId(insertResult: unknown, primaryKey: string): string | number | undefined {
    if (!Array.isArray(insertResult) || insertResult.length === 0) return undefined;
    const firstResult = insertResult[0];
    if (typeof firstResult === "string" || typeof firstResult === "number") return firstResult;
    if (typeof firstResult === "object" && firstResult !== null) {
      const value = Reflect.get(firstResult, primaryKey);
      if (typeof value === "string" || typeof value === "number") return value;
    }
    return undefined;
  }
  public async summary(knex: Knex, entity: EntityDefinition): Promise<EntitySummaryResult> {
    if (!entity.summary) throw new CrudSummaryNotSupportedError(entity.name);
    return entity.summary(knex, entity);
  }
  public async replace(context: CrudContext, id: string, replacement: Record<string, unknown>): Promise<EntityRecordResult> {
    return this.executeWrite(async () => {
      const { knex, entity } = context;
      return knex.transaction(async (trx) => {
        const adapter = this.createAdapter(entity);
        const existingRow = await trx(entity.tableName).select([...entity.readableColumns])
          .where(entity.primaryKey, id).whereNull("_deleted_at").forUpdate().first();
        if (!existingRow) throw new CrudRecordNotFoundError(entity.name, id);
        const decoded = adapter.decodeRow(entity.name, existingRow);
        const existingRootUid = decoded.value.uid;
        if (typeof existingRootUid !== "string") throw new Error(`Entity "${entity.name}" has an invalid root uid`);
        if (!entity.identityPolicy) throw new Error(`Entity "${entity.name}" does not provide an identity preparation policy`);
        const prepared = await this.changePreparation.prepareReplacement({ trx, context: { ...context, knex: trx }, entity,
          entityId: String(id), rootUid: existingRootUid, previousValue: decoded.value as Record<string, unknown>,
          submittedValue: replacement, policy: entity.identityPolicy });
        if (!prepared.changed) return this.toEntityRecord(entity, existingRow, adapter);
        const validatedPreparedValue = await entity.preparedReplaceSchema.parseAsync(prepared.value);
        const encodedValues = adapter.encodeRow(entity.name, validatedPreparedValue, decoded.state);
        const values = { ...encodedValues, uid: existingRootUid, crud: prepared.rootCrud, _msg_seq: 0, _updated_at: trx.fn.now() };
        const updatedCount = await trx(entity.tableName).where(entity.primaryKey, id).whereNull("_deleted_at").update(values);
        if (updatedCount !== 1) throw new CrudRecordNotFoundError(entity.name, id);
        const updatedRow = await trx(entity.tableName).select([...entity.readableColumns])
          .where(entity.primaryKey, id).whereNull("_deleted_at").first();
        if (!updatedRow) throw new CrudRecordNotFoundError(entity.name, id);
        return this.toEntityRecord(entity, updatedRow, adapter);
      });
    });
  }
}
