import { beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../../../config/env", () => ({ env: { DB_PASSWORD: "runtime_password", LOG_LEVEL: "debug" } }));
import { SchemaRegistryService } from "../../schema/schema-registry.service";
import { CrudEntityNotFoundError } from "./entity-crud.errors";
import { EntityCrudRegistry } from "./entity-crud.registry";
import type { IRColumn, IREntity, IRValueType, IRModelJSON, S3000LVersion } from "@sliwave/xsd-to-ir";

const mockColumn = (overrides: Partial<IRColumn> = {}): IRColumn => ({
  name: "test_column", columnName: "test_column", xmlName: null, xmlKind: "element" as any,
  minOccurs: 1, maxOccurs: 1 as any, sqlType: "varchar", jsonType: "string" as any,
  nullable: false, defaultValue: null, isPrimaryKey: false, isForeignKey: false,
  referencesEntity: null, isEnum: false, enumRef: null, constraints: {} as any,
  documentation: null, xsdType: null, ...overrides,
} as IRColumn);

const mockEntity = (overrides: Partial<IREntity> = {}): IREntity => ({
  name: "product", tableName: "product", columns: [
    mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
      minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
      nullable: false, isPrimaryKey: true, documentation: "Surrogate primary key" }),
    mockColumn({ name: "uid", columnName: "uid", xmlName: "uid", xmlKind: "attribute" as any,
      minOccurs: 0, sqlType: "VARCHAR(255)", jsonType: "string" as any, nullable: true }),
    mockColumn({ name: "prodId", columnName: "prod_id", xmlName: "prodId", xmlKind: "element" as any,
      minOccurs: 1, maxOccurs: "unbounded" as any, sqlType: "LONGTEXT",
      jsonType: "object" as any, nullable: false }),
  ], relations: [], abstract: false, parentType: null, documentation: null, ...overrides,
} as IREntity);

const mockIr = (entities: Record<string, IREntity>, version: S3000LVersion = "1.1"): IRModelJSON => ({
  entities, valueTypes: {}, joinTables: {}, enums: {}, simpleTypes: {}, assertionPaths: {},
  s3000lMode: true, s3000lDialect: version, s3000lCollections: {},
} as IRModelJSON);

describe("EntityCrudRegistry - isColumnRequired", () => {
  it("should return true when the column is non-nullable, required by the IR, and has no default value", () => {
    const column = mockColumn({ nullable: false, minOccurs: 1, defaultValue: null });
    expect(EntityCrudRegistry.isColumnRequired(column)).toBe(true);
  });
  describe("should return false if at least one condition is not met", () => {
    it("should return false for 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY'", () => {
      const testColumn: IRColumn = mockColumn({
        name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, maxOccurs: 1, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, defaultValue: null, isPrimaryKey: true,
        documentation: "Surrogate primary key",
      });
      expect(EntityCrudRegistry.isColumnRequired(testColumn)).toBe(false);
    });
    it("should return false for 'DATETIME(3) DEFAULT NULL COMMENT Technical: soft-delete (crud=D)'", () => {
      const testDeletColumn: IRColumn = mockColumn({
        isPrimaryKey: false, isForeignKey: false, referencesEntity: null, isEnum: false,
        enumRef: null, constraints: {}, xsdType: null, xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, maxOccurs: 1, defaultValue: null, name: "_deletedAt",
        columnName: "_deleted_at", sqlType: "DATETIME(3)", jsonType: "string" as any,
        nullable: true, documentation: "Technical: soft-delete (crud=D)",
      });
      expect(EntityCrudRegistry.isColumnRequired(testDeletColumn)).toBe(false);
    });
    it("should return false when the column is nullable", () => {
      const column = mockColumn({ nullable: true, minOccurs: 1, defaultValue: null });
      expect(EntityCrudRegistry.isColumnRequired(column)).toBe(false);
    });
    it("should return false when minOccurs is 0", () => {
      const column = mockColumn({ nullable: false, minOccurs: 0, defaultValue: null });
      expect(EntityCrudRegistry.isColumnRequired(column)).toBe(false);
    });
    it("should return false when a default value is provided", () => {
      const column = mockColumn({ nullable: false, minOccurs: 1, defaultValue: "default_value" });
      expect(EntityCrudRegistry.isColumnRequired(column)).toBe(false);
    });
  });
});

describe("EntityCrudRegistry - buildDefinitions", () => {
  const registry = EntityCrudRegistry.getInstance();
  const schemaRegistry = SchemaRegistryService.getInstance();
  beforeEach(() => {
    vi.restoreAllMocks();
    registry.clearCache();
  });

  it("builds an entity definition from the schema IR", () => {
    const getIRSpy = vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(getIRSpy).toHaveBeenCalledOnce();
    expect(getIRSpy).toHaveBeenCalledWith("1.1");
    expect(definition).toMatchObject({ name: "product", tableName: "product", primaryKey: "id",
      fieldColumns: { prodId: "prod_id" }, readableColumns: ["id", "uid", "prod_id"],
      filterableColumns: ["id", "uid"], sortableColumns: ["id", "uid"],
      defaultSort: { column: "id", direction: "asc" },
    });
  });

  it("builds definitions for multiple entities", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({
      product: mockEntity(),
      organization: mockEntity({ name: "organization", tableName: "organization", columns: [
        mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
          minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
          nullable: false, isPrimaryKey: true }),
        mockColumn({ name: "name", columnName: "name", sqlType: "VARCHAR(255)" }),
      ] }),
    }));
    const definitions = registry.getEntityDefinitions("1.1");
    expect(definitions).toHaveLength(2);
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "product", tableName: "product" }),
      expect.objectContaining({ name: "organization", tableName: "organization" }),
    ]));
  });

  it("skips abstract entities", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({
      abstractBase: mockEntity({ name: "abstractBase", tableName: "abstract_base", abstract: true }),
      product: mockEntity(),
    }));
    const definitions = registry.getEntityDefinitions("1.1");
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ name: "product", tableName: "product" });
    expect(registry.hasEntity("1.1", "abstractBase")).toBe(false);
  });

  it("allows lookup by the explicit entity name when it differs from the IR key", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({
      ProductEntityKey: mockEntity({ name: "product", tableName: "product" }),
    }));
    const definitionByKey = registry.getEntityDefinition("1.1", "ProductEntityKey");
    const definitionByName = registry.getEntityDefinition("1.1", "product");
    expect(definitionByName).toBe(definitionByKey);
    expect(definitionByName.tableName).toBe("product");
  });

  it("uses the physical column name as the primary key", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "internalId", columnName: "internal_id", xmlName: null,
        xmlKind: "internal" as any, minOccurs: 0, sqlType: "BIGINT",
        jsonType: "integer" as any, nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "name", columnName: "product_name" }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(definition.primaryKey).toBe("internal_id");
    expect(definition.defaultSort).toEqual({ column: "internal_id", direction: "asc" });
  });

  it("builds readable columns from physical column names", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null,
        xmlKind: "internal" as any, minOccurs: 0, sqlType: "BIGINT",
        jsonType: "integer" as any, nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "prodName", columnName: "prod_name" }),
      mockColumn({ name: "prodDescription", columnName: "prod_description" }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(definition.readableColumns).toEqual(["id", "prod_name", "prod_description"]);
  });

  it("excludes object columns from generic sorting and filtering", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "docs", columnName: "docs", sqlType: "LONGTEXT",
        jsonType: "object" as any, nullable: true, minOccurs: 0 }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(definition.readableColumns).toContain("docs");
    expect(definition.filterableColumns).not.toContain("docs");
    expect(definition.sortableColumns).not.toContain("docs");
  });

  it("does not expose the primary key as a writable create field", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const result = await definition.createSchema.safeParseAsync({ id: 100, uid: "PRODUCT-001", prodId: { id: "A" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flattened = result.error.flatten();
      expect(flattened.formErrors).toContain("Unrecognized key(s) in object: 'id'");
      expect(flattened.fieldErrors).toEqual({});
    }
  });

  it("uses logical field names in the update schema", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ organization: mockEntity({
      name: "organization", tableName: "organization", columns: [
        mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
          minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
          nullable: false, isPrimaryKey: true }),
        mockColumn({ name: "orgId", columnName: "org_id", xmlName: "orgId", xmlKind: "element" as any,
          minOccurs: 1, maxOccurs: "unbounded" as any, sqlType: "LONGTEXT",
          jsonType: "object" as any, nullable: false }),
        mockColumn({ name: "name", columnName: "name", xmlName: "name", xmlKind: "element" as any,
          minOccurs: 0, sqlType: "LONGTEXT", jsonType: "object" as any, nullable: true }),
      ],
    }) }));
    const definition = registry.getEntityDefinition("1.1", "organization");
    const result = await definition.updateSchema.safeParseAsync({ orgId: [{ id: "SB501" }],
      name: { descr: "Yeti Bike Company2" } });
    expect(result).toEqual({ success: true, data: {
      orgId: [{ id: "SB501" }], name: { descr: "Yeti Bike Company2" },
    } });
  });

  it("rejects physical SQL column names in the update schema", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ organization: mockEntity({
      name: "organization", tableName: "organization", columns: [
        mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
          minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
          nullable: false, isPrimaryKey: true }),
        mockColumn({ name: "orgId", columnName: "org_id", xmlName: "orgId", xmlKind: "element" as any,
          minOccurs: 1, maxOccurs: "unbounded" as any, sqlType: "LONGTEXT",
          jsonType: "object" as any, nullable: false }),
      ],
    }) }));
    const definition = registry.getEntityDefinition("1.1", "organization");
    const result = await definition.updateSchema.safeParseAsync({ org_id: [{ id: "SB501" }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().formErrors).toContain(
      "Unrecognized key(s) in object: 'org_id'",
    );
  });

  it("uses logical field names in the create schema", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const result = await definition.createSchema.safeParseAsync({ uid: "PRODUCT-001", prodId: [{ id: "A" }] });
    expect(result).toEqual({ success: true, data: { uid: "PRODUCT-001", prodId: [{ id: "A" }] } });
  });

  it("generates a create schema with required and optional columns", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "name", columnName: "name", nullable: false, minOccurs: 1, defaultValue: null }),
      mockColumn({ name: "description", columnName: "description", nullable: true, minOccurs: 0, defaultValue: null }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const missingRequired = await definition.createSchema.safeParseAsync({ description: "Description" });
    expect(missingRequired.success).toBe(false);
    const valid = await definition.createSchema.safeParseAsync({ name: "Product A" });
    expect(valid).toEqual({ success: true, data: { name: "Product A" } });
  });

  it("generates an update schema where all writable columns are optional", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "name", columnName: "name", nullable: false, minOccurs: 1 }),
      mockColumn({ name: "status", columnName: "status", nullable: false, minOccurs: 1 }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const result = await definition.updateSchema.safeParseAsync({ status: "active" });
    expect(result).toEqual({ success: true, data: { status: "active" } });
  });

  it("rejects an empty update", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const result = await definition.updateSchema.safeParseAsync({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "At least one field must be provided" }),
      ]));
    }
  });

  it("generates enum validation from IR constraints", async () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "crud", columnName: "crud", xmlName: "crud", xmlKind: "attribute" as any,
        nullable: true, minOccurs: 0, defaultValue: "I", isEnum: true,
        enumRef: "crudCodeValues", constraints: { enum: ["I", "D", "U", "R", "N"] } as any }),
    ] }) }));
    const definition = registry.getEntityDefinition("1.1", "product");
    const valid = await definition.createSchema.safeParseAsync({ crud: "I" });
    expect(valid.success).toBe(true);
    const invalid = await definition.createSchema.safeParseAsync({ crud: "INVALID" });
    expect(invalid.success).toBe(false);
  });

  it("builds direct foreign-key relationship metadata", () => {
    const organization = mockEntity({ name: "organization", tableName: "organization" });
    const product = mockEntity({ columns: [
      mockColumn({ name: "id", columnName: "id", xmlName: null, xmlKind: "internal" as any,
        minOccurs: 0, sqlType: "BIGINT", jsonType: "integer" as any,
        nullable: false, isPrimaryKey: true }),
      mockColumn({ name: "organizationId", columnName: "organization_id", sqlType: "BIGINT",
        jsonType: "integer" as any, nullable: false, minOccurs: 1,
        isForeignKey: true, referencesEntity: "organization" }),
    ] });
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product, organization }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(definition.relations).toEqual(expect.arrayContaining([expect.objectContaining({
      column: "organization_id", referencedEntity: "organization", referencedColumn: "id",
      nullable: false, ownsForeignKey: true,
    })]));
  });

  it("builds inverse one-to-many relationship metadata", () => {
    const product = mockEntity({ relations: [{ kind: "one-to-many", fieldName: "prodVar",
      targetEntity: "productVariant", joinTable: null, parentColumn: "product_prod_var_parent_id",
      nullable: true, minOccurs: 0, maxOccurs: "unbounded" }] as any });
    const productVariant = mockEntity({ name: "productVariant", tableName: "product_variant" });
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product, productVariant }));
    const definition = registry.getEntityDefinition("1.1", "product");
    expect(definition.relations).toEqual(expect.arrayContaining([expect.objectContaining({
      column: "product_prod_var_parent_id", referencedEntity: "productVariant",
      referencedColumn: "id", nullable: true, kind: "one-to-many",
      fieldName: "prodVar", ownsForeignKey: false,
    })]));
  });

  it("throws when an entity has no primary key", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ invalidEntity: mockEntity({
      name: "invalidEntity", tableName: "invalid_entity", columns: [
        mockColumn({ name: "name", columnName: "name", isPrimaryKey: false }),
      ],
    }) }));
    expect(() => registry.getEntityDefinition("1.1", "invalidEntity"))
      .toThrow('Entity "invalidEntity" does not have a primary key');
  });

  it("throws when an entity has a composite primary key", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ compositeEntity: mockEntity({
      name: "compositeEntity", tableName: "composite_entity", columns: [
        mockColumn({ name: "firstId", columnName: "first_id", sqlType: "BIGINT",
          jsonType: "integer" as any, isPrimaryKey: true }),
        mockColumn({ name: "secondId", columnName: "second_id", sqlType: "BIGINT",
          jsonType: "integer" as any, isPrimaryKey: true }),
      ],
    }) }));
    expect(() => registry.getEntityDefinition("1.1", "compositeEntity"))
      .toThrow('Entity "compositeEntity" has a composite primary key');
  });

  it("throws CrudEntityNotFoundError for an unknown entity", () => {
    vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    expect(() => registry.getEntityDefinition("1.1", "unknownEntity"))
      .toThrow(CrudEntityNotFoundError);
  });

  it("caches definitions for the same version", () => {
    const getIRSpy = vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    const first = registry.getEntityDefinition("1.1", "product");
    const second = registry.getEntityDefinition("1.1", "product");
    expect(first).toBe(second);
    expect(getIRSpy).toHaveBeenCalledOnce();
  });

  it("creates separate caches for each S3000L version", () => {
    const getIRSpy = vi.spyOn(schemaRegistry, "getIR").mockImplementation((version) => {
      if (version === "1.1") return mockIr({ product: mockEntity({ tableName: "product_v11" }) }, "1.1");
      return mockIr({ product: mockEntity({ tableName: "product_v20" }) }, "2.0");
    });
    const issue11 = registry.getEntityDefinition("1.1", "product");
    const issue20 = registry.getEntityDefinition("2.0", "product");
    expect(issue11.tableName).toBe("product_v11");
    expect(issue20.tableName).toBe("product_v20");
    expect(getIRSpy).toHaveBeenCalledTimes(2);
    expect(getIRSpy).toHaveBeenCalledWith("1.1");
    expect(getIRSpy).toHaveBeenCalledWith("2.0");
  });

  it("rebuilds definitions after clearing one version cache", () => {
    const getIRSpy = vi.spyOn(schemaRegistry, "getIR").mockReturnValue(mockIr({ product: mockEntity() }));
    registry.getEntityDefinition("1.1", "product");
    registry.clearCache("1.1");
    registry.getEntityDefinition("1.1", "product");
    expect(getIRSpy).toHaveBeenCalledTimes(2);
  });
});
