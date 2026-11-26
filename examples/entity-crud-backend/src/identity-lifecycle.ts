import type { Knex } from "knex";
import { EntityCrudRegistry } from "./entity-crud.registry";
import type { EntityDefinition } from "./entity-crud.types";
import type { EntityIdentityHistory } from "./entity-change-preparation.types";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import { CrudError, CrudValidationError } from "./entity-crud.errors";
import { pointer, type Value, type ExportedRecord } from "./xsd-runtime";
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

export interface ReconcileImportedRemovalsInput {
  trx: Knex.Transaction;
  entity: EntityDefinition;
  /** Full SQL row before the import's first write, or null for an inserted row. */
  before: Value | null;
  /** Full SQL row after all import writes and relation resolution. */
  after: Value;
  history?: EntityIdentityHistory;
}

/** Queue imported removals for export, under the project lock and before recordImportedRow. */
export async function reconcileImportedRemovals({
  trx,
  entity,
  before,
  after,
  history = new MariaDbEntityIdentityHistory(),
}: ReconcileImportedRemovalsInput): Promise<void> {
  if (!before) return;
  if (typeof before.uid !== "string" || before.uid !== after.uid)
    throw new CrudValidationError([
      { path: "/uid", message: "An import must preserve the stored root UID." },
    ]);
  if (before._deleted_at !== null) return;
  const rootUid = before.uid;

  const adapter = entity.createAdapter();
  const previous = new StoredIdentities(
    entity,
    before,
    adapter.decodeRow(entity.name, before).value,
  );
  const retained = new Set(
    after._deleted_at === null
      ? new StoredIdentities(
          entity,
          after,
          adapter.decodeRow(entity.name, after).value,
        ).items.map((node) => node.uid)
      : [],
  );
  const removals = previous.items
    .filter((node) => !retained.has(node.uid))
    .map((node) => ({
      entityName: entity.name,
      rootUid,
      identityType: node.type,
      uid: node.uid,
      path: pointer(node.path),
      previousValue: node.raw,
    }));

  // Validate every removed identity's ownership before writing any tombstones.
  for (const removal of removals) await history.isEstablished(trx, removal);
  for (const removal of removals)
    await history.recordNestedDeletion(trx, removal);
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
/** Reserve a sequence in the caller's project transaction. Rollback returns the number. */
export async function allocateExportSequence(
  trx: Knex.Transaction,
): Promise<string> {
  const updated = await trx("_entity_crud_state")
    .where({ id: 1, history_ready: true })
    .whereNotNull("last_exported_sequence")
    .increment("last_exported_sequence", 1);
  if (updated !== 1)
    throw new Error("Migrate and initialize the project before exporting.");
  const state = await trx("_entity_crud_state")
    .where({ id: 1 })
    .select(trx.raw("CAST(last_exported_sequence AS CHAR) AS sequence"))
    .first();
  return state.sequence;
}

/** The default acknowledges a host export that included the roots' pending removals. */
export async function acknowledgeExport(
  trx: Knex.Transaction,
  registry: EntityCrudRegistry,
  issue: string,
  records: readonly ExportedRecord[],
  sequence: string,
  mode: "includingRemovals" | "baseline" = "includingRemovals",
): Promise<void> {
  if (
    !/^[1-9][0-9]*$/.test(sequence) ||
    BigInt(sequence) > 9223372036854775807n
  )
    throw new Error(
      "Export sequence must be a positive integer string allocated by the host.",
    );
  const history = new MariaDbEntityIdentityHistory();
  await history.lock(trx);
  // Older host integrations can still supply their own sequence.
  await trx("_entity_crud_state")
    .where({ id: 1 })
    .update({
      last_exported_sequence: trx.raw(
        "GREATEST(last_exported_sequence, CAST(? AS SIGNED))",
        [sequence],
      ),
    });
  for (const record of records) {
    const entity = registry.getEntityDefinition(issue, record.entityName);
    const row = await trx(entity.tableName)
      .where(entity.primaryKey, record.id)
      .first();
    if (!row) throw new Error("Exported row is missing.");
    const owner = { entity_name: entity.name, root_uid: row.uid };
    const identities = trx("_entity_identity_history").where(owner);
    if (mode === "baseline") {
      if (row._deleted_at != null)
        throw new Error("A baseline cannot acknowledge a deleted row.");
      identities.where({ active: true });
      if (record.omittedDeletionUids?.length)
        identities.whereNotIn("uid", record.omittedDeletionUids);
    }
    await identities.update({ established: true });
    const pendingRemovals = () =>
      trx("_entity_nested_deletion").where(owner).whereNull("export_sequence");
    if (
      mode === "baseline" &&
      (record.omittedDeletionUids || (await pendingRemovals().first("id")))
    ) {
      // A baseline contains active values only. Keep this root and its logs discoverable for a delta.
      await trx(entity.tableName)
        .where(entity.primaryKey, record.id)
        .update({ _msg_seq: 0, _updated_at: row._updated_at });
      continue;
    }
    if (mode === "includingRemovals")
      await pendingRemovals().update({ export_sequence: sequence });
    await trx("_entity_change_log")
      .where(owner)
      .whereNull("export_sequence")
      .update({ export_sequence: sequence });
    await trx(entity.tableName)
      .where(entity.primaryKey, record.id)
      .update({ _msg_seq: sequence, _updated_at: row._updated_at });
  }
}
