const MESSAGE_CONTENT_TYPES = new Set([
  'logisticsSupportAnalysisMessageContent', // S3000L V2
  'messageContent', // S3000L V1
]);

const CONTENT_SECTIONS = {
  // S3000L V2
  lsaPrimaryData: 'lsaPrimaryData',
  lsaSupportingData: 'lsaSupportingData',

  // S3000L V1
  messageContentItems: 'lsaPrimaryData',
  supportingContentItems: 'lsaSupportingData',

};

function detectS3000LEntities(schema) {
  const candidates = [];
  for (const ct of (schema.complexType || [])) {
    const name = ct['@_name'];
    if (!name) continue;
    const attrs = flatAttributes(ct);
    const hasUid = attrs.some((a) => a['@_name'] === 'uid');
    const hasCrud = attrs.some((a) => a['@_name'] === 'crud');
    if (hasUid && hasCrud) candidates.push(name);
  }
  return candidates.length > 0 ? new Set(candidates) : null;
}

function extractS3000LCollections({ schema, resolver, entityTypes }) {
  const map = new Map();
  const msgContent = (schema.complexType || [])
    .find((complexType) => MESSAGE_CONTENT_TYPES.has(complexType['@_name']));

  if (!msgContent) return map;

  for (const section of childElements(msgContent)) {
    const xsdSectionName = section['@_name'];
    const normalizedSection = CONTENT_SECTIONS[xsdSectionName];

    // Ignore message-content elements that are not collection sections.
    if (!normalizedSection) continue;

    for (const collection of childElements(section)) {
      const collectionName = collection['@_name'];
      if (!collectionName) continue;

      const records = recordElements(collection, resolver);

      for (const record of records) {
        if (!record.type) continue;
        if (!entityTypes.has(record.type)) continue;
        map.set(record.type, {
          entityName: record.type,

          section: normalizedSection,

          // Preserve actual XML collection and record names.
          collectionName,
          recordName: record.name || record.type,
        });
      }
    }
  }

  return map;
}

function childElements(node) {
  const out = [];
  const walk = (cur) => {
    if (!cur || typeof cur !== 'object') return;
    for (const el of (cur.element || [])) out.push(el);
    for (const ct of (cur.complexType || [])) walk(ct);
    for (const seq of (cur.sequence || [])) walk(seq);
    for (const all of (cur.all || [])) walk(all);
  };
  walk(node);
  return out;
}

function recordElements(collectionNode, resolver) {
  const records = [];
  const walk = (cur, seenGroups = new Set()) => {
    if (!cur || typeof cur !== 'object') return;

    for (const el of (cur.element || [])) {
      if (el['@_type']) {
        records.push({ name: el['@_name'] || el['@_ref'], type: el['@_type'] });
      } else {
        walk(el, seenGroups);
      }
    }

    for (const groupRef of (cur.group || [])) {
      const ref = groupRef['@_ref'];
      if (!ref || seenGroups.has(ref)) continue;
      const group = resolver.getGroup(ref);
      if (!group) continue;
      const nextSeen = new Set(seenGroups);
      nextSeen.add(ref);
      walk(group, nextSeen);
    }

    for (const ct of (cur.complexType || [])) walk(ct, seenGroups);
    for (const seq of (cur.sequence || [])) walk(seq, seenGroups);
    for (const choice of (cur.choice || [])) walk(choice, seenGroups);
    for (const all of (cur.all || [])) walk(all, seenGroups);
  };

  walk(collectionNode);
  return records;
}

function flatAttributes(ct) {
  const attrs = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const a of (node.attribute || [])) attrs.push(a);
    for (const cc of (node.complexContent || [])) walk(cc);
    for (const sc of (node.simpleContent || [])) walk(sc);
    for (const ext of (node.extension || [])) walk(ext);
    for (const res of (node.restriction || [])) walk(res);
  };
  walk(ct);
  return attrs;
}

module.exports = {
  detectS3000LEntities,
  extractS3000LCollections,
};
