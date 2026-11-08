import type { Knex } from "knex";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { EntityIdentityValidationError } from "./entity-change-preparation.errors";
import { EntityChangePreparationService } from "./entity-change-preparation.service";
import type { EntityIdentityHistory, EntityIdentityPolicy, EntityUidAllocator } from "./entity-change-preparation.types";
import type { CrudContext, EntityDefinition } from "./entity-crud.types";

describe("EntityChangePreparationService", () => {
  let history: Mocked<EntityIdentityHistory>;
  let uidAllocator: Mocked<EntityUidAllocator>;
  let service: EntityChangePreparationService;
  let trx: Knex.Transaction;
  let entity: EntityDefinition;
  let context: CrudContext;
  const policy: EntityIdentityPolicy = {
    root: { identityType: "organization", uid: { prefix: "org", maxLength: 255,
      pattern: /^org[A-Za-z0-9._-]+$/ } },
    nested: [{ identityType: "organizationDocumentAssignment", path: ["docs", "doc"],
      uid: { prefix: "docasg", maxLength: 255, pattern: /^docasg[A-Za-z0-9._-]+$/ } }],
  };

  beforeEach(() => {
    history = {
      isEstablished: vi.fn(), findOwner: vi.fn(), recordNestedDeletion: vi.fn(),
    } as Mocked<EntityIdentityHistory>;
    uidAllocator = { allocate: vi.fn() } as Mocked<EntityUidAllocator>;
    service = new EntityChangePreparationService(uidAllocator, history);
    trx = {} as Knex.Transaction;
    entity = { dialectVersion: "1.1", name: "organization" } as EntityDefinition;
    context = { actor: { id: "user-123" }, projectId: "project-42",
      databaseName: "project_project_42", knex: trx, entity } as CrudContext;
    history.isEstablished.mockResolvedValue(true);
    history.findOwner.mockResolvedValue(undefined);
    history.recordNestedDeletion.mockResolvedValue();
  });

  it("preserves an existing nested UID and marks a changed established value as U", async () => {
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
      ] } },
      submittedValue: { docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc24" } },
      ] } }, policy,
    });
    expect(result).toEqual({ changed: true, rootCrud: "U", value: {
      uid: "org817", crud: "U", docs: { doc: [
        { uid: "docasg91", crud: "U", docRef: { uidRef: "doc24" } },
      ] },
    } });
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
    expect(history.recordNestedDeletion).not.toHaveBeenCalled();
    expect(history.isEstablished).toHaveBeenCalledWith(trx, {
      projectId: "project-42", entityName: "organization",
      identityType: "organizationDocumentAssignment", uid: "docasg91",
    });
    expect(history.isEstablished).toHaveBeenCalledWith(trx, {
      projectId: "project-42", entityName: "organization",
      identityType: "organization", uid: "org817",
    });
  });

  it("preserves the existing nested CRUD marker when the nested business value is unchanged", async () => {
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", name: { descr: "Old name" },
        docs: { doc: [{ uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } }] } },
      submittedValue: { name: { descr: "New name" },
        docs: { doc: [{ uid: "docasg91", docRef: { uidRef: "doc23" } }] } },
      policy,
    });
    expect(result.changed).toBe(true);
    expect(result.rootCrud).toBe("U");
    expect(result.value).toEqual({ uid: "org817", crud: "U", name: { descr: "New name" },
      docs: { doc: [{ uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } }] } });
  });

  it("allocates an identity for a new nested value", async () => {
    uidAllocator.allocate.mockResolvedValue("docasg92");
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { docs: { doc: [{ docRef: { uidRef: "doc23" } }] } }, policy,
    });
    expect(result).toEqual({ changed: true, rootCrud: "U", value: {
      uid: "org817", crud: "U", docs: { doc: [
        { uid: "docasg92", crud: "I", docRef: { uidRef: "doc23" } },
      ] },
    } });
    expect(uidAllocator.allocate).toHaveBeenCalledOnce();
    expect(uidAllocator.allocate).toHaveBeenCalledWith(trx, {
      projectId: "project-42", schemaIssue: "1.1", entityName: "organization",
      identityType: "organizationDocumentAssignment", prefix: "docasg",
      maxLength: 255, pattern: /^docasg[A-Za-z0-9._-]+$/,
    });
  });

  it("keeps root CRUD as I when the root identity is not established", async () => {
    history.isEstablished.mockImplementation(async (_trx, input) => {
      if (input.identityType === "organization") return false;
      return true;
    });
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "I", name: { descr: "Old name" } },
      submittedValue: { name: { descr: "New name" } }, policy,
    });
    expect(result.rootCrud).toBe("I");
    expect(result.value).toEqual({ uid: "org817", crud: "I", name: { descr: "New name" } });
  });

  it("rejects duplicate nested UIDs", async () => {
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
      ] } },
      submittedValue: { docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc24" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      name: "EntityIdentityValidationError", path: "/docs/doc/1/uid",
    }));
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
    expect(history.recordNestedDeletion).not.toHaveBeenCalled();
  });

  it("rejects a nested UID that is not part of the current entity", async () => {
    history.findOwner.mockResolvedValue(undefined);
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { docs: { doc: [
        { uid: "docasg999", crud: "R", docRef: { uidRef: "doc23" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      name: "EntityIdentityValidationError", path: "/docs/doc/0/uid",
      message: 'Nested UID "docasg999" is not part of the existing entity.',
    }));
    expect(history.findOwner).toHaveBeenCalledWith(trx, {
      projectId: "project-42", entityName: "organization",
      identityType: "organizationDocumentAssignment", uid: "docasg999",
    });
  });

  it("rejects a nested UID owned by another entity", async () => {
    history.findOwner.mockResolvedValue({ rootUid: "org999", identityType: "organizationDocumentAssignment" });
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { docs: { doc: [
        { uid: "docasg999", crud: "R", docRef: { uidRef: "doc23" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      path: "/docs/doc/0/uid", message: 'Nested UID "docasg999" belongs to another entity.',
    }));
  });

  it("rejects a client change to an existing nested CRUD marker", async () => {
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
      ] } },
      submittedValue: { docs: { doc: [
        { uid: "docasg91", crud: "U", docRef: { uidRef: "doc24" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      path: "/docs/doc/0/crud", message: "Nested CRUD state is managed by the backend.",
    }));
  });

  it("rejects a client-provided UID for a new nested value", async () => {
    history.findOwner.mockResolvedValue(undefined);
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { docs: { doc: [
        { uid: "client-generated-uid", docRef: { uidRef: "doc23" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toMatchObject({
      name: "EntityIdentityValidationError", path: "/docs/doc/0/uid",
    });
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
  });

  it("rejects a CRUD marker on a new nested value", async () => {
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { docs: { doc: [
        { crud: "I", docRef: { uidRef: "doc23" } },
      ] } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      path: "/docs/doc/0/crud", message: "A new nested value must not provide a CRUD state.",
    }));
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
  });

  it("records a removed nested identity", async () => {
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
      ] } }, submittedValue: { docs: null }, policy,
    });
    expect(result.changed).toBe(true);
    expect(result.rootCrud).toBe("U");
    expect(history.recordNestedDeletion).toHaveBeenCalledOnce();
    expect(history.recordNestedDeletion).toHaveBeenCalledWith(trx, {
      projectId: "project-42", entityName: "organization", entityId: "17",
      rootUid: "org817", identityType: "organizationDocumentAssignment", uid: "docasg91",
      path: ["docs", "doc"], previousValue: {
        uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" },
      },
    });
  });

  it("records only removed identities and preserves retained identities", async () => {
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", docs: { doc: [
        { uid: "docasg91", crud: "R", docRef: { uidRef: "doc23" } },
        { uid: "docasg92", crud: "R", docRef: { uidRef: "doc24" } },
      ] } }, submittedValue: { docs: { doc: [
        { uid: "docasg92", docRef: { uidRef: "doc24" } },
      ] } }, policy,
    });
    expect(result.changed).toBe(true);
    expect(history.recordNestedDeletion).toHaveBeenCalledOnce();
    expect(history.recordNestedDeletion).toHaveBeenCalledWith(trx,
      expect.objectContaining({ uid: "docasg91" }));
    expect(result.value).toEqual({ uid: "org817", crud: "U", docs: { doc: [
      { uid: "docasg92", crud: "R", docRef: { uidRef: "doc24" } },
    ] } });
  });

  it("does not allocate or record deletions for a semantic no-op", async () => {
    const result = await service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R", name: { lang: "en", descr: "Supplier" } },
      submittedValue: { name: { descr: "Supplier", lang: "en" } }, policy,
    });
    expect(result).toEqual({ changed: false, rootCrud: "U", value: {
      uid: "org817", crud: "R", name: { lang: "en", descr: "Supplier" },
    } });
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
    expect(history.isEstablished).not.toHaveBeenCalled();
    expect(history.findOwner).not.toHaveBeenCalled();
    expect(history.recordNestedDeletion).not.toHaveBeenCalled();
  });

  it("rejects root-managed fields in the submitted replacement", async () => {
    const operation = service.prepareReplacement({
      trx, context, entity, entityId: "17", rootUid: "org817",
      previousValue: { uid: "org817", crud: "R" },
      submittedValue: { uid: "forged-root-uid", name: { descr: "Supplier" } }, policy,
    });
    await expect(operation).rejects.toEqual(expect.objectContaining({
      path: "/uid", message: 'Root field "uid" is managed by the backend.',
    }));
    expect(history.isEstablished).not.toHaveBeenCalled();
    expect(uidAllocator.allocate).not.toHaveBeenCalled();
  });
});
