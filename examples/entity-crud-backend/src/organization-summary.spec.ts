import { describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import type { EntityDefinition } from "./entity-crud.types";
import { getOrganizationSummary } from "./organization-summary";
function createOrganizationDefinition(dialectVersion: "1.1" | "2.0" = "1.1"): EntityDefinition {
  return { dialectVersion, name: "organization", tableName: "organization", primaryKey: "id",
    readableColumns: [], fieldColumns: {}, filterableColumns: [], sortableColumns: [],
    createSchema: {} as EntityDefinition["createSchema"],
    updateSchema: {} as EntityDefinition["updateSchema"],
    replaceSchema: {} as EntityDefinition["replaceSchema"],
    preparedCreateSchema: {} as EntityDefinition["preparedCreateSchema"],
    preparedReplaceSchema: {} as EntityDefinition["preparedReplaceSchema"] };
}
function createKnexMock(row: unknown) {
  const builder = { select: vi.fn(), first: vi.fn() };
  builder.select.mockReturnValue(builder);
  builder.first.mockResolvedValue(row);
  const knex = vi.fn(() => builder) as unknown as Knex;
  Object.assign(knex, { raw: vi.fn((sql: string, bindings?: readonly unknown[]) => ({ sql, bindings })) });
  return { knex, builder };
}
describe("getOrganizationSummary", () => {
  it("returns normalized non-negative integer counts", async () => {
    const { knex } = createKnexMock({ total: "8", pending: "2", documents: "3", deleted: "1" });
    const result = await getOrganizationSummary(knex, createOrganizationDefinition());
    expect(result).toEqual({ schemaIssue: "1.1", total: 8, pending: 2, documents: 3, deleted: 1 });
  });
  it("returns the actual project schema issue", async () => {
    const { knex } = createKnexMock({ total: 0, pending: 0, documents: 0, deleted: 0 });
    const result = await getOrganizationSummary(knex, createOrganizationDefinition("2.0"));
    expect(result.schemaIssue).toBe("2.0");
  });
  it("uses zero when aggregate values are absent", async () => {
    const { knex } = createKnexMock(undefined);
    const result = await getOrganizationSummary(knex, createOrganizationDefinition());
    expect(result).toEqual({ schemaIssue: "1.1", total: 0, pending: 0, documents: 0, deleted: 0 });
  });
  it("queries only the resolved organization table", async () => {
    const { knex } = createKnexMock({ total: 0, pending: 0, documents: 0, deleted: 0 });
    const entity = createOrganizationDefinition(); entity.tableName = "organization_v11";
    await getOrganizationSummary(knex, entity);
    expect(knex).toHaveBeenCalledWith("organization_v11");
  });
  it("rejects invalid negative counts", async () => {
    const { knex } = createKnexMock({ total: -1, pending: 0, documents: 0, deleted: 0 });
    await expect(getOrganizationSummary(knex, createOrganizationDefinition()))
      .rejects.toThrow("Invalid Organization summary count: -1");
  });
});
