import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import type { Mock } from "vitest";
import { z } from "zod";
vi.mock("../../../config/env", () => ({ env: { DB_HOST: "localhost", DB_PORT: 3306,
  DB_USER: "runtime_user", DB_PASSWORD: "runtime_password", DB_NAME: "catalog_db", LOG_LEVEL: "debug" } }));
import { EntityCrudService, EntityRecordResult } from "./entity-crud.service";
import { CrudInvalidQueryError, CrudRecordNotFoundError } from "./entity-crud.errors";
import { translateDatabaseError } from "./entity-crud.db-errors";
import type { CrudContext, EntityDefinition, ListEntitiesInput } from "./entity-crud.types";
import { EntityCrudRegistry } from "./entity-crud.registry";
import { SQLRow } from "@sliwave/xsd-to-ir";

vi.mock("./entity-crud.db-errors", () => ({
  translateDatabaseError: vi.fn((error: unknown) => error),
}));

type MockFunction = Mock;

interface MockQueryBuilder {
  select: MockFunction; count: MockFunction; where: MockFunction;
  whereNull: MockFunction; orderBy: MockFunction; limit: MockFunction;
  offset: MockFunction; first: MockFunction; forUpdate: MockFunction;
  insert: MockFunction; update: MockFunction; delete: MockFunction;
  then: Promise<unknown>["then"]; catch: Promise<unknown>["catch"];
  finally: Promise<unknown>["finally"];
}
type MockKnex = Mock & { transaction: Mock; fn: { now: Mock } };
function createQueryBuilder(result: unknown): MockQueryBuilder {
  const promise = Promise.resolve(result);
  const builder = {} as MockQueryBuilder;
  builder.select = vi.fn(() => builder);
  builder.count = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.whereNull = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.first = vi.fn(() => builder);
  builder.forUpdate = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.delete = vi.fn(() => builder);
  builder.then = promise.then.bind(promise);
  builder.catch = promise.catch.bind(promise);
  builder.finally = promise.finally.bind(promise);
  return builder;
}
function createRejectedQueryBuilder(error: unknown): MockQueryBuilder {
  const builder = {} as MockQueryBuilder;
  builder.select = vi.fn(() => builder);
  builder.count = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.whereNull = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.first = vi.fn(() => builder);
  builder.forUpdate = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.delete = vi.fn(() => builder);
  builder.then = vi.fn((onFulfilled, onRejected) => Promise.reject(error).then(onFulfilled, onRejected)) as unknown as Promise<unknown>["then"];
  builder.catch = vi.fn((onRejected) => Promise.reject(error).catch(onRejected)) as unknown as Promise<unknown>["catch"];
  builder.finally = vi.fn((onFinally) => Promise.reject(error).finally(onFinally)) as unknown as Promise<unknown>["finally"];
  return builder;
}
function createKnexMock(...builders: MockQueryBuilder[]): MockKnex {
  const queue = [...builders];
  const knex = vi.fn(() => {
    const builder = queue.shift();
    if (!builder) throw new Error("No mocked query builder remains in the queue");
    return builder;
  }) as unknown as MockKnex;
  knex.transaction = vi.fn(async (callback: (trx: Knex.Transaction) => Promise<unknown>) =>
    callback(knex as unknown as Knex.Transaction));
  knex.fn = { now: vi.fn(() => "MOCK_NOW") };
  return knex;
}
function createEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  const tmpRegistrie = EntityCrudRegistry.getInstance();
  const tmpDefinition = tmpRegistrie.getEntityDefinition("1.1", "product");
  return {
    dialectVersion: "1.1", name: "product", tableName: "product", primaryKey: "id",
    readableColumns: ["id", "_created_at", "_updated_at", "_deleted_at", "_msg_seq", "prod_id", "name", "bkdns", "org_infos", "docs", "rmks", "uid", "crud"],
    relations: [{ column: "product_prod_var_parent_id", referencedEntity: "productVariant",
      referencedColumn: "id", nullable: true, kind: "one-to-many", fieldName: "prodVar", ownsForeignKey: false }],
    sortableColumns: ["id", "_created_at", "_updated_at", "_deleted_at", "_msg_seq", "uid", "crud"],
    filterableColumns: ["id", "_created_at", "_updated_at", "_deleted_at", "_msg_seq", "uid", "crud"],
    defaultSort: { column: "id", direction: "asc" },
    fieldColumns: { id: "id", createdAt: "_created_at", updatedAt: "_updated_at",
      deletedAt: "_deleted_at", msgSeq: "_msg_seq", prodId: "prod_id",
      name: "name", bkdns: "bkdns", orgInfos: "org_infos", docs: "docs",
      rmks: "rmks", uid: "uid", crud: "crud" },
    createSchema: tmpDefinition.createSchema,
    updateSchema: tmpDefinition.updateSchema,
    replaceSchema: tmpDefinition.replaceSchema,
    preparedCreateSchema: tmpDefinition.preparedCreateSchema,
    preparedReplaceSchema: tmpDefinition.preparedReplaceSchema,
    ...overrides,
  };
}
function createContext(knex: MockKnex, entity: EntityDefinition): CrudContext {
  return { knex: knex as unknown as Knex, entity } as CrudContext;
}
const DEFAULT_TIMESTAMP = "2026-10-28T10:52:47.546Z";
function createProductRow(overrides: Partial<SQLRow> = {}): SQLRow {
  return { id: 42, uid: "prod-42", crud: "I", _created_at: DEFAULT_TIMESTAMP,
    _updated_at: DEFAULT_TIMESTAMP, _deleted_at: null, _msg_seq: 0,
    name: JSON.stringify([{ descr: "Product A" }]), ...overrides };
}
function createExpectedProductRecord(overrides: Partial<EntityRecordResult> = {}) {
  return { id: 42, uid: "prod-42", crud: "I", pendingExport: true,
    _createdAt: DEFAULT_TIMESTAMP, _updatedAt: DEFAULT_TIMESTAMP,
    _deletedAt: null, value: { name: [{ descr: "Product A" }] }, ...overrides };
}

describe("EntityCrudService", () => {
  let service: EntityCrudService;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(translateDatabaseError).mockImplementation((error: unknown) => error as Error);
    service = new EntityCrudService();
  });

  describe("list", () => {
    it("returns paginated records and metadata", async () => {
      const entity = createEntity();
      const records = [
        { id: 1, _created_at: "2026-10-14T08:02:47.081Z",
          _updated_at: "2026-10-14T08:02:47.081Z", _deleted_at: null, _msg_seq: 0,
          prod_id: { id: "YB" }, name: '{"descr":"Yeti Beti"}',
          bkdns: '{"bkdnType":{"code":"SY"},"@_uid":"bkdn151944484750679569719022409353614305149"}',
          org_infos: null, docs: null, rmks: null,
          uid: "prod21804079431019224539821444141973604487", crud: "I" },
        { id: 2, _created_at: "2026-10-14T08:02:47.081Z",
          _updated_at: "2026-10-14T08:02:47.081Z", _deleted_at: null, _msg_seq: 0,
          prod_id: { id: "YB" }, name: '{"descr":"Product B"}',
          bkdns: null, org_infos: null, docs: null, rmks: null, uid: "prodB", crud: "I" },
      ];
      const expectedData = [
        { _createdAt: "2026-10-14T08:02:47.081Z", crud: "I", _deletedAt: null,
          _updatedAt: "2026-10-14T08:02:47.081Z", id: 1, pendingExport: true,
          uid: "prod21804079431019224539821444141973604487",
          value: { bkdns: { bkdn: [{ bkdnType: { code: "SY" }, uid: "bkdn151944484750679569719022409353614305149" }] },
            name: [{ descr: "Yeti Beti" }], prodId: [{ id: "YB" }] } },
        { _createdAt: "2026-10-14T08:02:47.081Z", crud: "I", _deletedAt: null,
          _updatedAt: "2026-10-14T08:02:47.081Z", id: 2, pendingExport: true,
          uid: "prodB", value: { name: [{ descr: "Product B" }], prodId: [{ id: "YB" }] } },
      ];
      const dataQuery = createQueryBuilder(records);
      const countQuery = createQueryBuilder([{ total: "5" }]);
      const knex = createKnexMock(dataQuery, countQuery);
      const input: ListEntitiesInput = { page: 2, pageSize: 2, filters: { _msgSeq: 0 },
        sortBy: "id", sortDirection: "asc" };
      const result = await service.list(knex as unknown as Knex, entity, input);
      expect(result).toEqual({ data: expect.any(Array), metadata: {
        page: 2, pageSize: 2, total: 5, pageCount: 3,
      } });
      expect(knex).toHaveBeenNthCalledWith(1, "product");
      expect(knex).toHaveBeenNthCalledWith(2, "product");
      expect(dataQuery.select).toHaveBeenCalledWith(entity.readableColumns);
      expect(dataQuery.where).toHaveBeenCalledWith("_msg_seq", 0);
      expect(dataQuery.orderBy).toHaveBeenCalledWith("id", "asc");
      expect(dataQuery.limit).toHaveBeenCalledWith(2);
      expect(dataQuery.offset).toHaveBeenCalledWith(2);
      expect(countQuery.count).toHaveBeenCalledWith({ total: "*" });
      expect(countQuery.where).toHaveBeenCalledWith("_msg_seq", 0);
    });

    it("uses a physical default sort column without resolving it as a public field", async () => {
      const entity = createEntity({ primaryKey: "internal_id", fieldColumns: { internalId: "internal_id" },
        sortableColumns: ["internal_id"], defaultSort: { column: "internal_id", direction: "asc" } });
      const dataQuery = createQueryBuilder([]);
      const countQuery = createQueryBuilder([{ total: 0 }]);
      const knex = createKnexMock(dataQuery, countQuery);
      await service.list(knex as unknown as Knex, entity, {
        page: 1, pageSize: 20, filters: {}, sortDirection: "desc",
      });
      expect(dataQuery.orderBy).toHaveBeenCalledWith("internal_id", "asc");
    });

    it("uses the entity default sort when sortBy is omitted", async () => {
      const entity = createEntity({ defaultSort: { column: "name", direction: "asc" },
        sortableColumns: ["name"] });
      const dataQuery = createQueryBuilder([]);
      const countQuery = createQueryBuilder([{ total: 0 }]);
      const knex = createKnexMock(dataQuery, countQuery);
      const input = { page: 1, pageSize: 20, filters: {}, sortDirection: "desc" } as ListEntitiesInput;
      const result = await service.list(knex as unknown as Knex, entity, input);
      expect(dataQuery.orderBy).toHaveBeenCalledWith("name", "asc");
      expect(result.metadata).toEqual({ page: 1, pageSize: 20, total: 0, pageCount: 0 });
    });

    it("uses the primary key when neither sortBy nor defaultSort is provided", async () => {
      const entity = createEntity({ defaultSort: undefined });
      const dataQuery = createQueryBuilder([]);
      const countQuery = createQueryBuilder([{ total: 0 }]);
      const knex = createKnexMock(dataQuery, countQuery);
      await service.list(knex as unknown as Knex, entity, { page: 1, pageSize: 10,
        filters: {}, sortDirection: "asc" });
      expect(dataQuery.orderBy).toHaveBeenCalledWith("id", "asc");
    });

    it("applies every supplied filter to both queries", async () => {
      const entity = createEntity();
      const dataQuery = createQueryBuilder([]);
      const countQuery = createQueryBuilder([{ total: 0 }]);
      const knex = createKnexMock(dataQuery, countQuery);
      const input: ListEntitiesInput = { page: 1, pageSize: 10,
        filters: { id: 10, _msgSeq: 0 }, sortBy: "id", sortDirection: "asc" };
      await service.list(knex as unknown as Knex, entity, input);
      expect(dataQuery.where).toHaveBeenCalledTimes(2);
      expect(dataQuery.where).toHaveBeenCalledWith("id", 10);
      expect(dataQuery.where).toHaveBeenCalledWith("_msg_seq", 0);
      expect(countQuery.where).toHaveBeenCalledTimes(2);
      expect(countQuery.where).toHaveBeenCalledWith("id", 10);
      expect(countQuery.where).toHaveBeenCalledWith("_msg_seq", 0);
    });

    it("throws when the sort column is not allowed", async () => {
      const entity = createEntity();
      const knex = createKnexMock();
      const input = { page: 1, pageSize: 10, filters: {}, sortBy: "forbiddenColumn",
        sortDirection: "asc" } as ListEntitiesInput;
      await expect(service.list(knex as unknown as Knex, entity, input))
        .rejects.toThrow(CrudInvalidQueryError);
      await expect(service.list(knex as unknown as Knex, entity, input)).rejects.toThrow(
        'Unknown field "forbiddenColumn" for entity "product"',
      );
      expect(knex).not.toHaveBeenCalled();
    });

    it("throws when a filter column is not allowed", async () => {
      const entity = createEntity();
      const knex = createKnexMock();
      const input = { page: 1, pageSize: 10, filters: { forbiddenColumn: "value" },
        sortBy: "id", sortDirection: "asc" } as ListEntitiesInput;
      await expect(service.list(knex as unknown as Knex, entity, input))
        .rejects.toThrow(CrudInvalidQueryError);
      await expect(service.list(knex as unknown as Knex, entity, input)).rejects.toThrow(
        'Unknown field "forbiddenColumn" for entity "product"',
      );
      expect(knex).not.toHaveBeenCalled();
    });

    it("handles a missing count result as zero", async () => {
      const entity = createEntity();
      const dataQuery = createQueryBuilder([]);
      const countQuery = createQueryBuilder([]);
      const knex = createKnexMock(dataQuery, countQuery);
      const input: ListEntitiesInput = { page: 1, pageSize: 10,
        filters: {}, sortBy: "id", sortDirection: "asc" };
      const result = await service.list(knex as unknown as Knex, entity, input);
      expect(result.metadata.total).toBe(0);
      expect(result.metadata.pageCount).toBe(0);
    });
  });

  describe("findById", () => {
    it("returns the requested record", async () => {
      const entity = createEntity();
      const record = createProductRow({ id: 42, uid: "prod21804079431019224539821444141973604487",
        name: JSON.stringify({ descr: "Product A" }) });
      const expected = { _createdAt: DEFAULT_TIMESTAMP, crud: "I", _deletedAt: null,
        id: 42, pendingExport: true, uid: "prod21804079431019224539821444141973604487",
        _updatedAt: DEFAULT_TIMESTAMP, value: { name: [{ descr: "Product A" }] } };
      const query = createQueryBuilder(record);
      const knex = createKnexMock(query);
      const result = await service.findById(knex as unknown as Knex, entity, "42");
      expect(result).toEqual(expected);
      expect(knex).toHaveBeenCalledWith("product");
      expect(query.select).toHaveBeenCalledWith(entity.readableColumns);
      expect(query.where).toHaveBeenCalledWith("id", "42");
      expect(query.first).toHaveBeenCalledOnce();
    });
    it("throws when the record does not exist", async () => {
      const entity = createEntity();
      const query = createQueryBuilder(undefined);
      const knex = createKnexMock(query);
      await expect(service.findById(knex as unknown as Knex, entity, "missing-id"))
        .rejects.toThrow(CrudRecordNotFoundError);
    });
  });

  describe("create", () => {
    it("inserts and reloads the created record", async () => {
      const entity = createEntity();
      const insertQuery = createQueryBuilder([42]);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 42 }));
      const knex = createKnexMock(insertQuery, reloadQuery);
      const context = createContext(knex, entity);
      const result = await service.create(context, {
        name: [{ descr: "Product A" }], prodId: [{ id: "YB" }], uid: "pa",
      });
      expect(result).toEqual(createExpectedProductRecord());
      expect(knex.transaction).toHaveBeenCalledOnce();
      expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
        _msg_seq: 0, crud: "I", name: '[{"descr":"Product A"}]',
        prod_id: '{"id":"YB"}', uid: "pa",
      }));
      expect(reloadQuery.select).toHaveBeenCalledWith(entity.readableColumns);
      expect(reloadQuery.where).toHaveBeenCalledWith("id", 42);
      expect(reloadQuery.first).toHaveBeenCalledOnce();
    });

    it("supports an object-shaped inserted identifier", async () => {
      const entity = createEntity();
      const insertQuery = createQueryBuilder([{ id: "generated-id" }]);
      const reloadQuery = createQueryBuilder(createProductRow({ id: "generated-id", uid: "generated-product" }));
      const knex = createKnexMock(insertQuery, reloadQuery);
      const result = await service.create(createContext(knex, entity), {
        name: [{ descr: "Product A" }], prodId: [{ id: "YB" }],
      });
      expect(result).toEqual(expect.objectContaining({ id: "generated-id",
        uid: "generated-product", crud: "I", pendingExport: true,
        _createdAt: DEFAULT_TIMESTAMP, _updatedAt: DEFAULT_TIMESTAMP,
        _deletedAt: null, value: { name: [{ descr: "Product A" }] },
      }));
      expect(reloadQuery.where).toHaveBeenCalledWith("id", "generated-id");
    });

    it("calls beforeCreate with the transaction context", async () => {
      const beforeCreate = vi.fn(async () => ({ name: [{ descr: "Normalized Product" }],
        prodId: [{ id: "YB" }], uid: "normalized-product" }));
      const entity = createEntity({ beforeCreate });
      const insertQuery = createQueryBuilder([1]);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 1, uid: "normalized-product",
        name: JSON.stringify([{ descr: "Normalized Product" }]),
        prod_id: JSON.stringify({ id: "YB" }) }));
      const knex = createKnexMock(insertQuery, reloadQuery);
      const context = createContext(knex, entity);
      await service.create(context, { name: [{ descr: "Original Product" }], prodId: [{ id: "YB" }] });
      expect(beforeCreate).toHaveBeenCalledWith({ name: [{ descr: "Original Product" }],
        prodId: [{ id: "YB" }] }, expect.objectContaining({ entity, knex }));
      expect(insertQuery.insert).toHaveBeenCalledWith({
        name: JSON.stringify([{ descr: "Normalized Product" }]),
        prod_id: JSON.stringify([{ id: "YB" }]), uid: "normalized-product",
        crud: "I", _msg_seq: 0,
      });
    });

    it("encodes IR-backed complex fields before insertion", async () => {
      const entity = createEntity();
      const insertQuery = createQueryBuilder([1]);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 1,
        name: JSON.stringify({ descr: "Product A" }), prod_id: JSON.stringify([{ id: "YB" }]),
        bkdns: JSON.stringify({ bkdn: [{ bkdnType: { code: "SY" }, "@_uid": "bkdn-1" }] }) }));
      const knex = createKnexMock(insertQuery, reloadQuery);
      await service.create(createContext(knex, entity), {
        name: [{ descr: "Product A" }], prodId: [{ id: "YB" }],
        bkdns: { bkdn: [{ bkdnType: { code: "SY" }, uid: "bkdn-1" }] },
      });
      expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
        crud: "I", _msg_seq: 0,
      }));
      const insertedValues = insertQuery.insert.mock.calls[0][0];
      expect(typeof insertedValues.name).toBe("string");
      expect(typeof insertedValues.bkdns).toBe("string");
    });

    it("throws when the inserted identifier cannot be determined", async () => {
      const entity = createEntity();
      const insertQuery = createQueryBuilder([]);
      const knex = createKnexMock(insertQuery);
      await expect(service.create(createContext(knex, entity), {
        name: [{ descr: "Product A" }], prodId: [{ id: "YB" }],
      })).rejects.toThrow('Could not determine the inserted identifier for entity "product"');
    });

    it("throws when the created record cannot be reloaded", async () => {
      const entity = createEntity();
      const insertQuery = createQueryBuilder([42]);
      const reloadQuery = createQueryBuilder(undefined);
      const knex = createKnexMock(insertQuery, reloadQuery);
      await expect(service.create(createContext(knex, entity), {
        name: [{ descr: "Product A" }], prodId: [{ id: "YB" }],
      })).rejects.toThrow('Created record could not be reloaded for entity "product"');
    });

    it("translates database errors", async () => {
      const databaseError = new Error("Duplicate entry");
      const translatedError = new Error("Translated database error");
      vi.mocked(translateDatabaseError).mockReturnValue(translatedError);
      const entity = createEntity();
      const productSchema = z.object({ name: z.array(z.object({ descr: z.string() })) });
      entity.createSchema = productSchema; entity.updateSchema = productSchema;
      const insertQuery = createRejectedQueryBuilder(databaseError);
      const knex = createKnexMock(insertQuery);
      await expect(service.create(createContext(knex, entity), {
        name: [{ descr: "Product A" }],
      })).rejects.toBe(translatedError);
      expect(translateDatabaseError).toHaveBeenCalledWith(databaseError);
    });
  });

  describe("update", () => {
    it("updates and reloads an existing record", async () => {
      const entity = createEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42, uid: "prod-42",
        name: JSON.stringify({ descr: "Original Product" }) }));
      const updateQuery = createQueryBuilder(1);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 42, uid: "prod-42",
        crud: "U", name: JSON.stringify({ descr: "Updated Product" }) }));
      const knex = createKnexMock(existingQuery, updateQuery, reloadQuery);
      const result = await service.update(createContext(knex, entity), "42", {
        name: [{ descr: "Updated Product" }],
      });
      expect(result).toEqual({ id: 42, uid: "prod-42", crud: "U",
        pendingExport: true, _createdAt: DEFAULT_TIMESTAMP, _updatedAt: DEFAULT_TIMESTAMP,
        _deletedAt: null, value: { name: [{ descr: "Updated Product" }] } });
      expect(existingQuery.select).toHaveBeenCalledWith(entity.readableColumns);
      expect(existingQuery.where).toHaveBeenCalledWith("id", "42");
      expect(existingQuery.whereNull).toHaveBeenCalledWith("_deleted_at");
      expect(existingQuery.forUpdate).toHaveBeenCalledOnce();
      expect(existingQuery.first).toHaveBeenCalledOnce();
      expect(updateQuery.where).toHaveBeenCalledWith("id", "42");
      expect(updateQuery.whereNull).toHaveBeenCalledWith("_deleted_at");
      expect(updateQuery.update).toHaveBeenCalledWith({ name: JSON.stringify({ descr: "Updated Product" }),
        crud: "U", uid: "prod-42", _msg_seq: 0 });
      expect(reloadQuery.select).toHaveBeenCalledWith(entity.readableColumns);
      expect(reloadQuery.where).toHaveBeenCalledWith("id", "42");
      expect(reloadQuery.first).toHaveBeenCalledOnce();
    });

    it("calls beforeUpdate and serializes its result", async () => {
      const beforeUpdate = vi.fn(async () => ({ name: [{ descr: "Normalized Product" }] }));
      const entity = createEntity({ beforeUpdate });
      const existingQuery = createQueryBuilder(createProductRow({ id: 42,
        name: JSON.stringify({ descr: "Existing Product" }) }));
      const updateQuery = createQueryBuilder(1);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 42, crud: "U",
        name: JSON.stringify({ descr: "Normalized Product" }) }));
      const knex = createKnexMock(existingQuery, updateQuery, reloadQuery);
      const context = createContext(knex, entity);
      await service.update(context, "42", { name: [{ descr: "Original Product" }] });
      expect(beforeUpdate).toHaveBeenCalledWith({ name: [{ descr: "Original Product" }],
        uid: "prod-42", crud: "I" }, expect.objectContaining({ entity, knex }));
      expect(updateQuery.update).toHaveBeenCalledWith({ name: JSON.stringify({ descr: "Normalized Product" }),
        crud: "U", _msg_seq: 0 });
    });

    it("throws when the record does not exist before update", async () => {
      const entity = createEntity();
      const existingQuery = createQueryBuilder(undefined);
      const knex = createKnexMock(existingQuery);
      await expect(service.update(createContext(knex, entity), "missing-id", {
        name: [{ descr: "Updated Product" }],
      })).rejects.toThrow(CrudRecordNotFoundError);
      expect(knex).toHaveBeenCalledOnce();
      expect(existingQuery.forUpdate).toHaveBeenCalledOnce();
    });

    it("throws when the updated record cannot be reloaded", async () => {
      const entity = createEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42 }));
      const updateQuery = createQueryBuilder(1);
      const reloadQuery = createQueryBuilder(undefined);
      const knex = createKnexMock(existingQuery, updateQuery, reloadQuery);
      await expect(service.update(createContext(knex, entity), "42", {
        name: [{ descr: "Updated Product" }],
      })).rejects.toThrow(CrudRecordNotFoundError);
    });

    it("translates database errors raised during update", async () => {
      const databaseError = new Error("Foreign key constraint failed");
      const translatedError = new Error("Translated foreign key error");
      vi.mocked(translateDatabaseError).mockReturnValue(translatedError);
      const entity = createEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42 }));
      const updateQuery = createRejectedQueryBuilder(databaseError);
      const knex = createKnexMock(existingQuery, updateQuery);
      await expect(service.update(createContext(knex, entity), "42", {
        name: [{ descr: "Updated Product" }],
      })).rejects.toBe(translatedError);
      expect(translateDatabaseError).toHaveBeenCalledWith(databaseError);
    });
  });

  describe("replace", () => {
    // The source snapshots exercise the identity-preparation workflow indirectly.
    // This mock isolates the SQL replacement behavior from UID allocation/history.
    function replacementService(preparedValue?: Record<string, unknown>, changed = true) {
      const prepareReplacement = vi.fn(async (input: { submittedValue: Record<string, unknown> }) => ({
        changed, rootCrud: "U" as const,
        value: preparedValue ?? { ...input.submittedValue, uid: "prod-42", crud: "U" },
      }));
      return { instance: new EntityCrudService({ prepareReplacement } as any), prepareReplacement };
    }
    function replacementEntity() {
      const entity = createEntity({
        replaceSchema: z.object({ prodId: z.array(z.record(z.unknown())),
          docs: z.record(z.unknown()).nullable().optional() }).strict(),
        preparedReplaceSchema: z.object({ prodId: z.array(z.record(z.unknown())),
          docs: z.record(z.unknown()).nullable().optional(),
          uid: z.string(), crud: z.enum(["I", "U", "R", "D", "N"]) }).strict(),
      });
      entity.identityPolicy = { root: { identityType: "product", uid: {
        prefix: "prod", maxLength: 255, pattern: /^prod.+$/ } }, nested: [] };
      return entity;
    }

    it("replaces the complete business value and clears omitted fields", async () => {
      const entity = replacementEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42, uid: "prod-42", crud: "R",
        prod_id: JSON.stringify([{ id: "001234" }]), name: JSON.stringify([{ descr: "Old name" }]),
        docs: JSON.stringify({ doc: [{ "@_uid": "docasg91", docRef: { "@_uidRef": "doc123" } }] }) }));
      const updateQuery = createQueryBuilder(1);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 42, uid: "prod-42", crud: "U",
        prod_id: JSON.stringify([{ id: "001234" }]), name: null, docs: null,
        _updated_at: "MOCK_NOW", _msg_seq: 0 }));
      const knex = createKnexMock(existingQuery, updateQuery, reloadQuery);
      const { instance } = replacementService({
        prodId: [{ id: "001234" }], docs: null, uid: "prod-42", crud: "U",
      });
      const result = await instance.replace(createContext(knex, entity), "42", {
        prodId: [{ id: "001234" }], docs: null,
      });
      expect(existingQuery.forUpdate).toHaveBeenCalledOnce();
      expect(existingQuery.whereNull).toHaveBeenCalledWith("_deleted_at");
      const writtenValues = updateQuery.update.mock.calls[0][0];
      expect(writtenValues).toEqual(expect.objectContaining({
        uid: "prod-42", crud: "U", _msg_seq: 0, _updated_at: "MOCK_NOW",
      }));
      expect(writtenValues.name).not.toBe(JSON.stringify([{ descr: "Old name" }]));
      expect(result).toEqual(expect.objectContaining({ id: 42, uid: "prod-42", crud: "U",
        pendingExport: true, value: expect.not.objectContaining({ name: expect.anything() }),
      }));
    });

    it("distinguishes explicit null from omission through adapter encoding", async () => {
      const entity = replacementEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42,
        docs: JSON.stringify({ doc: [{ "@_uid": "docasg91", docRef: { "@_uidRef": "doc123" } }] }) }));
      const updateQuery = createQueryBuilder(1);
      const reloadQuery = createQueryBuilder(createProductRow({ id: 42, crud: "U", docs: null }));
      const knex = createKnexMock(existingQuery, updateQuery, reloadQuery);
      const { instance } = replacementService({ prodId: [{ id: "001234" }], docs: null,
        uid: "prod-42", crud: "U" });
      await instance.replace(createContext(knex, entity), "42", {
        prodId: [{ id: "001234" }], docs: null,
      });
      expect(updateQuery.update).toHaveBeenCalledOnce();
    });

    it("throws when the active record does not exist", async () => {
      const entity = replacementEntity();
      const existingQuery = createQueryBuilder(undefined);
      const knex = createKnexMock(existingQuery);
      const { instance } = replacementService();
      await expect(instance.replace(createContext(knex, entity), "missing-id", {
        prodId: [{ id: "001234" }],
      })).rejects.toThrow(CrudRecordNotFoundError);
      expect(existingQuery.forUpdate).toHaveBeenCalledOnce();
      expect(knex).toHaveBeenCalledOnce();
    });

    it("translates database errors raised during replacement", async () => {
      const databaseError = new Error("Foreign key constraint failed");
      const translatedError = new Error("Translated database error");
      vi.mocked(translateDatabaseError).mockReturnValue(translatedError);
      const entity = replacementEntity();
      const existingQuery = createQueryBuilder(createProductRow({ id: 42, uid: "prod-42" }));
      const updateQuery = createRejectedQueryBuilder(databaseError);
      const knex = createKnexMock(existingQuery, updateQuery);
      const { instance } = replacementService({ prodId: [{ id: "001234" }],
        uid: "prod-42", crud: "U" });
      await expect(instance.replace(createContext(knex, entity), "42", {
        prodId: [{ id: "001234" }],
      })).rejects.toBe(translatedError);
      expect(translateDatabaseError).toHaveBeenCalledWith(databaseError);
    });
  });

  describe("delete", () => {
    it("soft-deletes an existing record", async () => {
      const entity = createEntity();
      const deleteQuery = createQueryBuilder(1);
      const knex = createKnexMock(deleteQuery);
      await expect(service.delete(knex as unknown as Knex, entity, "42")).resolves.toBeUndefined();
      expect(knex).toHaveBeenCalledWith("product");
      expect(deleteQuery.where).toHaveBeenCalledWith("id", "42");
      expect(deleteQuery.whereNull).toHaveBeenCalledWith("_deleted_at");
      expect(deleteQuery.update).toHaveBeenCalledWith({ _deleted_at: "MOCK_NOW",
        _updated_at: "MOCK_NOW", crud: "D", _msg_seq: 0 });
      expect(deleteQuery.delete).not.toHaveBeenCalledOnce();
    });

    it("throws when no record was deleted", async () => {
      const entity = createEntity();
      const deleteQuery = createQueryBuilder(0);
      const knex = createKnexMock(deleteQuery);
      await expect(service.delete(knex as unknown as Knex, entity, "missing-id"))
        .rejects.toThrow(CrudRecordNotFoundError);
    });

    it("translates database errors raised during deletion", async () => {
      const databaseError = new Error("Cannot delete referenced record");
      const translatedError = new Error("Translated delete error");
      vi.mocked(translateDatabaseError).mockReturnValue(translatedError);
      const entity = createEntity();
      const deleteQuery = createRejectedQueryBuilder(databaseError);
      const knex = createKnexMock(deleteQuery);
      await expect(service.delete(knex as unknown as Knex, entity, "42"))
        .rejects.toBe(translatedError);
      expect(translateDatabaseError).toHaveBeenCalledWith(databaseError);
    });
  });
});
