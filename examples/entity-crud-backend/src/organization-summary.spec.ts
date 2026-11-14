import { describe, it, expect } from "vitest";
import { toNonNegativeInteger } from "./organization-summary";
describe("summary count conversion", () => {
  it.each([0, "0", 12, "12", null, undefined])("accepts count %s", (count) =>
    expect(toNonNegativeInteger(count)).toBe(Number(count ?? 0)),
  );
  it.each([-1, 1.5, "bad", Infinity, 9007199254740992])(
    "rejects invalid count %s",
    (count) => expect(() => toNonNegativeInteger(count)).toThrow(),
  );
});
