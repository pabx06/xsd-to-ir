import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import type { Knex } from "knex";
import { createEntityCrudRouter } from "./entity-crud.routes";
import { business, organization, registry } from "../test-support/fixtures";
import { EntityCrudService } from "./entity-crud.service";
import { EntityIdentityValidationError } from "./entity-change-preparation.errors";
import type {
  Authorizer,
  CrudOperation,
  EntityRecordResult,
} from "./entity-crud.types";

const endpoint = "/api/projects/p1/entities/organization";
const record = {
  id: "9007199254740993",
  uid: "org1",
  crud: "R",
  pendingExport: false,
  _createdAt: "2026-11-01T12:00:00.000Z",
  _updatedAt: "2026-11-01T12:00:00.000Z",
  _deletedAt: null,
  value: business(),
} satisfies EntityRecordResult;
const summaryResult = {
  schemaIssue: "1.1",
  total: 1,
  pending: 0,
  documents: 0,
  deleted: 0,
};
const listResult = {
  data: [record],
  metadata: { page: 1, pageSize: 20, total: 1, pageCount: 1 },
};
const routes = [
  {
    method: "get",
    suffix: "",
    operation: "list",
    handler: "list",
    status: 200,
    body: listResult,
  },
  {
    method: "get",
    suffix: "/summary",
    operation: "list",
    handler: "summary",
    status: 200,
    body: { data: summaryResult },
  },
  {
    method: "get",
    suffix: `/${record.id}`,
    operation: "read",
    handler: "findById",
    status: 200,
    body: { data: record },
  },
  {
    method: "post",
    suffix: "",
    operation: "create",
    handler: "create",
    status: 201,
    body: { data: record },
  },
  {
    method: "put",
    suffix: `/${record.id}`,
    operation: "update",
    handler: "replace",
    status: 200,
    body: { data: record },
  },
  {
    method: "patch",
    suffix: `/${record.id}`,
    operation: "update",
    handler: "update",
    status: 200,
    body: { data: record },
  },
  {
    method: "delete",
    suffix: `/${record.id}`,
    operation: "delete",
    handler: "delete",
    status: 204,
    body: {},
  },
] as const;

function fixture(
  options: { actor?: string; status?: string; authorize?: Authorizer } = {},
) {
  const { actor = "reader", status = "ready" } = options;
  const service = new EntityCrudService(registry);
  // These tests exercise HTTP dispatch and context. MariaDB behavior is tested
  // separately; service spies make reaching the wrong handler observable.
  const handlers = {
    list: vi.spyOn(service, "list").mockResolvedValue(listResult),
    summary: vi.spyOn(service, "summary").mockResolvedValue(summaryResult),
    findById: vi.spyOn(service, "findById").mockResolvedValue(record),
    create: vi.spyOn(service, "create").mockResolvedValue(record),
    replace: vi.spyOn(service, "replace").mockResolvedValue(record),
    update: vi.spyOn(service, "update").mockResolvedValue(record),
    delete: vi.spyOn(service, "delete").mockResolvedValue(undefined),
  };
  const knex = {} as Knex;
  const database = vi.fn(() => knex);
  const findProject = vi.fn(async (id: string) => ({
    id,
    status,
    databaseName: "test",
    dialect: "1.1",
  }));
  const authorize = vi.fn<Authorizer>(
    options.authorize ??
      ((input) =>
        input.projectId === "p1" && ["read", "list"].includes(input.operation)),
  );
  const onError = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/projects/:projectId/entities",
    createEntityCrudRouter({
      registry,
      service,
      projectRepository: { findById: findProject },
      getProjectDatabase: database,
      getActor: async () => (actor ? { id: actor } : undefined),
      authorize,
      onError,
    }),
  );
  return { app, handlers, knex, database, findProject, authorize, onError };
}

function send(app: express.Express, route: (typeof routes)[number]) {
  const pending = request(app)[route.method](`${endpoint}${route.suffix}`);
  return ["post", "put", "patch"].includes(route.method)
    ? pending.send(business())
    : pending;
}

function scope(operation: CrudOperation, recordId?: string) {
  return {
    actor: { id: "reader" },
    projectId: "p1",
    databaseName: "test",
    entity: "organization",
    operation,
    recordId,
  };
}

function expectNoServiceCalls(state: ReturnType<typeof fixture>) {
  for (const handler of Object.values(state.handlers))
    expect(handler).not.toHaveBeenCalled();
}

describe("HTTP context and authorization", () => {
  it.each(routes)(
    "$method $suffix uses $operation permission and dispatches to $handler",
    async (route) => {
      // Summary must work with list-only permission; granting both read and list
      // cannot detect the wrong authorization operation.
      const state = fixture({
        authorize: (input) => input.operation === route.operation,
      });
      const response = await send(state.app, route).expect(route.status);
      const recordId = route.suffix === `/${record.id}` ? record.id : undefined;
      expect(state.authorize).toHaveBeenCalledExactlyOnceWith(
        scope(route.operation, recordId),
      );
      expect(state.findProject).toHaveBeenCalledExactlyOnceWith("p1");
      expect(state.database).toHaveBeenCalledExactlyOnceWith("test");
      expect(response.body).toEqual(route.body);
      if (route.status === 204) expect(response.text).toBe("");
      const ctx = {
        actor: { id: "reader" },
        projectId: "p1",
        databaseName: "test",
        entity: organization,
        knex: state.knex,
      };
      switch (route.handler) {
        case "list":
          expect(state.handlers.list).toHaveBeenCalledExactlyOnceWith(
            state.knex,
            organization,
            {
              page: 1,
              pageSize: 20,
              sortBy: undefined,
              sortDirection: "asc",
              filters: {},
            },
          );
          break;
        case "summary":
          expect(state.handlers.summary).toHaveBeenCalledExactlyOnceWith(
            state.knex,
            organization,
          );
          break;
        case "findById":
          expect(state.handlers.findById).toHaveBeenCalledExactlyOnceWith(
            state.knex,
            organization,
            record.id,
          );
          break;
        case "create":
          expect(state.handlers.create).toHaveBeenCalledExactlyOnceWith(
            ctx,
            business(),
          );
          break;
        case "replace":
        case "update":
          expect(state.handlers[route.handler]).toHaveBeenCalledExactlyOnceWith(
            ctx,
            record.id,
            business(),
          );
          break;
        case "delete":
          expect(state.handlers.delete).toHaveBeenCalledExactlyOnceWith(
            ctx,
            record.id,
          );
          break;
      }
      for (const [name, handler] of Object.entries(state.handlers))
        if (name !== route.handler) expect(handler).not.toHaveBeenCalled();
      expect(state.onError).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "denies $method $suffix before database or service access",
    async (route) => {
      const state = fixture({ authorize: () => false });
      const response = await send(state.app, route).expect(403);
      const recordId = route.suffix === `/${record.id}` ? record.id : undefined;
      expect(state.authorize).toHaveBeenCalledExactlyOnceWith(
        scope(route.operation, recordId),
      );
      expect(response.body.error).toBe("forbidden");
      expect(state.database).not.toHaveBeenCalled();
      expectNoServiceCalls(state);
      expect(state.onError).not.toHaveBeenCalled();
    },
  );

  it.each(["", "unknown"])(
    "rejects unauthenticated actor '%s' before project or permission lookup",
    async (actor) => {
      const state = fixture({ actor });
      const response = await request(state.app).get(endpoint).expect(401);
      expect(response.body.error).toBe("unauthenticated");
      expect(state.findProject).not.toHaveBeenCalled();
      expect(state.authorize).not.toHaveBeenCalled();
      expect(state.database).not.toHaveBeenCalled();
      expectNoServiceCalls(state);
    },
  );

  it("denies access to another project with its actual authorization scope", async () => {
    const state = fixture();
    const response = await request(state.app)
      .get("/api/projects/p2/entities/organization")
      .expect(403);
    expect(response.body.error).toBe("forbidden");
    expect(state.authorize).toHaveBeenCalledExactlyOnceWith({
      ...scope("list"),
      projectId: "p2",
    });
    expect(state.database).not.toHaveBeenCalled();
    expectNoServiceCalls(state);
  });

  it("preserves project status errors before database or service access", async () => {
    const state = fixture({ status: "importing" });
    const response = await request(state.app).get(endpoint).expect(409);
    expect(response.body).toMatchObject({
      error: "project_not_ready",
      status: "importing",
    });
    expect(state.authorize).toHaveBeenCalledExactlyOnceWith(scope("list"));
    expect(state.database).not.toHaveBeenCalled();
    expectNoServiceCalls(state);
    expect(state.onError).not.toHaveBeenCalled();
  });
});

describe("HTTP query and error mapping", () => {
  it("converts paging and filters before forwarding a list query", async () => {
    const state = fixture();
    await request(state.app)
      .get(endpoint)
      .query({
        page: "2",
        pageSize: "6",
        sortBy: "_updatedAt",
        sortDirection: "desc",
        "filter.search": "001234",
        "filter.status": "pending",
        "filter.uid": "",
      })
      .expect(200);
    expect(state.handlers.list).toHaveBeenCalledExactlyOnceWith(
      state.knex,
      organization,
      {
        page: 2,
        pageSize: 6,
        sortBy: "_updatedAt",
        sortDirection: "desc",
        filters: { search: "001234", status: "pending" },
      },
    );
  });

  it.each([
    { query: { page: "0" }, error: "invalid_request" },
    { query: { pageSize: "101" }, error: "invalid_request" },
    { query: { sortDirection: "sideways" }, error: "invalid_request" },
    { query: { unexpected: "value" }, error: "invalid_query" },
    { query: { "filter.": "value" }, error: "invalid_query" },
  ])(
    "rejects invalid query $query with $error without calling the service",
    async ({ query, error }) => {
      const state = fixture();
      const response = await request(state.app)
        .get(endpoint)
        .query(query)
        .expect(400);
      expect(response.body.error).toBe(error);
      expectNoServiceCalls(state);
    },
  );

  it("preserves the precise field issue returned by replacement validation", async () => {
    const state = fixture({ authorize: () => true });
    const path = "/rmks/rmk/0/crud";
    const message = "CRUD is managed by the backend.";
    state.handlers.replace.mockRejectedValue(
      new EntityIdentityValidationError(message, path),
    );
    const response = await request(state.app)
      .put(`${endpoint}/${record.id}`)
      .send(business())
      .expect(400);
    expect(state.handlers.replace).toHaveBeenCalledOnce();
    expect(response.body).toEqual({
      error: "invalid_request",
      message: "Check the marked fields.",
      details: { issues: [{ path, message }] },
    });
    expect(state.onError).not.toHaveBeenCalled();
  });
});
