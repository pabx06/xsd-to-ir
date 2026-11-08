import type { Knex } from "knex";
import { EntityCrudRegistry } from "./entity-crud.registry";
import type { EntityDefinition } from "./entity-crud.types";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import { CrudError } from "./entity-crud.errors";
import { pointer, type Value } from "./xsd-runtime";
import { StoredIdentities } from "./stored-identities";

/** Host must answer from authoritative import/export history, not from the current CRUD marker. */
export type EstablishmentResolver = (input: {
  entity: EntityDefinition;
  row: Value;
  type: string;
  uid: string;
  path: string;
}) => boolean | Promise<boolean>;
export async function recordImportedRow(
  trx: Knex.Transaction,
  entity: EntityDefinition,
  row: Value,
  established: EstablishmentResolver,
  history = new MariaDbEntityIdentityHistory(),
): Promise<void> {
  const value = entity.createAdapter().decodeRow(entity.name, row).value;
  const seen = new Set<string>();
  for (const node of new StoredIdentities(entity, row, value).items) {
    const uid = node.uid;
    if (seen.has(uid))
      throw new CrudError(
        "duplicate_uid",
        `Duplicate imported UID "${uid}".`,
        409,
      );
    seen.add(uid);
    await history.register(
      trx,
      {
        entityName: entity.name,
        rootUid: String(value.uid),
        identityType: node.type,
        uid,
      },
      await established({
        entity,
        row,
        type: node.type,
        uid,
        path: pointer(node.path),
      }),
      row._deleted_at === null,
    );
  }
}
export async function initializeProjectHistory(
  knex: Knex,
  registry: EntityCrudRegistry,
  issue: string,
  established: EstablishmentResolver,
): Promise<void> {
  const history = new MariaDbEntityIdentityHistory();
  await knex.transaction(async (trx) => {
    await history.lock(trx, false);
    // Include deleted rows: their XML UIDs must never be reallocated.
    for (const entity of registry.getEntityDefinitions(issue)) {
      const rows: Value[] = await trx(entity.tableName).select(
        entity.readableColumns,
      );
      for (const row of rows)
        await recordImportedRow(trx, entity, row, established, history);
    }
    await trx("_entity_crud_state")
      .where({ id: 1 })
      .update({ history_ready: true });
  });
}
/** Call after successful export while holding the project lock and the exact export snapshot stable. */
export async function acknowledgeExport(
  trx: Knex.Transaction,
  registry: EntityCrudRegistry,
  issue: string,
  records: readonly { entityName: string; id: string | number }[],
  sequence: string,
): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(sequence))
    throw new Error(
      "Export sequence must be a positive integer string allocated by the host.",
    );
  const history = new MariaDbEntityIdentityHistory();
  await history.lock(trx);
  for (const record of records) {
    const entity = registry.getEntityDefinition(issue, record.entityName);
    const row = await trx(entity.tableName)
      .where(entity.primaryKey, record.id)
      .first();
    if (!row) throw new Error("Exported row is missing.");
    await trx("_entity_identity_history")
      .where({ entity_name: entity.name, root_uid: row.uid })
      .update({ established: true });
    for (const table of ["_entity_nested_deletion", "_entity_change_log"]) {
      await trx(table)
        .where({ entity_name: entity.name, root_uid: row.uid })
        .whereNull("export_sequence")
        .update({ export_sequence: sequence });
    }
    await trx(entity.tableName)
      .where(entity.primaryKey, record.id)
      .update({ _msg_seq: sequence, _updated_at: row._updated_at });
  }
}
