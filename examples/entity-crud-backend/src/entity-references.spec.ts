import { dirname, resolve } from "node:path";
import type { Knex } from "knex";
import { describe, expect, it, vi } from "vitest";
import { organization, registry } from "../test-support/fixtures";
import { EntityCrudRegistry } from "./entity-crud.registry";
import type { EntityDefinition } from "./entity-crud.types";
import type { Occurrence } from "./entity-metadata";
import {
  ProjectReferenceSnapshot,
  type ReferenceExtension,
  type SnapshotRoot,
} from "./entity-references";
import { IRBuilder, parseXSD, type Value } from "./xsd-runtime";

const trx = {} as Knex.Transaction;

function root(entity: EntityDefinition, row: Value): SnapshotRoot {
  return {
    entity,
    key: `${entity.name}:${row[entity.primaryKey]}`,
    row,
    value: entity.createAdapter().decodeRow(entity.name, row).value,
  };
}

function reference(type: string, value: Value): Occurrence {
  return {
    type,
    value,
    path: [],
    shape: organization.metadata.model.shape(type),
  };
}

function document(id: number, ...identifiers: string[]) {
  return root(registry.getEntityDefinition("1.1", "externalDocument"), {
    id,
    uid: `doc${id}`,
    doc_id: identifiers.map((identifier) => ({ id: identifier })),
  });
}

describe("ProjectReferenceSnapshot", () => {
  it("loads active SQL rows and decodes stored identifiers for lookup", async () => {
    const rows: Value[] = [
      {
        id: "17",
        uid: "org17",
        org_id: '[{"id":"SUPPLIER"}]',
        _deleted_at: null,
      },
      {
        id: "18",
        uid: "org18",
        org_id: '[{"id":"SUPPLIER"}]',
        _deleted_at: new Date(),
      },
    ];
    const readTable = (name: string) => ({
      select: (columns: string[]) => ({
        whereNull: (column: string) =>
          (name === organization.tableName ? rows : [])
            .filter((row) => row[column] === null)
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).filter(([key]) => columns.includes(key)),
              ),
            ),
      }),
    });
    const readTrx = readTable as unknown as Knex.Transaction;
    const snapshot = await ProjectReferenceSnapshot.load(
      readTrx,
      registry,
      "1.1",
    );

    expect(snapshot.roots.map((item) => item.key)).toEqual(["organization:17"]);
    await expect(
      snapshot.resolve(
        readTrx,
        reference("organizationReference", { orgId: { id: "SUPPLIER" } }),
      ),
    ).resolves.toMatchObject([
      { rootKey: "organization:17", value: { uid: "org17" } },
    ]);
  });

  it("resolves UIDs within the reference's type family, including different concrete document types", async () => {
    const dataModule = root(
      registry.getEntityDefinition("1.1", "s1000dDataModule"),
      {
        id: 1,
        uid: "doc7",
        dmc: { id: "DM" },
      },
    );
    const snapshot = new ProjectReferenceSnapshot([dataModule]);
    await expect(
      snapshot.resolve(trx, reference("documentReference", { uidRef: "doc7" })),
    ).resolves.toMatchObject([
      { rootKey: dataModule.key, type: "s1000dDataModule" },
    ]);
    await expect(
      snapshot.resolve(
        trx,
        reference("organizationReference", { uidRef: "doc7" }),
      ),
    ).resolves.toEqual([]);
    await expect(
      snapshot.resolve(trx, reference("documentReference", {})),
    ).resolves.toEqual([]);
  });

  it("matches an issue by its parent's alternate identifier and its own issue identifier", async () => {
    const issueEntity = registry.getEntityDefinition(
      "1.1",
      "externalDocumentIssue",
    );
    const issue = (id: number, parent: string, revision: string) =>
      root(issueEntity, {
        id,
        uid: `dociss${id}`,
        external_document_doc_iss_parent_id: parent,
        doc_iss_id: { id: revision, setBy: { "@_uidRef": "org3" } },
      });
    const wanted = issue(10, "1", "A");
    const snapshot = new ProjectReferenceSnapshot([
      document(1, "LOCAL", "MANUAL"),
      document(2, "OTHER"),
      wanted,
      issue(11, "2", "A"),
      issue(12, "1", "B"),
    ]);
    const ref = reference("documentIssueReference", {
      docId: { id: "MANUAL" },
      docIssId: { id: "A" },
    });
    await expect(snapshot.resolve(trx, ref)).resolves.toMatchObject([
      { rootKey: wanted.key },
    ]);
  });

  it("resolves a nested UID retained on a nil XML element until its owning root is removed", async () => {
    const owner = root(organization, {
      id: 1,
      uid: "org1",
      org_id: [
        {
          id: "ORG",
          applic: { applicDef: { "@_xsi:nil": "true", "@_uid": "applst7" } },
        },
      ],
    });
    expect(owner.value.orgId).toEqual([
      { id: "ORG", applic: { applicDef: null } },
    ]);
    const snapshot = new ProjectReferenceSnapshot([owner]);
    const ref = reference("applicabilityStatementReference", {
      uidRef: "applst7",
    });
    const target = [
      {
        rootKey: owner.key,
        type: "applicabilityStatement",
        value: { uid: "applst7" },
      },
    ];
    await expect(snapshot.resolve(trx, ref)).resolves.toMatchObject(target);
    const removed = snapshot.withRoot(null, owner.key);
    await expect(removed.resolve(trx, ref)).resolves.toEqual([]);
    await expect(snapshot.resolve(trx, ref)).resolves.toMatchObject(target);
  });

  it("reports the exact outgoing reference that is missing or ambiguous, and accepts a unique match", async () => {
    const source = root(organization, {
      id: 7,
      uid: "org7",
      org_id: [{ id: "SOURCE" }],
      docs: {
        doc: [
          { docRef: { "@_uidRef": "doc1" } },
          { docRef: { docId: { id: "MANUAL" } } },
        ],
      },
    });
    const snapshot = new ProjectReferenceSnapshot([
      source,
      document(1, "OTHER"),
    ]);
    const errorAtSecondReference = (message: string) => ({
      code: "invalid_request",
      httpStatus: 400,
      details: { issues: [{ path: "/docs/doc/1/docRef", message }] },
    });

    await expect(snapshot.validateOutgoing(trx, source)).rejects.toMatchObject(
      errorAtSecondReference(
        "The reference does not resolve to an active record of the permitted type.",
      ),
    );
    const unique = snapshot.withRoot(document(2, "MANUAL"));
    await expect(unique.validateOutgoing(trx, source)).resolves.toBeUndefined();
    const ambiguous = unique.withRoot(document(3, "MANUAL"));
    await expect(ambiguous.validateOutgoing(trx, source)).rejects.toMatchObject(
      errorAtSecondReference("The reference is ambiguous."),
    );
  });

  it("resolves external URIs through the host and only falls back when the host returns undefined", async () => {
    const xsd = resolve(
      dirname(require.resolve("xsd-to-ir")),
      "s3000l/2_0/s3000l_2-0_lsaDataset.xsd",
    );
    const issue2 = new EntityCrudRegistry({
      getIRRAW: () => new IRBuilder(parseXSD(xsd)).build(),
    });
    const product = issue2.getEntityDefinition("2.0", "product");
    const [uri] = product.metadata.references("product", {
      prodId: [{ id: "P", setBy: { uriRef: "urn:org:vendor" } }],
    });
    const local = root(issue2.getEntityDefinition("2.0", "organization"), {
      id: 1,
      uid: "org1",
      org_id: [{ id: "LOCAL" }],
    });
    const localRef = { ...uri, value: { uidRef: "org1" } };
    const hostTarget = {
      rootKey: "urn:org:vendor",
      type: "organization",
      value: {},
      scope: {},
      patterns: [],
    };
    const extension = vi.fn<ReferenceExtension>().mockResolvedValue(undefined);
    const snapshot = new ProjectReferenceSnapshot([], extension).withRoot(
      local,
    );

    await expect(snapshot.resolve(trx, uri)).rejects.toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: "/prodId/0/setBy",
            message:
              "The host must configure reference resolution for organizationRef.",
          },
        ],
      },
    });
    extension.mockResolvedValueOnce([hostTarget]);
    await expect(snapshot.resolve(trx, uri)).resolves.toEqual([hostTarget]);
    expect(extension).toHaveBeenLastCalledWith({
      trx,
      reference: uri,
      roots: [local],
    });
    extension.mockResolvedValueOnce([]);
    await expect(snapshot.resolve(trx, localRef)).resolves.toEqual([]);
    await expect(snapshot.resolve(trx, localRef)).resolves.toMatchObject([
      { rootKey: local.key },
    ]);
  });
});

describe("incoming reference protection", () => {
  // Each nested statement has the same natural identifier. Its UID distinguishes replacements.
  function owner(...uids: string[]) {
    return root(organization, {
      id: 1,
      uid: "org1",
      org_id: uids.map((uid, i) => ({
        id: `OWNER-${i}`,
        applic: { applicDef: { "@_uid": uid, applicId: { id: "BASE" } } },
      })),
    });
  }
  const source = root(organization, {
    id: 9,
    uid: "org9",
    org_id: [
      { id: "SOURCE", applic: { applicRef: { applicId: { id: "BASE" } } } },
    ],
  });

  it.each([
    ["deletes the owning root", []],
    ["replaces the matching UID inside the same root", ["applst2"]],
    [
      "makes the reference ambiguous inside the same root",
      ["applst1", "applst2"],
    ],
  ] as const)(
    "blocks a change that %s",
    async (_description, remainingUids) => {
      const original = owner("applst1");
      const before = new ProjectReferenceSnapshot([original, source]);
      await before.validateOutgoing(trx, source);
      const replacement = remainingUids.length ? owner(...remainingUids) : null;
      const after = before.withRoot(replacement, original.key);
      const [ref] = organization.metadata.references(
        organization.name,
        source.value,
      );
      const matches = await after.resolve(trx, ref);
      expect(matches.map((target) => target.value.uid)).toEqual(remainingUids);
      await expect(
        before.protectIncoming(trx, after, original.key),
      ).rejects.toMatchObject({
        code: "record_is_referenced",
        httpStatus: 409,
        message:
          "The change would break a reference from organization 9 at /orgId/0/applic/applicRef.",
      });
    },
  );

  it("allows an edit that preserves the referenced UID even when the source has an unrelated missing reference", async () => {
    const original = owner("applst1");
    const updated = root(organization, {
      ...original.row,
      name: { descr: "Renamed" },
    });
    const sourceWithMissingDocument = root(organization, {
      ...source.row,
      docs: { doc: [{ docRef: { "@_uidRef": "doc999" } }] },
    });
    const before = new ProjectReferenceSnapshot([
      original,
      sourceWithMissingDocument,
    ]);
    const after = before.withRoot(updated, original.key);
    await expect(
      before.protectIncoming(trx, after, original.key),
    ).resolves.toBeUndefined();
  });

  it("allows deleting a root whose only incoming reference is its own", async () => {
    const self = root(organization, {
      id: 4,
      uid: "org4",
      org_id: [{ id: "SELF" }],
      rmks: {
        rmk: [
          { text: { descr: "Author", providedBy: { "@_uidRef": "org4" } } },
        ],
      },
    });
    const before = new ProjectReferenceSnapshot([self]);
    const [ref] = organization.metadata.references(
      organization.name,
      self.value,
    );
    await expect(before.resolve(trx, ref)).resolves.toMatchObject([
      { rootKey: self.key },
    ]);
    await expect(
      before.protectIncoming(trx, before.withRoot(null, self.key), self.key),
    ).resolves.toBeUndefined();
  });
});
