import type { EntityDefinition } from "./entity-crud.types";
/** Kept as an integration entry point. Rules now come from each value type, including recursive children. */
export function organizationIdentityPolicyV11(entity: EntityDefinition) {
  if (entity.name !== "organization" || entity.dialectVersion !== "1.1")
    throw new Error("Expected an Issue 1.1 Organization definition.");
  return entity.metadata;
}
