import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../config/env", () => ({ env: {
  DB_HOST: "localhost", DB_PORT: 3306, DB_USER: "runtime_user",
  DB_PASSWORD: "runtime_password", DB_NAME: "catalog_db", LOG_LEVEL: "debug",
} }));

import type { Request, RequestHandler } from "express";
import { createApp } from "../../../app";

const createNoopSessionMiddleware = (): RequestHandler => {
  return (request, _response, next) => {
    request.session = { authContext: { user: { id: "user-123" } } } as Request["session"];
    next();
  };
};

describe.runIf(process.env.END2END === "true")("Entity CRUD API", () => {
  console.log("--- DEBUG END_2_END VALUE IS:", typeof process.env.END2END, process.env.END2END);
  let app: ReturnType<typeof createApp>;
  let myNoopSessionMiddleware: RequestHandler;
  beforeAll(async () => {
    myNoopSessionMiddleware = createNoopSessionMiddleware();
    app = createApp(myNoopSessionMiddleware);
  });
  afterAll(async () => {});

  it("lists organizations for project 1", async () => {
    const response = await request(app)
      .get("/api/projects/1/entities/organization")
      .query({ page: 1, pageSize: 6, sortBy: "id", sortDirection: "asc",
        "filter.uid": "", "filter.crud": "" })
      .expect("Content-Type", /json/).expect(200);
    expect(response.body).toEqual({ data: expect.any(Array), metadata: {
      page: 1, pageSize: 6, total: expect.any(Number), pageCount: expect.any(Number),
    } });
    for (const record of response.body.data) {
      expect(record).toEqual(expect.objectContaining({
        id: expect.anything(), uid: expect.any(String), crud: expect.stringMatching(/^[IURD]$/),
        pendingExport: expect.any(Boolean), _createdAt: expect.any(String),
        _updatedAt: expect.any(String), _deletedAt: null, value: expect.any(Object),
      }));
      if (record._deletedAt === null || typeof record._deletedAt === "string") expect(true).toBe(true);
    }
  });

  const sortByCases = [
    { sortBy: "id" }, { sortBy: "_createdAt" }, { sortBy: "_updatedAt" },
    { sortBy: "_deletedAt" }, { sortBy: "_msgSeq" }, { sortBy: "uid" }, { sortBy: "crud" },
  ];
  it.each(sortByCases)("lists organizations for project 1 sortBy=$sortBy", async ({ sortBy }) => {
    const response = await request(app).get("/api/projects/1/entities/organization")
      .query({ page: 1, pageSize: 6, sortBy, sortDirection: "asc",
        "filter.uid": "", "filter.crud": "" })
      .expect("Content-Type", /json/).expect(200);
    expect(response.body).toEqual({ data: expect.any(Array), metadata: {
      page: 1, pageSize: 6, total: expect.any(Number), pageCount: expect.any(Number),
    } });
    for (const record of response.body.data) {
      expect(record).toEqual(expect.objectContaining({
        id: expect.anything(), uid: expect.any(String),
        crud: expect.stringMatching(/^[IURD]$/), pendingExport: expect.any(Boolean),
        _createdAt: expect.any(String), _updatedAt: expect.any(String), _deletedAt: null,
        value: expect.any(Object),
      }));
    }
  });

  it("patches organization 6 for project 1", async () => {
    const response = await request(app)
      .patch("/api/projects/1/entities/organization/6")
      .send({ orgId: [{ id: "SB501" }], name: { descr: "Yeti Bike Company2" } })
      .expect("Content-Type", /json/).expect(200);
    expect(response.body).toEqual({ data: expect.objectContaining({
      id: expect.anything(), uid: expect.any(String), crud: "U", pendingExport: true,
      _createdAt: expect.any(String), _updatedAt: expect.any(String), _deletedAt: null,
      value: expect.objectContaining({
        orgId: [expect.objectContaining({ id: "SB501" })],
        name: expect.objectContaining({ descr: "Yeti Bike Company2" }),
      }),
    }) });
  });

  it("POST (create) organization for project 1", async () => {
    const response = await request(app)
      .post("/api/projects/1/entities/organization")
      .send({ orgId: [{ id: "cn" }], name: { descr: "test", lang: "zh" } })
      .set("Content-Type", "application/json")
      .expect("Content-Type", /json/).expect(200);
    expect(response.body).toEqual({ data: expect.objectContaining({
      id: expect.anything(), uid: expect.any(String), crud: "I", pendingExport: true,
      _createdAt: expect.any(String), _updatedAt: expect.any(String), _deletedAt: null,
      value: expect.objectContaining({
        orgId: [expect.objectContaining({ id: "SB501" })],
        name: expect.objectContaining({ descr: "Yeti Bike Company2" }),
      }),
    }) });
  });
});
