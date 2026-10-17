import raw from '../generated/form-metadata.json';
import type { JsonObject } from './models';

export interface Constraints {
  enum?: (string | number | boolean)[];
  patterns?: string[];
  format?: string;
  minLength?: string | number;
  maxLength?: string | number;
  whiteSpace?: string;
  [key: string]: unknown;
}
export interface Field {
  name: string;
  label: string;
  enumLabels?: Record<string, string>;
  ref?: string;
  kind: string;
  constraints: Constraints;
  min: number;
  max: number | 'unbounded';
  required: boolean;
  nullable: boolean;
  system: boolean;
  defaultValue?: unknown;
  fixedValue?: unknown;
}
export interface Choice {
  branches: string[][];
  optional: boolean;
  repeated: boolean;
}
export interface Shape {
  name: string;
  fields: Field[];
  choices: Choice[];
  reference: boolean;
  scalar?: { jsonType: string; constraints: Constraints; enumLabels?: Record<string, string> };
}
export const metadata = raw as unknown as {
  issue: string;
  root: string;
  types: Record<string, Shape>;
  warnings: string[];
};
export const shapeOf = (name: string): Shape => metadata.types[name];
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const repeated = (field: Field): boolean => field.max === 'unbounded' || field.max > 1;
export const itemField = (field: Field): Field => ({ ...field, min: 1, max: 1, required: true });
export function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => same(v, right[i]));
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
    );
  }
  return false;
}
export function initialValue(field: Field, depth = 0): unknown {
  if (field.fixedValue != null) return field.fixedValue;
  if (repeated(field))
    return Array.from({ length: Math.max(1, field.min) }, () =>
      initialValue(itemField(field), depth),
    );
  if (field.ref && !shapeOf(field.ref).scalar) {
    // Only materialize required values. Optional recursive branches stay absent.
    if (depth > 15) return {};
    const shape = shapeOf(field.ref);
    const value: JsonObject = {};
    shape.fields
      .filter((child) => child.required && !child.system)
      .forEach((child) => {
        value[child.name] = initialValue(child, depth + 1);
      });
    for (const choice of shape.choices.filter((group) => !group.optional)) {
      for (const name of choice.branches[0] || []) {
        const child = shape.fields.find((f) => f.name === name)!;
        value[name] = initialValue(child, depth + 1);
      }
    }
    return value;
  }
  const scalar = field.ref
    ? shapeOf(field.ref).scalar!
    : { jsonType: field.kind, constraints: field.constraints };
  if (field.defaultValue != null) return field.defaultValue;
  if (scalar.constraints.enum?.length) return scalar.constraints.enum[0];
  if (scalar.jsonType === 'boolean') return false;
  // Exact XSD decimals and large integers can be strings; do not coerce them here.
  return '';
}
export const organizationFields = shapeOf('organization').fields.filter((field) => !field.system);
