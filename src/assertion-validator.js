/**
 * Evaluates the enforceable subset of XSD 1.1 assertions extracted into the IR.
 *
 * This is not a general XPath engine. It supports the S3000L reference pattern
 * classified by IRBuilder as:
 *   exactly one of @uidRef, natural-key element, @uriRef must be present,
 *   or exactly one group of alternative fields must have a present member.
 */
const { effectiveAssertionRules, effectiveValueContent } = require('./value-type-inheritance');

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

  for (const occurrence of _assertionValues(ir, typeName, node)) {
    const result = validateNodeAssertions(ir, occurrence.typeName, occurrence.value);
    if (!result.errors.length && !result.skipped.length) continue;
    const path = _pathSegments(occurrence.path);
    errors.push(...result.errors.map((error) => ({ ...error, path })));
    skipped.push(...result.skipped.map((skip) => ({ ...skip, path })));
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

function _lookup(registry, name) {
  return registry instanceof Map ? registry.get(name) : registry?.[name];
}

// Follow actual occurrences through the retained type graph. Recursive type
// references are ordinary edges; only a cycle in the input objects is invalid.
function* _assertionValues(ir, typeName, value) {
  const stack = [{ typeName, value, path: null }];
  const active = new Set();
  const children = new Map();
  while (stack.length) {
    const current = stack.pop();
    const node = current.value;
    if (current.leave) {
      active.delete(node);
      continue;
    }
    if (node && typeof node === 'object') {
      if (active.has(node)) throw new TypeError(`Cyclic JSON value at ${JSON.stringify(_pathSegments(current.path))}`);
      active.add(node);
      stack.push({ value: node, leave: true });
    }
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index--) {
        stack.push({ ...current, value: node[index], path: { parent: current.path, step: index } });
      }
      continue;
    }

    yield current;
    if (current.directOnly || !node || typeof node !== 'object') continue;

    if (_lookup(ir?.valueTypes, current.typeName)) {
      if (!children.has(current.typeName)) {
        children.set(current.typeName, _complexChildren(ir.valueTypes, current.typeName));
      }
      const fields = children.get(current.typeName);
      for (let index = fields.length - 1; index >= 0; index--) {
        const field = fields[index];
        if (!Object.hasOwn(node, field.jsonName) || node[field.jsonName] === undefined) continue;
        stack.push({
          typeName: field.type.valueTypeRef,
          value: node[field.jsonName],
          path: { parent: current.path, step: field.jsonName },
        });
      }
    } else {
      // Older IRs without retained value definitions can only use their finite
      // path catalog. Do not traverse these targets again and duplicate checks.
      const paths = _lookup(ir?.assertionPaths, current.typeName)?.paths || [];
      const targets = paths.flatMap((item) => _valuesAtPath(node, item.path, current.path)
        .map((target) => ({ ...target, typeName: item.typeName, directOnly: true })));
      for (let index = targets.length - 1; index >= 0; index--) stack.push(targets[index]);
    }
  }
}

function _complexChildren(valueTypes, typeName) {
  const fields = new Map();
  const particles = [effectiveValueContent(valueTypes, typeName)];
  while (particles.length) {
    const particle = particles.pop();
    if (!particle) continue;
    if (particle.kind === 'element') {
      if (particle.type.valueTypeRef) {
        const jsonName = particle.jsonName || particle.xmlName || particle.name;
        fields.set(`${jsonName}\0${particle.type.valueTypeRef}`, { ...particle, jsonName });
      }
    } else {
      for (let index = particle.children.length - 1; index >= 0; index--) particles.push(particle.children[index]);
    }
  }
  return [...fields.values()];
}

// Linked paths avoid copying an ever-growing array at every recursion level.
function _pathSegments(path) {
  const steps = [];
  for (let current = path; current; current = current.parent) steps.push(current.step);
  return steps.reverse();
}

function _valuesAtPath(node, path, prefix) {
  let current = [{ value: node, path: prefix }];

  for (const step of path) {
    const next = [];
    for (const { value, path: parent } of current) {
      if (!value || typeof value !== 'object') continue;
      const name = Object.hasOwn(value, step.xmlName) ? step.xmlName : step.name;
      if (!Object.hasOwn(value, name)) continue;
      const child = value[name];
      if (child === undefined || child === null) continue;
      const childPath = { parent, step: name };
      if (Array.isArray(child)) {
        child.forEach((item, index) => next.push({ value: item, path: { parent: childPath, step: index } }));
      } else {
        next.push({ value: child, path: childPath });
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  return current.filter(({ value }) => value !== undefined && value !== null);
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
