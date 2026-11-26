import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { database } from "../test-support/mariadb";
import { registry, ir } from "../test-support/fixtures";
import { createXmlFilesDumpRouter, dumpProjectXml } from "./xml-files-dump";
import { migrateEntityCrud } from "./migrations";
import { allocateExportSequence } from "./identity-lifecycle";
const { DBAdapter, deserializeXML } = require("xsd-to-ir");

let db: Awaited<ReturnType<typeof database>>;
let directory: string;
beforeAll(async () => {
  db = await database();
}, 60000);
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "xsd-xml-dump-"));
  await db.reset();
}, 30000);
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});
const options = (fileName: string) => ({
  directory,
  fileName,
  projectId: "p1",
  issue: "1.1",
  registry,
  projectDb: db.knex,
});
const counter = async () =>
  String(
    (await db.knex("_entity_crud_state").where({ id: 1 }).first())
      .last_exported_sequence,
  );
function app() {
  const api = express();
  api.use(express.json());
  api.use(
    createXmlFilesDumpRouter({
      directory,
      registry,
      resolveProject: async (_req, projectId) => ({
        projectDb: db.knex,
        issue: "1.1",
        projectId,
      }),
    }),
  );
  return api;
}

it("publishes an XSD-valid restorable baseline, acknowledges children, and preserves pending removals", async () => {
  const ctx = db.context();
  const { service } = db.app();
  const created = await service.create(ctx, {
    orgId: [{ id: "000123" }],
    rmks: { rmk: [{ text: { descr: "First" } }] },
  });
  const nestedUid = (created.value.rmks as { rmk: { uid: string }[] }).rmk[0]
    .uid;
  await service.replace(ctx, String(created.id), { orgId: [{ id: "000123" }] });
  const other = await service.create(ctx, { orgId: [{ id: "OLD" }] });
  await service.delete(ctx, String(other.id));
  const route = app();
  const result = await request(route)
    .post("/xml-files-dump")
    .send({ id: "p1", fileName: "dump.xml" })
    .expect(201);
  expect(result.body.sequence).toBe("1");
  const xml = await readFile(path.join(directory, "dump.xml"), "utf8");
  const parsed = deserializeXML(xml, ir);
  expect(parsed.msgMeta.msgId).toBe("MSG-1");
  expect(
    parsed.batches
      .get("organization")
      .insert.map((row: { uid: string }) => row.uid),
  ).toEqual([created.uid]);
  const restored = await database();
  try {
    await new DBAdapter(restored.knex, ir).persistMessage(
      parsed.batches,
      parsed.msgMeta,
    );
    const doc = await restored
      .knex("external_document")
      .where({ uid: "doc1" })
      .first();
    const child = await restored
      .knex("external_document_issue")
      .where({ uid: "dociss1" })
      .first();
    expect(String(child.external_document_doc_iss_parent_id)).toBe(
      String(doc.id),
    );
    expect(await restored.knex("organization").select("uid")).toEqual([
      { uid: created.uid },
    ]);
  } finally {
    await restored.close();
  }
  expect(xml).toContain("<id>000123</id>");
  expect(xml).not.toContain(nestedUid);
  expect(
    String((await db.knex("external_document_issue").first())._msg_seq),
  ).toBe("1");
  expect(
    String(
      (await db.knex("organization").where("id", other.id).first())._msg_seq,
    ),
  ).toBe("0");
  expect(
    String(
      (await db.knex("organization").where("id", created.id).first())._msg_seq,
    ),
  ).toBe("0");
  expect(
    (await db.knex("_entity_nested_deletion").where("uid", nestedUid).first())
      .export_sequence,
  ).toBeNull();
  expect(
    (
      await db
        .knex("_entity_identity_history")
        .where("uid", created.uid)
        .first()
    ).established,
  ).toBe(1);
  expect(
    (await db.knex("_entity_identity_history").where("uid", nestedUid).first())
      .established,
  ).toBe(0);
  const replay = await request(route)
    .post("/xml-files-dump")
    .send({ id: "p1", fileName: "dump.xml" })
    .expect(200);
  expect(replay.body.sequence).toBe("1");
  expect(await readdir(directory)).toEqual(["dump.xml"]);
}, 30000);

it("rejects unrelated files and rolls back validation and late acknowledgment failures", async () => {
  const target = path.join(directory, "dump.xml");
  await writeFile(target, "existing");
  await request(app())
    .post("/xml-files-dump")
    .send({ id: "p1", fileName: "../escape.xml" })
    .expect(400);
  await request(app())
    .post("/xml-files-dump")
    .send({ id: "p1", fileName: "dump.xml" })
    .expect(409);
  expect(await readFile(target, "utf8")).toBe("existing");
  await rm(target);
  await db
    .knex("external_document")
    .where({ uid: "doc1" })
    .update({ doc_id: "[{}]" });
  const invalid = await request(app())
    .post("/xml-files-dump")
    .send({ id: "p1", fileName: "dump.xml" })
    .expect(422);
  expect(invalid.body).toMatchObject({ error: "invalid_export_xml" });
  expect(invalid.body.message).toContain("cvc-");
  expect(await readdir(directory)).toEqual([]);
  expect(await counter()).toBe("0");
  await expect(
    dumpProjectXml({
      ...options("dump.xml"),
      validate: async () => {
        throw new Error("invalid XSD");
      },
    }),
  ).rejects.toThrow("invalid XSD");
  // Another publisher can claim the name after validation starts.
  await expect(
    dumpProjectXml({
      ...options("dump.xml"),
      validate: async () => {
        await writeFile(target, "other publisher", { flag: "wx" });
      },
    }),
  ).rejects.toMatchObject({ code: "export_file_conflict" });
  expect(await readFile(target, "utf8")).toBe("other publisher");
  await rm(target);
  // Fail the receipt insertion after publication and row acknowledgment.
  await db.knex.raw(
    "CREATE TRIGGER fail_xml_export BEFORE INSERT ON _entity_xml_export FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected receipt failure'",
  );
  try {
    await expect(
      dumpProjectXml({ ...options("dump.xml"), validate: async () => {} }),
    ).rejects.toThrow("injected receipt failure");
  } finally {
    await db.knex.raw("DROP TRIGGER fail_xml_export");
  }
  expect(await readdir(directory)).toEqual([]);
  expect(await counter()).toBe("0");
  expect(await db.knex("_entity_xml_export").select()).toEqual([]);
  expect(
    String((await db.knex("external_document_issue").first())._msg_seq),
  ).toBe("7");
});

it("reconciles an interrupted publish under the project lock and serializes competing writers", async () => {
  const name = "same.xml";
  const key = createHash("sha256")
    .update(JSON.stringify(["p1", name]))
    .digest("hex");
  const stage = path.join(directory, `.xml-export-${key}.pending`);
  await writeFile(stage, "uncommitted bytes");
  await link(stage, path.join(directory, name));
  const validate = vi.fn(async () => {});
  const results = await Promise.all([
    dumpProjectXml({ ...options(name), validate }),
    dumpProjectXml({ ...options(name), validate }),
    dumpProjectXml({ ...options("another.xml"), validate }),
  ]);
  expect(results.filter((r) => r.replay)).toHaveLength(1);
  expect(new Set(results.map((r) => r.sequence))).toEqual(new Set(["1", "2"]));
  expect(validate).toHaveBeenCalledTimes(2);
  expect((await readdir(directory)).sort()).toEqual(["another.xml", name]);
  await writeFile(path.join(directory, name), "replacement");
  await expect(
    dumpProjectXml({ ...options(name), validate }),
  ).rejects.toMatchObject({ code: "export_file_conflict" });
  expect(await counter()).toBe("2");
});

it("upgrades a live database, retains the high-water mark across reruns and allocates exact BIGINT strings", async () => {
  await db.knex("_entity_change_log").insert({
    entity_name: "organization",
    entity_id: "1",
    root_uid: "org1",
    operation: "update",
    export_sequence: "9007199254740993",
  });
  await db.knex.schema.alterTable("_entity_crud_state", (t) =>
    t.dropColumn("last_exported_sequence"),
  );
  await migrateEntityCrud(db.knex);
  expect(await db.knex.transaction(allocateExportSequence)).toBe(
    "9007199254740994",
  );
  await migrateEntityCrud(db.knex, "20");
  expect(await counter()).toBe("9007199254740994");
}, 30000);
