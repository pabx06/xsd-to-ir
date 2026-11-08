import { describe, expect, it } from "vitest";
import { iamAllowed } from "./entity-crud.authorization";
import type { CrudAuthorizationRequest } from "./entity-crud.types";

describe("iamAllowed", () => {
  it("returns true", async () => {
    const request = {} as CrudAuthorizationRequest;
    await expect(iamAllowed(request)).resolves.toBe(true);
  });
  it("does not throw for a valid authorization request", async () => {
    const request = {} as CrudAuthorizationRequest;
    await expect(iamAllowed(request)).resolves.not.toThrow();
  });
});
