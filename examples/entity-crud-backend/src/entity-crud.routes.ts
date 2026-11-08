import { Router, type NextFunction, type Request, type Response } from "express";
import { ForeignKeyReferenceNotFoundError, RecordIsReferencedError, UniqueConstraintViolationError } from "./entity-crud.db-errors";
import { z } from "zod";
import type { Knex } from "knex";
import { getProjectDatabase } from "../../database/project.pool";
import { ProjectRepository } from "../project.repository";
import { CrudEntityNotFoundError, CrudForbiddenError, CrudInvalidQueryError, CrudRecordNotFoundError, CrudSummaryNotSupportedError } from "./entity-crud.errors";
import { EntityCrudRegistry } from "./entity-crud.registry";
import { iamAllowed } from "./entity-crud.authorization";
import { logger } from "../../config/logger";
import { EntityCrudService } from "./entity-crud.service";
import type { CrudActor, CrudContext, CrudOperation, EntityDefinition } from "./entity-crud.types";
import { EntityIdentityValidationError } from "./entity-change-preparation.errors";
import { UIAdapterValidationError } from "@sliwave/xsd-to-ir";

const entityRegistry = EntityCrudRegistry.getInstance();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().trim().min(1).optional(),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
}).catchall(z.union([z.string(), z.coerce.number(), z.coerce.boolean()]));

interface CrudRequestContext {
  actor: CrudActor;
  projectId: string;
  databaseName: string;
  knex: Knex;
  entity: EntityDefinition;
}
type CrudRequest = Request & { crudContext?: CrudRequestContext };
interface CreateEntityCrudRouterDependencies {
  projectRepository: ProjectRepository;
}
const crudService = new EntityCrudService();

export function createEntityCrudRouter(
  dependencies: CreateEntityCrudRouterDependencies,
): Router {
  const router = Router({ mergeParams: true });
  const { projectRepository } = dependencies;
  const resolveContext = async (req: CrudRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { projectId, entity: entityName } = req.params;
      const project = await projectRepository.findById(projectId);
      if (!project) {
        logger.error(`project_not_found projectId=${projectId}`);
        res.status(404).json({ error: "project_not_found" });
        return;
      }
      if (project.status !== "ready") {
        logger.error(`project_not_ready projectId=${projectId}, projectStatus=${project.status}`);
        res.status(409).json({ error: "project_not_ready", status: project.status });
        return;
      }
      const entity = entityRegistry.getEntityDefinition(project.dialect, entityName);
      const knex = getProjectDatabase(project.databaseName);
      req.crudContext = {
        actor: { id: req.session.authContext?.user.id ?? "unknown" },
        projectId, databaseName: project.databaseName, knex, entity,
      };
      next();
    } catch (error) { next(error); }
  };
  const authorize = (operation: CrudOperation) => {
    return async (req: CrudRequest, _res: Response, next: NextFunction): Promise<void> => {
      try {
        const context = requireCrudContext(req);
        const allowed = await iamAllowed({
          actor: context.actor, projectId: context.projectId,
          databaseName: context.databaseName, entity: context.entity.name,
          operation, recordId: req.params.id,
        });
        if (!allowed) throw new CrudForbiddenError();
        next();
      } catch (error) { next(error); }
    };
  };
  router.get("/:entity", resolveContext, authorize("list"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      const parsedQuery = listQuerySchema.parse(req.query);
      const { page, pageSize, sortBy, sortDirection, ...rawFilters } = parsedQuery;
      const unknownParameters = Object.keys(rawFilters).filter(key => !key.startsWith("filter."));
      if (unknownParameters.length > 0) {
        throw new CrudInvalidQueryError(`Unknown query parameter(s): ${unknownParameters.join(", ")}`);
      }
      const filters = Object.fromEntries(Object.entries(rawFilters)
        .filter(([key, value]) => key.startsWith("filter.") && value !== "")
        .map(([key, value]) => [key.substring("filter.".length), value]));
      const result = await crudService.list(context.knex, context.entity,
        { page, pageSize, sortBy, sortDirection, filters });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.get("/:entity/summary", resolveContext, authorize("list"), async (req: CrudRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = requireCrudContext(req);
      const data = await crudService.summary(context.knex, context.entity);
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });
  router.get("/:entity/:id", resolveContext, authorize("read"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      const record = await crudService.findById(context.knex, context.entity, req.params.id);
      res.status(200).json({ data: record });
    } catch (error) { next(error); }
  });
  router.post("/:entity", resolveContext, authorize("create"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      const body = await context.entity.createSchema.parseAsync(req.body);
      const record = await crudService.create(toServiceContext(context), body);
      res.status(201).json({ data: record });
    } catch (error) { next(error); }
  });
  router.put("/:entity/:id", resolveContext, authorize("update"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      const body = await context.entity.replaceSchema.parseAsync(req.body);
      const record = await crudService.replace(toServiceContext(context), req.params.id, body);
      res.status(200).json({ data: record });
    } catch (error) { next(error); }
  });
  router.patch("/:entity/:id", resolveContext, authorize("update"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      const body = await context.entity.updateSchema.parseAsync(req.body);
      const record = await crudService.update(toServiceContext(context), req.params.id, body);
      res.status(200).json({ data: record });
    } catch (error) { next(error); }
  });
  router.delete("/:entity/:id", resolveContext, authorize("delete"), async (req: CrudRequest, res, next) => {
    try {
      const context = requireCrudContext(req);
      await crudService.delete(context.knex, context.entity, req.params.id);
      res.status(204).send();
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof z.ZodError) {
      logger.info({ err: error, details: error.flatten() }, "Validation error");
      res.status(400).json({ error: "invalid_request", message: "The request payload is invalid.", details: error.flatten() });
      return;
    }
    if (error instanceof EntityIdentityValidationError) {
      logger.info({ err: error }, "EntityIdentityValidationError");
      res.status(400).json({ error: "invalid_request", message: "Check the marked fields.", details: { issues: [{ path: error.path, message: error.message }] } });
      return;
    }
    if (error instanceof CrudSummaryNotSupportedError) {
      logger.info({ err: error }, "Entity summary is not supported/implemented");
      res.status(404).json({ error: "summary_not_supported", message: error.message });
      return;
    }
    if (error instanceof UIAdapterValidationError) {
      logger.info({ err: error }, "Invalid entity UI value");
      res.status(400).json({ error: "invalid_request", message: error.message });
      return;
    }
    if (error instanceof CrudEntityNotFoundError) {
      logger.info({ err: error }, "Entity not found");
      res.status(404).json({ error: "entity_not_found", message: error.message });
      return;
    }
    if (error instanceof CrudRecordNotFoundError) {
      logger.info({ err: error }, "Record not found");
      res.status(404).json({ error: "record_not_found", message: error.message });
      return;
    }
    if (error instanceof CrudForbiddenError) {
      logger.warn({ err: error }, "Forbidden access attempt");
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (error instanceof CrudInvalidQueryError) {
      logger.info({ err: error }, "Invalid query parameters");
      res.status(400).json({ error: "invalid_query", message: error.message });
      return;
    }
    if (error instanceof ForeignKeyReferenceNotFoundError) {
      logger.warn({ err: error, constraint: error.constraintName }, "Foreign key reference not found");
      res.status(409).json({ error: "foreign_key_reference_not_found",
        message: "The referenced record does not exist.", constraint: error.constraintName });
      return;
    }
    if (error instanceof RecordIsReferencedError) {
      logger.warn({ err: error, constraint: error.constraintName }, "Record is referenced by another entity");
      res.status(409).json({ error: "record_is_referenced",
        message: "This record cannot be deleted or updated because it is referenced by another record.",
        constraint: error.constraintName });
      return;
    }
    if (error instanceof UniqueConstraintViolationError) {
      logger.warn({ err: error, constraint: error.constraintName }, "Unique constraint violation");
      res.status(409).json({ error: "unique_constraint_violation",
        message: "A record with the same unique value already exists.", constraint: error.constraintName });
      return;
    }
    logger.error({ err: error }, "Unknown router error, delegating to central handler");
    next(error);
  });
  return router;
}
function requireCrudContext(req: CrudRequest): CrudRequestContext {
  if (!req.crudContext) throw new Error("CRUD request context was not initialized");
  return req.crudContext;
}
function toServiceContext(context: CrudRequestContext): CrudContext {
  return { actor: context.actor, projectId: context.projectId,
    databaseName: context.databaseName, knex: context.knex, entity: context.entity };
}
