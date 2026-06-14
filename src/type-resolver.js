const XSD_PRIMITIVES = {
  // strings
  string: { sqlType: 'TEXT', jsonType: 'string' },
  normalizedString: { sqlType: 'VARCHAR', jsonType: 'string' },
  token: { sqlType: 'VARCHAR', jsonType: 'string' },
  Name: { sqlType: 'VARCHAR', jsonType: 'string' },
  NCName: { sqlType: 'VARCHAR', jsonType: 'string' },
  NMTOKEN: { sqlType: 'VARCHAR', jsonType: 'string' },
  NMTOKENS: { sqlType: 'TEXT', jsonType: 'string' },
  anyURI: { sqlType: 'TEXT', jsonType: 'string', format: 'uri' },
  language: { sqlType: 'VARCHAR', jsonType: 'string' },
  // identifiers
  ID: { sqlType: 'VARCHAR', jsonType: 'string', isId: true },
  IDREF: { sqlType: 'VARCHAR', jsonType: 'string', isIdRef: true },
  IDREFS: { sqlType: 'TEXT', jsonType: 'string', isIdRefs: true },
  // numbers
  integer: { sqlType: 'INTEGER', jsonType: 'integer' },
  int: { sqlType: 'INTEGER', jsonType: 'integer' },
  long: { sqlType: 'BIGINT', jsonType: 'integer' },
  short: { sqlType: 'SMALLINT', jsonType: 'integer' },
  byte: { sqlType: 'SMALLINT', jsonType: 'integer' },
  positiveInteger: { sqlType: 'INTEGER', jsonType: 'integer', minimum: 1 },
  nonNegativeInteger: { sqlType: 'INTEGER', jsonType: 'integer', minimum: 0 },
  negativeInteger: { sqlType: 'INTEGER', jsonType: 'integer', maximum: -1 },
  nonPositiveInteger: { sqlType: 'INTEGER', jsonType: 'integer', maximum: 0 },
  unsignedLong: { sqlType: 'BIGINT', jsonType: 'integer', minimum: 0 },
  unsignedInt: { sqlType: 'INTEGER', jsonType: 'integer', minimum: 0 },
  unsignedShort: { sqlType: 'SMALLINT', jsonType: 'integer', minimum: 0 },
  unsignedByte: { sqlType: 'SMALLINT', jsonType: 'integer', minimum: 0 },
  decimal: { sqlType: 'DECIMAL', jsonType: 'number' },
  float: { sqlType: 'FLOAT', jsonType: 'number' },
  double: { sqlType: 'DOUBLE', jsonType: 'number' },
  // date/time
  date: { sqlType: 'DATE', jsonType: 'string', format: 'date' },
  time: { sqlType: 'TIME', jsonType: 'string', format: 'time' },
  dateTime: { sqlType: 'DATETIME(3)', jsonType: 'string', format: 'date-time' },
  duration: { sqlType: 'VARCHAR', jsonType: 'string', format: 'duration' },
  gYear: { sqlType: 'CHAR(4)', jsonType: 'string' },
  gMonth: { sqlType: 'CHAR(7)', jsonType: 'string' },
  gDay: { sqlType: 'CHAR(10)', jsonType: 'string' },
  gYearMonth: { sqlType: 'CHAR(7)', jsonType: 'string' },
  gMonthDay: { sqlType: 'CHAR(10)', jsonType: 'string' },
  // boolean
  boolean: { sqlType: 'BOOLEAN', jsonType: 'boolean' },
  // binary
  base64Binary: { sqlType: 'LONGBLOB', jsonType: 'string', contentEncoding: 'base64' },
  hexBinary: { sqlType: 'LONGBLOB', jsonType: 'string' },
  // catch-all / abstract
  anyType: { sqlType: 'TEXT', jsonType: {} },
  anySimpleType: { sqlType: 'TEXT', jsonType: 'string' },
};

// ─── TypeResolver class ───────────────────────────────────────────────────────

class TypeResolver {
  /**
   * @param {object} schema  The namespace-stripped, parsed schema root.
   */
  constructor(schema) {
    this.complexTypes = new Map(); // name → node
    this.simpleTypes = new Map(); // name → node
    this.groups = new Map(); // name → node
    this.attributeGroups = new Map(); // name → node
    this._index(schema);
  }

  // ── indexing ──────────────────────────────────────────────────────────────

  _index(schema) {
    for (const ct of (schema.complexType || [])) {
      if (ct['@_name']) this.complexTypes.set(ct['@_name'], ct);
    }
    for (const st of (schema.simpleType || [])) {
      if (st['@_name']) this.simpleTypes.set(st['@_name'], st);
    }
    for (const g of (schema.group || [])) {
      if (g['@_name']) this.groups.set(g['@_name'], g);
    }
    for (const ag of (schema.attributeGroup || [])) {
      if (ag['@_name']) this.attributeGroups.set(ag['@_name'], ag);
    }
  }

  // ── public helpers ────────────────────────────────────────────────────────

  isPrimitive(typeName) {
    return Object.prototype.hasOwnProperty.call(XSD_PRIMITIVES, typeName);
  }

  /**
   * Resolve a type name to its primitive mapping (if it is one).
   * Returns null for complex / unknown types.
   */
  primitiveInfo(typeName) {
    return XSD_PRIMITIVES[typeName] ?? null;
  }

  getComplexType(name) { return this.complexTypes.get(name) ?? null; }

  getSimpleType(name) { return this.simpleTypes.get(name) ?? null; }

  getGroup(name) { return this.groups.get(name) ?? null; }

  getAttributeGroup(name) { return this.attributeGroups.get(name) ?? null; }

  /**
   * Resolve any type name:
   *   - primitive  → { kind: 'primitive', ...primitiveInfo }
   *   - complexType → { kind: 'complex',  node }
   *   - simpleType  → { kind: 'simple',   node }
   *   - unknown    → { kind: 'unknown' }
   */
  resolve(typeName) {
    if (!typeName) return { kind: 'unknown' };
    if (this.isPrimitive(typeName)) return { kind: 'primitive', ...this.primitiveInfo(typeName) };
    const ct = this.complexTypes.get(typeName);
    if (ct) return { kind: 'complex', node: ct };
    const st = this.simpleTypes.get(typeName);
    if (st) return { kind: 'simple', node: st };
    return { kind: 'unknown' };
  }
}

module.exports = { TypeResolver, XSD_PRIMITIVES };
