import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import request from "supertest";
import { database } from "../test-support/mariadb";
import {
  business,
  editable,
  organization,
  recursiveApplicability,
  registry,
} from "../test-support/fixtures";
import { EntityCrudService } from "./entity-crud.service";
import {
  acknowledgeExport,
  initializeProjectHistory,
} from "./identity-lifecycle";
import type { Value } from "./xsd-runtime";
const endpoint = "/api/projects/p1/entities/organization";
let db: Awaited<ReturnType<typeof database>>;
beforeAll(async () => {
  db = await database();
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
}, 30000);

describe("HTTP CRUD with the generated Issue 1.1 DDL and MariaDB", () => {
  it("reserves nil XML identities hidden by UI null and retains them until removal", async () => {
    const nil = {
      "@_uid": "applst2",
      "@_crud": "R",
      "@_xsi:nil": "true",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    };
    const id = await db.seed(
      "organization",
      { ...business("NIL"), uid: "org90", crud: "R" },
      {
        org_id: JSON.stringify([{ id: "NIL", applic: { applicDef: nil } }]),
      },
    );
    await initializeProjectHistory(db.knex, registry, "1.1", () => true);
    expect(
      await db.knex("_entity_identity_history").where("uid", "applst2").first(),
    ).toMatchObject({ root_uid: "org90", active: 1 });
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const original = await service.findById(db.knex, organization, id);
    expect((original.value.orgId as Value[])[0].applic).toEqual({
      applicDef: null,
    });
    await service.replace(ctx, id, {
      ...original.value,
      name: { descr: "Unrelated edit" },
    });
    expect(
      await db.knex("_entity_nested_deletion").where("uid", "applst2").select(),
    ).toEqual([]);
    const allocated = await service.create(ctx, {
      ...business("OTHER"),
      orgId: [
        { id: "OTHER", applic: { applicDef: { applicId: { id: "OTHER" } } } },
      ],
    });
    expect(
      (
        ((allocated.value.orgId as Value[])[0].applic as Value)
          .applicDef as Value
      ).uid,
    ).toBe("applst3");
    await service.replace(ctx, id, business("NIL"));
    const tombstone = await db
      .knex("_entity_nested_deletion")
      .where("uid", "applst2")
      .first();
    expect(tombstone.path).toBe("/orgId/0/applic/applicDef");
    expect(JSON.parse(tombstone.previous_value)).toEqual(nil);
  });
  it("retains an existing identity when its value becomes nil, then tracks its later removal", async () => {
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const row = await service.create(ctx, {
      ...business(),
      orgId: [
        { id: "NIL", applic: { applicDef: { applicId: { id: "LOCAL" } } } },
      ],
    });
    const nestedUid = String(
      (((row.value.orgId as Value[])[0].applic as Value).applicDef as Value)
        .uid,
    );
    await db.knex.transaction((trx) =>
      acknowledgeExport(
        trx,
        registry,
        "1.1",
        [{ entityName: "organization", id: row.id }],
        "8",
      ),
    );
    const exported = await service.findById(
      db.knex,
      organization,
      String(row.id),
    );
    expect(exported.pendingExport).toBe(false);
    expect(exported._updatedAt).toBe(row._updatedAt);
    await service.replace(ctx, String(row.id), {
      ...row.value,
      orgId: [{ id: "NIL", applic: { applicDef: null } }],
    });
    const stored = await db.knex("organization").where("id", row.id).first();
    const values =
      typeof stored.org_id === "string"
        ? JSON.parse(stored.org_id)
        : stored.org_id;
    expect(values[0].applic.applicDef).toMatchObject({
      "@_uid": nestedUid,
      "@_crud": "U",
      "@_xsi:nil": "true",
    });
    expect(
      await db.knex("_entity_nested_deletion").where("uid", nestedUid).select(),
    ).toEqual([]);
    await service.replace(ctx, String(row.id), business("NIL"));
    expect(
      await db.knex("_entity_nested_deletion").where("uid", nestedUid).first(),
    ).toBeDefined();
  });
  it("rolls back allocations and tombstones when a late SQL constraint rejects the write", async () => {
    const { app, service } = db.app();
    const ctx = db.context();
    const row = await service.create(ctx, {
      ...business("ONE"),
      name: { descr: "One" },
      docs: { doc: [{ docRef: { uidRef: "doc1" } }] },
    });
    await service.create(ctx, { ...business("TWO"), name: { descr: "Two" } });
    await db.knex.raw(
      "CREATE UNIQUE INDEX test_unique_name ON organization (name(190))",
    );
    const ledger = await db
      .knex("_entity_identity_history")
      .select()
      .orderBy("uid");
    const sequences = await db
      .knex("_entity_uid_sequence")
      .select()
      .orderBy("prefix");
    try {
      const response = await request(app)
        .put(`${endpoint}/${row.id}`)
        .set("x-test-role", "editor")
        .send({
          orgId: row.value.orgId,
          name: { descr: "Two" },
          rmks: { rmk: [{ text: { descr: "Allocated then rolled back" } }] },
        })
        .expect(409);
      expect(response.body.constraint).toBe("test_unique_name");
      expect(
        (await service.findById(db.knex, organization, String(row.id))).value,
      ).toEqual(row.value);
      expect(
        await db.knex("_entity_identity_history").select().orderBy("uid"),
      ).toEqual(ledger);
      expect(
        await db.knex("_entity_uid_sequence").select().orderBy("prefix"),
      ).toEqual(sequences);
      expect(await db.knex("_entity_nested_deletion").select()).toEqual([]);
    } finally {
      await db.knex.raw("DROP INDEX test_unique_name ON organization");
    }
  });
  it("resolves permitted DMC and PMC natural identifiers and their issue scopes", async () => {
    const dm = await db.seed("s1000dDataModule", {
      uid: "doc2",
      crud: "R",
      dmc: { id: "DMC-DEMO" },
    });
    const pm = await db.seed("s1000dPublicationModule", {
      uid: "doc3",
      crud: "R",
      pmc: { id: "PMC-DEMO" },
    });
    const dmEntity = registry.getEntityDefinition("1.1", "s1000dDataModule");
    const pmEntity = registry.getEntityDefinition(
      "1.1",
      "s1000dPublicationModule",
    );
    const dmParent = dmEntity.ir.entities
      .get(dmEntity.name)!
      .relations.find(
        (item) => item.targetEntity === "s1000dDataModuleIssue",
      )!.parentColumn;
    const pmParent = pmEntity.ir.entities
      .get(pmEntity.name)!
      .relations.find(
        (item) => item.targetEntity === "s1000dPublicationModuleIssue",
      )!.parentColumn;
    await db.seed(
      "s1000dDataModuleIssue",
      { uid: "dociss2", crud: "R", dmIssId: { id: "A" } },
      { [dmParent]: dm },
    );
    await db.seed(
      "s1000dPublicationModuleIssue",
      { uid: "dociss3", crud: "R", pmIssId: { id: "B" } },
      { [pmParent]: pm },
    );
    await initializeProjectHistory(db.knex, registry, "1.1", () => true);
    const service = new EntityCrudService(registry);
    const row = await service.create(db.context(), {
      ...business(),
      docs: {
        doc: [
          { docRef: { dmc: { id: "DMC-DEMO" } } },
          { docRef: { pmc: { id: "PMC-DEMO" } } },
          { docIssRef: { dmc: { id: "DMC-DEMO" }, dmIssId: { id: "A" } } },
          { docIssRef: { pmc: { id: "PMC-DEMO" }, pmIssId: { id: "B" } } },
        ],
      },
    });
    expect((row.value.docs as { doc: Value[] }).doc).toHaveLength(4);
  });
  it("creates without client identities, preserves leading zeroes, edits through PUT and soft-deletes", async () => {
    const { app, errors } = db.app();
    const created = await request(app)
      .post(endpoint)
      .set("x-test-role", "editor")
      .send(business())
      .expect(201);
    const row = created.body.data;
    expect(row).toMatchObject({
      uid: expect.stringMatching(/^org[1-9][0-9]*$/),
      crud: "I",
      pendingExport: true,
      value: { orgId: [{ id: "001234" }] },
    });
    expect(row.value).not.toHaveProperty("uid");
    expect(row._createdAt).toMatch(/Z$/);
    const updated = await request(app)
      .put(`${endpoint}/${row.id}`)
      .set("x-test-role", "editor")
      .send({ ...row.value, name: { descr: "Edited" } })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      uid: row.uid,
      crud: "I",
      value: { name: { descr: "Edited" } },
    });
    await request(app)
      .delete(`${endpoint}/${row.id}`)
      .set("x-test-role", "editor")
      .expect(204);
    await request(app)
      .get(`${endpoint}/${row.id}`)
      .set("x-test-role", "reader")
      .expect(404);
    const stored = await db.knex("organization").where("id", row.id).first();
    expect(stored.crud).toBe("D");
    expect(stored._deleted_at).not.toBeNull();
    expect(errors).toEqual([]);
    const stats = await request(app)
      .get(`${endpoint}/summary`)
      .set("x-test-role", "reader")
      .expect(200);
    expect(stats.body.data).toEqual({
      schemaIssue: "1.1",
      total: 0,
      pending: 1,
      documents: 0,
      deleted: 1,
    });
  });
  it("removes omitted columns, distinguishes explicit nil, and skips unchanged writes", async () => {
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const first = await service.create(ctx, business());
    const before = await db.knex("organization").where("id", first.id).first();
    const logs = await db
      .knex("_entity_change_log")
      .count({ total: "*" })
      .first();
    const unchanged = await service.replace(
      ctx,
      String(first.id),
      Object.fromEntries(Object.entries(first.value).reverse()),
    );
    expect(unchanged._updatedAt).toBe(first._updatedAt);
    expect(
      await db.knex("_entity_change_log").count({ total: "*" }).first(),
    ).toEqual(logs);
    const nil = await service.replace(ctx, String(first.id), {
      orgId: first.value.orgId,
      docs: null,
    });
    const storedNil = await db
      .knex("organization")
      .where("id", first.id)
      .first();
    expect(storedNil.name).toBeNull();
    expect(JSON.parse(storedNil.docs)["@_xsi:nil"]).toBe("true");
    expect(nil.value.docs).toBeNull();
    const absent = await service.replace(ctx, String(first.id), {
      orgId: first.value.orgId,
    });
    expect(absent.value).not.toHaveProperty("docs");
    expect(
      (await db.knex("organization").where("id", first.id).first()).docs,
    ).toBeNull();
    expect(
      typeof before.org_id === "string"
        ? JSON.parse(before.org_id)
        : before.org_id,
    ).toEqual([{ id: "001234" }]);
  });
  it("tracks recursive nested values and saves tombstones outside active JSON", async () => {
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const row = await service.create(ctx, {
      ...business(),
      docs: {
        doc: [
          {
            docRef: { uidRef: "doc1" },
            rmks: { rmk: [{ text: { descr: "Doc remark" } }] },
          },
        ],
      },
      rmks: {
        rmk: [
          { text: { descr: "Main remark", applic: recursiveApplicability() } },
        ],
      },
    });
    const full = { ...row.value, uid: row.uid, crud: row.crud };
    const identities = organization.metadata.identities("organization", full);
    expect(identities.length).toBeGreaterThan(6);
    expect(identities.every((node) => typeof node.value.uid === "string")).toBe(
      true,
    );
    await db.knex.transaction(async (trx) => {
      await acknowledgeExport(
        trx,
        registry,
        "1.1",
        [{ entityName: "organization", id: row.id }],
        "8",
      );
    });
    const patch = structuredClone(row.value);
    (patch.rmks as { rmk: Value[] }).rmk[0].text = {
      descr: "Edited after export",
    };
    const changed = await service.replace(ctx, String(row.id), patch);
    expect(changed.crud).toBe("U");
    expect((changed.value.rmks as { rmk: Value[] }).rmk[0].crud).toBe("U");
    expect(changed.value.docs).toEqual(row.value.docs);
    const deletions = await db
      .knex("_entity_nested_deletion")
      .where({ root_uid: row.uid })
      .select();
    expect(deletions.length).toBeGreaterThan(2);
    expect(deletions.every((item) => item.export_sequence === null)).toBe(true);
    const log = await db
      .knex("_entity_change_log")
      .where({ root_uid: row.uid })
      .orderBy("id", "desc")
      .first();
    expect(JSON.parse(log.previous_row).rmks).toContain("@_uid");
  });
  it("rejects forged root/nested fields, invalid choices and prohibited fields and rolls back allocations", async () => {
    const { app, service } = db.app();
    const existing = await service.create(db.context(), {
      ...business(),
      rmks: { rmk: [{ text: { descr: "Remark" } }] },
    });
    const ledger = await db
      .knex("_entity_identity_history")
      .select()
      .orderBy("uid");
    const sequences = await db
      .knex("_entity_uid_sequence")
      .select()
      .orderBy("prefix");
    const invalid = [
      { ...existing.value, uid: "org999" },
      { ...existing.value, docs: { doc: [{}] } },
      {
        ...existing.value,
        name: { descr: "Name", providedBy: { uidRef: existing.uid } },
      },
      {
        ...existing.value,
        orgId: [{ id: "A", setBy: { uidRef: existing.uid } }],
      },
      {
        ...existing.value,
        rmks: {
          rmk: [{ text: { descr: "Remark" }, uid: "rmk999", crud: "D" }],
        },
      },
    ];
    for (const value of invalid)
      await request(app)
        .put(`${endpoint}/${existing.id}`)
        .set("x-test-role", "editor")
        .send(value)
        .expect(400);
    expect(
      await db.knex("_entity_identity_history").select().orderBy("uid"),
    ).toEqual(ledger);
    expect(
      await db.knex("_entity_uid_sequence").select().orderBy("prefix"),
    ).toEqual(sequences);
    expect(
      (await service.findById(db.knex, organization, String(existing.id)))
        .value,
    ).toEqual(existing.value);
  });
  it("resolves UID and natural document/issue/applicability references, and rejects missing or wrong-type targets", async () => {
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const value = {
      ...business(),
      docs: {
        doc: [
          { docRef: { docId: { id: "MANUAL-001" } } },
          { docIssRef: { docId: { id: "MANUAL-001" }, docIssId: { id: "A" } } },
        ],
      },
      rmks: {
        rmk: [
          {
            text: {
              descr: "Applicable",
              applic: { applicRef: { applicId: { id: "BASE" } } },
            },
          },
        ],
      },
    };
    const row = await service.create(ctx, value);
    expect(row.value.docs).toBeDefined();
    for (const docRef of [
      { uidRef: "doc999" },
      { uidRef: "org1" },
      { docId: { id: "MISSING" } },
    ]) {
      await expect(
        service.create(ctx, {
          ...business("BAD"),
          docs: { doc: [{ docRef }] },
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    await db.seed("externalDocument", {
      uid: "doc2",
      crud: "R",
      docId: [{ id: "MANUAL-001" }],
    });
    await initializeProjectHistory(db.knex, registry, "1.1", () => true);
    await expect(service.create(ctx, value)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
  it("protects incoming Organization references inside JSON against deletes and natural-key changes", async () => {
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const target = await service.create(ctx, business("TARGET"));
    const source = await service.create(ctx, {
      ...business("SOURCE"),
      rmks: {
        rmk: [
          {
            text: {
              descr: "Reference",
              providedBy: { orgId: { id: "TARGET" } },
            },
          },
        ],
      },
    });
    await expect(service.delete(ctx, String(target.id))).rejects.toMatchObject({
      code: "record_is_referenced",
    });
    await expect(
      service.replace(ctx, String(target.id), {
        ...target.value,
        orgId: [{ id: "CHANGED" }],
      }),
    ).rejects.toMatchObject({ code: "record_is_referenced" });
    await service.replace(ctx, String(source.id), business("SOURCE"));
    await service.delete(ctx, String(target.id));
  });
  it("handles legacy singleton JSON without UIDs, then allows an explicit identity backfill", async () => {
    const id = await db.seed(
      "organization",
      { ...business("LEGACY"), uid: "org90", crud: "R" },
      {
        docs: JSON.stringify({
          doc: { docRef: { "@_uidRef": "doc1" }, "@_xmlns:keep": "urn:keep" },
        }),
      },
    );
    await initializeProjectHistory(db.knex, registry, "1.1", () => true);
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const original = await service.findById(db.knex, organization, id);
    const changed = await service.replace(ctx, id, {
      ...original.value,
      name: { descr: "Unrelated edit" },
    });
    expect(changed.value.docs).toEqual(original.value.docs);
    expect(
      JSON.parse((await db.knex("organization").where("id", id).first()).docs)
        .doc["@_xmlns:keep"],
    ).toBe("urn:keep");
    await expect(
      service.replace(ctx, id, { ...changed.value, docs: null }),
    ).rejects.toMatchObject({ code: "legacy_identity_required" });
    const filled = await service.backfillIdentities(ctx, id);
    expect((filled.value.docs as { doc: Value[] }).doc[0].uid).toMatch(
      /^docasg/,
    );
    expect(filled.crud).toBe("U");
    await service.replace(ctx, id, { ...filled.value, docs: null });
  });
  it("uses real establishment history and never allocates an imported UID again", async () => {
    await db.seed("organization", {
      ...business("IMPORTED"),
      uid: "org1",
      crud: "I",
      rmks: { rmk: [{ text: { descr: "Imported" }, uid: "rmk1", crud: "I" }] },
    });
    await initializeProjectHistory(db.knex, registry, "1.1", () => true);
    const service = new EntityCrudService(registry);
    const ctx = db.context();
    const imported = await db.knex("organization").where("uid", "org1").first();
    const value = (
      await service.findById(db.knex, organization, String(imported.id))
    ).value;
    const edited = await service.replace(ctx, String(imported.id), {
      ...value,
      name: { descr: "Changed" },
    });
    expect(edited.crud).toBe("U");
    const created = await service.create(ctx, {
      ...business("NEW"),
      rmks: { rmk: [{ text: { descr: "New" } }] },
    });
    expect(created.uid).not.toBe("org1");
    expect((created.value.rmks as { rmk: Value[] }).rmk[0].uid).not.toBe(
      "rmk1",
    );
    await db
      .knex("_entity_crud_state")
      .where({ id: 1 })
      .update({ history_ready: false });
    await expect(
      service.replace(ctx, String(created.id), {
        ...created.value,
        name: { descr: "Blocked" },
      }),
    ).rejects.toMatchObject({ code: "identity_history_not_ready" });
  });
  it("applies logical search/status filters before pagination and provides complete reference pages", async () => {
    for (let index = 0; index < 105; index++)
      await db.seed(
        "organization",
        {
          ...business(`ID-${index}`),
          uid: `org${index + 1}`,
          crud: index === 104 ? "N" : "R",
          name: { descr: index === 104 ? "Last %_ Literal" : "Supplier" },
        },
        { _msg_seq: index === 104 ? 0 : 7 },
      );
    await db
      .knex("organization")
      .where("uid", "org105")
      .update({ org_id: JSON.stringify({ id: "001234" }) });
    const { app } = db.app();
    const found = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({
        page: 1,
        pageSize: 6,
        "filter.search": "001234",
        "filter.status": "pending",
      })
      .expect(200);
    expect(found.body.metadata.total).toBe(1);
    expect(found.body.data[0].uid).toBe("org105");
    const unchanged = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({ "filter.status": "N" })
      .expect(200);
    expect(unchanged.body.data).toHaveLength(1);
    expect(unchanged.body.data[0].crud).toBe("N");
    const literal = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({ "filter.search": "%_" })
      .expect(200);
    expect(literal.body.metadata.total).toBe(1);
    const second = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({ page: 2, pageSize: 100, sortBy: "uid", sortDirection: "asc" })
      .expect(200);
    expect(second.body.metadata).toMatchObject({
      total: 105,
      pageCount: 2,
      pageSize: 100,
    });
    expect(second.body.data).toHaveLength(5);
    const first = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({
        page: 1,
        pageSize: 6,
        sortBy: "_updatedAt",
        sortDirection: "desc",
      })
      .expect(200);
    const again = await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({
        page: 1,
        pageSize: 6,
        sortBy: "_updatedAt",
        sortDirection: "desc",
      })
      .expect(200);
    expect(first.body.data.map((row: Value) => row.id)).toEqual(
      again.body.data.map((row: Value) => row.id),
    );
    await request(app)
      .get(endpoint)
      .set("x-test-role", "reader")
      .query({ "filter.status": "invalid" })
      .expect(400);
  }, 15000);
  it("counts direct singleton/array assignments and pending deletions using real MariaDB JSON functions", async () => {
    const doc = {
      docRef: { "@_uidRef": "doc1" },
      "@_uid": "docasg1",
      "@_crud": "R",
    };
    await db.seed(
      "organization",
      { ...business("A"), uid: "org1", crud: "R" },
      { docs: JSON.stringify({ doc }) },
    );
    await db.seed(
      "organization",
      { ...business("B"), uid: "org2", crud: "I" },
      {
        _msg_seq: 0,
        docs: JSON.stringify({ doc: [doc, { ...doc, "@_uid": "docasg2" }] }),
      },
    );
    await db.seed("organization", { ...business("C"), uid: "org3", crud: "R" });
    await db.seed(
      "organization",
      { ...business("D"), uid: "org4", crud: "D" },
      {
        _msg_seq: 0,
        _deleted_at: new Date(),
        docs: JSON.stringify({ doc: [doc, doc] }),
      },
    );
    const { app } = db.app();
    const summary = await request(app)
      .get(`${endpoint}/summary`)
      .set("x-test-role", "reader")
      .expect(200);
    expect(summary.body.data).toEqual({
      schemaIssue: "1.1",
      total: 3,
      pending: 2,
      documents: 3,
      deleted: 1,
    });
  });
  it("rolls back failed writes and applies the same protections to PATCH", async () => {
    const { app, service } = db.app({
      validateAdditional: (_ctx, value) => {
        if ((value.name as Value)?.descr === "FAIL")
          throw new Error("Injected project-rule failure");
      },
    });
    const row = await service.create(db.context(), business());
    await request(app)
      .put(`${endpoint}/${row.id}`)
      .set("x-test-role", "editor")
      .send({
        ...row.value,
        name: { descr: "FAIL" },
        docs: { doc: [{ docRef: { uidRef: "doc1" } }] },
      })
      .expect(500);
    expect(
      (await service.findById(db.knex, organization, String(row.id))).value,
    ).toEqual(row.value);
    expect(
      Number(
        (
          await db
            .knex("_entity_identity_history")
            .where("root_uid", row.uid)
            .count({ total: "*" })
            .first()
        )?.total,
      ),
    ).toBe(1);
    await request(app)
      .patch(`${endpoint}/${row.id}`)
      .set("x-test-role", "editor")
      .send({ uid: "org999" })
      .expect(400);
    const edited = await request(app)
      .patch(`${endpoint}/${row.id}`)
      .set("x-test-role", "editor")
      .send({ name: { descr: "Patch" } })
      .expect(200);
    expect(edited.body.data.crud).toBe("I");
    expect(edited.body.data.value.orgId).toEqual(row.value.orgId);
  });
});
