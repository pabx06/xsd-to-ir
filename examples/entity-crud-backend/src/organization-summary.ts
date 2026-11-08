import type { EntitySummaryImplementation } from "./entity-crud.types";
export function toNonNegativeInteger(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error(`Invalid summary count: ${String(value)}`);
  return count;
}
export const getOrganizationSummary: EntitySummaryImplementation = async (
  knex,
  entity,
) => {
  const row = await knex(entity.tableName)
    .select({
      total: knex.raw(
        "COALESCE(SUM(CASE WHEN ?? IS NULL THEN 1 ELSE 0 END), 0)",
        ["_deleted_at"],
      ),
      pending: knex.raw(
        "COALESCE(SUM(CASE WHEN ?? = ? THEN 1 ELSE 0 END), 0)",
        ["_msg_seq", 0],
      ),
      documents: knex.raw(
        `COALESCE(SUM(CASE WHEN ?? IS NOT NULL THEN 0
      ELSE CASE JSON_TYPE(JSON_EXTRACT(??, '$.doc'))
        WHEN 'ARRAY' THEN JSON_LENGTH(??, '$.doc') WHEN 'OBJECT' THEN 1 ELSE 0 END END), 0)`,
        ["_deleted_at", "docs", "docs"],
      ),
      deleted: knex.raw(
        "COALESCE(SUM(CASE WHEN ?? IS NOT NULL THEN 1 ELSE 0 END), 0)",
        ["_deleted_at"],
      ),
    })
    .first();
  return {
    schemaIssue: entity.dialectVersion,
    total: toNonNegativeInteger(row?.total),
    pending: toNonNegativeInteger(row?.pending),
    documents: toNonNegativeInteger(row?.documents),
    deleted: toNonNegativeInteger(row?.deleted),
  };
};
