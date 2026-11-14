import type { Knex } from "knex";
import type { EntityDefinition, CrudMarker } from "./entity-crud.types";
import type { Value } from "./xsd-runtime";
export interface IdentityOwner {
  uid: string;
  entity_name: string;
  root_uid: string;
  identity_type: string;
  established: number | boolean;
  active: number | boolean;
}
export interface IdentityInput {
  entityName: string;
  rootUid: string;
  identityType: string;
  uid: string;
}
export interface EntityIdentityHistory {
  findOwner(
    trx: Knex.Transaction,
    uid: string,
  ): Promise<IdentityOwner | undefined>;
  register(
    trx: Knex.Transaction,
    input: IdentityInput,
    established: boolean,
    active?: boolean,
  ): Promise<void>;
  isEstablished(trx: Knex.Transaction, input: IdentityInput): Promise<boolean>;
  recordNestedDeletion(
    trx: Knex.Transaction,
    input: IdentityInput & { path: string; previousValue: Value },
  ): Promise<void>;
}
export interface EntityUidAllocator {
  allocate(
    trx: Knex.Transaction,
    entity: EntityDefinition,
    type: string,
  ): Promise<string>;
}
export interface PrepareCreateInput {
  trx: Knex.Transaction;
  entity: EntityDefinition;
  submittedValue: Value;
}
export interface PrepareReplacementInput extends PrepareCreateInput {
  previousValue: Value;
}
export interface PreparedTrackedValue {
  value: Value;
  rootCrud: CrudMarker;
  changed: boolean;
}
