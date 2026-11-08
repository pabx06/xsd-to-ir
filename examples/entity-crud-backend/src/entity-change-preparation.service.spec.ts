import { describe, it, expect } from "vitest";
import {
  business,
  editable,
  memoryPreparation,
  organization,
  recursiveApplicability,
  tracked,
} from "../test-support/fixtures";
import type { Value } from "./xsd-runtime";

describe("metadata-based identity preparation", () => {
  it("allocates distinct schema-valid identities throughout documents, remarks, and recursive applicability", async () => {
    const { service, trx } = memoryPreparation();
    const submittedValue = {
      ...business(),
      docs: {
        doc: [
          {
            docRef: { uidRef: "doc1" },
            rmks: { rmk: [{ text: { descr: "Nested" } }] },
          },
        ],
      },
      rmks: {
        rmk: [
          { text: { descr: "Root remark", applic: recursiveApplicability() } },
        ],
      },
    };
    const result = await service.prepareCreate({
      trx,
      entity: organization,
      submittedValue,
    });
    organization.preparedCreateSchema.parse(result.value);
    const nodes = organization.metadata.identities(
      "organization",
      result.value,
    );
    expect(nodes.length).toBeGreaterThan(6);
    expect(new Set(nodes.map((node) => node.value.uid)).size).toBe(
      nodes.length,
    );
    for (const node of nodes) {
      expect(node.value.crud).toBe("I");
      expect(
        organization.metadata
          .uidRule(node.type)
          .patterns.every((pattern) => pattern.test(String(node.value.uid))),
      ).toBe(true);
    }
    expect(submittedValue).not.toHaveProperty("uid");
  });
  it("marks changed established values U and leaves untouched siblings alone", async () => {
    const previousValue = tracked();
    const state = memoryPreparation(previousValue);
    const submittedValue = editable(previousValue);
    (submittedValue.rmks as { rmk: Value[] }).rmk[0].text = { descr: "Edited" };
    const result = await state.service.prepareReplacement({
      trx: state.trx,
      entity: organization,
      previousValue,
      submittedValue,
    });
    expect(result.value.crud).toBe("U");
    expect(result.value.docs).toEqual(previousValue.docs);
    expect((result.value.rmks as { rmk: Value[] }).rmk[0]).toMatchObject({
      uid: "rmk20",
      crud: "U",
    });
  });
  it("keeps unestablished records I across edits and defers removal tracking until encoding", async () => {
    const previousValue = { ...tracked(), crud: "I" };
    const state = memoryPreparation(previousValue, false);
    const submittedValue = editable(previousValue);
    delete submittedValue.docs;
    const result = await state.service.prepareReplacement({
      trx: state.trx,
      entity: organization,
      previousValue,
      submittedValue,
    });
    expect(result.rootCrud).toBe("I");
    expect(result.value).not.toHaveProperty("docs");
    expect(state.deletions).toEqual([]);
  });
  it.each(["uid", "crud"])("rejects a forged remark %s", async (field) => {
    const previousValue = tracked();
    const state = memoryPreparation(previousValue);
    const submittedValue = editable(previousValue);
    (submittedValue.rmks as { rmk: Value[] }).rmk[0][field] =
      field === "uid" ? "rmk999" : "D";
    await expect(
      state.service.prepareReplacement({
        trx: state.trx,
        entity: organization,
        previousValue,
        submittedValue,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("rejects duplicate and incompatible nested identities", async () => {
    const previousValue = tracked();
    const state = memoryPreparation(previousValue);
    const submittedValue = editable(previousValue);
    const remarks = (submittedValue.rmks as { rmk: Value[] }).rmk;
    remarks.push(structuredClone(remarks[0]));
    await expect(
      state.service.prepareReplacement({
        trx: state.trx,
        entity: organization,
        previousValue,
        submittedValue,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    remarks.pop();
    remarks[0].uid = "docasg30";
    await expect(
      state.service.prepareReplacement({
        trx: state.trx,
        entity: organization,
        previousValue,
        submittedValue,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("recognizes unchanged data regardless of property order without changing tracking", async () => {
    const previousValue = tracked();
    const state = memoryPreparation(previousValue);
    const result = await state.service.prepareReplacement({
      trx: state.trx,
      entity: organization,
      previousValue,
      submittedValue: Object.fromEntries(
        Object.entries(editable(previousValue)).reverse(),
      ),
    });
    expect(result.changed).toBe(false);
    expect(result.value).toEqual(previousValue);
    expect(state.deletions).toEqual([]);
  });
  it("preserves untouched UID-less legacy assignments and requires explicit backfill for ambiguous edits", async () => {
    const previousValue = {
      ...business(),
      uid: "org50",
      crud: "R",
      docs: { doc: [{ docRef: { uidRef: "doc1" } }] },
    };
    const state = memoryPreparation(previousValue);
    const submittedValue = {
      ...editable(previousValue),
      name: { descr: "Changed name" },
    };
    const result = await state.service.prepareReplacement({
      trx: state.trx,
      entity: organization,
      previousValue,
      submittedValue,
    });
    expect(result.value.docs).toEqual(previousValue.docs);
    await expect(
      state.service.prepareReplacement({
        trx: state.trx,
        entity: organization,
        previousValue,
        submittedValue: { ...submittedValue, docs: null },
      }),
    ).rejects.toMatchObject({
      code: "legacy_identity_required",
      httpStatus: 409,
    });
    const filled = await state.service.prepareBackfill({
      trx: state.trx,
      entity: organization,
      previousValue,
    });
    expect(filled.changed).toBe(true);
    expect((filled.value.docs as { doc: Value[] }).doc[0]).toMatchObject({
      crud: "U",
      uid: expect.stringMatching(/^docasg/),
    });
    const removed = await state.service.prepareReplacement({
      trx: state.trx,
      entity: organization,
      previousValue: filled.value,
      submittedValue: { ...editable(filled.value), docs: null },
    });
    expect(removed.value.docs).toBeNull();
  });
  it("rejects managed fields on new roots and nested values", async () => {
    const state = memoryPreparation();
    for (const submittedValue of [
      { ...business(), uid: "org999" },
      { ...business(), rmks: { rmk: [{ text: { descr: "New" }, crud: "I" }] } },
    ]) {
      await expect(
        state.service.prepareCreate({
          trx: state.trx,
          entity: organization,
          submittedValue,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });
});
