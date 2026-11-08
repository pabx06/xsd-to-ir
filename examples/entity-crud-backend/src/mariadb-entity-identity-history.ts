import type { Knex } from "knex";
import { CrudError } from "./entity-crud.errors";
import type {
  EntityIdentityHistory,
  IdentityInput,
  IdentityOwner,
} from "./entity-change-preparation.types";
import type { Value } from "./xsd-runtime";
export class MariaDbEntityIdentityHistory implements EntityIdentityHistory {
  async findOwner(
    trx: Knex.Transaction,
    uid: string,
  ): Promise<IdentityOwner | undefined> {
    return trx<IdentityOwner>("_entity_identity_history")
      .where({ uid })
      .first();
  }
  async isEstablished(
    trx: Knex.Transaction,
    input: IdentityInput,
  ): Promise<boolean> {
    const row = await this.findOwner(trx, input.uid);
    if (
      !row ||
      row.root_uid !== input.rootUid ||
      row.entity_name !== input.entityName ||
      row.identity_type !== input.identityType
    ) {
      throw new CrudError(
        "identity_history_missing",
        `Identity history must be populated for "${input.uid}" before editing.`,
        409,
      );
    }
    return Boolean(row.established);
  }
  async register(
    trx: Knex.Transaction,
    input: IdentityInput,
    established: boolean,
    active = true,
  ): Promise<void> {
    const owner = await this.findOwner(trx, input.uid);
    if (
      owner &&
      (owner.root_uid !== input.rootUid ||
        owner.entity_name !== input.entityName ||
        owner.identity_type !== input.identityType)
    ) {
      throw new CrudError(
        "duplicate_uid",
        `UID "${input.uid}" is already owned by another value.`,
        409,
      );
    }
    const row = {
      uid: input.uid,
      entity_name: input.entityName,
      root_uid: input.rootUid,
      identity_type: input.identityType,
      established: Boolean(owner?.established) || established,
      active,
    };
    if (owner)
      await trx("_entity_identity_history")
        .where({ uid: input.uid })
        .update(row);
    else await trx("_entity_identity_history").insert(row);
  }
  async recordNestedDeletion(
    trx: Knex.Transaction,
    input: IdentityInput & { path: string; previousValue: Value },
  ): Promise<void> {
    await trx("_entity_nested_deletion").insert({
      entity_name: input.entityName,
      root_uid: input.rootUid,
      identity_type: input.identityType,
      uid: input.uid,
      path: input.path,
      previous_value: JSON.stringify(input.previousValue),
    });
    await trx("_entity_identity_history")
      .where({ uid: input.uid })
      .update({ active: false });
  }
  /** Serialize project writes and reference checks. Import/export integrations must take this lock too. */
  async lock(trx: Knex.Transaction, requireReady = true): Promise<void> {
    const state = await trx("_entity_crud_state")
      .where({ id: 1 })
      .forUpdate()
      .first();
    if (!state || (requireReady && !state.history_ready))
      throw new CrudError(
        "identity_history_not_ready",
        "Initialize project identity history before enabling writes.",
        409,
      );
  }
}
