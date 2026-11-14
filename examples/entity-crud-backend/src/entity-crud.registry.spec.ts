import { describe, it, expect } from "vitest";
import {
  registry,
  organization,
  business,
  tracked,
} from "../test-support/fixtures";

describe("generated input and prepared-value contracts", () => {
  it("rejects managed/unknown root fields and retains absence versus null and leading zeroes", () => {
    for (const key of ["uid", "crud", "id", "_updatedAt", "_msgSeq", "unknown"])
      expect(
        organization.createSchema.safeParse({ ...business(), [key]: "x" })
          .success,
      ).toBe(false);
    const missing = organization.replaceSchema.parse({
      orgId: [{ id: "001234" }],
    });
    const nil = organization.replaceSchema.parse({ ...missing, docs: null });
    expect(missing).not.toHaveProperty("docs");
    expect(nil.docs).toBeNull();
    expect(missing.orgId).toEqual([{ id: "001234" }]);
  });
  it.each([
    { orgId: [] },
    { orgId: [{ id: 1234 }] },
    { orgId: [{ id: "" }] },
    { name: { descr: "" } },
    { name: { descr: "Name", lang: "not-a-language" } },
    { orgId: [{ id: "A", setBy: { uidRef: "org1" } }] },
    { name: { descr: "Name", providedBy: { uidRef: "org1" } } },
    { docs: { doc: [{ uid: "docasg1" }] } },
    {
      docs: {
        doc: [{ docRef: { uidRef: "doc1" }, docIssRef: { uidRef: "dociss1" } }],
      },
    },
    { docs: { doc: [{ docRef: { uidRef: "doc1", docId: { id: "BOTH" } } }] } },
  ])("rejects incomplete or prohibited business values: %j", (patch) => {
    expect(() =>
      organization.preparedReplaceSchema.parse({ ...tracked(), ...patch }),
    ).toThrow();
  });
  it("accepts either permitted document reference choice and natural issue identifiers", () => {
    for (const doc of [
      { docRef: { uidRef: "doc1" } },
      { docIssRef: { uidRef: "dociss1" } },
      { docIssRef: { docId: { id: "D-1" }, docIssId: { id: "A" } } },
    ]) {
      expect(() =>
        organization.preparedReplaceSchema.parse({
          ...tracked(),
          docs: { doc: [doc] },
        }),
      ).not.toThrow();
    }
  });
  it("keeps unsupported XSD rules visible and caches by schema issue", () => {
    expect(organization.validationWarnings()).toContain(
      "whiteSpace requires XSD validation.",
    );
    expect(registry.getEntityDefinition("1.1", "organization")).toBe(
      organization,
    );
    expect(() => registry.getEntityDefinition("1.1", "notAnEntity")).toThrow();
    expect(organization.fieldColumns._updatedAt).toBe("_updated_at");
  });
});
