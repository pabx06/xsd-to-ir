/**
 * Evaluates the enforceable subset of XSD 1.1 assertions extracted into the IR.
 *
 * This is not a general XPath engine. It supports the S3000L reference pattern
 * classified by IRBuilder as:
 *   exactly one of @uidRef, natural-key element, @uriRef must be present,
 *   or exactly one group of alternative fields must have a present member.
 */
const { effectiveAssertionRules } = require('./value-type-inheritance');

class AssertionValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'AssertionValidationError';
    this.errors = errors;
  }
}

function validateNodeAssertions(ir, typeName, node, opts = {}) {
  const shouldThrow = opts.throw === true;
  const rules = effectiveAssertionRules(ir, typeName);
  const errors = [];
  const skipped = [];

  for (const rule of rules) {
    if (rule.kind === 'exactlyOneGroup') {
      const presentGroups = rule.groups.filter((group) => group.some((field) => _hasNode(node, field)));
      if (presentGroups.length !== 1) {
        errors.push({
          typeName,
          ruleId: rule.id,
          kind: rule.kind,
          message: `${typeName}: ${rule.description}`,
          presentFields: rule.fields.filter((field) => _hasNode(node, field)).map(_fieldLabel),
          expected: rule.fields.map(_fieldLabel),
          expectedGroups: rule.groups.map((group) => group.map(_fieldLabel)),
          test: rule.test,
        });
      }
      continue;
    }
    if (rule.kind === 'exactlyOne') {
      const present = rule.fields.filter((field) => _hasNode(node, field));
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

  const occurrences = Array.isArray(node) ? node : [node];
  for (const [index, occurrence] of occurrences.entries()) {
    const prefix = Array.isArray(node) ? [index] : [];
    const direct = validateNodeAssertions(ir, typeName, occurrence);
    errors.push(...direct.errors.map((error) => ({ ...error, path: prefix })));
    skipped.push(...direct.skipped.map((skip) => ({ ...skip, path: prefix })));

    const pathSet = _assertionPathSet(ir, typeName);
    for (const assertionPath of (pathSet?.paths || [])) {
      const values = _valuesAtPath(occurrence, assertionPath.path);
      for (const value of values) {
        const result = validateNodeAssertions(ir, assertionPath.typeName, value);
        const path = [...prefix, ...assertionPath.path.map((step) => step.name)];
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

function _hasNode(node, field) {
  if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, field.xmlName)) return false;
  const value = node[field.xmlName];
  // Empty element text still represents a node. Empty arrays emit no nodes;
  // null element values emit empty nodes, while null attributes are omitted.
  if (value === undefined || (field.kind === 'attribute' && value === null)) return false;
  return !Array.isArray(value) || value.length > 0;
}

function _fieldLabel(field) {
  return field.kind === 'attribute' ? `@${field.name}` : field.name;
}

module.exports = {
  AssertionValidationError,
  validateNodeAssertions,
  validateValueAssertions,
};
