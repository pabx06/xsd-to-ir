import { isDeepStrictEqual } from "node:util";
import { CrudError, CrudValidationError } from "./entity-crud.errors";
import {
  isObject,
  pointer,
  type Model,
  type Shape,
  type Value,
} from "./xsd-runtime";

export interface Occurrence {
  type: string;
  value: Value;
  path: (string | number)[];
  shape: Shape;
}
export interface UidRule {
  prefix: string;
  patterns: RegExp[];
  maxLength: number;
}

export class EntityMetadata {
  constructor(public readonly model: Model) {}
  /** Follow actual values, not an eagerly expanded graph of recursive schema types. */
  walk(type: string, value: Value): Occurrence[] {
    const result: Occurrence[] = [];
    const active = new Set<object>();
    const visit = (
      name: string,
      node: unknown,
      path: (string | number)[],
      depth: number,
    ) => {
      if (depth > 100)
        throw new CrudValidationError([
          { path: pointer(path), message: "Value is nested too deeply." },
        ]);
      if (!isObject(node)) return;
      if (active.has(node))
        throw new CrudValidationError([
          { path: pointer(path), message: "Cyclic values are not JSON." },
        ]);
      active.add(node);
      const shape = this.model.shape(name);
      result.push({ type: name, value: node, path, shape });
      for (const field of shape.fields) {
        if (
          !field.type.valueTypeRef ||
          field.maxOccurs === 0 ||
          !Object.hasOwn(node, field.uiName)
        )
          continue;
        const child = node[field.uiName];
        if (Array.isArray(child))
          child.forEach((entry, index) =>
            visit(
              field.type.valueTypeRef!,
              entry,
              [...path, field.uiName, index],
              depth + 1,
            ),
          );
        else
          visit(
            field.type.valueTypeRef,
            child,
            [...path, field.uiName],
            depth + 1,
          );
      }
      active.delete(node);
    };
    visit(type, value, [], 0);
    return result;
  }
  identities(type: string, value: Value): Occurrence[] {
    return this.walk(type, value).filter((item) =>
      item.shape.attributes.some(
        (field) => field.uiName === "uid" && field.maxOccurs !== 0,
      ),
    );
  }
  references(type: string, value: Value): Occurrence[] {
    return this.walk(type, value).filter((item) =>
      item.shape.attributes.some(
        (field) => field.uiName === "uidRef" && field.maxOccurs !== 0,
      ),
    );
  }
  uidRule(type: string): UidRule {
    const attribute = this.model
      .shape(type)
      .attributes.find(
        (field) => field.uiName === "uid" && field.maxOccurs !== 0,
      );
    const constraints = attribute?.type.constraints;
    const patterns =
      constraints?.patterns ??
      (constraints?.pattern ? [constraints.pattern] : []);
    // The supported numeric UID syntax is read from the XSD, never from a table name.
    const declaration = patterns.find((pattern) =>
      /^([A-Za-z_][A-Za-z0-9_.-]*)\[1-9\]\[0-9\]\*$/.test(pattern),
    );
    const prefix = declaration?.slice(0, declaration.indexOf("["));
    if (!prefix)
      throw new CrudError(
        "uid_policy_required",
        `No supported schema UID allocation rule for "${type}".`,
        409,
      );
    return {
      prefix,
      maxLength: Math.min(Number(constraints?.maxLength ?? 255), 255),
      patterns: patterns.map((pattern) => new RegExp(`^(?:${pattern})$`, "u")),
    };
  }
  businessValue(type: string, value: Value): Value {
    const copy = structuredClone(value);
    for (const node of this.identities(type, copy)) {
      delete node.value.uid;
      delete node.value.crud;
    }
    return copy;
  }
  sameBusiness(type: string, left: Value, right: Value): boolean {
    return isDeepStrictEqual(
      this.businessValue(type, left),
      this.businessValue(type, right),
    );
  }
  compatible(type: string, expected: string): boolean {
    const seen = new Set<string>();
    let current: string | null | undefined = type;
    while (current && !seen.has(current)) {
      if (current === expected) return true;
      seen.add(current);
      current = this.model.shape(current).baseTypeRef;
    }
    return false;
  }
}
