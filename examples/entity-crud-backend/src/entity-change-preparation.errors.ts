export class EntityIdentityValidationError extends Error {
  public constructor(message: string, public readonly path: string) {
    super(message);
    this.name = "EntityIdentityValidationError";
  }
}
