const MAX_ASSERTION_PATH_DEPTH = 2;

function extractAssertionSets(schema) {
  const assertions = new Map();

  for (const ct of (schema.complexType || [])) {
    const typeName = ct['@_name'];
    if (!typeName || !ct.assert) continue;

    const asserts = Array.isArray(ct.assert) ? ct.assert : [ct.assert];
    const rules = asserts
      .map((assertNode, index) => {
        const test = assertNode['@_test'];
        if (!test) return null;
        return {
          id: `${typeName}#assert${index + 1}`,
          test,
          ...classifyAssert(test),
        };
      })
      .filter(Boolean);

    if (rules.length > 0) {
      assertions.set(typeName, { typeName, rules });
    }
  }

  return assertions;
}

function extractAssertionPaths({
  entities,
  resolver,
  assertions,
}) {
  const assertionPaths = new Map();
  const typeNames = new Set();
  const pathCache = new Map();

  for (const entity of entities.values()) {
    for (const col of entity.columns) {
      if (col.sqlType === 'LONGTEXT' && col.xsdType) typeNames.add(col.xsdType);
    }
  }

  const assertionPathsForType = (typeName) => {
    if (pathCache.has(typeName)) return pathCache.get(typeName);

    const ct = resolver.getComplexType(typeName);
    if (!ct) return [];

    const paths = assertionChildPaths({
      resolver,
      assertions,
      node: ct,
      seenTypes: new Set([typeName]),
    });

    pathCache.set(typeName, paths);
    return paths;
  };

  for (const typeName of typeNames) {
    const paths = assertionPathsForType(typeName);
    if (paths.length > 0) {
      assertionPaths.set(typeName, { typeName, paths });
    }
  }

  return assertionPaths;
}

function assertionChildPaths({
  resolver,
  assertions,
  node,
  seenTypes,
  prefix = [],
  seenGroups = new Set(),
}) {
  const paths = [];

  for (const child of directTypedChildElements(node, resolver, seenGroups)) {
    if (!child.name) continue;

    const step = {
      kind: 'element',
      name: child.name,
      xmlName: child.name,
      minOccurs: child.minOccurs,
      maxOccurs: child.maxOccurs,
    };
    const childPath = [...prefix, step];

    if (child.type && assertions.has(child.type)) {
      paths.push({
        path: childPath,
        typeName: child.type,
        direct: childPath.length === 1,
        ruleIds: assertions.get(child.type).rules.map((rule) => rule.id),
      });
    }

    const childNode = child.type ? resolver.getComplexType(child.type) : child.node;
    if (!childNode || !child.type || seenTypes.has(child.type)) continue;
    if (childPath.length >= MAX_ASSERTION_PATH_DEPTH) continue;

    paths.push(...assertionChildPaths({
      resolver,
      assertions,
      node: childNode,
      seenTypes: new Set([...seenTypes, child.type]),
      prefix: childPath,
      seenGroups: new Set(),
    }));
  }

  return paths;
}

function directTypedChildElements(node, resolver, seenGroups = new Set()) {
  const out = [];
  if (!node || typeof node !== 'object') return out;

  for (const el of (node.element || [])) {
    const name = el['@_name'] || el['@_ref'];
    if (!name) continue;

    const anonComplexType = (el.complexType || [])[0] || null;
    out.push({
      name,
      type: el['@_type'],
      node: anonComplexType,
      minOccurs: parseOccurs(el['@_minOccurs'], 1),
      maxOccurs: parseOccurs(el['@_maxOccurs'], 1),
    });
  }

  for (const groupRef of (node.group || [])) {
    const ref = groupRef['@_ref'];
    if (!ref || seenGroups.has(ref)) continue;
    const group = resolver.getGroup(ref);
    if (!group) continue;

    seenGroups.add(ref);
    out.push(...directTypedChildElements(group, resolver, seenGroups));
    seenGroups.delete(ref);
  }

  for (const key of ['sequence', 'choice', 'all', 'complexContent', 'simpleContent', 'extension', 'restriction']) {
    for (const child of (node[key] || [])) {
      out.push(...directTypedChildElements(child, resolver, seenGroups));
    }
  }

  return out.filter((child) => child.name && (child.type || child.node));
}

function parseOccurs(val, defaultVal) {
  if (val === undefined || val === null) return defaultVal;
  if (val === 'unbounded') return 'unbounded';
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? defaultVal : n;
}

function classifyAssert(test) {
  const exactlyOne = parseExactlyOneAssert(test);
  if (exactlyOne) {
    return {
      kind: 'exactlyOne',
      enforceable: true,
      fields: exactlyOne,
      description: `Exactly one of ${exactlyOne.map(fieldLabel).join(', ')} must be present`,
    };
  }

  return {
    kind: 'rawXPath',
    enforceable: false,
    fields: [],
    description: 'Raw XSD 1.1 assertion; requires a full XPath/XSD 1.1 validator',
  };
}

function parseExactlyOneAssert(test) {
  if (!test || typeof test !== 'string') return null;

  const trimmed = test.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;

  const groups = trimmed
    .slice(1, -1)
    .split(/\)\s+or\s+\(/)
    .map((group) => group.trim())
    .filter(Boolean);

  if (groups.length < 2) return null;

  const parsedGroups = [];
  const fieldByKey = new Map();

  for (const group of groups) {
    const terms = group.split(/\s+and\s+/).map((term) => term.trim()).filter(Boolean);
    const positives = [];
    const negatives = [];

    for (const term of terms) {
      const neg = term.match(/^not\((@?[-A-Za-z0-9_:.]+)\)$/);
      if (neg) {
        const field = assertField(neg[1]);
        negatives.push(field);
        fieldByKey.set(fieldKey(field), field);
        continue;
      }

      const pos = term.match(/^@?[-A-Za-z0-9_:.]+$/);
      if (pos) {
        const field = assertField(term);
        positives.push(field);
        fieldByKey.set(fieldKey(field), field);
        continue;
      }

      return null;
    }

    if (positives.length !== 1) return null;
    parsedGroups.push({ positive: positives[0], negatives });
  }

  const fields = [...fieldByKey.values()];
  if (fields.length !== groups.length) return null;

  const allKeys = new Set(fields.map(fieldKey));
  const positiveKeys = new Set(parsedGroups.map((group) => fieldKey(group.positive)));
  if (positiveKeys.size !== fields.length) return null;

  for (const group of parsedGroups) {
    const expectedNegatives = new Set([...allKeys].filter((key) => key !== fieldKey(group.positive)));
    const actualNegatives = new Set(group.negatives.map(fieldKey));
    if (expectedNegatives.size !== actualNegatives.size) return null;
    for (const key of expectedNegatives) {
      if (!actualNegatives.has(key)) return null;
    }
  }

  return fields;
}

function assertField(raw) {
  const isAttribute = raw.startsWith('@');
  const name = isAttribute ? raw.slice(1) : raw;
  return {
    kind: isAttribute ? 'attribute' : 'element',
    name,
    xmlName: isAttribute ? `@_${name}` : name,
  };
}

function fieldKey(field) {
  return `${field.kind}:${field.name}`;
}

function fieldLabel(field) {
  return field.kind === 'attribute' ? `@${field.name}` : field.name;
}

module.exports = {
  classifyAssert,
  extractAssertionPaths,
  extractAssertionSets,
};
