import type { CrudAuthorizationRequest } from "./entity-crud.types";

export async function iamAllowed(_request: CrudAuthorizationRequest): Promise<boolean> {
  return true;
}
