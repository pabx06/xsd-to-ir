import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import type { Knex } from "knex";
import { EntityCrudRegistry } from "./entity-crud.registry";
import { EntityCrudService } from "./entity-crud.service";
import {
  CrudError,
  CrudForbiddenError,
  CrudInvalidQueryError,
} from "./entity-crud.errors";
import {
  ForeignKeyReferenceNotFoundError,
  RecordIsReferencedError,
  UniqueConstraintViolationError,
} from "./entity-crud.db-errors";
import { iamAllowed } from "./entity-crud.authorization";
import type {
  Authorizer,
  CrudActor,
  CrudContext,
  CrudOperation,
} from "./entity-crud.types";

export interface Project {
  id: string;
  databaseName: string;
  dialect: string;
  status: string;
}
export interface EntityCrudRouterDependencies {
  registry: EntityCrudRegistry;
  service?: EntityCrudService;
  projectRepository: {
    findById(id: string): Promise<Project | undefined | null>;
  };
  getProjectDatabase(name: string): Knex;
  getActor(
    request: Request,
  ): CrudActor | undefined | Promise<CrudActor | undefined>;
  authorize: Authorizer;
  onError?: (error: unknown) => void;
}
const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.string().trim().min(1).optional(),
    sortDirection: z.enum(["asc", "desc"]).default("asc"),
  })
  .catchall(z.string());

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  // Express 4 ignores returned promises. Forward rejections explicitly so the
  // same error middleware handles them on both Express 4 and Express 5.
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

export function createEntityCrudRouter(
  dependencies: EntityCrudRouterDependencies,
): Router {
  if (
    typeof dependencies.authorize !== "function" ||
    typeof dependencies.getActor !== "function"
  )
    throw new Error(
      "Configure authenticated actor resolution and project permissions before mounting CRUD.",
    );
  const router = Router({ mergeParams: true });
  const service =
    dependencies.service ?? new EntityCrudService(dependencies.registry);
  const param = (request: Request, key: string) =>
    z.string().min(1).parse(request.params[key]);
  const context = async (
    request: Request,
    operation: CrudOperation,
  ): Promise<CrudContext> => {
    const actor = await dependencies.getActor(request);
    if (!actor?.id || actor.id === "unknown")
      throw new CrudError(
        "unauthenticated",
        "Sign in before using this project.",
        401,
      );
    const projectId = param(request, "projectId");
    const entityName = param(request, "entity");
    const project = await dependencies.projectRepository.findById(projectId);
    if (!project)
      throw new CrudError(
        "project_not_found",
        "The project does not exist.",
        404,
      );
    const allowed = await iamAllowed(
      {
        actor,
        projectId,
        databaseName: project.databaseName,
        entity: entityName,
        operation,
        recordId:
          typeof request.params.id === "string" ? request.params.id : undefined,
      },
      dependencies.authorize,
    );
    if (!allowed) throw new CrudForbiddenError();
    if (project.status !== "ready")
      throw new CrudError(
        "project_not_ready",
        "The project is not ready for editing.",
        409,
        undefined,
        project.status,
      );
    const entity = dependencies.registry.getEntityDefinition(
      project.dialect,
      entityName,
    );
    return {
      actor,
      projectId,
      databaseName: project.databaseName,
      entity,
      knex: dependencies.getProjectDatabase(project.databaseName),
    };
  };
  router.get(
    "/:entity",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "list");
      const { page, pageSize, sortBy, sortDirection, ...raw } =
        listQuerySchema.parse(request.query);
      if (
        Object.keys(raw).some(
          (key) => !key.startsWith("filter.") || key.length === 7,
        )
      )
        throw new CrudInvalidQueryError("Unknown query parameter.");
      const filters = Object.fromEntries(
        Object.entries(raw)
          .filter(([, value]) => value !== "")
          .map(([key, value]) => [key.slice(7), value]),
      );
      response.json(
        await service.list(ctx.knex, ctx.entity, {
          page,
          pageSize,
          sortBy,
          sortDirection,
          filters,
        }),
      );
    }),
  );
  router.get(
    "/:entity/summary",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "list");
      response.json({ data: await service.summary(ctx.knex, ctx.entity) });
    }),
  );
  router.get(
    "/:entity/:id",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "read");
      response.json({
        data: await service.findById(
          ctx.knex,
          ctx.entity,
          param(request, "id"),
        ),
      });
    }),
  );
  router.post(
    "/:entity",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "create");
      response
        .status(201)
        .json({ data: await service.create(ctx, request.body) });
    }),
  );
  router.put(
    "/:entity/:id",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "update");
      response.json({
        data: await service.replace(ctx, param(request, "id"), request.body),
      });
    }),
  );
  router.patch(
    "/:entity/:id",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "update");
      response.json({
        data: await service.update(ctx, param(request, "id"), request.body),
      });
    }),
  );
  router.delete(
    "/:entity/:id",
    asyncRoute(async (request, response) => {
      const ctx = await context(request, "delete");
      await service.delete(ctx, param(request, "id"));
      response.status(204).send();
    }),
  );
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "invalid_request",
          message: "The request payload is invalid.",
          details: error.flatten(),
        });
        return;
      }
      if (error instanceof CrudError) {
        response.status(error.httpStatus).json({
          error: error.code,
          message: error.message,
          details: error.details,
          status: error.status,
          constraint: error.constraint,
        });
        return;
      }
      for (const [type, code] of [
        [ForeignKeyReferenceNotFoundError, "foreign_key_reference_not_found"],
        [RecordIsReferencedError, "record_is_referenced"],
        [UniqueConstraintViolationError, "unique_constraint_violation"],
      ] as const) {
        if (error instanceof type) {
          response.status(409).json({
            error: code,
            message: error.message,
            constraint: error.constraintName,
          });
          return;
        }
      }
      dependencies.onError?.(error);
      response.status(500).json({
        error: "internal_error",
        message: "The operation could not be completed.",
      });
    },
  );
  return router;
}
