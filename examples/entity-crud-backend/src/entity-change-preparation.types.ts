import type { Knex } from "knex";
import type { CrudContext, EntityDefinition } from "./entity-crud.types";

export type NestedCrudMarker = "I" | "U" | "R" | "D" | "N";

export interface IdentityBearingValue extends Record<string, unknown> {
  uid?: string;
  crud?: NestedCrudMarker;
}

export interface IdentityPathDefinition {
  identityType: string;
  path: readonly string[];
  uid: { prefix: string; maxLength: number; pattern: RegExp };
}

export interface EntityIdentityPolicy {
  root: {
    identityType: string;
    uid: { prefix: string; maxLength: number; pattern: RegExp };
  };
  nested: readonly IdentityPathDefinition[];
}

export interface EntityIdentityHistory {
  isEstablished(
    trx: Knex.Transaction,
    input: { projectId: string; entityName: string; identityType: string; uid: string },
  ): Promise<boolean>;
  findOwner(
    trx: Knex.Transaction,
    input: { projectId: string; entityName: string; identityType: string; uid: string },
  ): Promise<{ rootUid: string; identityType: string } | undefined>;
  recordNestedDeletion(
    trx: Knex.Transaction,
    input: {
      projectId: string;
      entityName: string;
      entityId: string;
      rootUid: string;
      identityType: string;
      uid: string;
      path: readonly string[];
      previousValue: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface EntityUidAllocator {
  allocate(
    trx: Knex.Transaction,
    input: {
      projectId: string;
      schemaIssue: string;
      entityName: string;
      identityType: string;
      prefix: string;
      maxLength: number;
      pattern: RegExp;
    },
  ): Promise<string>;
}

export interface PrepareCreateInput {
  trx: Knex.Transaction;
  context: CrudContext;
  entity: EntityDefinition;
  submittedValue: Record<string, unknown>;
  policy: EntityIdentityPolicy;
}

export interface PrepareReplacementInput extends PrepareCreateInput {
  entityId: string;
  rootUid: string;
  previousValue: Record<string, unknown>;
}

export interface PreparedTrackedValue {
  value: Record<string, unknown>;
  rootCrud: "I" | "U";
  changed: boolean;
}
