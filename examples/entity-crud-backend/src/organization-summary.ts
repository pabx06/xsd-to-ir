import type { EntitySummaryImplementation } from "./entity-crud.types";
interface OrganizationSummaryRow {
  total: string | number | null; pending: string | number | null;
  documents: string | number | null; deleted: string | number | null;
}
export const getOrganizationSummary: EntitySummaryImplementation = async (knex, entity) => {
  const row = await knex(entity.tableName).select({
    total: knex.raw("COALESCE(SUM(CASE WHEN ?? IS NULL THEN 1 ELSE 0 END), 0)", ["_deleted_at"]),
    pending: knex.raw("COALESCE(SUM(CASE WHEN ?? = ? THEN 1 ELSE 0 END), 0)", ["_msg_seq", 0]),
    documents: knex.raw(
      "COALESCE(SUM(CASE WHEN ?? IS NOT NULL THEN 0 ELSE CASE WHEN JSON_TYPE(JSON_EXTRACT(??, '$.doc')) = 'ARRAY' THEN JSON_LENGTH(??, '$.doc') WHEN 'OBJECT' THEN 1 ELSE 0 END END), 0)",
      ["_deleted_at", "docs", "docs"],
    ),
    deleted: knex.raw("COALESCE(SUM(CASE WHEN ?? IS NOT NULL THEN 1 ELSE 0 END), 0)", ["_deleted_at"]),
  }).first() as OrganizationSummaryRow | undefined;
  return {
    schemaIssue: entity.dialectVersion,
    total: toNonNegativeInteger(row?.total), pending: toNonNegativeInteger(row?.pending),
    documents: toNonNegativeInteger(row?.documents), deleted: toNonNegativeInteger(row?.deleted),
  };
};
function toNonNegativeInteger(value: unknown): number {
  const numericValue = Number(value ?? 0);
  if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue) || numericValue < 0) {
    throw new Error(`Invalid Organization summary count: ${String(value)}`);
  }
  return numericValue;
}
