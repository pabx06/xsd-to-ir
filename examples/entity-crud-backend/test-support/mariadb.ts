import { randomUUID } from "node:crypto";
import knexFactory, { type Knex } from "knex";
import express from "express";
import { ir, registry } from "./fixtures";
import { generateSQL, type Value } from "../src/xsd-runtime";
import { migrateEntityCrud } from "../src/migrations";
import { initializeProjectHistory } from "../src/identity-lifecycle";
import { createEntityCrudRouter } from "../src/entity-crud.routes";
import {
  EntityCrudService,
  type CrudServiceOptions,
} from "../src/entity-crud.service";
import type { CrudContext } from "../src/entity-crud.types";

export async function database() {
  const socketPath = process.env.ENTITY_CRUD_TEST_SOCKET;
  const url = process.env.ENTITY_CRUD_TEST_URL
    ? new URL(process.env.ENTITY_CRUD_TEST_URL)
    : undefined;
  if (!socketPath && !url)
    throw new Error(
      "Set ENTITY_CRUD_TEST_SOCKET or ENTITY_CRUD_TEST_URL for an isolated MariaDB server. The test user needs CREATE/DROP DATABASE permission.",
    );
  const connection = {
    ...(socketPath
      ? { socketPath }
      : { host: url!.hostname, port: Number(url!.port || 3306) }),
    user: url ? decodeURIComponent(url.username) : "root",
    password: url ? decodeURIComponent(url.password) : "",
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: "Z",
  };
  const name = "xsd_crud_test_" + randomUUID().replaceAll("-", "");
  const admin = knexFactory({
    client: "mysql2",
    connection,
    pool: { min: 0, max: 1 },
  });
  await admin.raw("CREATE DATABASE ??", [name]);
  const setup = knexFactory({
    client: "mysql2",
    connection: { ...connection, database: name, multipleStatements: true },
    pool: { min: 0, max: 1 },
  });
  try {
    await setup.raw(generateSQL(ir));
    await migrateEntityCrud(setup);
  } catch (error) {
    await setup.destroy();
    await admin.raw("DROP DATABASE ??", [name]);
    await admin.destroy();
    throw error;
  }
  await setup.destroy();
  const knex = knexFactory({
    client: "mysql2",
    connection: { ...connection, database: name },
    pool: { min: 0, max: 4 },
  });
  const tables = [
    ...new Set([...ir.entities.values()].map((entity) => entity.tableName)),
  ];
  const seed = async (entityName: string, value: Value, extra: Value = {}) => {
    const entity = registry.getEntityDefinition("1.1", entityName);
    const [id] = await knex(entity.tableName).insert({
      ...entity.createAdapter().encodeRow(entityName, value),
      _msg_seq: 7,
      _created_at: "2026-11-01 12:00:00.000",
      _updated_at: "2026-11-01 12:00:00.000",
      ...extra,
    });
    return String(id);
  };
  return {
    knex,
    name,
    seed,
    async reset() {
      await knex.transaction(async (trx) => {
        await trx.raw("SET FOREIGN_KEY_CHECKS = 0");
        try {
          for (const table of [
            ...tables,
            "_entity_identity_history",
            "_entity_uid_sequence",
            "_entity_nested_deletion",
            "_entity_change_log",
          ])
            await trx(table).delete();
          await trx("_entity_crud_state")
            .where({ id: 1 })
            .update({ history_ready: false });
        } finally {
          await trx.raw("SET FOREIGN_KEY_CHECKS = 1");
        }
      });
      const docId = await seed("externalDocument", {
        uid: "doc1",
        crud: "R",
        docId: [{ id: "MANUAL-001" }],
        docTitle: { descr: "Service manual" },
      });
      await seed(
        "externalDocumentIssue",
        { uid: "dociss1", crud: "R", docIssId: { id: "A" } },
        { external_document_doc_iss_parent_id: docId },
      );
      await seed("applicabilityStatement", {
        uid: "applst1",
        crud: "R",
        applicId: { id: "BASE" },
        applicDescr: { descr: "Baseline applicability" },
      });
      await initializeProjectHistory(knex, registry, "1.1", () => true);
    },
    context(entityName = "organization"): CrudContext {
      return {
        actor: { id: "editor" },
        projectId: "p1",
        databaseName: name,
        entity: registry.getEntityDefinition("1.1", entityName),
        knex,
      };
    },
    app(options: CrudServiceOptions = {}) {
      const app = express();
      const errors: unknown[] = [];
      const service = new EntityCrudService(registry, options);
      app.use(express.json({ limit: "1mb" }));
      app.use(
        "/api/projects/:projectId/entities",
        createEntityCrudRouter({
          registry,
          service,
          projectRepository: {
            findById: async (id) =>
              id === "p1"
                ? { id, status: "ready", databaseName: name, dialect: "1.1" }
                : undefined,
          },
          getProjectDatabase: () => knex,
          // Test-only trusted-principal simulator. Production must use authenticated session state.
          getActor: (request) =>
            ["editor", "reader"].includes(
              String(request.headers["x-test-role"]),
            )
              ? { id: String(request.headers["x-test-role"]) }
              : undefined,
          authorize: (input) =>
            input.actor.id === "editor" ||
            ["list", "read"].includes(input.operation),
          onError: (error) => errors.push(error),
        }),
      );
      return { app, errors, service };
    },
    async close() {
      await knex.destroy();
      await admin.raw("DROP DATABASE ??", [name]);
      await admin.destroy();
    },
  };
}
