import type { Knex } from "knex";
import type { z } from "zod";
import type { EntityMetadata } from "./entity-metadata";
import type { Adapter, IR, Value } from "./xsd-runtime";
export type CrudOperation = "list" | "read" | "create" | "update" | "delete";
export type CrudMarker = "I" | "U" | "R" | "D" | "N";
export interface CrudActor {
  id: string;
}
export interface EntitySummaryResult {
  schemaIssue: string;
  total: number;
  pending: number;
  documents: number;
  deleted: number;
}
export type EntitySummaryImplementation = (
  knex: Knex,
  entity: EntityDefinition,
) => Promise<EntitySummaryResult>;
export interface EntityDefinition {
  dialectVersion: string;
  name: string;
  tableName: string;
  primaryKey: string;
  readableColumns: string[];
  fieldColumns: Record<string, string>;
  filterableColumns: string[];
  sortableColumns: string[];
  createSchema: z.ZodType<Value>;
  updateSchema: z.ZodType<Value>;
  replaceSchema: z.ZodType<Value>;
  preparedCreateSchema: z.ZodType<Value>;
  preparedReplaceSchema: z.ZodType<Value>;
  metadata: EntityMetadata;
  ir: IR;
  createAdapter(): Adapter;
  summary?: EntitySummaryImplementation;
  validationWarnings(): readonly string[];
}
export interface CrudContext {
  actor: CrudActor;
  projectId: string;
  databaseName: string;
  entity: EntityDefinition;
  knex: Knex;
}
export interface CrudAuthorizationRequest {
  actor: CrudActor;
  projectId: string;
  databaseName: string;
  entity: string;
  operation: CrudOperation;
  recordId?: string;
}
export type Authorizer = (
  request: CrudAuthorizationRequest,
) => boolean | Promise<boolean>;
export interface ListEntitiesInput {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDirection: "asc" | "desc";
  filters: Record<string, string | number | boolean>;
}
export interface EntityRecordResult {
  id: string | number;
  uid: string;
  crud: CrudMarker;
  pendingExport: boolean;
  _createdAt: string;
  _updatedAt: string;
  _deletedAt: string | null;
  value: Value;
}
export interface ListResult {
  data: EntityRecordResult[];
  metadata: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}
/** The host owns schema loading/caching and chooses the issue from the project, never from request data. */
export interface SchemaProvider {
  getIRRAW(issue: string): unknown;
}
