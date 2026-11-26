const { XMLParser } = require('fast-xml-parser');

// Retain the existing safe-number/exact-string policy, but only for XSD numeric
// elements. Never run a string, enum, attribute, or unknown type through it.
const numericParser = new XMLParser();
const numericText = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const integerText = /^[+-]?[0-9]+$/;
const xmlWhitespace = /^[\t\r\n ]*$/;

function normalizeWhitespace(value, rule) {
  if (typeof value !== 'string' || rule === 'preserve' || !rule) return value;
  const replaced = value.replace(/[\t\r\n]/g, ' ');
  return rule === 'collapse' ? replaced.replace(/ +/g, ' ').replace(/^ | $/g, '') : replaced;
}

function primitiveWhitespace(name) {
  if (['string', 'anySimpleType', 'anyType'].includes(name)) return 'preserve';
  return name === 'normalizedString' ? 'replace' : 'collapse';
}

function scalar(value, use, attribute = false) {
  if (value === null || value === undefined) return value;
  const text = normalizeWhitespace(String(value), use.constraints?.whiteSpace);
  // Choosing a union member requires validation of all its facets. Preserve its
  // lexical value rather than guessing from the spelling or JSON primitive type.
  if (attribute || use.alternatives || use.itemType) return text;
  if (use.jsonType === 'string') return text;
  if (use.jsonType === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === '1' || text === '0') return Number(text);
    return text;
  }
  const numericPattern = use.jsonType === 'integer' ? integerText : numericText;
  if (['number', 'integer'].includes(use.jsonType) && numericPattern.test(text)) {
    const parsed = numericParser.parse(`<value>${text}</value>`).value;
    return typeof parsed === 'number' ? parsed : text;
  }
  return value;
}

function elementFields(particle) {
  if (!particle) return [];
  if (particle.kind === 'element') return [particle];
  return (particle.children || []).flatMap(elementFields);
}

/** Normalize typed inline values without changing XML names or occurrence shapes. */
class XMLValueNormalizer {
  constructor(ir) {
    this.types = ir.valueTypes || new Map();
    this.shapes = new Map();
  }

  shape(name, seen = new Set()) {
    if (this.shapes.has(name)) return this.shapes.get(name);
    const type = this.types.get(name);
    if (!type) return null; // Older IRs may not contain value type metadata.
    if (seen.has(name)) throw new Error(`Cyclic value type inheritance: ${name}`);
    const base = type.baseTypeRef ? this.shape(type.baseTypeRef, new Set([...seen, name])) : null;
    const inherited = type.derivation === 'extension' ? base?.elements : [];
    const elements = new Map(inherited || []);
    elementFields(type.content).forEach((field) => elements.set(field.xmlName, field.type));
    const attributes = new Map(base?.attributes || []);
    (type.attributes || []).forEach((field) => attributes.set(field.jsonName, field.type));
    const shape = {
      elements,
      attributes,
      text: type.text || base?.text,
      mixed: type.mixed || base?.mixed,
    };
    this.shapes.set(name, shape);
    return shape;
  }

  value(value, use, attribute = false) {
    if (Array.isArray(value)) return value.map((item) => this.value(item, use, attribute));
    if (use.valueTypeRef) return this.complex(value, use.valueTypeRef);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key, key === '#text' ? scalar(child, use, attribute) : child,
      ]));
    }
    return scalar(value, use, attribute);
  }

  complex(value, name) {
    if (Array.isArray(value)) return value.map((item) => this.complex(item, name));
    const shape = this.shape(name);
    if (!shape || value === null || value === undefined) return value;
    if (typeof value !== 'object') return shape.text ? scalar(value, shape.text) : value;

    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '#text') {
        if (shape.text) result[key] = scalar(child, shape.text);
        else if (shape.mixed || !xmlWhitespace.test(String(child))) result[key] = child;
      } else if (key.startsWith('@_')) {
        const use = shape.attributes.get(key);
        result[key] = use ? this.value(child, use, true) : child;
      } else {
        const use = shape.elements.get(key) || shape.elements.get(key.split(':').pop());
        result[key] = use ? this.value(child, use) : child;
      }
    }
    return result;
  }
}

module.exports = { XMLValueNormalizer, normalizeWhitespace, primitiveWhitespace };
