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
  typedChildElements,
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

    const paths = [];
    for (const child of typedChildElements(ct)) {
      if (!child.name || !child.type) continue;

      const step = {
        kind: 'element',
        name: child.name,
        xmlName: child.name,
        minOccurs: child.minOccurs,
        maxOccurs: child.maxOccurs,
      };

      if (assertions.has(child.type)) {
        paths.push({
          path: [step],
          typeName: child.type,
          direct: true,
          ruleIds: assertions.get(child.type).rules.map((rule) => rule.id),
        });
      }
    }

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
