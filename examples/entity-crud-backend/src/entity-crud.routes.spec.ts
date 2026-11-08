import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Knex } from "knex";
import type { ProjectRepository } from "../project.repository";
import type { EntityDefinition } from "./entity-crud.types";
import { CrudInvalidQueryError, CrudRecordNotFoundError } from "./entity-crud.errors";
import {
  ForeignKeyReferenceNotFoundError,
  RecordIsReferencedError,
  UniqueConstraintViolationError,
} from "./entity-crud.db-errors";

const mocks = vi.hoisted(() => ({
  getProjectDatabase: vi.fn(),
  getEntityDefinition: vi.fn(), iamAllowed: vi.fn(),
  list: vi.fn(), summary: vi.fn(), findById: vi.fn(),
  create: vi.fn(), replace: vi.fn(), update: vi.fn(), delete: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../database/project.pool", () => ({ getProjectDatabase: mocks.getProjectDatabase }));
vi.mock("./entity-crud.registry", () => ({
  EntityCrudRegistry: { getInstance: () => ({ getEntityDefinition: mocks.getEntityDefinition }) },
}));
vi.mock("./entity-crud.authorization", () => ({ iamAllowed: mocks.iamAllowed }));
vi.mock("./entity-crud.service", () => ({
  EntityCrudService: class {
    public list = mocks.list;
    public summary = mocks.summary;
    public findById = mocks.findById;
    public create = mocks.create;
    public replace = mocks.replace;
    public update = mocks.update;
    public delete = mocks.delete;
  },
}));
vi.mock("../../config/logger", () => ({ logger: mocks.logger }));
import { createEntityCrudRouter } from "./entity-crud.routes";

interface TestProject { id: string; databaseName: string; dialect: "1.1" | "2.0"; status: string }
const knexMock = {} as Knex;
const entityDefinition: EntityDefinition = {
  dialectVersion: "1.1", name: "products", tableName: "product", primaryKey: "id",
  readableColumns: ["id", "name", "status"],
  fieldColumns: { id: "id", name: "name", status: "status" },
  filterableColumns: ["name", "status"],
  sortableColumns: ["id", "name", "status"],
  defaultSort: { column: "id", direction: "asc" },
  createSchema: z.object({ name: z.string().min(1), status: z.enum(["draft", "active"]).optional() }).strict(),
  updateSchema: z.object({ name: z.string().min(1).optional(),
    status: z.enum(["draft", "active"]).optional() }).strict()
    .refine(body => Object.keys(body).length > 0, { message: "At least one field must be provided" }),
  replaceSchema: z.object({ name: z.string().min(1),
    status: z.enum(["draft", "active"]).optional() }).strict(),
  preparedCreateSchema: z.object({}).passthrough(),
  preparedReplaceSchema: z.object({}).passthrough(),
};
const organizationEntityDefinition: EntityDefinition = {
  ...entityDefinition, name: "organization", tableName: "organization", summary: vi.fn(),
};
const readyProject: TestProject = {
  id: "project-1", databaseName: "project_project_1", dialect: "1.1", status: "ready",
};
function createProjectRepositoryMock() {
  return { findById: vi.fn() };
}
type ProjectRepositoryMock = ReturnType<typeof createProjectRepositoryMock>;

function createApp(projectRepository: ProjectRepositoryMock) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.session = { authContext: { user: { id: "user-123" } } } as Request["session"];
    next();
  });
  app.use("/projects/:projectId/entities", createEntityCrudRouter({
    projectRepository: projectRepository as unknown as ProjectRepository,
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal_server_error", message:
      error instanceof Error ? error.message : "Unknown error" });
  });
  return app;
}

describe("createEntityCrudRouter", () => {
  let projectRepository: ProjectRepositoryMock;
  beforeEach(() => {
    vi.clearAllMocks();
    projectRepository = createProjectRepositoryMock();
    projectRepository.findById.mockResolvedValue(readyProject);
    mocks.getProjectDatabase.mockReturnValue(knexMock);
    mocks.getEntityDefinition.mockReturnValue(entityDefinition);
    mocks.iamAllowed.mockResolvedValue(true);
  });

  describe("context resolution", () => {
    it("returns 404 when the project does not exist", async () => {
      projectRepository.findById.mockResolvedValue(undefined);
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/missing/entities/products").expect(404);
      expect(response.body).toEqual({ error: "project_not_found" });
      expect(projectRepository.findById).toHaveBeenCalledWith("missing");
      expect(mocks.getEntityDefinition).not.toHaveBeenCalled();
      expect(mocks.getProjectDatabase).not.toHaveBeenCalled();
    });
    it("returns 409 when the project is not ready", async () => {
      projectRepository.findById.mockResolvedValue({ ...readyProject, status: "provisioning" });
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/products").expect(409);
      expect(response.body).toEqual({ error: "project_not_ready", status: "provisioning" });
      expect(mocks.getEntityDefinition).not.toHaveBeenCalled();
    });
    it("resolves the entity using the project dialect", async () => {
      mocks.list.mockResolvedValue({ data: [], metadata: {
        page: 1, pageSize: 20, total: 0, pageCount: 0,
      } });
      const app = createApp(projectRepository);
      await request(app).get("/projects/project-1/entities/products").expect(200);
      expect(mocks.getEntityDefinition).toHaveBeenCalledWith("1.1", "products");
      expect(mocks.getProjectDatabase).toHaveBeenCalledWith("project_project_1");
    });
    it("passes the actor and operation to iamAllowed", async () => {
      mocks.findById.mockResolvedValue({ id: 42, name: "Product A" });
      const app = createApp(projectRepository);
      await request(app).get("/projects/project-1/entities/products/42").expect(200);
      expect(mocks.iamAllowed).toHaveBeenCalledWith({
        actor: { id: "user-123" }, projectId: "project-1", databaseName: "project_project_1",
        entity: "products", operation: "read", recordId: "42",
      });
    });
    it("returns 403 when the actor is not allowed", async () => {
      mocks.iamAllowed.mockResolvedValue(false);
      const app = createApp(projectRepository);
      const response = await request(app).delete("/projects/project-1/entities/products/42").expect(403);
      expect(response.body).toEqual({ error: "forbidden" });
      expect(mocks.delete).not.toHaveBeenCalled();
    });
  });

  describe("GET /:entity", () => {
    it("lists records with pagination, sorting, and filters", async () => {
      const listResult = { data: [{ id: 1, name: "Product A", status: "active" }],
        metadata: { page: 2, pageSize: 10, total: 11, pageCount: 2 } };
      mocks.list.mockResolvedValue(listResult);
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/products")
        .query({ page: "2", pageSize: "10", sortBy: "name", sortDirection: "desc",
          "filter.status": "active" }).expect(200);
      expect(response.body).toEqual(listResult);
      expect(mocks.list).toHaveBeenCalledWith(knexMock, entityDefinition, {
        page: 2, pageSize: 10, sortBy: "name", sortDirection: "desc",
        filters: { status: "active" },
      });
      expect(mocks.iamAllowed).toHaveBeenCalledWith(expect.objectContaining({
        operation: "list", recordId: undefined,
      }));
    });
    it("returns 400 for invalid pagination", async () => {
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/products")
        .query({ page: "0" }).expect(400);
      expect(response.body.error).toBe("invalid_request");
      expect(response.body.details).toBeDefined();
      expect(mocks.list).not.toHaveBeenCalled();
    });
  });

  describe("GET /:entity/summary", () => {
    beforeEach(() => { mocks.getEntityDefinition.mockReturnValue(organizationEntityDefinition); });
    it("returns the Organization summary", async () => {
      mocks.summary.mockResolvedValue({ schemaIssue: "1.1", total: 8,
        pending: 2, documents: 3, deleted: 1 });
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/organization/summary")
        .expect(200);
      expect(response.body).toEqual({ data: { schemaIssue: "1.1", total: 8,
        pending: 2, documents: 3, deleted: 1 } });
      expect(mocks.summary).toHaveBeenCalledWith(knexMock, organizationEntityDefinition);
    });
    it("uses list authorization", async () => {
      mocks.summary.mockResolvedValue({ schemaIssue: "1.1", total: 0,
        pending: 0, documents: 0, deleted: 0 });
      const app = createApp(projectRepository);
      await request(app).get("/projects/project-1/entities/organization/summary").expect(200);
      expect(mocks.iamAllowed).toHaveBeenCalledWith({ actor: { id: "user-123" },
        projectId: "project-1", databaseName: "project_project_1", entity: "organization",
        operation: "list", recordId: undefined });
    });
    it("does not interpret summary as a record identifier", async () => {
      mocks.summary.mockResolvedValue({ schemaIssue: "1.1", total: 0,
        pending: 0, documents: 0, deleted: 0 });
      const app = createApp(projectRepository);
      await request(app).get("/projects/project-1/entities/organization/summary").expect(200);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.summary).toHaveBeenCalledOnce();
    });
    it("returns 403 when list authorization is denied", async () => {
      mocks.iamAllowed.mockResolvedValue(false);
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/organization/summary")
        .expect(403);
      expect(response.body).toEqual({ error: "forbidden" });
      expect(mocks.summary).not.toHaveBeenCalled();
    });
  });

  describe("GET /:entity/:id", () => {
    it("returns one record", async () => {
      const record = { id: 42, name: "Product A", status: "active" };
      mocks.findById.mockResolvedValue(record);
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/products/42").expect(200);
      expect(response.body).toEqual({ data: record });
      expect(mocks.findById).toHaveBeenCalledWith(knexMock, entityDefinition, "42");
    });
    it("returns 404 when the record does not exist", async () => {
      mocks.findById.mockRejectedValue(new CrudRecordNotFoundError("products", "999"));
      const app = createApp(projectRepository);
      const response = await request(app).get("/projects/project-1/entities/products/999")
        .expect(404);
      expect(response.body).toMatchObject({ error: "record_not_found" });
    });
  });
describe("POST /:entity", () => {
  it("validates and creates a record", async () => {
    const createdRecord = { id: 44, name: "New product", status: "draft" };
    mocks.create.mockResolvedValue(createdRecord);
    const app = createApp(projectRepository);
    const response = await request(app)
      .post("/projects/project-1/entities/products")
      .send({ name: "New product", status: "draft" })
      .expect(201);
    expect(response.body).toEqual({ data: createdRecord });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: "user-123" }, projectId: "project-1",
      databaseName: "project_project_1", knex: knexMock,
      entity: entityDefinition,
    }), { name: "New product", status: "draft" });
  });
  it("returns 400 for an invalid request body", async () => {
    const app = createApp(projectRepository);
    const response = await request(app)
      .post("/projects/project-1/entities/products")
      .send({ name: "", unsupportedColumn: "value" }).expect(400);
    expect(response.body.error).toBe("invalid_request");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
describe("PUT /:entity/:id", () => {
  it("replaces a complete business value", async () => {
    const replacedRecord = {
      id: 42, uid: "product-42", crud: "U", pendingExport: true,
      _createdAt: "2026-10-01T08:00:00.000Z",
      _updatedAt: "2026-11-05T08:20:00.000Z",
      _deletedAt: null, value: { name: "Replacement product" },
    };
    mocks.replace.mockResolvedValue(replacedRecord);
    const app = createApp(projectRepository);
    const response = await request(app)
      .put("/projects/project-1/entities/products/42")
      .send({ name: "Replacement product" }).expect(200);
    expect(response.body).toEqual({ data: replacedRecord });
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: "user-123" }, projectId: "project-1",
      databaseName: "project_project_1", knex: knexMock,
      entity: entityDefinition,
    }), "42", { name: "Replacement product" });
    expect(mocks.iamAllowed).toHaveBeenCalledWith(expect.objectContaining({
      operation: "update", recordId: "42",
    }));
  });
  it("rejects root-managed fields", async () => {
    const app = createApp(projectRepository);
    const response = await request(app)
      .put("/projects/project-1/entities/products/42")
      .send({ name: "Replacement product", uid: "forged-uid", crud: "R" })
      .expect(400);
    expect(response.body.error).toBe("invalid_request");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("requires all required business fields", async () => {
    const app = createApp(projectRepository);
    const response = await request(app)
      .put("/projects/project-1/entities/products/42")
      .send({ status: "active" }).expect(400);
    expect(response.body.error).toBe("invalid_request");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("returns 403 when update authorization is denied", async () => {
    mocks.iamAllowed.mockResolvedValue(false);
    const app = createApp(projectRepository);
    await request(app).put("/projects/project-1/entities/products/42")
      .send({ name: "Replacement product" }).expect(403);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
describe("PATCH /:entity/:id", () => {
  it("updates a record", async () => {
    const updatedRecord = { id: 42, name: "Updated product", status: "active" };
    mocks.update.mockResolvedValue(updatedRecord);
    const app = createApp(projectRepository);
    const response = await request(app)
      .patch("/projects/project-1/entities/products/42")
      .send({ name: "Updated product" }).expect(200);
    expect(response.body).toEqual({ data: updatedRecord });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1", entity: entityDefinition,
    }), "42", { name: "Updated product" });
  });
});
describe("DELETE /:entity/:id", () => {
  it("deletes a record and returns 204", async () => {
    mocks.delete.mockResolvedValue(undefined);
    const app = createApp(projectRepository);
    const response = await request(app)
      .delete("/projects/project-1/entities/products/42").expect(204);
    expect(response.body).toEqual({});
    expect(mocks.delete).toHaveBeenCalledWith(knexMock, entityDefinition, "42");
    expect(mocks.iamAllowed).toHaveBeenCalledWith(expect.objectContaining({
      operation: "delete", recordId: "42",
    }));
  });
});
describe("error mapping", () => {
  it("maps an invalid query error to 400", async () => {
    mocks.list.mockRejectedValue(new CrudInvalidQueryError(
      'Column "unknown" cannot be used for sorting',
    ));
    const app = createApp(projectRepository);
    const response = await request(app)
      .get("/projects/project-1/entities/products").expect(400);
    expect(response.body).toMatchObject({ error: "invalid_query" });
  });
  it("maps a missing foreign-key reference to 409", async () => {
    mocks.create.mockRejectedValue(new ForeignKeyReferenceNotFoundError("fk_product_organization"));
    const app = createApp(projectRepository);
    const response = await request(app)
      .post("/projects/project-1/entities/products")
      .send({ name: "Product A" }).expect(409);
    expect(response.body).toEqual({ error: "foreign_key_reference_not_found",
      message: "The referenced record does not exist.",
      constraint: "fk_product_organization" });
  });
  it("maps a referenced-record error to 409", async () => {
    mocks.delete.mockRejectedValue(new RecordIsReferencedError("fk_variant_product"));
    const app = createApp(projectRepository);
    const response = await request(app)
      .delete("/projects/project-1/entities/products/42").expect(409);
    expect(response.body).toEqual({ error: "record_is_referenced",
      message: "This record cannot be deleted or updated because it is referenced by another record.",
      constraint: "fk_variant_product" });
  });
  it("maps a unique constraint violation to 409", async () => {
    mocks.create.mockRejectedValue(new UniqueConstraintViolationError("uq_product_uid"));
    const app = createApp(projectRepository);
    const response = await request(app)
      .post("/projects/project-1/entities/products")
      .send({ name: "Product A" }).expect(409);
    expect(response.body).toEqual({ error: "unique_constraint_violation",
      message: "A record with the same unique value already exists.",
      constraint: "uq_product_uid" });
  });
  it("delegates unknown errors to the central handler", async () => {
    mocks.list.mockRejectedValue(new Error("Unexpected database failure"));
    const app = createApp(projectRepository);
    const response = await request(app)
      .get("/projects/project-1/entities/products").expect(500);
    expect(response.body).toEqual({ error: "internal_server_error",
      message: "Unexpected database failure" });
    expect(mocks.logger.error).toHaveBeenCalledWith({ err: expect.any(Error) },
      "Unknown router error, delegating to central handler");
  });
});
});
