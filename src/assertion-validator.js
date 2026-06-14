/**
 * Evaluates the enforceable subset of XSD 1.1 assertions extracted into the IR.
 *
 * This is not a general XPath engine. It supports the S3000L reference pattern
 * classified by IRBuilder as:
 *   exactly one of @uidRef, natural-key element, @uriRef must be present.
 */

class AssertionValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'AssertionValidationError';
    this.errors = errors;
  }
}

function validateNodeAssertions(ir, typeName, node, opts = {}) {
  const shouldThrow = opts.throw === true;
  const assertionSet = _assertionSet(ir, typeName);
  const rules = assertionSet?.rules || [];
  const errors = [];
  const skipped = [];

  for (const rule of rules) {
    if (rule.kind === 'exactlyOne') {
      const present = rule.fields.filter((field) => _hasField(node, field));
      if (present.length !== 1) {
        errors.push({
          typeName,
          ruleId: rule.id,
          kind: rule.kind,
          message: `${typeName}: ${rule.description}`,
          presentFields: present.map(_fieldLabel),
          expected: rule.fields.map(_fieldLabel),
          test: rule.test,
        });
      }
      continue;
    }

    skipped.push({
      typeName,
      ruleId: rule.id,
      kind: rule.kind,
      test: rule.test,
      reason: 'No local evaluator for this assertion kind',
    });
  }

  const result = { valid: errors.length === 0, errors, skipped };
  if (!result.valid && shouldThrow) {
    throw new AssertionValidationError(
      `XSD assertion validation failed (${errors.length} error(s))`,
      errors,
    );
  }
  return result;
}

function validateValueAssertions(ir, typeName, node, opts = {}) {
  const shouldThrow = opts.throw === true;
  const errors = [];
  const skipped = [];

  const direct = validateNodeAssertions(ir, typeName, node);
  errors.push(...direct.errors.map((error) => ({ ...error, path: [] })));
  skipped.push(...direct.skipped.map((skip) => ({ ...skip, path: [] })));

  const pathSet = _assertionPathSet(ir, typeName);
  for (const assertionPath of (pathSet?.paths || [])) {
    const values = _valuesAtPath(node, assertionPath.path);
    for (const value of values) {
      const result = validateNodeAssertions(ir, assertionPath.typeName, value);
      const path = assertionPath.path.map((step) => step.name);
      errors.push(...result.errors.map((error) => ({
        ...error,
        path,
      })));
      skipped.push(...result.skipped.map((skip) => ({
        ...skip,
        path,
      })));
    }
  }

  const result = { valid: errors.length === 0, errors, skipped };
  if (!result.valid && shouldThrow) {
    throw new AssertionValidationError(
      `XSD assertion validation failed (${errors.length} error(s))`,
      errors,
    );
  }
  return result;
}

function _assertionSet(ir, typeName) {
  if (!ir || !ir.assertions) return null;
  if (ir.assertions instanceof Map) return ir.assertions.get(typeName) || null;
  return ir.assertions[typeName] || null;
}

function _assertionPathSet(ir, typeName) {
  if (!ir || !ir.assertionPaths) return null;
  if (ir.assertionPaths instanceof Map) return ir.assertionPaths.get(typeName) || null;
  return ir.assertionPaths[typeName] || null;
}

function _valuesAtPath(node, path) {
  let current = [node];

  for (const step of path) {
    const next = [];
    for (const value of current) {
      if (!value || typeof value !== 'object') continue;
      const child = value[step.xmlName] ?? value[step.name];
      if (child === undefined || child === null) continue;
      if (Array.isArray(child)) {
        next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  return current.filter((value) => value !== undefined && value !== null);
}

function _hasField(node, field) {
  if (!node || typeof node !== 'object') return false;
  const value = field.kind === 'attribute'
    ? node[field.xmlName] ?? node[`@_${field.name}`] ?? node[field.name]
    : node[field.xmlName] ?? node[field.name];

  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

function _fieldLabel(field) {
  return field.kind === 'attribute' ? `@${field.name}` : field.name;
}

module.exports = {
  AssertionValidationError,
  validateNodeAssertions,
  validateValueAssertions,
};
