import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import {
  CrudEntityNotFoundError,
  CrudValidationError,
} from "./entity-crud.errors";
import { EntityMetadata } from "./entity-metadata";
import {
  generateUIJSONSchema,
  UIAdapter,
  UIModel,
  isObject,
  pointer,
  type Value,
} from "./xsd-runtime";
import type { EntityDefinition, SchemaProvider } from "./entity-crud.types";
import { getOrganizationSummary } from "./organization-summary";

export class EntityCrudRegistry {
  private readonly versions = new Map<string, Map<string, EntityDefinition>>();
  constructor(private readonly schemas: SchemaProvider) {}
  clearCache(issue?: string): void {
    if (issue) this.versions.delete(issue);
    else this.versions.clear();
  }
  getEntityDefinition(issue: string, name: string): EntityDefinition {
    const definition = this.definitions(issue).get(name);
    if (!definition) throw new CrudEntityNotFoundError(name);
    return definition;
  }
  getEntityDefinitions(issue: string): EntityDefinition[] {
    return [...this.definitions(issue).values()];
  }
  hasEntity(issue: string, name: string): boolean {
    return this.definitions(issue).has(name);
  }
  private definitions(issue: string): Map<string, EntityDefinition> {
    const cached = this.versions.get(issue);
    if (cached) return cached;
    const model = new UIModel(this.schemas.getIRRAW(issue));
    const metadata = new EntityMetadata(model);
    const definitions = new Map<string, EntityDefinition>();
    for (const [name, entity] of model.ir.entities) {
      const primaryKeys = entity.columns.filter(
        (column) => column.isPrimaryKey,
      );
      // Internal join/tuple tables are not UI entity records.
      if (
        entity.abstract ||
        primaryKeys.length !== 1 ||
        !entity.columns.some((column) => column.name === "uid")
      )
        continue;
      const business = model
        .entity(name)
        .columns.filter((column) => !["uid", "crud"].includes(column.name));
      const shape = Object.fromEntries(
        business.map((column) => [column.name, z.unknown().optional()]),
      );
      const input = z.object(shape).strict();
      let validate: ValidateFunction | undefined;
      const warnings = new Set<string>();
      const compile = () => {
        if (validate) return validate;
        const schema = generateUIJSONSchema(model.ir, { rootEntity: name });
        const seen = new Set<string>();
        const visit = (node: unknown) => {
          if (!isObject(node) && !Array.isArray(node)) return;
          if (isObject(node)) {
            if (Array.isArray(node["x-xsd-unsupported"]))
              for (const warning of node["x-xsd-unsupported"])
                warnings.add(String(warning));
            if (
              typeof node.$ref === "string" &&
              node.$ref.startsWith("#/") &&
              !seen.has(node.$ref)
            ) {
              seen.add(node.$ref);
              const target = node.$ref
                .slice(2)
                .split("/")
                .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
                .reduce<unknown>(
                  (object, key) => (isObject(object) ? object[key] : undefined),
                  schema,
                );
              visit(target);
            }
          }
          Object.values(node).forEach(visit);
        };
        visit({ $ref: schema.$ref });
        for (const key of ["$defs", "definitions"])
          if (isObject(schema[key])) {
            schema[key] = Object.fromEntries(
              Object.entries(schema[key]).filter(([entry]) =>
                seen.has(
                  `#/${key}/${entry.replaceAll("~", "~0").replaceAll("/", "~1")}`,
                ),
              ),
            );
          }
        const ajv = new Ajv({
          allErrors: true,
          strict: false,
          coerceTypes: false,
          useDefaults: false,
          removeAdditional: false,
        });
        addFormats(ajv);
        validate = ajv.compile(schema);
        return validate;
      };
      const prepared = z.record(z.unknown()).transform((value) => {
        // Also enforces bounded recursion before the JSON Schema validator runs.
        metadata.walk(name, value);
        const check = compile();
        if (!check(value)) {
          const issues = (check.errors ?? []).map((error) => {
            const field =
              error.keyword === "required"
                ? error.params.missingProperty
                : error.keyword === "additionalProperties"
                  ? error.params.additionalProperty
                  : undefined;
            return {
              path: error.instancePath + (field ? pointer([field]) : ""),
              message: error.message ?? "Invalid value.",
            };
          });
          throw new CrudValidationError(issues);
        }
        return value;
      });
      const scalars = entity.columns
        .filter(
          (column) => !["object", "array"].includes(column.jsonType ?? ""),
        )
        .map((column) => column.columnName);
      definitions.set(name, {
        dialectVersion: issue,
        name,
        tableName: entity.tableName,
        primaryKey: primaryKeys[0].columnName,
        readableColumns: entity.columns.map((column) => column.columnName),
        fieldColumns: Object.fromEntries(
          entity.columns.map((column) => [column.name, column.columnName]),
        ),
        filterableColumns: scalars,
        sortableColumns: scalars,
        createSchema: input,
        replaceSchema: input,
        updateSchema: input.refine(
          (value) => Object.keys(value).length > 0,
          "Supply at least one field.",
        ),
        preparedCreateSchema: prepared,
        preparedReplaceSchema: prepared,
        metadata,
        ir: model.ir,
        createAdapter: () => new UIAdapter(model.ir),
        summary: name === "organization" ? getOrganizationSummary : undefined,
        validationWarnings: () => {
          compile();
          return [...warnings];
        },
      });
    }
    this.versions.set(issue, definitions);
    return definitions;
  }
}
