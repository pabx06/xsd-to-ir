import { S3000LVersion } from "@sliwave/xsd-to-ir";
import type { Knex } from "knex";
import type { z } from "zod";
import type { EntityIdentityPolicy } from "./entity-change-preparation.types";
export type CrudOperation = "list" | "read" | "create" | "update" | "delete";
export interface CrudActor { id: string; }
export interface EntitySummaryResult {
  schemaIssue: S3000LVersion; total: number; pending: number; documents: number; deleted: number;
}
export type EntitySummaryImplementation = (knex: Knex, entity: EntityDefinition) => Promise<EntitySummaryResult>;
export interface EntityRelationDefinition {
  column: string; referencedEntity: string; referencedColumn: string; displayColumn?: string;
  nullable?: boolean; onDelete?: "restrict" | "cascade" | "set-null"; kind?: string;
  fieldName?: string; ownsForeignKey: boolean;
}
export interface EntityDefinition<
  TCreate extends Record<string, unknown> = Record<string, unknown>,
  TUpdate extends Record<string, unknown> = Record<string, unknown>,
  TReplace extends Record<string, unknown> = Record<string, unknown>,
> {
  dialectVersion: S3000LVersion; name: string; tableName: string; primaryKey: string;
  readableColumns: readonly string[]; fieldColumns: Readonly<Record<string, string>>;
  filterableColumns: readonly string[]; sortableColumns: readonly string[];
  defaultSort?: { column: string; direction: "asc" | "desc" };
  createSchema: z.ZodType<TCreate>; updateSchema: z.ZodType<TUpdate>; replaceSchema: z.ZodType<TReplace>;
  preparedCreateSchema: z.ZodType<Record<string, unknown>>;
  preparedReplaceSchema: z.ZodType<Record<string, unknown>>;
  relations?: readonly EntityRelationDefinition[]; summary?: EntitySummaryImplementation;
  beforeCreate?: (data: TCreate, context: CrudContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  beforeUpdate?: (entityValue: Record<string, unknown>, context: CrudContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  beforeReplace?: (replacement: TReplace, previousValue: Readonly<Record<string, unknown>>, context: CrudContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  identityPolicy?: EntityIdentityPolicy;
}
export interface CrudContext { actor: CrudActor; projectId: string; databaseName: string; entity: EntityDefinition; knex: Knex; }
export interface CrudAuthorizationRequest {
  actor: CrudActor; projectId: string; databaseName: string; entity: string; operation: CrudOperation; recordId?: string;
}
export interface ListEntitiesInput {
  page: number; pageSize: number; sortBy?: string; sortDirection: "asc" | "desc";
  filters: Record<string, string | number | boolean>;
}
