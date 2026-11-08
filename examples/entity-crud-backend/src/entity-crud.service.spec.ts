import { describe, it, expect } from "vitest";
import { EntityCrudService } from "./entity-crud.service";
import { registry, organization } from "../test-support/fixtures";
const row = {
  id: "9007199254740993",
  uid: "org1",
  crud: "N",
  _created_at: new Date("2026-11-01T12:00:00Z"),
  _updated_at: "2026-11-01 12:00:00.000",
  _deleted_at: null,
  _msg_seq: "0",
  org_id: '{"id":"001234"}',
  name: { descr: "Supplier" },
  docs: null,
};
describe("record mapping", () => {
  it("accepts JSON driver forms, large string IDs and N without exposing root tracking inside the business value", () => {
    const result = new EntityCrudService(registry).toEntityRecord(
      organization,
      row,
    );
    expect(result).toMatchObject({
      id: row.id,
      uid: "org1",
      crud: "N",
      pendingExport: true,
      _updatedAt: "2026-11-01T12:00:00.000Z",
      value: { orgId: [{ id: "001234" }], name: { descr: "Supplier" } },
    });
    expect(result.value).not.toHaveProperty("uid");
    expect(result.value).not.toHaveProperty("docs");
  });
  it("rejects unsafe numeric IDs instead of rounding them silently", () => {
    expect(() =>
      new EntityCrudService(registry).toEntityRecord(organization, {
        ...row,
        id: 9007199254740992,
      }),
    ).toThrow("invalid");
  });
});
