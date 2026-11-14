import { describe, expect, it } from "vitest";
import {
  ForeignKeyReferenceNotFoundError,
  RecordIsReferencedError,
  UniqueConstraintViolationError,
  translateDatabaseError,
  type DatabaseDriverError,
} from "./entity-crud.db-errors";

function createDatabaseError(
  overrides: Partial<DatabaseDriverError> = {},
): DatabaseDriverError {
  return Object.assign(new Error("Database operation failed"), overrides);
}

describe("database error classes", () => {
  describe("ForeignKeyReferenceNotFoundError", () => {
    it("sets its name, message, and constraint name", () => {
      const error = new ForeignKeyReferenceNotFoundError(
        "fk_product_organization",
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ForeignKeyReferenceNotFoundError);
      expect(error.name).toBe("ForeignKeyReferenceNotFoundError");
      expect(error.message).toBe("The referenced record does not exist");
      expect(error.constraintName).toBe("fk_product_organization");
    });
    it("allows an undefined constraint name", () => {
      const error = new ForeignKeyReferenceNotFoundError();
      expect(error.constraintName).toBeUndefined();
    });
  });
  describe("RecordIsReferencedError", () => {
    it("sets its name, message, and constraint name", () => {
      const error = new RecordIsReferencedError("fk_order_product");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RecordIsReferencedError);
      expect(error.name).toBe("RecordIsReferencedError");
      expect(error.message).toBe("The record is referenced by another record");
      expect(error.constraintName).toBe("fk_order_product");
    });
    it("allows an undefined constraint name", () => {
      const error = new RecordIsReferencedError();
      expect(error.constraintName).toBeUndefined();
    });
  });
  describe("UniqueConstraintViolationError", () => {
    it("sets its name, message, and constraint name", () => {
      const error = new UniqueConstraintViolationError("uq_product_code");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error.name).toBe("UniqueConstraintViolationError");
      expect(error.message).toBe(
        "A record with the same unique value already exists",
      );
      expect(error.constraintName).toBe("uq_product_code");
    });
    it("allows an undefined constraint name", () => {
      const error = new UniqueConstraintViolationError();
      expect(error.constraintName).toBeUndefined();
    });
  });
});

describe("translateDatabaseError", () => {
  it("translates MariaDB errno 1452 into ForeignKeyReferenceNotFoundError", () => {
    const databaseError = createDatabaseError({
      errno: 1452,
      code: "ER_NO_REFERENCED_ROW_2",
      sqlState: "23000",
      sqlMessage:
        "Cannot add or update a child row: " +
        "a foreign key constraint fails " +
        "CONSTRAINT `fk_product_organization`",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(ForeignKeyReferenceNotFoundError);
    expect(result).toMatchObject({
      name: "ForeignKeyReferenceNotFoundError",
      message: "The referenced record does not exist",
      constraintName: "fk_product_organization",
    });
  });
  it("translates MariaDB errno 1451 into RecordIsReferencedError", () => {
    const databaseError = createDatabaseError({
      errno: 1451,
      code: "ER_ROW_IS_REFERENCED_2",
      sqlState: "23000",
      sqlMessage:
        "Cannot delete or update a parent row: " +
        "a foreign key constraint fails " +
        "CONSTRAINT `fk_order_product`",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(RecordIsReferencedError);
    expect(result).toMatchObject({
      name: "RecordIsReferencedError",
      message: "The record is referenced by another record",
      constraintName: "fk_order_product",
    });
  });
  it("translates MariaDB errno 1062 into UniqueConstraintViolationError", () => {
    const databaseError = createDatabaseError({
      errno: 1062,
      code: "ER_DUP_ENTRY",
      sqlState: "23000",
      sqlMessage:
        "Duplicate entry 'PRODUCT-001' for key " + '"uq_product_code"',
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(UniqueConstraintViolationError);
    expect(result).toMatchObject({
      name: "UniqueConstraintViolationError",
      message: "A record with the same unique value already exists",
    });
  });
  it("uses the Error message when sqlMessage is absent", () => {
    const databaseError = createDatabaseError({
      errno: 1452,
      message:
        "Foreign key constraint failed: " + "CONSTRAINT `fk_product_project`",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(ForeignKeyReferenceNotFoundError);
    expect((result as ForeignKeyReferenceNotFoundError).constraintName).toBe(
      "fk_product_project",
    );
  });
  it("supports a single-quoted constraint name", () => {
    const databaseError = createDatabaseError({
      errno: 1452,
      sqlMessage:
        "Foreign key constraint failed: " + "CONSTRAINT 'fk_product_project'",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(ForeignKeyReferenceNotFoundError);
    expect((result as ForeignKeyReferenceNotFoundError).constraintName).toBe(
      "fk_product_project",
    );
  });
  it("supports a double-quoted constraint name", () => {
    const databaseError = createDatabaseError({
      errno: 1451,
      sqlMessage:
        "Foreign key constraint failed: " + 'CONSTRAINT "fk_order_product"',
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(RecordIsReferencedError);
    expect((result as RecordIsReferencedError).constraintName).toBe(
      "fk_order_product",
    );
  });
  it("returns a translated error with a constraint name when none can be extracted", () => {
    const databaseError = createDatabaseError({
      errno: 1452,
      sqlMessage: "Foreign key constraint failed",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBeInstanceOf(ForeignKeyReferenceNotFoundError);
    expect(
      (result as ForeignKeyReferenceNotFoundError).constraintName,
    ).toBeUndefined();
  });
  it("returns an unrecognized database driver error unchanged", () => {
    const databaseError = createDatabaseError({
      errno: 9999,
      code: "ER_UNKNOWN",
      sqlState: "HY000",
    });
    const result = translateDatabaseError(databaseError);
    expect(result).toBe(databaseError);
  });
  it.each([
    { field: "errno", error: createDatabaseError({ errno: 9999 }) },
    { field: "code", error: createDatabaseError({ code: "ER_UNKNOWN" }) },
    { field: "sqlState", error: createDatabaseError({ sqlState: "HY000" }) },
  ])(
    "recognizes an Error containing only the $field driver field",
    ({ error }) => {
      const result = translateDatabaseError(error);
      expect(result).toBe(error);
    },
  );
  it("returns a regular Error unchanged", () => {
    const originalError = new Error("Regular application error");
    const result = translateDatabaseError(originalError);
    expect(result).toBe(originalError);
  });
  it.each([
    undefined,
    null,
    "database failure",
    42,
    true,
    {},
    { errno: 1452, message: "Not an Error instance" },
  ])("returns Unknown database error for a non-Error value: %s", (value) => {
    const result = translateDatabaseError(value);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Unknown database error");
  });
});
