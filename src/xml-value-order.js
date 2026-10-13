function elementFields(particle) {
  if (!particle) return [];
  if (particle.kind === 'element') return [particle];
  return (particle.children || []).flatMap(elementFields);
}

function fieldNames(particle) {
  return new Set(elementFields(particle).map((field) => field.xmlName));
}

function choiceBranch(particle, present) {
  const active = [...fieldNames(particle)].filter((name) => present.has(name));
  return particle.children.find((child) => {
    const names = fieldNames(child);
    return active.every((name) => names.has(name)) && hasRequiredFields(child, present);
  });
}

// Branch selection only examines names/requiredness, not scalar facets. Export
// remains distinct from XSD validation, including for invalid input objects.
function hasRequiredFields(particle, present) {
  const active = [...fieldNames(particle)].some((name) => present.has(name));
  if (particle.maxOccurs === 0) return !active;
  if (!active && particle.minOccurs === 0) return true;
  if (particle.kind === 'element') return active;
  if (particle.kind === 'choice') return Boolean(choiceBranch(particle, present));
  return (particle.children || []).every((child) => hasRequiredFields(child, present));
}

function orderedFields(particle, present) {
  if (!particle || particle.maxOccurs === 0) return [];
  if (particle.kind === 'element') return [particle];

  // Object properties cannot encode interleaving between different names in
  // repeated compositors. An absent group or one present name is unambiguous.
  const repeated = particle.maxOccurs === 'unbounded' || particle.maxOccurs > 1;
  const active = [...fieldNames(particle)].filter((name) => present.has(name));
  if (repeated && active.length > 1) return null;

  if (particle.kind === 'choice') {
    const branch = choiceBranch(particle, present);
    if (branch) return orderedFields(branch, present);
    return [...fieldNames(particle)].some((name) => present.has(name)) ? null : [];
  }

  const children = (particle.children || []).map((child) => orderedFields(child, present));
  if (children.some((fields) => fields === null)) return null;
  const fields = children.flat();
  const activeNames = fields.filter((field) => present.has(field.xmlName)).map((field) => field.xmlName);
  // A name used at separate sequence positions is also ambiguous in an object.
  return new Set(activeNames).size === activeNames.length ? fields : null;
}

/** Order typed JSON children for XML without normalizing or mutating values. */
class XMLValueOrder {
  constructor(ir) {
    this.types = ir.valueTypes || new Map();
    this.shapes = new Map();
  }

  shape(name, seen = new Set()) {
    if (this.shapes.has(name)) return this.shapes.get(name);
    const type = this.types.get(name);
    if (!type) return null;
    if (seen.has(name)) throw new Error(`Cyclic value type inheritance: ${name}`);
    const base = type.baseTypeRef ? this.shape(type.baseTypeRef, new Set([...seen, name])) : null;
    const content = type.derivation === 'extension' && base?.content
      ? { kind: 'sequence', children: [base.content, type.content].filter(Boolean) }
      : type.content;
    const shape = {
      content,
      elements: new Map(elementFields(content).map((field) => [field.xmlName, field.type])),
      mixed: type.mixed || base?.mixed,
    };
    this.shapes.set(name, shape);
    return shape;
  }

  complex(value, name) {
    if (Array.isArray(value)) return value.map((item) => this.complex(item, name));
    if (value === null || typeof value !== 'object') return value;
    const shape = this.shape(name);
    if (!shape) return value; // Older IRs need not have value-type metadata.

    const entries = Object.entries(value);
    const childName = (key) => {
      if (key.startsWith('@_') || key === '#text') return null;
      return shape.elements.has(key) ? key : key.split(':').pop();
    };
    const present = new Set(entries
      .filter(([, child]) => !Array.isArray(child) || child.length > 0)
      .map(([key]) => childName(key)));
    const fields = shape.mixed ? null : orderedFields(shape.content, present);
    const elements = new Map(shape.elements);
    const ranks = new Map();
    (fields || []).forEach((field) => {
      elements.set(field.xmlName, field.type);
      if (!ranks.has(field.xmlName)) ranks.set(field.xmlName, ranks.size);
    });
    const children = entries.map(([key, child]) => {
      const use = elements.get(childName(key));
      return [key, use?.valueTypeRef ? this.complex(child, use.valueTypeRef) : child];
    });

    // Only move known child entries. Attributes, #text and unknown extensions
    // retain their slots; repeated element arrays retain their item order.
    const sorted = children.filter(([key]) => ranks.has(childName(key)))
      .sort(([left], [right]) => ranks.get(childName(left)) - ranks.get(childName(right)));
    let index = 0;
    return Object.fromEntries(children.map((entry) => (
      ranks.has(childName(entry[0])) ? sorted[index++] : entry
    )));
  }
}

module.exports = { XMLValueOrder };
