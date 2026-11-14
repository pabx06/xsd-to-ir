import { CrudValidationError } from "./entity-crud.errors";
export class EntityIdentityValidationError extends CrudValidationError {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super([{ path, message }]);
    this.name = "EntityIdentityValidationError";
  }
}
