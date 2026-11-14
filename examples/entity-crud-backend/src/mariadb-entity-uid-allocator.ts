import type { Knex } from "knex";
import type { EntityUidAllocator } from "./entity-change-preparation.types";
import type { EntityDefinition } from "./entity-crud.types";
export class MariaDbEntityUidAllocator implements EntityUidAllocator {
  async allocate(
    trx: Knex.Transaction,
    entity: EntityDefinition,
    type: string,
  ): Promise<string> {
    const rule = entity.metadata.uidRule(type);
    // Types that share an XML prefix share the same allocation space.
    await trx("_entity_uid_sequence")
      .insert({ prefix: rule.prefix, next_value: "1" })
      .onConflict("prefix")
      .ignore();
    const row = await trx("_entity_uid_sequence")
      .where({ prefix: rule.prefix })
      .forUpdate()
      .first();
    let next = BigInt(row.next_value);
    for (;;) {
      const uid = `${rule.prefix}${next++}`;
      if (
        uid.length > rule.maxLength ||
        !rule.patterns.every((pattern) => pattern.test(uid))
      )
        throw new Error(`UID space exhausted for ${type}.`);
      if (await trx("_entity_identity_history").where({ uid }).first())
        continue;
      await trx("_entity_uid_sequence")
        .where({ prefix: rule.prefix })
        .update({ next_value: next.toString() });
      return uid;
    }
  }
}
