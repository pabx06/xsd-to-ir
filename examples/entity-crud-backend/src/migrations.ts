import type { Knex } from "knex";
/** Run once through the host migration runner for every project database, before enabling writes. */
export async function migrateEntityCrud(
  knex: Knex,
  priorExportSequence = "0",
): Promise<void> {
  if (
    !/^(0|[1-9][0-9]*)$/.test(priorExportSequence) ||
    BigInt(priorExportSequence) > 9223372036854775807n
  )
    throw new Error("Invalid previous export sequence.");
  if (!(await knex.schema.hasTable("_entity_crud_state"))) {
    await knex.schema.createTable("_entity_crud_state", (table) => {
      table.integer("id").primary();
      table.boolean("history_ready").notNullable().defaultTo(false);
    });
  }
  await knex("_entity_crud_state")
    .insert({ id: 1, history_ready: false })
    .onConflict("id")
    .ignore();
  if (!(await knex.schema.hasTable("_entity_identity_history")))
    await knex.schema.createTable("_entity_identity_history", (table) => {
      table
        .specificType(
          "uid",
          "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
        )
        .primary();
      table.string("entity_name", 255).notNullable();
      table.string("identity_type", 512).notNullable();
      table
        .specificType(
          "root_uid",
          "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
        )
        .notNullable()
        .index();
      table.boolean("established").notNullable();
      table.boolean("active").notNullable().defaultTo(true);
    });
  if (!(await knex.schema.hasTable("_entity_uid_sequence")))
    await knex.schema.createTable("_entity_uid_sequence", (table) => {
      table.string("prefix", 128).primary();
      table.bigInteger("next_value").unsigned().notNullable();
    });
  if (!(await knex.schema.hasTable("_entity_nested_deletion")))
    await knex.schema.createTable("_entity_nested_deletion", (table) => {
      table.bigIncrements("id");
      table.string("entity_name", 255).notNullable();
      table.string("root_uid", 255).notNullable().index();
      table.string("identity_type", 512).notNullable();
      table.string("uid", 255).notNullable();
      table.text("path").notNullable();
      table.text("previous_value", "longtext").notNullable();
      table.bigInteger("export_sequence").nullable();
    });
  if (!(await knex.schema.hasTable("_entity_change_log")))
    await knex.schema.createTable("_entity_change_log", (table) => {
      table.bigIncrements("id");
      table.string("entity_name", 255).notNullable();
      table.string("entity_id", 255).notNullable();
      table.string("root_uid", 255).notNullable().index();
      table.string("operation", 32).notNullable();
      table.text("previous_row", "longtext").nullable();
      table.text("next_row", "longtext").nullable();
      table.bigInteger("export_sequence").nullable();
      table.timestamp("created_at", { precision: 3 }).defaultTo(knex.fn.now(3));
    });
  if (!(await knex.schema.hasTable("_entity_xml_export")))
    await knex.schema.createTable("_entity_xml_export", (table) => {
      table
        .specificType(
          "file_name",
          "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
        )
        .primary();
      table.bigInteger("sequence").notNullable().unique();
      table.string("sha256", 64).notNullable();
    });
  if (
    !(await knex.schema.hasColumn(
      "_entity_crud_state",
      "last_exported_sequence",
    ))
  )
    await knex.schema.alterTable("_entity_crud_state", (table) => {
      // NULL makes interrupted initialization retryable after MariaDB's implicit DDL commit.
      table.bigInteger("last_exported_sequence").nullable();
    });
  await knex.transaction(async (trx) => {
    const state = await trx("_entity_crud_state")
      .where({ id: 1 })
      .forUpdate()
      .first();
    let high = BigInt(priorExportSequence);
    if (state.last_exported_sequence === null) {
      const columns = await trx("information_schema.COLUMNS")
        .select({ name: "TABLE_NAME" })
        .whereRaw("TABLE_SCHEMA = DATABASE()")
        .where("COLUMN_NAME", "_msg_seq");
      const sources = [
        ...columns.map(({ name }) => [name, "_msg_seq"]),
        ["_entity_change_log", "export_sequence"],
        ["_entity_nested_deletion", "export_sequence"],
        ["_entity_xml_export", "sequence"],
      ];
      for (const [table, column] of sources) {
        const result = await trx(table)
          .select(trx.raw("CAST(MAX(??) AS CHAR) AS high", [column]))
          .first();
        const recorded = BigInt(result.high ?? 0);
        if (recorded > high) high = recorded;
      }
    }
    await trx("_entity_crud_state")
      .where({ id: 1 })
      .update({
        last_exported_sequence: trx.raw(
          "GREATEST(COALESCE(last_exported_sequence, 0), CAST(? AS SIGNED))",
          [high.toString()],
        ),
      });
  });
}
