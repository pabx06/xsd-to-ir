import { getOrganizationSummary } from "./organization-summary";
import { organizationIdentityPolicyV11 } from "./organization-identity.policy";
import { z } from "zod";
import type { IRColumn, IREntity, S3000LVersion } from "@sliwave/xsd-to-ir";
import { SchemaRegistryService } from "../../schema/schema-registry.service";
import { CrudEntityNotFoundError } from "./entity-crud.errors";
import type { EntityDefinition, EntityRelationDefinition } from "./entity-crud.types";
import { logger } from "../../../config/logger";
import assert from "node:assert/strict";

interface IRDocument { version: string; ir: { entities: Record<string, IREntity> }; }
const DATABASE_MANAGED_COLUMNS = new Set(["id", "_created_at", "_updated_at", "_deleted_at", "_msg_seq"]);
const ROOT_MANAGED_COLUMNS = new Set(["id", "uid", "crud", "_created_at", "_updated_at", "_deleted_at", "_msg_seq"]);
const HIDDEN_COLUMNS = new Set<string>([]);
const NON_SORTABLE_JSON_TYPES = new Set(["object", "array"]);

export class EntityCrudRegistry {
  private static instance?: EntityCrudRegistry;
  private readonly definitionsByVersion = new Map<S3000LVersion, ReadonlyMap<string, EntityDefinition>>();
  private constructor(private readonly schemaRegistry: SchemaRegistryService) {}

  public static getInstance(): EntityCrudRegistry {
    if (!EntityCrudRegistry.instance) {
      EntityCrudRegistry.instance = new EntityCrudRegistry(SchemaRegistryService.getInstance());
    }
    return EntityCrudRegistry.instance;
  }

  public getEntityDefinition(version: S3000LVersion, entityName: string): EntityDefinition {
    const definitions = this.getDefinitions(version);
    const definition = definitions.get(entityName);
    if (!definition) { throw new CrudEntityNotFoundError(entityName); }
    assert(definition.dialectVersion === version);
    return definition;
  }

  public getEntityDefinitions(version: S3000LVersion): readonly EntityDefinition[] {
    assert([...new Set(this.getDefinitions(version).values())].length ===
      [...this.getDefinitions(version).values()].length);
    return [...this.getDefinitions(version).values()];
  }

  public hasEntity(version: S3000LVersion, entityName: string): boolean {
    return this.getDefinitions(version).has(entityName);
  }

  public clearCache(version?: S3000LVersion): void {
    if (version) { this.definitionsByVersion.delete(version); return; }
    this.definitionsByVersion.clear();
  }

  private getDefinitions(version: S3000LVersion): ReadonlyMap<string, EntityDefinition> {
    const cached = this.definitionsByVersion.get(version);
    if (cached) return cached;
    const definitions = this.buildDefinitions(version);
    this.definitionsByVersion.set(version, definitions);
    return definitions;
  }

  private registerDefinition(definitions: Map<string, EntityDefinition>, publicName: string,
    definition: EntityDefinition): void {
    const existing = definitions.get(publicName);
    if (existing && existing !== definition) {
      throw new Error(`Duplicate CRUD entity name "${publicName}"`);
    }
    definitions.set(publicName, definition);
  }

  private buildDefinitions(version: S3000LVersion): ReadonlyMap<string, EntityDefinition> {
    const irDocument = this.schemaRegistry.getIR(version);
    const entities = (irDocument as IRDocument).ir.entities;
    if (!entities || typeof entities !== "object") {
      throw new Error(`The IR model for S3000L version "${version}" does not contain ir.entities.`);
    }
    const definitions = new Map<string, EntityDefinition>();
    for (const [entityKey, irEntity] of Object.entries(entities)) {
      if (irEntity.abstract) continue;
      const definition = this.buildEntityDefinition(version, entityKey, irEntity, entities);
      this.registerDefinition(definitions, entityKey, definition);
      if (irEntity.name !== entityKey) {
        this.registerDefinition(definitions, irEntity.name, definition);
      }
    }
    return definitions;
  }

  private buildEntityDefinition(version: S3000LVersion, entityKey: string, irEntity: IREntity,
    allEntities: Record<string, IREntity>): EntityDefinition {
    const primaryKeys = irEntity.columns.filter((column) => column.isPrimaryKey);
    if (primaryKeys.length === 0) {
      throw new Error(`Entity "${entityKey}" does not have a primary key and cannot be exposed through the generic CRUD API.`);
    }
    if (primaryKeys.length > 1) {
      throw new Error(`Entity "${entityKey}" has a composite primary key. The current generic CRUD API supports only single-column primary keys.`);
    }
    const primaryKey = primaryKeys[0].columnName;
    const fieldColumns = Object.fromEntries(irEntity.columns.map((column) => [column.name, column.columnName]));
    const readableColumns = irEntity.columns.filter((column) => !HIDDEN_COLUMNS.has(column.columnName))
      .map((column) => column.columnName);
    const writableColumns = irEntity.columns.filter((column) => this.isWritableColumn(column));
    const filterableColumns = irEntity.columns.filter((column) => this.isFilterableColumn(column))
      .map((column) => column.columnName);
    const sortableColumns = irEntity.columns.filter((column) => this.isSortableColumn(column))
      .map((column) => column.columnName);
    const relations = this.buildRelations(irEntity, allEntities);
    const replacementColumns = irEntity.columns.filter((column) => this.isReplaceableColumn(column));
    const preparedEntitySchema = this.buildCompleteEntitySchema(replacementColumns);
    const isOrganization = entityKey === "organization" || irEntity.name === "organization";
    return {
      dialectVersion: version, name: entityKey, tableName: irEntity.tableName, primaryKey,
      readableColumns, fieldColumns, filterableColumns, sortableColumns,
      defaultSort: { column: primaryKey, direction: "asc" },
      createSchema: this.buildCreateSchema(writableColumns),
      updateSchema: this.buildUpdateSchema(writableColumns),
      replaceSchema: this.buildReplaceSchema(replacementColumns),
      preparedCreateSchema: preparedEntitySchema,
      preparedReplaceSchema: preparedEntitySchema,
      relations,
      summary: isOrganization ? getOrganizationSummary : undefined,
      identityPolicy: isOrganization && version === "1.1" ? organizationIdentityPolicyV11 : undefined,
    };
  }

  public static isColumnRequired(column: IRColumn) {
    return !column.nullable && column.minOccurs > 0 && column.defaultValue === null;
  }

  private buildCreateSchema(columns: IRColumn[]): z.ZodType<Record<string, unknown>> {
    const shape: z.ZodRawShape = {};
    for (const column of columns) {
      let schema = this.buildColumnSchema(column);
      const isRequired = EntityCrudRegistry.isColumnRequired(column);
      if (!isRequired) schema = schema.optional();
      shape[column.name] = schema;
    }
    return z.object(shape).strict();
  }

  private buildCompleteEntitySchema(businessColumns: readonly IRColumn[]): z.ZodType<Record<string, unknown>> {
    const shape: z.ZodRawShape = {};
    for (const column of businessColumns) {
      let schema = this.buildColumnSchema(column);
      if (!EntityCrudRegistry.isColumnRequired(column)) schema = schema.optional();
      shape[column.name] = schema;
    }
    shape.uid = z.string().min(1);
    shape.crud = z.enum(["I", "U", "R", "D", "N"]);
    return z.object(shape).strict();
  }

  private buildUpdateSchema(columns: IRColumn[]): z.ZodType<Record<string, unknown>> {
    const shape: z.ZodRawShape = {};
    for (const column of columns) shape[column.name] = this.buildColumnSchema(column).optional();
    return z.object(shape).strict().refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided",
    });
  }

  private buildColumnSchema(column: IRColumn): z.ZodTypeAny {
    let schema = this.buildNonNullableColumnSchema(column);
    if (column.nullable) schema = schema.nullable();
    return schema;
  }

  private buildNonNullableColumnSchema(column: IRColumn): z.ZodTypeAny {
    const enumValues = this.getEnumValues(column);
    if (enumValues.length > 0) return this.buildEnumSchema(enumValues);
    switch (column.jsonType) {
      case "integer": return z.number().int();
      case "number": return z.number();
      case "boolean": return z.preprocess((value) => {
        if (value === "true") return true;
        if (value === "false") return false;
        return value;
      }, z.boolean());
      case "array": return z.array(z.unknown());
      case "object": return this.buildObjectColumnSchema(column);
      case "string": default: return this.buildStringColumnSchema(column);
    }
  }

  private buildEnumSchema(values: string[]): z.ZodTypeAny {
    const allowedValues = new Set(values);
    return z.string().refine((value) => allowedValues.has(value), {
      message: `Expected one of: ${values.join(", ")}`,
    });
  }

  private buildStringColumnSchema(column: IRColumn): z.ZodTypeAny {
    let schema = z.string();
    const maxLength = this.readNumericConstraint(column.constraints.maxLength) ??
      this.extractSqlStringLength(column.sqlType);
    if (maxLength !== undefined) schema = schema.max(maxLength);
    const minLength = this.readNumericConstraint(column.constraints.minLength);
    if (minLength !== undefined) schema = schema.min(minLength);
    const pattern = column.constraints.pattern;
    if (typeof pattern === "string" && pattern.length > 0) {
      try { schema = schema.regex(new RegExp(pattern)); }
      catch (error) { logger.error({ err: error, entityField: column.name, pattern }, "Unsupported XSD regular expression"); }
    }
    return schema;
  }

  private buildObjectColumnSchema(column: IRColumn): z.ZodTypeAny {
    if (this.isTextSqlType(column.sqlType)) {
      return z.union([z.record(z.unknown()), z.array(z.unknown()), z.string()]);
    }
    return z.record(z.unknown());
  }

  private buildRelations(irEntity: IREntity, allEntities: Record<string, IREntity>): EntityRelationDefinition[] {
    const relations: EntityRelationDefinition[] = [];
    for (const column of irEntity.columns) {
      if (!column.isForeignKey || !column.referencesEntity) continue;
      const target = allEntities[column.referencesEntity];
      relations.push({ column: column.columnName, referencedEntity: column.referencesEntity,
        referencedColumn: this.findPrimaryKeyColumn(target) ?? "id", nullable: column.nullable,
        ownsForeignKey: true });
    }
    for (const relation of irEntity.relations ?? []) {
      relations.push({ column: relation.parentColumn, referencedEntity: relation.targetEntity,
        referencedColumn: this.findPrimaryKeyColumn(irEntity) ?? "id", nullable: relation.nullable,
        kind: relation.kind, fieldName: relation.fieldName, ownsForeignKey: false });
    }
    return relations;
  }

  private findPrimaryKeyColumn(entity: IREntity | undefined): string | undefined {
    return entity?.columns.find((column) => column.isPrimaryKey)?.columnName;
  }
  private isWritableColumn(column: IRColumn): boolean {
    if (column.isPrimaryKey) return false;
    if (DATABASE_MANAGED_COLUMNS.has(column.columnName)) return false;
    if (HIDDEN_COLUMNS.has(column.columnName)) return false;
    return true;
  }
  private isFilterableColumn(column: IRColumn): boolean {
    if (HIDDEN_COLUMNS.has(column.columnName)) return false;
    return typeof column.jsonType === "string" && !NON_SORTABLE_JSON_TYPES.has(column.jsonType);
  }
  private isSortableColumn(column: IRColumn): boolean { return this.isFilterableColumn(column); }
  private getEnumValues(column: IRColumn): string[] {
    if (!column.isEnum) return [];
    const enumConstraint = column.constraints.enum;
    if (!Array.isArray(enumConstraint)) return [];
    return enumConstraint.filter((value): value is string => typeof value === "string");
  }
  private extractSqlStringLength(sqlType: string): number | undefined {
    const match = sqlType.match(/^(?:VAR)?CHAR\s*\((\d+)\)$/i);
    if (!match) return undefined;
    return Number(match[1]);
  }
  private isTextSqlType(sqlType: string): boolean { return /TEXT|JSON/i.test(sqlType); }
  private readNumericConstraint(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }
  private buildReplaceSchema(columns: IRColumn[]): z.ZodType<Record<string, unknown>> {
    const shape: z.ZodRawShape = {};
    for (const column of columns) {
      let schema = this.buildColumnSchema(column);
      if (!EntityCrudRegistry.isColumnRequired(column)) schema = schema.optional();
      shape[column.name] = schema;
    }
    return z.object(shape).strict();
  }
  private isReplaceableColumn(column: IRColumn): boolean {
    if (column.isPrimaryKey) return false;
    if (ROOT_MANAGED_COLUMNS.has(column.columnName)) return false;
    if (HIDDEN_COLUMNS.has(column.columnName)) return false;
    return true;
  }
}
