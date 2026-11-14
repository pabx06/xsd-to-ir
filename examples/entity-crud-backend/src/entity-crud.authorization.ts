import type { Authorizer, CrudAuthorizationRequest } from "./entity-crud.types";
/** The host supplies its real permission implementation. Missing/unknown actors never pass. */
export async function iamAllowed(
  request: CrudAuthorizationRequest,
  authorize?: Authorizer,
): Promise<boolean> {
  if (!authorize || !request.actor.id || request.actor.id === "unknown")
    return false;
  return (await authorize(request)) === true;
}
