const { XSD_PRIMITIVES } = require('./type-resolver');
const { extractAssertionSets } = require('./xsd-assertion-metadata');
const { primitiveWhitespace } = require('./xml-value-normalizer');

const nodes = (value) => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};
const first = (value) => nodes(value)[0];
const occurs = (value, fallback = 1) => (value === 'unbounded' ? value : Number(value ?? fallback));
const localName = (name) => name?.split(':').pop();

function documentation(node) {
  const doc = first(first(node.annotation)?.documentation);
  return typeof doc === 'string' ? doc : doc?.['#text'] || null;
}

function facets(node) {
  const result = {};
  for (const key of ['length', 'minLength', 'maxLength', 'minInclusive', 'maxInclusive',
    'minExclusive', 'maxExclusive', 'totalDigits', 'fractionDigits', 'whiteSpace']) {
    const value = first(node[key])?.['@_value'];
    if (value !== undefined) result[key] = value;
  }
  const patterns = nodes(node.pattern).map((item) => item['@_value']);
  if (patterns.length) result.patterns = patterns;
  const values = nodes(node.enumeration).map((item) => item['@_value']);
  if (values.length) result.enum = values;
  return result;
}

/** Build the XML-shaped values inside JSON columns independently of database entities. */
class ValueTypeBuilder {
  constructor(schema, resolver, assertions) {
    this.resolver = resolver;
    this.assertions = assertions;
    this.types = new Map();
    this.anonymousNames = new WeakMap();
    this.elements = new Map(nodes(schema.element).map((node) => [node['@_name'], node]));
    this.attributes = new Map(nodes(schema.attribute).map((node) => [node['@_name'], node]));
    this._indexAnonymous(schema, []);
  }

  _indexAnonymous(node, path) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue;
      nodes(value).forEach((child, index) => {
        const childPath = [...path, key, child['@_name'] || String(index)];
        if (key === 'complexType' && !child['@_name']) {
          this.anonymousNames.set(child, `@anonymous/${childPath.join('/')}`);
        }
        this._indexAnonymous(child, childPath);
      });
    }
  }

  reference(name, node = this.resolver.getComplexType(name)) {
    if (!node) return null;
    const id = node['@_name'] || this.anonymousNames.get(node) || name;
    if (this.types.has(id)) return id;
    if (node.assert && !this.assertions.has(id)) {
      const sets = extractAssertionSets({ complexType: [{ ...node, '@_name': id }] });
      if (sets.has(id)) this.assertions.set(id, sets.get(id));
    }
    const type = {
      name: id,
      documentation: documentation(node),
      content: null,
      attributes: [],
      text: null,
      baseTypeRef: null,
      derivation: null,
      mixed: node['@_mixed'] === 'true',
      assertionRefs: (this.assertions.get(id)?.rules || []).map((rule) => rule.id),
      unsupported: [],
    };
    // Register before following child/base references: recursive types stay references.
    this.types.set(id, type);
    const complex = first(node.complexContent);
    const simple = first(node.simpleContent);
    const container = complex || simple;
    const body = first(container?.extension) || first(container?.restriction) || node;
    if (container) {
      type.derivation = container.extension ? 'extension' : 'restriction';
      const base = localName(body['@_base']);
      type.baseTypeRef = this.reference(base);
      if (simple && !type.baseTypeRef) type.text = this.typeUse(base);
      if (simple && type.derivation === 'restriction') {
        const text = type.text || this._textType(type.baseTypeRef);
        if (text) type.text = { ...text, constraints: { ...text.constraints, ...facets(body) } };
      }
      type.mixed ||= complex?.['@_mixed'] === 'true';
    }
    type.content = this._content(body, type, new Set());
    type.attributes = this._attributes(body, type, new Set());
    if (type.mixed) type.unsupported.push('Mixed XML text order is not represented by object properties.');
    if (body.anyAttribute) type.unsupported.push('xs:anyAttribute requires XSD validation.');
    return id;
  }

  _textType(name, seen = new Set()) {
    if (!name || seen.has(name)) return null;
    const type = this.types.get(name);
    return type?.text || this._textType(type?.baseTypeRef, new Set([...seen, name]));
  }

  typeUse(name, inline = null, seen = new Set()) {
    const xsdType = localName(name) || null;
    const use = {
      xsdType, valueTypeRef: null, jsonType: null, constraints: {}, unsupported: [],
    };
    if (inline?.complexType) {
      use.valueTypeRef = this.reference(null, first(inline.complexType));
      return use;
    }
    const complex = this.resolver.getComplexType(xsdType);
    if (complex) {
      use.valueTypeRef = this.reference(xsdType, complex);
      return use;
    }
    const primitive = XSD_PRIMITIVES[xsdType];
    if (primitive && !inline?.simpleType) {
      use.jsonType = typeof primitive.jsonType === 'string' ? primitive.jsonType : null;
      use.constraints.whiteSpace = primitiveWhitespace(xsdType);
      for (const key of ['format', 'minimum', 'maximum', 'contentEncoding']) {
        if (primitive[key] !== undefined) use.constraints[key] = primitive[key];
      }
      return use;
    }
    const simple = first(inline?.simpleType) || this.resolver.getSimpleType(xsdType);
    if (!simple || (xsdType && seen.has(xsdType))) {
      use.unsupported.push(`Unresolved value type: ${xsdType || 'anonymous'}`);
      return use;
    }
    const visiting = new Set(seen);
    if (xsdType) visiting.add(xsdType);
    const restriction = first(simple.restriction);
    if (restriction) {
      const base = this.typeUse(restriction['@_base'], restriction, visiting);
      return {
        ...base,
        xsdType,
        constraints: { ...base.constraints, ...facets(restriction) },
      };
    }
    const union = first(simple.union);
    if (union) {
      use.alternatives = (union['@_memberTypes'] || '').split(/\s+/).filter(Boolean)
        .map((member) => this.typeUse(member, null, visiting));
      use.alternatives.push(...nodes(union.simpleType).map((item) => (
        this.typeUse(null, { simpleType: [item] }, visiting)
      )));
      return use;
    }
    const list = first(simple.list);
    if (list) {
      use.jsonType = 'string';
      use.constraints.whiteSpace = 'collapse';
      use.itemType = this.typeUse(list['@_itemType'], list, visiting);
      use.unsupported.push('XML whitespace-separated list item validation requires XSD validation.');
      return use;
    }
    use.unsupported.push(`Unsupported simple type: ${xsdType || 'anonymous'}`);
    return use;
  }

  _field(node, kind) {
    const ref = localName(node['@_ref']);
    const declaration = ref && (kind === 'element' ? this.elements : this.attributes).get(ref);
    const field = { ...declaration, ...node };
    const name = field['@_name'] || ref;
    const attribute = kind === 'attribute';
    let fallback = attribute ? 'string' : 'anyType';
    if (field.complexType || field.simpleType) fallback = null;
    const use = this.typeUse(field['@_type'] || fallback, field);
    return {
      kind,
      name,
      xmlName: name,
      jsonName: attribute ? `@_${name}` : name,
      type: use,
      minOccurs: attribute ? Number(field['@_use'] === 'required') : occurs(field['@_minOccurs']),
      maxOccurs: attribute ? Number(field['@_use'] !== 'prohibited') : occurs(field['@_maxOccurs']),
      nillable: !attribute && field['@_nillable'] === 'true',
      defaultValue: field['@_default'] ?? null,
      fixedValue: field['@_fixed'] ?? null,
      documentation: documentation(field),
    };
  }

  _content(node, owner, groups) {
    const children = [];
    for (const [kind, values] of Object.entries(node)) {
      if (!['element', 'sequence', 'choice', 'all', 'group', 'any'].includes(kind)) continue;
      for (const item of nodes(values)) {
        if (kind === 'element') children.push(this._field(item, kind));
        else if (kind === 'any') owner.unsupported.push('xs:any requires XSD validation.');
        else {
          const ref = localName(item['@_ref']);
          const group = ref ? this.resolver.getGroup(ref) : item;
          const child = {
            kind, minOccurs: occurs(item['@_minOccurs']), maxOccurs: occurs(item['@_maxOccurs']), children: [],
          };
          if (ref) child.ref = ref;
          if (!group || (ref && groups.has(ref))) {
            owner.unsupported.push(`Unresolved or recursive group: ${ref}`);
          } else {
            const visiting = new Set(groups);
            if (ref) visiting.add(ref);
            child.children = this._content(group, owner, visiting)?.children || [];
          }
          children.push(child);
        }
      }
    }
    return children.length ? {
      kind: 'sequence', minOccurs: 1, maxOccurs: 1, children,
    } : null;
  }

  _attributes(node, owner, groups) {
    const fields = nodes(node.attribute).map((attr) => this._field(attr, 'attribute'));
    for (const group of nodes(node.attributeGroup)) {
      const ref = localName(group['@_ref']);
      const definition = this.resolver.getAttributeGroup(ref);
      if (!definition || groups.has(ref)) {
        owner.unsupported.push(`Unresolved or recursive attribute group: ${ref}`);
        continue;
      }
      fields.push(...this._attributes(definition, owner, new Set([...groups, ref])));
    }
    return fields;
  }
}

module.exports = { ValueTypeBuilder };
