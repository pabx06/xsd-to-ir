const { ValueJSONSchema } = require('./value-json-schema');

function normalizeIR(input) {
  const ir = { ...input };
  for (const name of ['entities', 'valueTypes', 'enums', 'simpleTypes', 'assertions', 'assertionPaths']) {
    ir[name] = input[name] instanceof Map ? input[name] : new Map(Object.entries(input[name] || {}));
  }
  return ir;
}

const repeating = (max) => max === 'unbounded' || max > 1;
const multiply = (left, right) => (left === 'unbounded' || right === 'unbounded' ? 'unbounded' : left * right);

function fieldsIn(particle, max = 1) {
  if (!particle) return [];
  const total = multiply(max, particle.maxOccurs ?? 1);
  if (particle.kind === 'element') return [{ ...particle, maxOccurs: total, uiName: particle.jsonName }];
  return (particle.children || []).flatMap((child) => fieldsIn(child, total));
}

/** Shared naming and occurrence rules for the UI generator and runtime adapter. */
class UIModel {
  constructor(input) {
    this.ir = normalizeIR(input);
    this.values = new ValueJSONSchema(this.ir);
    this.shapes = new Map();
    this.entities = new Map();
  }

  entity(name, seen = new Set()) {
    if (this.entities.has(name)) return this.entities.get(name);
    const entity = this.ir.entities.get(name);
    if (!entity) throw new Error(`Unknown entity: ${name}`);
    if (seen.has(name)) throw new Error(`Cyclic entity inheritance: ${name}`);
    const parent = entity.parentType ? this.entity(entity.parentType, new Set([...seen, name])) : null;
    const columns = [...new Map([...(parent?.columns || []), ...entity.columns]
      .filter((column) => !column.isPrimaryKey && !column.columnName.startsWith('_')
        && !['internal', 'relation'].includes(column.xmlKind))
      .map((column) => [column.name, column])).values()];
    const relations = [...new Map([...(parent?.relations || []), ...entity.relations]
      .map((relation) => [relation.fieldName, relation])).values()];
    const shape = { ...entity, columns, relations };
    this.entities.set(name, shape);
    return shape;
  }

  columnUse(column) {
    const constraints = { ...column.constraints };
    if (constraints.pattern && !constraints.patterns) constraints.patterns = [constraints.pattern];
    const enumAnnotations = this.ir.enums.get(column.enumRef)?.enumAnnotations;
    return {
      ...column, constraints, unsupported: [], ...(enumAnnotations ? { enumAnnotations } : {}),
    };
  }

  shape(name) {
    if (this.shapes.has(name)) return this.shapes.get(name);
    const base = this.values.shape(name);
    const mixed = base.mixed || !!(base.baseTypeRef && this.shape(base.baseTypeRef).mixed);
    const fields = fieldsIn(base.content);
    const used = new Set(fields.map((field) => field.uiName));
    const attributes = base.attributes.map((attribute) => {
      let uiName = attribute.jsonName.replace(/^@_/, '');
      while (used.has(uiName)) uiName = `attribute_${uiName}`;
      used.add(uiName);
      return { ...attribute, uiName };
    });
    let textName = 'value';
    if (used.has(textName)) textName = 'textValue';
    while (used.has(textName)) textName = `_${textName}`;
    const shape = {
      ...base,
      mixed,
      fields,
      attributes,
      textName,
      scalarText: !!base.text && !mixed && !attributes.some((field) => field.maxOccurs !== 0),
    };
    this.shapes.set(name, shape);
    return shape;
  }
}

module.exports = { UIModel, normalizeIR, repeating };
