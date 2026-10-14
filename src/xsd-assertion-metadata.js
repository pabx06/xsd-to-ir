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
  valueTypes,
  assertions,
}) {
  const assertionPaths = new Map();
  const typeNames = new Set();

  for (const entity of entities.values()) {
    for (const col of entity.columns) {
      const typeName = col.valueTypeRef || col.xsdType;
      if (col.sqlType === 'LONGTEXT' && typeName) typeNames.add(typeName);
    }
  }

  for (const typeName of typeNames) {
    const paths = assertionChildPaths({
      valueTypes,
      assertions,
      typeName,
      seenTypes: new Set([typeName]),
    });
    if (paths.length > 0) {
      assertionPaths.set(typeName, { typeName, paths });
    }
  }

  return assertionPaths;
}

function assertionChildPaths({
  valueTypes,
  assertions,
  typeName,
  seenTypes,
  prefix = [],
}) {
  const paths = [];

  for (const child of childElements(valueTypes.get(typeName)?.content)) {
    const childType = child.type.valueTypeRef;
    if (!childType) continue;

    const step = {
      kind: 'element',
      name: child.name,
      xmlName: child.xmlName,
      minOccurs: child.minOccurs,
      maxOccurs: child.maxOccurs,
    };
    const childPath = [...prefix, step];

    if (assertions.has(childType)) {
      paths.push({
        path: childPath,
        typeName: childType,
        direct: childPath.length === 1,
        ruleIds: assertions.get(childType).rules.map((rule) => rule.id),
      });
    }

    if (seenTypes.has(childType)) continue;
    if (childPath.length >= MAX_ASSERTION_PATH_DEPTH) continue;

    paths.push(...assertionChildPaths({
      valueTypes,
      assertions,
      typeName: childType,
      seenTypes: new Set([...seenTypes, childType]),
      prefix: childPath,
    }));
  }

  return paths;
}

function childElements(particle) {
  if (!particle) return [];
  if (particle.kind === 'element') return [particle];
  return particle.children.flatMap(childElements);
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

  const groups = parseExactlyOneGroupAssert(test);
  if (groups) {
    return {
      kind: 'exactlyOneGroup',
      enforceable: true,
      fields: groups.flat(),
      groups,
      description: `Exactly one group must have a present member: ${groups
        .map((group) => `(${group.map(fieldLabel).join(' or ')})`).join(', ')}`,
    };
  }

  return {
    kind: 'rawXPath',
    enforceable: false,
    fields: [],
    description: 'Raw XSD 1.1 assertion; requires a full XPath/XSD 1.1 validator',
  };
}

// Recognize only the binary presence pattern used by Issue 1.1:
// (a and not(b or c)) or (not(a) and (b or c)). The identifier group
// means ANY member, not exactly one member; XSD particles enforce choices.
// Other XPath syntax stays raw rather than being partially interpreted.
function parseExactlyOneGroupAssert(test) {
  if (typeof test !== 'string') return null;
  const field = '@?[A-Za-z_][A-Za-z0-9_.-]*';
  const list = `${field}(?:\\s+or\\s+${field})+`;
  const pattern = new RegExp([
    `^\\s*\\(\\s*(${field})\\s+and\\s+not\\s*\\(\\s*(${list})\\s*\\)\\s*\\)`,
    `\\s+or\\s+\\(\\s*not\\s*\\(\\s*(${field})\\s*\\)\\s+and\\s*\\(\\s*(${list})\\s*\\)\\s*\\)\\s*$`,
  ].join(''));
  const match = test.match(pattern);
  if (!match || match[1] !== match[3]) return null;
  const negative = match[2].split(/\s+or\s+/);
  const positive = match[4].split(/\s+or\s+/);
  const members = new Set(negative);
  if (members.has(match[1]) || members.size !== negative.length || members.size !== positive.length) return null;
  if (new Set(positive).size !== members.size || positive.some((name) => !members.has(name))) return null;
  return [[assertField(match[1])], positive.map(assertField)];
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
