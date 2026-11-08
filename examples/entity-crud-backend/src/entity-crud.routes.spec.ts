import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import type { Knex } from "knex";
import { createEntityCrudRouter } from "./entity-crud.routes";
import { registry } from "../test-support/fixtures";
import { EntityCrudService } from "./entity-crud.service";
function fixture(actor = "reader", status = "ready") {
  const service = new EntityCrudService(registry);
  const summary = vi.spyOn(service, "summary").mockResolvedValue({
    schemaIssue: "1.1",
    total: 0,
    pending: 0,
    documents: 0,
    deleted: 0,
  });
  const database = vi.fn(() => ({}) as Knex);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/projects/:projectId/entities",
    createEntityCrudRouter({
      registry,
      service,
      projectRepository: {
        findById: async (id) => ({
          id,
          status,
          databaseName: "test",
          dialect: "1.1",
        }),
      },
      getProjectDatabase: database,
      getActor: () => (actor ? { id: actor } : undefined),
      authorize: (input) =>
        input.projectId === "p1" && ["read", "list"].includes(input.operation),
    }),
  );
  return { app, summary, database };
}
describe("HTTP context and authorization", () => {
  it("registers summary before the record route and uses list permission", async () => {
    const { app, summary } = fixture();
    const response = await request(app)
      .get("/api/projects/p1/entities/organization/summary")
      .expect(200);
    expect(response.body.data.schemaIssue).toBe("1.1");
    expect(summary).toHaveBeenCalledOnce();
  });
  it("rejects unauthenticated and wrong-project requests before opening a database", async () => {
    const anonymous = fixture("");
    await request(anonymous.app)
      .get("/api/projects/p1/entities/organization")
      .expect(401);
    expect(anonymous.database).not.toHaveBeenCalled();
    const other = fixture();
    await request(other.app)
      .get("/api/projects/p2/entities/organization")
      .expect(403);
    expect(other.database).not.toHaveBeenCalled();
  });
  it("checks write permission and preserves project status errors", async () => {
    const viewer = fixture();
    await request(viewer.app)
      .put("/api/projects/p1/entities/organization/1")
      .send({})
      .expect(403);
    const pending = fixture("reader", "importing");
    const response = await request(pending.app)
      .get("/api/projects/p1/entities/organization")
      .expect(409);
    expect(response.body).toMatchObject({
      error: "project_not_ready",
      status: "importing",
    });
  });
});
