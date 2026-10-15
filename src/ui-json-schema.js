const { generateJSONSchema } = require('./json-schema-generator');
const { numericChoices, numericValue } = require('./numeric-value-schema');
const { UIModel } = require('./ui-contract');
const { ValueJSONSchema } = require('./value-json-schema');

function annotations(source, target) {
  for (const key of ['title', 'description', 'x-xsd-assertions', 'x-xsd-unsupported']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

function canonical(value, use) {
  if (use.jsonType === 'boolean') return value === true || value === 1 || value === 'true' || value === '1';
  if (['integer', 'number'].includes(use.jsonType)) return numericValue(value, use.numericKind);
  return value;
}

/** JSON Schema for values exposed to application forms and other UI code. */
class UIValueJSONSchema extends ValueJSONSchema {
  constructor(input, model = new UIModel(input)) {
    super(model.ir);
    this.model = model;
  }

  shape(name) {
    return this.model.shape(name);
  }

  scalar(use, _attribute, warnings) {
    if (use.valueTypeRef) return super.scalar(use, true, warnings);
    if (use.alternatives) {
      return { anyOf: use.alternatives.map((item) => this.scalar(item, false, warnings)) };
    }
    // Passing attribute=true suppresses fast-xml-parser's legacy string coercions.
    const schema = super.scalar(use, true, warnings);
    if (use.jsonType !== 'boolean') return schema;
    const values = (schema.enum || [true, false]).filter((value) => typeof value === 'boolean');
    return values.length === 2 ? { type: 'boolean' } : { enum: values };
  }

  nilValue() {
    return { type: 'null' };
  }

  fieldValue(field, warnings) {
    const use = field.type;
    let schema = this.scalar(use, false, warnings);
    if (field.fixedValue !== null && ['integer', 'number'].includes(use.jsonType)) {
      schema = {
        allOf: [schema, numericChoices([field.fixedValue], use, warnings)],
        'x-xsd-fixed': field.fixedValue,
      };
    } else if (field.fixedValue !== null) {
      schema = { allOf: [schema, { enum: [canonical(field.fixedValue, use)] }] };
    }
    if (field.nillable) schema = { anyOf: [schema, this.nilValue()] };
    if (field.documentation) schema = { ...schema, description: field.documentation };
    if (field.defaultValue !== null) {
      schema = { ...schema, default: canonical(field.defaultValue, use) };
    }
    return schema;
  }

  occurrence(value, min, max) {
    if (max === 0) return false;
    if (max !== 'unbounded' && max <= 1) return value;
    const array = { type: 'array', items: value, minItems: Math.max(1, min) };
    if (max !== 'unbounded') array.maxItems = max;
    return array;
  }

  column(column) {
    const warnings = new Set();
    if (column.valueTypeRef) this.shape(column.valueTypeRef);
    const value = this.fieldValue({
      ...column,
      type: this.model.columnUse(column),
      fixedValue: column.fixedValue ?? null,
      defaultValue: column.defaultValue ?? null,
    }, warnings);
    return {
      ...this.occurrence(value, column.minOccurs ?? 1, column.maxOccurs ?? 1),
      description: column.documentation || undefined,
      'x-xsd-type': column.xsdType,
      'x-xsd-minOccurs': column.minOccurs,
      'x-xsd-maxOccurs': column.maxOccurs,
      'x-xsd-nillable': !!column.nillable,
      ...(warnings.size ? { 'x-xsd-unsupported': [...warnings] } : {}),
    };
  }

  entity(name) {
    // Flatten before closing the object so inherited properties remain valid.
    const entity = this.model.entity(name);
    const properties = {};
    const required = [];
    for (const column of entity.columns) {
      properties[column.name] = this.column(column);
      if (!column.nullable) required.push(column.name);
    }
    for (const relation of entity.relations) {
      const ref = { $ref: `#/$defs/${relation.targetEntity}` };
      if (relation.kind === 'one-to-many') {
        properties[relation.fieldName] = {
          type: 'array', items: ref,
          ...(relation.minOccurs > 0 ? { minItems: relation.minOccurs } : {}),
          ...(relation.maxOccurs !== 'unbounded' ? { maxItems: relation.maxOccurs } : {}),
        };
      } else {
        properties[relation.fieldName] = relation.nullable ? { oneOf: [ref, { type: 'null' }] } : ref;
      }
      if (!relation.nullable && relation.minOccurs > 0) required.push(relation.fieldName);
    }
    return {
      title: name,
      description: entity.documentation || undefined,
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
  }

  definition(name) {
    const shape = this.shape(name);
    const raw = super.definition(name);
    if (shape.scalarText) {
      const warnings = new Set(raw['x-xsd-unsupported'] || []);
      const result = this.scalar(shape.text, false, warnings);
      annotations(raw, result);
      if (warnings.size) result['x-xsd-unsupported'] = [...warnings];
      return result;
    }

    const names = new Map([
      ...shape.fields.map((field) => [field.jsonName, field.uiName]),
      ...shape.attributes.map((field) => [field.jsonName, field.uiName]),
      ['#text', shape.textName],
    ]);
    const rename = (field) => names.get(field) || field;
    const transform = (schema) => {
      if (!schema || typeof schema !== 'object') return schema;
      if (Array.isArray(schema)) return schema.map(transform);
      const result = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'patternProperties') continue;
        if (key === 'properties') {
          result.properties = Object.fromEntries(Object.entries(value)
            .filter(([field]) => field !== '@_xsi:nil')
            .map(([field, child]) => [rename(field), transform(child)]));
        } else if (key === 'required') {
          const required = value.filter((field) => field !== '@_xsi:nil').map(rename);
          if (required.length) result.required = required;
        } else result[key] = transform(value);
      }
      return result;
    };

    // XML simple content with optional attributes permits a scalar branch. UI
    // values with any declared business attribute consistently use an object.
    const object = shape.text && raw.anyOf?.length === 2 ? raw.anyOf[1] : raw;
    return annotations(raw, transform(object));
  }
}

function generateUIJSONSchema(input, options = {}) {
  const model = new UIModel(input);
  const values = new UIValueJSONSchema(model.ir, model);
  const schema = generateJSONSchema(model.ir, {
    schemaId: 'https://example.com/ui-schema.json',
    ...options,
    valueSchemas: values,
    entitySchema: (name) => values.entity(name),
  });
  schema.title = 'XSD-derived UI schema';
  schema.description = 'Auto-generated clean UI representation from XSD via xsd-to-ir';
  return schema;
}

module.exports = { generateUIJSONSchema, UIValueJSONSchema };
