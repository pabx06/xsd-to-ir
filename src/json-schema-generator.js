'use strict';

/**
 * json-schema-generator.js
 *
 * Consumes the Intermediate Representation produced by ir-builder.js and
 * emits a JSON Schema (draft-07) document that can validate XML-derived
 * JSON messages matching the original XSD structure.
 *
 * Each entity becomes a $defs entry; a root $schema object is emitted
 * that $refs all top-level entities.
 */

/**
 * @param {object} ir       The IR object returned by IRBuilder.build()
 * @param {object} options
 * @param {string} [options.rootEntity]    Name of the root entity to use as
 *                                          the document root (optional).
 * @param {string} [options.schemaId]      Value for the "$id" field.
 * @returns {object}  A JSON Schema draft-07 object (not yet serialised).
 */
function generateJSONSchema(ir, options = {}) {
  const {
    rootEntity = null,
    schemaId   = 'https://example.com/schema.json',
  } = options;

  const defs = {};

  // ── enum definitions ────────────────────────────────────────────────────────
  for (const [name, enumDef] of ir.enums) {
    defs[name] = {
      title      : name,
      description: enumDef.docs || undefined,
      type       : 'string',
      enum       : enumDef.values,
    };
  }

  // ── simpleType definitions ──────────────────────────────────────────────────
  for (const [name, st] of ir.simpleTypes) {
    defs[name] = _simpleTypeDef(name, st);
  }

  // ── entity definitions ──────────────────────────────────────────────────────
  for (const [name, entity] of ir.entities) {
    defs[name] = _entityDef(entity, ir);
  }

  // ── root schema ─────────────────────────────────────────────────────────────
  const schema = {
    $schema    : 'http://json-schema.org/draft-07/schema#',
    $id        : schemaId,
    title      : 'XSD-derived schema',
    description: 'Auto-generated from XSD via xsd-to-ir',
    $defs      : defs,
  };

  if (rootEntity && ir.entities.has(rootEntity)) {
    schema.$ref = `#/$defs/${rootEntity}`;
  } else {
    // Default: union of all top-level entities
    schema.oneOf = [...ir.entities.keys()].map(name => ({ $ref: `#/$defs/${name}` }));
  }

  return schema;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _simpleTypeDef(name, st) {
  const def = {
    title      : name,
    description: st.docs || undefined,
    type       : st.jsonType,
  };
  _applyConstraints(def, st.constraints);
  return def;
}

function _entityDef(entity, ir) {
  const properties  = {};
  const required    = [];

  // Columns → JSON Schema properties
  for (const col of entity.columns) {
    if (col.isPrimaryKey) continue; // internal DB id; skip in JSON schema
    if (col.columnName.startsWith('_')) continue; // S3000L tech columns; skip in JSON schema

    const prop = _columnToProp(col, ir);
    properties[col.name] = prop;

    if (!col.nullable) {
      required.push(col.name);
    }
  }

  // Relations → JSON Schema properties
  for (const rel of entity.relations) {
    const prop = _relationToProp(rel, ir);
    properties[rel.fieldName] = prop;

    if (!rel.nullable && rel.minOccurs > 0) {
      required.push(rel.fieldName);
    }
  }

  const def = {
    title      : entity.name,
    description: entity.documentation || undefined,
    type       : 'object',
    properties,
  };

  if (required.length > 0) def.required = required;

  // Inheritance: allOf parent ref
  if (entity.parentType && ir.entities.has(entity.parentType)) {
    return {
      allOf: [
        { $ref: `#/$defs/${entity.parentType}` },
        def,
      ],
    };
  }

  return def;
}

function _columnToProp(col, ir) {
  if (col.isEnum && col.enumRef) {
    return {
      description: col.documentation || undefined,
      $ref       : `#/$defs/${col.enumRef}`,
    };
  }

  const prop = {
    description: col.documentation || undefined,
    type       : col.nullable ? [col.jsonType, 'null'] : col.jsonType,
  };

  // Constraints
  const c = col.constraints || {};
  if (c.format)      prop.format      = c.format;
  if (c.minimum   != null) prop.minimum   = Number(c.minimum);
  if (c.maximum   != null) prop.maximum   = Number(c.maximum);
  if (c.minLength != null) prop.minLength = Number(c.minLength);
  if (c.maxLength != null) prop.maxLength = Number(c.maxLength);
  if (c.pattern)     prop.pattern     = c.pattern;
  if (c.enum)        prop.enum        = c.enum;
  if (c.contentEncoding) prop.contentEncoding = c.contentEncoding;

  return _clean(prop);
}

function _relationToProp(rel, ir) {
  const refSchema = ir.entities.has(rel.targetEntity)
    ? { $ref: `#/$defs/${rel.targetEntity}` }
    : { type: 'object' };

  if (rel.kind === 'one-to-many') {
    const prop = {
      type    : 'array',
      items   : refSchema,
    };
    if (rel.minOccurs > 0)            prop.minItems = rel.minOccurs;
    if (rel.maxOccurs !== 'unbounded') prop.maxItems = rel.maxOccurs;
    return prop;
  }

  // one-to-one / idrefs
  return rel.nullable ? { oneOf: [refSchema, { type: 'null' }] } : refSchema;
}

function _applyConstraints(def, constraints = {}) {
  if (!constraints) return;
  if (constraints.minLength  != null) def.minLength  = Number(constraints.minLength);
  if (constraints.maxLength  != null) def.maxLength  = Number(constraints.maxLength);
  if (constraints.pattern)   def.pattern   = constraints.pattern;
  if (constraints.minInclusive != null) def.minimum  = Number(constraints.minInclusive);
  if (constraints.maxInclusive != null) def.maximum  = Number(constraints.maxInclusive);
  if (constraints.minExclusive != null) def.exclusiveMinimum = Number(constraints.minExclusive);
  if (constraints.maxExclusive != null) def.exclusiveMaximum = Number(constraints.maxExclusive);
}

/** Remove keys whose value is undefined */
function _clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

module.exports = { generateJSONSchema };