import type { Knex } from "knex";
/** Run once through the host migration runner for every project database, before enabling writes. */
export async function migrateEntityCrud(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("_entity_crud_state"))) {
    await knex.schema.createTable("_entity_crud_state", (table) => {
      table.integer("id").primary();
      table.boolean("history_ready").notNullable().defaultTo(false);
    });
    await knex("_entity_crud_state").insert({ id: 1, history_ready: false });
  }
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
}
