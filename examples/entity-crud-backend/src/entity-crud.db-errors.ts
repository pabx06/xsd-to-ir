import { UIAdapterValidationError } from "@sliwave/xsd-to-ir";

export interface DatabaseDriverError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
}

export class ForeignKeyReferenceNotFoundError extends Error {
  public constructor(public readonly constraintName?: string) {
    super("The referenced record does not exist");
    this.name = "ForeignKeyReferenceNotFoundError";
  }
}

export class RecordIsReferencedError extends Error {
  public constructor(public readonly constraintName?: string) {
    super("The record is referenced by another record");
    this.name = "RecordIsReferencedError";
  }
}

export class UniqueConstraintViolationError extends Error {
  public constructor(public readonly constraintName?: string) {
    super("A record with the same unique value already exists");
    this.name = "UniqueConstraintViolationError";
  }
}

export function translateDatabaseError(error: unknown): Error {
  if (error instanceof UIAdapterValidationError) return error;
  if (!isDatabaseDriverError(error)) {
    return error instanceof Error ? error : new Error("Unknown database error");
  }
  const constraintName = extractConstraintName(error);
  if (error.errno === 1452 || error.code === "ER_NO_REFERENCED_ROW_2") {
    return new ForeignKeyReferenceNotFoundError(constraintName);
  }
  if (error.errno === 1451 || error.code === "ER_ROW_IS_REFERENCED_2") {
    return new RecordIsReferencedError(constraintName);
  }
  if (error.errno === 1062 || error.code === "ER_DUP_ENTRY") {
    return new UniqueConstraintViolationError(constraintName);
  }
  return error;
}

function isDatabaseDriverError(error: unknown): error is DatabaseDriverError {
  return error instanceof Error && ("errno" in error || "code" in error || "sqlState" in error);
}

function extractConstraintName(error: DatabaseDriverError): string | undefined {
  const message = error.sqlMessage ?? error.message;
  const match = message.match(/CONSTRAINT\s+(['"`])([^'"`]+)\1/i);
  return match?.[2];
}
