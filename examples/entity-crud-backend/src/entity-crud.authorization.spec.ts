import { describe, it, expect, vi } from "vitest";
import { iamAllowed } from "./entity-crud.authorization";
import type { CrudAuthorizationRequest } from "./entity-crud.types";
const request: CrudAuthorizationRequest = {
  actor: { id: "viewer" },
  projectId: "p1",
  databaseName: "p1_db",
  entity: "organization",
  operation: "read",
};
describe("authorization", () => {
  it("denies absent policies and unauthenticated actors", async () => {
    expect(await iamAllowed(request)).toBe(false);
    const authorize = vi.fn(() => true);
    expect(
      await iamAllowed({ ...request, actor: { id: "unknown" } }, authorize),
    ).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("delegates the complete scope and respects operation permissions", async () => {
    const policy = vi.fn(
      (input: CrudAuthorizationRequest) =>
        input.projectId === "p1" && input.operation === "read",
    );
    expect(await iamAllowed(request, policy)).toBe(true);
    expect(policy).toHaveBeenCalledWith(request);
    expect(await iamAllowed({ ...request, operation: "delete" }, policy)).toBe(
      false,
    );
    expect(await iamAllowed({ ...request, projectId: "other" }, policy)).toBe(
      false,
    );
  });
});
