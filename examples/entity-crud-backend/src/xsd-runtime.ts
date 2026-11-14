/** Keep package-specific imports aligned with the host's installed xsd-to-ir package. */
export type Value = Record<string, unknown>;
export interface TypeUse {
  valueTypeRef?: string | null;
  jsonType?: string | null;
  constraints: {
    patterns?: string[];
    pattern?: string;
    maxLength?: number;
    enum?: string[];
    [key: string]: unknown;
  };
}
export interface Field {
  uiName: string;
  jsonName: string;
  kind: string;
  minOccurs: number;
  maxOccurs: number | "unbounded";
  nillable?: boolean;
  type: TypeUse;
}
export interface Column extends TypeUse {
  name: string;
  columnName: string;
  sqlType: string;
  nullable: boolean;
  minOccurs: number;
  maxOccurs: number | "unbounded";
  isPrimaryKey: boolean;
  xmlKind: string;
}
export interface Relation {
  fieldName: string;
  targetEntity: string;
  parentColumn: string;
  kind: string;
}
export interface Entity {
  name: string;
  tableName: string;
  abstract?: boolean;
  columns: Column[];
  relations: Relation[];
}
export interface Shape {
  name: string;
  fields: Field[];
  attributes: Field[];
  baseTypeRef?: string | null;
}
export interface IR {
  entities: Map<string, Entity>;
  valueTypes: Map<string, unknown>;
  [key: string]: unknown;
}
export interface Model {
  ir: IR;
  shape(name: string): Shape;
  entity(name: string): Entity;
}
export interface Adapter {
  decodeRow(name: string, row: Value): { value: Value; state: object };
  encodeRow(name: string, value: Value, state?: object): Value;
}
// The repository publishes JavaScript. These narrow interfaces cover the APIs used here.
const library = require("xsd-to-ir") as {
  UIAdapter: new (ir: unknown) => Adapter;
  generateUIJSONSchema(ir: unknown, options: { rootEntity: string }): Value;
  IRBuilder: new (parsed: unknown) => { build(): IR };
  parseXSD(file: string): unknown;
};
const contract = require("xsd-to-ir/src/ui-contract") as {
  UIModel: new (ir: unknown) => Model;
};
export const { UIAdapter, generateUIJSONSchema, IRBuilder, parseXSD } = library;
export const { UIModel } = contract;
export const generateSQL = (
  require("xsd-to-ir/src/sql-generator") as { generateSQL(ir: IR): string }
).generateSQL;
export function isObject(value: unknown): value is Value {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function pointer(path: readonly (string | number)[]): string {
  return path
    .map(
      (part) => "/" + String(part).replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .join("");
}
