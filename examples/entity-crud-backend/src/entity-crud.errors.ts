export interface FieldIssue {
  path: string;
  message: string;
}
export class CrudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: { issues: FieldIssue[] },
    public readonly status?: string,
    public readonly constraint?: string,
  ) {
    super(message);
    this.name = "CrudError";
  }
}
export class CrudValidationError extends CrudError {
  constructor(issues: FieldIssue[], message = "Check the marked fields.") {
    super("invalid_request", message, 400, { issues });
  }
}
export class CrudEntityNotFoundError extends CrudError {
  constructor(name: string) {
    super("entity_not_found", `Unknown entity "${name}".`, 404);
  }
}
export class CrudRecordNotFoundError extends CrudError {
  constructor(name: string, id: string) {
    super("record_not_found", `No active ${name} record "${id}".`, 404);
  }
}
export class CrudInvalidQueryError extends CrudError {
  constructor(message: string) {
    super("invalid_query", message);
  }
}
export class CrudForbiddenError extends CrudError {
  constructor() {
    super("forbidden", "This operation is not permitted.", 403);
  }
}
export class CrudSummaryNotSupportedError extends CrudError {
  constructor(name: string) {
    super("summary_not_supported", `No summary for "${name}".`, 404);
  }
}
