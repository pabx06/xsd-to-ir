const path = require('node:path');

const { DBAdapter } = require('../src/db-adapter');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');

const ISSUE_11_XSD = path.join(
  __dirname,
  '..',
  's3000l',
  '1_1',
  's3000l_1-1_lsa_dataset.xsd',
);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseJsonCell(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${location}: ${error.message}`);
  }
}

function firstScalar(value, preferredKeys = []) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstScalar(item, preferredKeys);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return String(value);

  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const found = firstScalar(value[key], preferredKeys);
    if (found !== null) return found;
  }

  if (Object.prototype.hasOwnProperty.call(value, '#text')) {
    return String(value['#text']);
  }
  return null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function naturalRevisionKey(elementIdentifier, revisionIdentifier) {
  if (!elementIdentifier || !revisionIdentifier) return null;
  return JSON.stringify([
    stableValue(elementIdentifier),
    stableValue(revisionIdentifier),
  ]);
}

function requiredEntity(ir, entityName) {
  const entity = ir.entities.get(entityName);
  if (!entity) throw new Error(`Issue 1.1 IR does not contain ${entityName}`);
  return entity;
}

function requiredRelation(entity, fieldName) {
  const relation = entity.relations.find((candidate) => candidate.fieldName === fieldName);
  if (!relation) throw new Error(`IR relation ${entity.name}.${fieldName} is missing`);
  if (!relation.parentColumn) {
    throw new Error(`IR relation ${entity.name}.${fieldName} has no child parentColumn`);
  }
  return relation;
}

function rowValue(row, columnName, location) {
  return parseJsonCell(row[columnName], `${location}.${columnName}`);
}

function joinedLabel(name, identifier, fallback) {
  if (name && identifier && name !== identifier) return `${name} (${identifier})`;
  return name || identifier || fallback;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const leftKey = String(left.uid ?? left.id ?? '');
    const rightKey = String(right.uid ?? right.id ?? '');
    return leftKey.localeCompare(rightKey);
  });
}

async function loadBreakdownElementIndex(ir, db) {
  const byRevisionUid = new Map();
  const byNaturalKey = new Map();
  const collectionMappings = [...ir.s3000lCollections.values()]
    .filter((mapping) => mapping.collectionName === 'breakdownElements');

  for (const mapping of collectionMappings) {
    const elementEntity = requiredEntity(ir, mapping.entityName);
    const revisionRelation = requiredRelation(elementEntity, 'beRev');
    const elementRows = sortRows(await db.queryEntity(mapping.entityName));

    for (const elementRow of elementRows) {
      const location = `${elementEntity.tableName}[uid=${elementRow.uid}]`;
      const elementIdentifier = rowValue(elementRow, 'be_id', location);
      const elementName = rowValue(elementRow, 'name', location);
      const revisions = sortRows(await db.queryRelated(
        revisionRelation.targetEntity,
        revisionRelation.parentColumn,
        elementRow.id,
      ));

      for (const revisionRow of revisions) {
        const revisionLocation = `${revisionRelation.targetEntity}[uid=${revisionRow.uid}]`;
        const revisionIdentifier = rowValue(revisionRow, 'be_rev_id', revisionLocation);
        const identifier = firstScalar(elementIdentifier, ['id']);
        const name = firstScalar(elementName, ['descr', 'name']);
        const descriptor = {
          entityName: mapping.entityName,
          elementUid: elementRow.uid,
          revisionEntityName: revisionRelation.targetEntity,
          revisionUid: revisionRow.uid,
          identifier,
          revisionIdentifier: firstScalar(revisionIdentifier, ['id']),
          label: joinedLabel(name, identifier, revisionRow.uid || elementRow.uid),
        };

        if (revisionRow.uid) byRevisionUid.set(String(revisionRow.uid), descriptor);
        const key = naturalRevisionKey(elementIdentifier, revisionIdentifier);
        if (key) byNaturalKey.set(key, descriptor);
      }
    }
  }

  return { byRevisionUid, byNaturalKey };
}

function resolveBreakdownElement(reference, index) {
  if (!reference || typeof reference !== 'object') return null;

  const uidRef = reference['@_uidRef'];
  if (uidRef !== undefined && uidRef !== null) {
    return index.byRevisionUid.get(String(uidRef)) || null;
  }

  const key = naturalRevisionKey(reference.beId, reference.beRevId);
  return key ? index.byNaturalKey.get(key) || null : null;
}

function referenceLabel(reference) {
  if (!reference || typeof reference !== 'object') return 'Unresolved breakdown element';
  const naturalId = firstScalar(reference.beId, ['id']);
  const uidRef = reference['@_uidRef'];
  return `Unresolved breakdown element ${naturalId || uidRef || 'reference'}`;
}

function quantityLabel(quantity) {
  if (!quantity || typeof quantity !== 'object') return null;
  const value = firstScalar(quantity, ['value', 'nomVal', 'txt']);
  const unit = firstScalar(quantity.unit, ['code', '#text']);
  if (value && unit) return `${value} ${unit}`;
  return value || unit;
}

function usageNode(usage, usageByUid, index, pathUids, edge = {}) {
  const usageUid = usage?.['@_uid'] ? String(usage['@_uid']) : null;
  const reference = usage?.beRef;
  const resolved = resolveBreakdownElement(reference, index);
  const node = {
    key: `usage:${usageUid || referenceLabel(reference)}`,
    kind: 'breakdown-element',
    source: resolved ? 'database-entity' : 'json-reference',
    schemaType: 'breakdownElementUsageInBreakdown',
    uid: usageUid,
    label: resolved?.label || referenceLabel(reference),
    quantity: edge.quantity || null,
    referenceDesignator: edge.referenceDesignator || null,
    resolvedEntity: resolved,
    children: [],
  };

  if (usageUid && pathUids.has(usageUid)) {
    node.cycle = true;
    node.label = `${node.label} [cycle]`;
    return node;
  }

  const nextPath = new Set(pathUids);
  if (usageUid) nextPath.add(usageUid);

  for (const structure of asArray(usage?.beChild)) {
    const childUid = structure?.beChildRef?.['@_uidRef'];
    const quantity = quantityLabel(structure?.qty);
    const referenceDesignator = firstScalar(structure?.rfd, ['id', 'descr', '#text']);
    const childUsage = childUid === undefined || childUid === null
      ? null
      : usageByUid.get(String(childUid));

    if (!childUsage) {
      node.children.push({
        key: `missing-usage:${childUid || node.children.length}`,
        kind: 'unresolved-usage',
        source: 'json-reference',
        uid: childUid ? String(childUid) : null,
        label: `Unresolved usage ${childUid || 'reference'}`,
        quantity,
        referenceDesignator,
        children: [],
      });
      continue;
    }

    node.children.push(usageNode(childUsage, usageByUid, index, nextPath, {
      quantity,
      referenceDesignator,
    }));
  }

  return node;
}

function revisionNode(revision, index, ownerKey, revisionPosition) {
  const usages = asArray(revision?.beUsage);
  const usageByUid = new Map();
  const childUids = new Set();

  for (const usage of usages) {
    if (usage?.['@_uid']) usageByUid.set(String(usage['@_uid']), usage);
  }

  // References may point forward, so index every usage before collecting child UIDs.
  for (const usage of usages) {
    for (const structure of asArray(usage?.beChild)) {
      const childUid = structure?.beChildRef?.['@_uidRef'];
      if (childUid !== undefined && childUid !== null && usageByUid.has(String(childUid))) {
        childUids.add(String(childUid));
      }
    }
  }

  let roots = usages.filter((usage) => !usage?.['@_uid'] || !childUids.has(String(usage['@_uid'])));
  if (roots.length === 0 && usages.length > 0) roots = usages;

  const revisionUid = revision?.['@_uid'] ? String(revision['@_uid']) : null;
  const revisionIdentifier = firstScalar(revision?.bkdnRevId, ['id']);
  return {
    key: `${ownerKey}:revision:${revisionUid || revisionPosition}`,
    kind: 'breakdown-revision',
    source: 'json-column',
    schemaType: 'breakdownRevision',
    uid: revisionUid,
    label: `Revision ${revisionIdentifier || revisionUid || revisionPosition + 1}`,
    children: roots.map((usage) => usageNode(usage, usageByUid, index, new Set())),
  };
}

function breakdownNodes(rawBkdns, index, ownerKey) {
  const wrapper = parseJsonCell(rawBkdns, `${ownerKey}.bkdns`);
  return asArray(wrapper?.bkdn).map((breakdown, breakdownPosition) => {
    const breakdownUid = breakdown?.['@_uid'] ? String(breakdown['@_uid']) : null;
    const type = firstScalar(breakdown?.bkdnType, ['code']);
    const key = `${ownerKey}:breakdown:${breakdownUid || breakdownPosition}`;
    return {
      key,
      kind: 'breakdown',
      source: 'json-column',
      schemaType: 'breakdown',
      uid: breakdownUid,
      label: type ? `${type} breakdown` : `Breakdown ${breakdownUid || breakdownPosition + 1}`,
      children: asArray(breakdown?.bkdnRev)
        .map((revision, revisionPosition) => revisionNode(revision, index, key, revisionPosition)),
    };
  });
}

function ownerNode(row, kind, entityName, identifierColumn, elementIndex) {
  const identifier = firstScalar(
    parseJsonCell(row[identifierColumn], `${entityName}[uid=${row.uid}].${identifierColumn}`),
    ['id'],
  );
  const name = firstScalar(
    parseJsonCell(row.name, `${entityName}[uid=${row.uid}].name`),
    ['descr', 'name'],
  );
  const key = `${entityName}:${row.uid || row.id}`;
  return {
    key,
    kind,
    source: 'database-entity',
    entityName,
    uid: row.uid || null,
    databaseId: row.id,
    identifier,
    label: joinedLabel(name, identifier, row.uid || `${entityName} ${row.id}`),
    children: breakdownNodes(row.bkdns, elementIndex, key),
  };
}

async function loadIssue11ProductBreakdown(ir, db, options = {}) {
  if (ir.s3000lDialect !== '1.1') {
    throw new Error(`Issue 1.1 IR required; received ${ir.s3000lDialect || 'unknown dialect'}`);
  }

  const productEntity = requiredEntity(ir, 'product');
  const variantRelation = requiredRelation(productEntity, 'prodVar');
  const elementIndex = await loadBreakdownElementIndex(ir, db);
  let products = sortRows(await db.queryEntity('product'));

  if (options.productUid) {
    products = products.filter((row) => String(row.uid) === String(options.productUid));
    if (products.length === 0) {
      throw new Error(`Active product ${options.productUid} was not found`);
    }
  }

  const nodes = [];
  for (const productRow of products) {
    const productNode = ownerNode(productRow, 'product', 'product', 'prod_id', elementIndex);
    const variants = sortRows(await db.queryRelated(
      variantRelation.targetEntity,
      variantRelation.parentColumn,
      productRow.id,
    ));

    for (const variantRow of variants) {
      productNode.children.push(ownerNode(
        variantRow,
        'product-variant',
        variantRelation.targetEntity,
        'prod_var_id',
        elementIndex,
      ));
    }
    nodes.push(productNode);
  }

  return nodes;
}

function renderTextTree(nodes) {
  const lines = [];
  const visit = (node, prefix, isLast, isRoot) => {
    let branch = '';
    if (!isRoot) branch = isLast ? '└─ ' : '├─ ';
    const quantity = node.quantity ? ` × ${node.quantity}` : '';
    const referenceDesignator = node.referenceDesignator ? ` [${node.referenceDesignator}]` : '';
    lines.push(`${prefix}${branch}${node.label}${quantity}${referenceDesignator}`);

    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
    node.children.forEach((child, position) => {
      visit(child, childPrefix, position === node.children.length - 1, false);
    });
  };

  nodes.forEach((node) => visit(node, '', true, true));
  return lines.join('\n');
}

async function main() {
  if (!process.env.MARIADB_URL) {
    throw new Error('Set MARIADB_URL to the database generated from the Issue 1.1 IR');
  }

  // mysql2 is an optional package dependency. Install it for MariaDB use.
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  const knex = require('knex')({
    client: 'mysql2',
    connection: process.env.MARIADB_URL,
  });

  try {
    const ir = new IRBuilder(parseXSD(ISSUE_11_XSD)).build();
    const db = new DBAdapter(knex, ir);
    const nodes = await loadIssue11ProductBreakdown(ir, db, {
      productUid: process.argv[2] || null,
    });
    console.log(renderTextTree(nodes));
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ISSUE_11_XSD,
  loadIssue11ProductBreakdown,
  renderTextTree,
};
