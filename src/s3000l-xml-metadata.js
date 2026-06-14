const PRIMARY_COLLECTIONS = new Set([
  'breakdownElements', 'parts', 'productOperationalRoleKits',
  'products', 'taskRequirements', 'tasks',
]);

const IRREGULAR_SINGULAR = {
  breakdownElements: 'breakdownElement',
  productOperationalRoleKits: 'productOperationalRoleKit',
  facilities: 'facility',
  countries: 'country',
  trades: 'trade',
  skills: 'skill',
  contracts: 'contract',
  projects: 'project',
  documents: 'document',
  organizations: 'organization',
  infrastructures: 'infrastructure',
  substances: 'substance',
};

const COLLECTION_OVERRIDES = {
  breakdownElement: 'breakdownElements',
  productOperationalRoleKit: 'productOperationalRoleKits',
  facility: 'facilities',
  country: 'countries',
  trade: 'trades',
  skill: 'skills',
  contract: 'contracts',
  project: 'projects',
  document: 'documents',
  organization: 'organizations',
  infrastructure: 'infrastructures',
  substanceDefinition: 'substanceDefinitions',
};

const XML_ATTRIBUTE_COLS = new Set(['uid', 'uri', 'crud']);

function toCamel(s) {
  return String(s || '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function singularOf(pluralKey) {
  if (IRREGULAR_SINGULAR[pluralKey]) return IRREGULAR_SINGULAR[pluralKey];
  if (pluralKey.endsWith('s')) return pluralKey.slice(0, -1);
  return pluralKey;
}

function collectionKey(entityName) {
  return COLLECTION_OVERRIDES[entityName] ?? (`${entityName}s`);
}

function collectionEntries(ir, opts = {}) {
  const source = ir.s3000lCollections;
  const entries = source instanceof Map
    ? [...source.entries()]
    : Object.entries(source || {});

  return entries
    .map(([entityName, meta]) => ({
      entityName,
      section: meta.section,
      collectionName: meta.collectionName,
      recordName: meta.recordName || entityName,
    }))
    .filter((meta) => {
      if (!meta.collectionName || !meta.recordName) return false;
      return !opts.requireSection || !!meta.section;
    });
}

function fallbackCollectionMeta(entityName) {
  const collectionName = collectionKey(entityName);
  return {
    entityName,
    section: PRIMARY_COLLECTIONS.has(collectionName)
      ? 'lsaPrimaryData'
      : 'lsaSupportingData',
    collectionName,
    recordName: entityName,
  };
}

function readField(node, fieldName, kind = null) {
  if (node === null || typeof node !== 'object') return undefined;
  if (!fieldName) return undefined;

  if (kind === 'attribute') return node[`@_${fieldName}`];
  if (kind === 'element') return node[fieldName];

  const attrVal = node[`@_${fieldName}`];
  if (attrVal !== undefined) return attrVal;

  const elemVal = node[fieldName];
  if (elemVal !== undefined) return elemVal;

  return undefined;
}

function columnXmlKindForImport(col) {
  if (col.xmlKind) return col.xmlKind;
  if (col.columnName === 'id' || col.columnName?.startsWith('_')) return 'internal';
  return null;
}

function columnXmlKindForExport(col) {
  if (col.xmlKind) return col.xmlKind;
  if (col.columnName === 'id' || col.columnName?.startsWith('_')) return 'internal';
  if (XML_ATTRIBUTE_COLS.has(col.columnName)) return 'attribute';
  return 'element';
}

function columnXmlNameForImport(col) {
  return col.xmlName || col.name || col.columnName;
}

function columnXmlNameForExport(col) {
  return col.xmlName || col.name || toCamel(col.columnName);
}

function relationColumn(entity, relation) {
  return entity.columns.find((col) => col.xmlKind === 'relation'
    && col.xmlName === relation.fieldName
    && col.referencesEntity === relation.targetEntity) || null;
}

function isXmlImportColumn(col) {
  const kind = columnXmlKindForImport(col);
  return kind !== 'internal' && kind !== 'relation';
}

function readColumnField(node, col) {
  const kind = columnXmlKindForImport(col);
  const xmlName = columnXmlNameForImport(col);

  if (kind === 'attribute') {
    return readField(node, xmlName, 'attribute')
      ?? readField(node, col.name)
      ?? readField(node, col.columnName);
  }

  if (kind === 'element') {
    return readField(node, xmlName, 'element')
      ?? readField(node, col.name)
      ?? readField(node, col.columnName);
  }

  return readField(node, col.name)
    ?? readField(node, col.columnName);
}

module.exports = {
  COLLECTION_OVERRIDES,
  IRREGULAR_SINGULAR,
  PRIMARY_COLLECTIONS,
  XML_ATTRIBUTE_COLS,
  collectionEntries,
  collectionKey,
  columnXmlKindForExport,
  columnXmlKindForImport,
  columnXmlNameForExport,
  columnXmlNameForImport,
  fallbackCollectionMeta,
  isXmlImportColumn,
  readColumnField,
  readField,
  relationColumn,
  singularOf,
};
