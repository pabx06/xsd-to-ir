import type { Knex } from "knex";
import type { EntityIdentityHistory } from "./entity-change-preparation.types";
interface IdentityHistoryRow {
  id: string | number; entity_name: string; identity_type: string; uid: string; root_uid: string;
  established: number | boolean | string;
}
interface NestedDeletionRow {
  entity_name: string; root_uid: string; identity_type: string; uid: string; path: string;
  previous_value: string; exported: boolean;
}
export class MariaDbEntityIdentityHistory implements EntityIdentityHistory {
  public async isEstablished(trx: Knex.Transaction, input: { projectId: string; entityName: string; identityType: string; uid: string }): Promise<boolean> {
    const row = await trx<IdentityHistoryRow>("_entity_identity_history").select("established")
      .where("entity_name", input.entityName).where("identity_type", input.identityType)
      .where("uid", input.uid).first();
    if (!row) return false;
    return row.established === true || row.established === 1 || row.established === "1";
  }
  public async findOwner(trx: Knex.Transaction, input: { projectId: string; entityName: string; identityType: string; uid: string }): Promise<{ rootUid: string; identityType: string } | undefined> {
    const row = await trx<IdentityHistoryRow>("_entity_identity_history").select(["root_uid", "identity_type"])
      .where("entity_name", input.entityName).where("uid", input.uid).first();
    if (!row) return undefined;
    return { rootUid: row.root_uid, identityType: row.identity_type };
  }
  public async recordNestedDeletion(trx: Knex.Transaction, input: {
    projectId: string; entityName: string; entityId: string; rootUid: string;
    identityType: string; uid: string; path: readonly string[]; previousValue: Record<string, unknown>;
  }): Promise<void> {
    const row: NestedDeletionRow = {
      entity_name: input.entityName, entity_id: input.entityId, root_uid: input.rootUid,
      identity_type: input.identityType, uid: input.uid, path: JSON.stringify(input.path),
      previous_value: JSON.stringify(input.previousValue), exported: false,
    } as NestedDeletionRow;
    await trx<NestedDeletionRow>("_entity_nested_deletion").insert(row)
      .onConflict(["entity_name", "root_uid", "identity_type", "uid", "exported"]).ignore();
  }
}
