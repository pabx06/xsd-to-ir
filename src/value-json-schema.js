const { XMLParser } = require('fast-xml-parser');
const { numericSchema, numericChoices, numericValue } = require('./numeric-value-schema');

// Match legacy XMLDeserializer coercion for compatibility with stored string fields.
const textParser = new XMLParser({ trimValues: true });
function parsedText(value) {
  const text = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return textParser.parse(`<value>${text}</value>`).value;
}

const pointer = (name) => name.replace(/~/g, '~0').replace(/\//g, '~1');
const ref = (name) => ({ $ref: `#/definitions/${pointer(name)}` });
const multiply = (a, b) => (a === 'unbounded' || b === 'unbounded' ? 'unbounded' : a * b);
const repeating = (max) => max === 'unbounded' || max > 1;
const nilTrue = ['true', '1', true, 1];
const nilFalse = ['false', '0', false, 0];
const namespaceProperties = { '^@_xmlns(?::[^:]+)?$': { type: 'string' } };

function fieldNames(particle) {
  if (!particle) return [];
  if (particle.kind === 'element') return [particle.jsonName];
  return [...new Set(particle.children.flatMap(fieldNames))];
}

function absent(names) {
  return names.length ? { not: { anyOf: names.map((name) => ({ required: [name] })) } } : {};
}

function combine(schemas) {
  const result = {};
  for (const schema of schemas) {
    if (schema.properties) {
      result.properties ||= {};
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = result.properties[key]
          ? { allOf: [result.properties[key], value] } : value;
      }
    }
    if (schema.required?.length) result.required = [...new Set([...(result.required || []), ...schema.required])];
    if (schema.allOf) result.allOf = [...(result.allOf || []), ...schema.allOf];
    const rest = Object.fromEntries(Object.entries(schema)
      .filter(([key]) => !['properties', 'required', 'allOf'].includes(key)));
    if (Object.keys(rest).length) result.allOf = [...(result.allOf || []), rest];
  }
  return result;
}

function scalarValue(value, type, numericKind) {
  if (['integer', 'number'].includes(type)) return numericValue(value, numericKind);
  if (type === 'boolean' && ['true', '1', 'false', '0'].includes(String(value))) {
    return value === true || value === 1 || value === 'true' || value === '1';
  }
  return value;
}

/** JSON Schema for the parser's XML-shaped JSON values, not database entity objects. */
class ValueJSONSchema {
  constructor(ir) {
    this.ir = ir;
    this.types = ir.valueTypes || new Map();
    this.shapes = new Map();
  }

  definitions() {
    return Object.fromEntries([...this.types].map(([name]) => [name, this.definition(name)]));
  }

  shape(name, seen = new Set()) {
    if (this.shapes.has(name)) return this.shapes.get(name);
    const type = this.types.get(name);
    if (!type) throw new Error(`Missing IR value type: ${name}`);
    if (seen.has(name)) throw new Error(`Cyclic value type inheritance: ${name}`);
    const base = type.baseTypeRef ? this.shape(type.baseTypeRef, new Set([...seen, name])) : null;
    const attributes = new Map((base?.attributes || []).map((field) => [field.jsonName, field]));
    type.attributes.forEach((field) => attributes.set(field.jsonName, field));
    const shape = {
      ...type,
      attributes: [...attributes.values()],
      text: type.text || base?.text || null,
      content: type.derivation === 'extension' && base?.content
        ? {
          kind: 'sequence', minOccurs: 1, maxOccurs: 1, children: [base.content, type.content].filter(Boolean),
        }
        : type.content,
      assertionRefs: [...new Set([...(base?.assertionRefs || []), ...type.assertionRefs])],
      unsupported: [...new Set([...(base?.unsupported || []), ...type.unsupported])],
    };
    this.shapes.set(name, shape);
    return shape;
  }

  definition(name) {
    const type = this.shape(name);
    const warnings = new Set(type.unsupported);
    const content = type.content ? this.particle(type.content, warnings) : {};
    const attributes = this.attributeSchema(type.attributes, warnings);
    const object = {
      type: 'object',
      ...combine([content, attributes]),
      patternProperties: namespaceProperties,
      additionalProperties: type.unsupported.some((reason) => /xs:any/.test(reason)),
    };
    // Declare all names at the object boundary; group/choice rules live in subschemas.
    object.properties = {
      ...Object.fromEntries(fieldNames(type.content).map((key) => [key, {}])),
      ...object.properties,
      '@_xsi:nil': { enum: nilFalse },
    };
    if (type.text) {
      object.properties['#text'] = this.scalar(type.text, false, warnings);
      object.required = [...(object.required || []), '#text'];
    } else if (type.mixed) object.properties['#text'] = {};
    const rules = [...this.ir.assertions?.values() || []].flatMap((set) => set.rules)
      .filter((rule) => type.assertionRefs.includes(rule.id));
    for (const rule of rules) {
      if (rule.kind === 'exactlyOneGroup') {
        object.allOf ||= [];
        object.allOf.push({
          oneOf: rule.groups.map((group) => ({
            anyOf: group.map((field) => ({ required: [field.xmlName] })),
          })),
        });
        continue;
      }
      if (rule.kind !== 'exactlyOne') {
        warnings.add(`Assertion ${rule.id} requires XSD validation.`);
        continue;
      }
      const names = rule.fields.map((field) => (field.kind === 'attribute' ? `@_${field.name}` : field.name));
      object.allOf ||= [];
      object.allOf.push({
        oneOf: names.map((key) => ({
          required: [key],
          properties: { [key]: { not: { enum: [null, '', []] } } },
        })),
      });
    }
    const result = type.text && !attributes.required?.length && !rules.length
      ? { anyOf: [this.scalar(type.text, false, warnings), object] } : object;
    result.title = name;
    if (type.documentation) result.description = type.documentation;
    if (type.assertionRefs.length) result['x-xsd-assertions'] = type.assertionRefs;
    if (warnings.size) result['x-xsd-unsupported'] = [...warnings];
    return result;
  }

  attributeSchema(attributes, warnings) {
    const result = { properties: {}, required: [] };
    for (const field of attributes) {
      result.properties[field.jsonName] = field.maxOccurs === 0 ? false : this.fieldValue(field, warnings);
      if (field.minOccurs > 0 && field.maxOccurs !== 0) result.required.push(field.jsonName);
    }
    return result;
  }

  scalar(use, attribute, warnings) {
    use.unsupported.forEach((reason) => warnings.add(reason));
    if (use.valueTypeRef) return ref(use.valueTypeRef);
    if (use.alternatives) return { anyOf: use.alternatives.map((item) => this.scalar(item, attribute, warnings)) };
    const schema = use.jsonType ? { type: use.jsonType } : {};
    const constraints = use.constraints;
    for (const key of ['format', 'minimum', 'maximum', 'contentEncoding']) {
      if (constraints[key] !== undefined) schema[key] = constraints[key];
    }
    for (const [source, target] of Object.entries({
      minLength: 'minLength', maxLength: 'maxLength', minInclusive: 'minimum', maxInclusive: 'maximum',
      minExclusive: 'exclusiveMinimum', maxExclusive: 'exclusiveMaximum',
    })) {
      if (constraints[source] !== undefined) schema[target] = Number(constraints[source]);
    }
    if (constraints.length !== undefined) {
      schema.minLength = Number(constraints.length);
      schema.maxLength = Number(constraints.length);
    }
    if (constraints.enum) schema.enum = [...new Set(constraints.enum.map((value) => scalarValue(value, use.jsonType)))];
    if (constraints.patterns?.length) {
      const patterns = constraints.patterns.filter((pattern) => {
        try {
          // XML-only escapes and character-class subtraction have no direct ECMA equivalent.
          if (/\\[iIcCpP]|\]-\[/.test(pattern)) throw new Error('XML regex');
          new RegExp(pattern); // eslint-disable-line no-new
          return true;
        } catch {
          warnings.add(`XML regular expression requires XSD validation: ${pattern}`);
          return false;
        }
      });
      if (patterns.length === 1) schema.pattern = patterns[0];
      else if (patterns.length) schema.anyOf = patterns.map((pattern) => ({ pattern }));
    }
    for (const key of ['totalDigits', 'fractionDigits', 'whiteSpace']) {
      if (constraints[key] !== undefined) warnings.add(`${key} requires XSD validation.`);
    }
    if (!attribute && use.jsonType === 'string') {
      const coerced = { type: ['number', 'boolean'] };
      if (constraints.enum) {
        // Preserve enum restrictions even when a code such as "01" was imported as 1.
        const values = constraints.enum.map(parsedText).filter((value) => typeof value !== 'string');
        if (!values.length) return schema;
        coerced.enum = [...new Set(values)];
      } else if (Object.keys(constraints).some((key) => (
        ['length', 'maxLength', 'patterns', 'format'].includes(key)
          || (key === 'minLength' && Number(constraints[key]) > 1)
      ))) {
        warnings.add('String facets on parser-coerced numbers/booleans require XSD validation; original text spelling is lost.');
      }
      return { anyOf: [schema, coerced] };
    }
    if (use.jsonType === 'boolean') {
      const values = schema.enum || [true, false];
      const forms = values.flatMap((value) => (value ? [true, 1] : [false, 0]));
      if (attribute) forms.push(...values.flatMap((value) => (value ? ['true', '1'] : ['false', '0'])));
      return { enum: [...new Set(forms)] };
    }
    return ['integer', 'number'].includes(use.jsonType) ? numericSchema(schema, use, warnings) : schema;
  }

  nilValue(use, warnings) {
    const attributes = use.valueTypeRef ? this.shape(use.valueTypeRef).attributes : [];
    const schema = this.attributeSchema(attributes, warnings);
    return {
      type: 'object',
      properties: { ...schema.properties, '@_xsi:nil': { enum: nilTrue }, '#text': { const: '' } },
      required: [...schema.required, '@_xsi:nil'],
      patternProperties: namespaceProperties,
      additionalProperties: false,
    };
  }

  fieldValue(field, warnings) {
    const attribute = field.kind === 'attribute';
    let schema = this.scalar(field.type, attribute, warnings);
    if (field.fixedValue !== null && ['integer', 'number'].includes(field.type.jsonType)) {
      schema = {
        allOf: [schema, numericChoices([field.fixedValue], field.type, warnings)],
        'x-xsd-fixed': field.fixedValue,
      };
    } else if (field.fixedValue !== null) {
      const fixed = scalarValue(field.fixedValue, attribute ? 'string' : field.type.jsonType);
      const values = attribute ? [fixed] : [fixed, parsedText(field.fixedValue)];
      if (field.type.jsonType === 'boolean') {
        const boolean = scalarValue(field.fixedValue, 'boolean');
        values.push(boolean, boolean ? 1 : 0);
        if (attribute) values.push(boolean ? 'true' : 'false', boolean ? '1' : '0');
      }
      schema = { allOf: [schema, { enum: [...new Set(values)] }] };
    }
    if (!attribute && !field.type.valueTypeRef) {
      schema = {
        anyOf: [schema, {
          type: 'object',
          properties: { '#text': schema, '@_xsi:nil': { enum: nilFalse } },
          required: ['#text'],
          patternProperties: namespaceProperties,
          additionalProperties: false,
        }],
      };
    }
    if (field.nillable) schema = { anyOf: [schema, this.nilValue(field.type, warnings)] };
    if (field.documentation) schema = { ...schema, description: field.documentation };
    if (field.defaultValue !== null) {
      schema = {
        ...schema,
        default: scalarValue(field.defaultValue, attribute ? 'string' : field.type.jsonType, field.type.numericKind),
      };
    }
    return schema;
  }

  occurrence(value, min, max) {
    if (max === 0) return false;
    if (!repeating(max)) return value;
    const array = { type: 'array', items: value, minItems: Math.max(1, min) };
    if (max !== 'unbounded') array.maxItems = max;
    // fast-xml-parser preserves a single occurrence as an object/scalar.
    return min > 1 ? array : { anyOf: [value, array] };
  }

  particle(node, warnings, parentMin = 1, parentMax = 1) {
    const min = parentMin * Math.max(1, node.minOccurs);
    const max = multiply(parentMax, node.maxOccurs);
    const names = fieldNames(node);
    if (max === 0) return absent(names);
    if (node.kind === 'element') {
      const schema = {
        properties: {
          [node.jsonName]: this.occurrence(this.fieldValue(node, warnings), node.minOccurs * parentMin, max),
        },
      };
      if (node.minOccurs > 0) schema.required = [node.jsonName];
      return schema;
    }
    let body;
    if (node.kind === 'choice' && !repeating(max)) {
      body = {
        anyOf: node.children.map((child) => combine([
          this.particle(child, warnings, min, max),
          absent(names.filter((name) => !fieldNames(child).includes(name))),
        ])),
      };
    } else if (node.kind === 'choice') {
      warnings.add('Repeating choice totals and branch order require XSD validation.');
      body = combine(node.children.map((child) => ({
        anyOf: [
          absent(fieldNames(child)), this.particle(child, warnings, 1, max),
        ],
      })));
      if (node.minOccurs > 0 && names.length) {
        body = combine([body, { anyOf: names.map((name) => ({ required: [name] })) }]);
      }
    } else {
      if (repeating(max)) warnings.add('Repeating group count correlations and XML order require XSD validation.');
      body = combine(node.children.map((child) => this.particle(child, warnings, min, max)));
    }
    return node.minOccurs === 0 ? { anyOf: [absent(names), body] } : body;
  }

  column(column) {
    const warnings = new Set();
    // Validate the reference now rather than emitting a dangling $ref.
    this.shape(column.valueTypeRef);
    const value = column.nillable
      ? { anyOf: [ref(column.valueTypeRef), this.nilValue({ valueTypeRef: column.valueTypeRef }, warnings)] }
      : ref(column.valueTypeRef);
    const occurrence = this.occurrence(value, column.minOccurs ?? 1, column.maxOccurs ?? 1);
    const schema = column.nullable ? { anyOf: [occurrence, { type: 'null' }] } : occurrence;
    return {
      ...schema,
      description: column.documentation || undefined,
      'x-xsd-type': column.xsdType,
      'x-xsd-minOccurs': column.minOccurs,
      'x-xsd-maxOccurs': column.maxOccurs,
      'x-xsd-nillable': !!column.nillable,
    };
  }
}

module.exports = { ValueJSONSchema };
