// Translate the subset emitted by our JSON Schema generator. This is deliberately
// not a general-purpose JSON Schema compiler: unsupported structural keywords fail
// rather than silently erasing a constraint when that generator changes.
const structuralKeys = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties',
  'patternProperties', 'items', 'minItems', 'maxItems', 'allOf', 'anyOf', 'oneOf', 'not',
]);
const annotationKeys = new Set([
  'title', 'description', 'default', 'format', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'contentEncoding',
]);
const namespacePattern = '^@_xmlns(?::[^:]+)?$';
const tupleLimit = 20;

const quote = (value) => JSON.stringify(value);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
const unique = (values) => [...new Set(values)];

function join(types, operator) {
  const identity = operator === '&' ? 'unknown' : 'never';
  const absorbing = operator === '&' ? 'never' : 'unknown';
  if (types.includes(absorbing)) return absorbing;
  const members = unique(types.filter((type) => type !== identity));
  if (!members.length) return identity;
  return members.length === 1 ? members[0] : `(${members.join(` ${operator} `)})`;
}

// Presence assertions have one field per alternative, or groups of alternatives.
function presenceNames(schema) {
  if (only(schema, ['required']) && schema.required?.length === 1) return schema.required;
  if (only(schema, ['anyOf']) && schema.anyOf?.length) {
    const names = schema.anyOf.map(presenceNames);
    if (names.every(Boolean)) return unique(names.flat());
  }
  return null;
}

function absentNames(schema) {
  return only(schema, ['not']) ? presenceNames(schema.not) : null;
}

function absentType(names) {
  return `{ ${unique(names).map((name) => `${quote(name)}?: never;`).join(' ')} }`;
}

/** Collapse independent optional fields before TS expands intersections of unions. */
function simplify(schema) {
  if (!isObject(schema)) return schema;
  const result = { ...schema };
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key]) result[key] = schema[key].map(simplify);
  }
  if (result.allOf) {
    result.allOf = result.allOf.filter((child) => {
      if (!only(child, ['properties', 'required'])) return true;
      if (child.properties) {
        result.properties = { ...result.properties };
        for (const [name, property] of Object.entries(child.properties)) {
          const previous = result.properties[name];
          result.properties[name] = previous === false || (previous && Object.keys(previous).length)
            ? { allOf: [previous, property] } : property;
        }
      }
      if (child.required) result.required = unique([...(result.required || []), ...child.required]);
      return false;
    });
    if (!result.allOf.length) delete result.allOf;
  }
  if (result.anyOf?.length === 2) {
    const [absent, present] = result.anyOf;
    const names = absentNames(absent);
    // An optional group of several fields must keep its all-or-none constraint.
    const fields = Object.keys(present.properties || {});
    const required = present.required || [];
    if (names?.length && only(present, ['properties', 'required'])
        && fields.length === names.length && fields.every((name) => names.includes(name))
        && (!required.length || (names.length === 1 && required.length === 1 && required[0] === names[0]))) {
      delete result.anyOf;
      result.properties = { ...result.properties, ...present.properties };
    }
  }
  return result;
}

function literal(value) {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (isObject(value)) {
    return `{ ${Object.entries(value).map(([key, item]) => `${quote(key)}: ${literal(item)};`).join(' ')} }`;
  }
  return quote(value);
}

class TypeScriptSchema {
  constructor(resolveReference) {
    this.resolveReference = resolveReference;
  }

  type(input) {
    if (input === false) return 'never';
    if (input === true) return 'unknown';
    const schema = simplify(input);
    for (const key of Object.keys(schema)) {
      if (!structuralKeys.has(key) && !annotationKeys.has(key) && !key.startsWith('x-')) {
        throw new Error(`Unsupported TypeScript schema keyword: ${key}`);
      }
    }
    if (schema.$ref) return this.resolveReference(schema.$ref);
    const parts = [];
    if (Object.hasOwn(schema, 'const')) parts.push(literal(schema.const));
    if (schema.enum) parts.push(join(schema.enum.map(literal), '|'));
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      parts.push(join(types.map((type) => this.primitive(type, schema)), '|'));
    } else if (schema.properties || schema.required) parts.push(this.object(schema));
    if (schema.allOf) parts.push(...schema.allOf.map((child) => this.type(child)));
    if (schema.anyOf) parts.push(join(schema.anyOf.map((child) => this.type(child)), '|'));
    if (schema.oneOf) {
      const groups = schema.oneOf.map(presenceNames);
      parts.push(join(schema.oneOf.map((child, i) => {
        const type = this.type(child);
        if (!groups.every(Boolean)) return type; // Disjoint scalar/ref/null alternatives.
        const excluded = groups.filter((_, j) => i !== j).flat();
        return join([type, absentType(excluded)], '&');
      }), '|'));
    }
    if (schema.not) {
      const names = absentNames(schema);
      if (!names) throw new Error('Unsupported TypeScript negation; expected field absence');
      parts.push(absentType(names));
    }
    return join(parts, '&');
  }

  primitive(type, schema) {
    if (type === 'object') return this.object(schema);
    if (type === 'array') return this.array(schema);
    if (type === 'integer') return 'number';
    if (['string', 'number', 'boolean', 'null'].includes(type)) return type;
    throw new Error(`Unsupported TypeScript schema type: ${type}`);
  }

  object(schema) {
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const names = unique([...Object.keys(properties), ...required]);
    const fields = names.map((name) => {
      const type = this.type(properties[name] ?? {});
      return `${quote(name)}${required.has(name) ? '' : '?'}: ${type};`;
    });
    for (const pattern of Object.keys(schema.patternProperties || {})) {
      if (pattern !== namespacePattern) throw new Error(`Unsupported TypeScript property pattern: ${pattern}`);
      // Literal TypeScript template index signature, not a JS interpolation.
      // eslint-disable-next-line no-template-curly-in-string
      fields.push('"@_xmlns"?: string;', '[namespace: `@_xmlns:${string}`]: string;');
    }
    if (schema.additionalProperties === true
        || (!fields.length && schema.type === 'object' && schema.additionalProperties !== false)) {
      fields.push('[key: string]: unknown;');
    }
    // {} in TS accepts scalars; Record<string, never> represents an empty object.
    return fields.length ? `{\n${fields.map((field) => `  ${field.replace(/\n/g, '\n  ')}`).join('\n')}\n}`
      : 'Record<string, never>';
  }

  array(schema) {
    const item = this.type(schema.items ?? {});
    const min = schema.minItems || 0;
    const max = schema.maxItems;
    if (max !== undefined && max < min) return 'never';
    if (Number.isInteger(max) && max <= tupleLimit) {
      return join(Array.from({ length: max - min + 1 }, (_, offset) => (
        `[${Array(min + offset).fill(item).join(', ')}]`
      )), '|');
    }
    const prefix = Array(Math.min(min, tupleLimit)).fill(item);
    if (!prefix.length) return `Array<${item}>`;
    return `[${prefix.join(', ')}, ...Array<${item}>]`;
  }
}

module.exports = { TypeScriptSchema };
