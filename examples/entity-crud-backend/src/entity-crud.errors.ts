export class CrudEntityNotFoundError extends Error {
  constructor(entity: string) { super(`CRUD entity "${entity}" is not registered`);
    this.name = "CrudEntityNotFoundError"; }
}
export class CrudRecordNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`Record "${id}" was not found in entity "${entity}"`); this.name = "CrudRecordNotFoundError";
  }
}
export class CrudForbiddenError extends Error {
  constructor() { super("The current actor is not allowed to perform this operation");
    this.name = "CrudForbiddenError"; }
}
export class CrudInvalidQueryError extends Error {
  constructor(message: string) { super(message); this.name = "CrudInvalidQueryError"; }
}
export class CrudSummaryNotSupportedError extends Error {
  constructor(entity: string) { super(`Entity "${entity}" does not provide a summary`);
    this.name = "CrudSummaryNotSupportedError"; }
}
