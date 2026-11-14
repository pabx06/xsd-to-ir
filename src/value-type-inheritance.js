function lookup(registry, name) {
  return registry instanceof Map ? registry.get(name) : registry?.[name];
}

function lineage(valueTypes, typeName) {
  const types = [];
  const seen = new Set();
  for (let name = typeName; name;) {
    if (seen.has(name)) throw new Error(`Cyclic value type inheritance: ${name}`);
    seen.add(name);
    const type = lookup(valueTypes, name);
    types.push({ name, type });
    name = type?.baseTypeRef;
  }
  return types.reverse();
}

// Both extension and restriction retain base assertions. Keep declaration IDs
// and base-first order rather than copying inherited rules into the IR.
function effectiveAssertionRules(ir, typeName) {
  const rules = new Map();
  for (const { name } of lineage(ir?.valueTypes, typeName)) {
    for (const rule of (lookup(ir?.assertions, name)?.rules || [])) {
      if (!rules.has(rule.id)) rules.set(rule.id, rule);
    }
  }
  return [...rules.values()];
}

// Unlike assertions, restricted content replaces the base particle. Only an
// extension carries base children forward into nested assertion paths.
function effectiveValueContent(valueTypes, typeName) {
  let content = null;
  for (const { type } of lineage(valueTypes, typeName)) {
    if (!type) continue;
    content = type.derivation === 'extension' && content
      ? {
        kind: 'sequence', minOccurs: 1, maxOccurs: 1, children: [content, type.content].filter(Boolean),
      }
      : type.content;
  }
  return content;
}

module.exports = { effectiveAssertionRules, effectiveValueContent };
