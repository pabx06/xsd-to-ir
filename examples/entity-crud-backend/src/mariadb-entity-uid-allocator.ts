import type { Knex } from "knex";
import type { EntityUidAllocator } from "./entity-change-preparation.types";
interface SequenceRow { identity_type: string; next_value: string | number; }
export class MariaDbEntityUidAllocator implements EntityUidAllocator {
  public async allocate(trx: Knex.Transaction, input: {
    projectId: string; schemaIssue: string; entityName: string; identityType: string;
    prefix: string; maxLength: number; pattern: RegExp;
  }): Promise<string> {
    const sequenceKey = [input.schemaIssue, input.identityType].join(":");
    await trx("_entity_uid_sequence").insert({ identity_type: sequenceKey, next_value: 1 })
      .onConflict("identity_type").ignore();
    const row = await trx<SequenceRow>("_entity_uid_sequence").where("identity_type", sequenceKey).forUpdate().first();
    if (!row) throw new Error(`Unable to lock UID sequence "${sequenceKey}"`);
    const nextValue = BigInt(row.next_value);
    const uid = `${input.prefix}${nextValue.toString()}`;
    if (uid.length > input.maxLength || !input.pattern.test(uid)) {
      throw new Error(`Generated UID "${uid}" does not satisfy the ${input.identityType} constraints`);
    }
    await trx("_entity_uid_sequence").where("identity_type", sequenceKey)
      .update({ next_value: (nextValue + 1n).toString(), _updated_at: trx.fn.now() });
    return uid;
  }
}
