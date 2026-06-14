const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectionEntries,
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
} = require('../src/s3000l-xml-metadata');

test('S3000L XML metadata preserves collection and fallback naming', () => {
  const ir = {
    s3000lCollections: new Map([
      ['product', {
        section: 'lsaPrimaryData',
        collectionName: 'products',
        recordName: 'prod',
      }],
      ['looseRecord', {
        collectionName: 'looseRecords',
      }],
    ]),
  };

  assert.deepEqual(collectionEntries(ir), [
    {
      entityName: 'product',
      section: 'lsaPrimaryData',
      collectionName: 'products',
      recordName: 'prod',
    },
    {
      entityName: 'looseRecord',
      section: undefined,
      collectionName: 'looseRecords',
      recordName: 'looseRecord',
    },
  ]);

  assert.deepEqual(collectionEntries(ir, { requireSection: true }), [{
    entityName: 'product',
    section: 'lsaPrimaryData',
    collectionName: 'products',
    recordName: 'prod',
  }]);

  assert.deepEqual(fallbackCollectionMeta('product'), {
    entityName: 'product',
    section: 'lsaPrimaryData',
    collectionName: 'products',
    recordName: 'product',
  });

  assert.deepEqual(fallbackCollectionMeta('facility'), {
    entityName: 'facility',
    section: 'lsaSupportingData',
    collectionName: 'facilities',
    recordName: 'facility',
  });
  assert.equal(singularOf('facilities'), 'facility');
});

test('S3000L XML metadata keeps import and export field-kind rules separate', () => {
  const legacyUid = { columnName: 'uid', name: 'uid' };
  const explicitAttr = {
    columnName: 'uid',
    name: 'uid',
    xmlName: 'uid',
    xmlKind: 'attribute',
  };
  const explicitElem = {
    columnName: 'prod_name',
    name: 'prodName',
    xmlName: 'prodName',
    xmlKind: 'element',
  };
  const fallbackElem = { columnName: 'prod_name' };
  const internal = { columnName: '_msg_seq' };

  assert.equal(columnXmlKindForImport(legacyUid), null);
  assert.equal(columnXmlKindForExport(legacyUid), 'attribute');
  assert.equal(columnXmlKindForImport(internal), 'internal');
  assert.equal(columnXmlKindForExport(internal), 'internal');
  assert.equal(columnXmlKindForExport(fallbackElem), 'element');
  assert.equal(columnXmlNameForImport(fallbackElem), 'prod_name');
  assert.equal(columnXmlNameForExport(fallbackElem), 'prodName');

  assert.equal(isXmlImportColumn(explicitAttr), true);
  assert.equal(isXmlImportColumn({ columnName: 'child_id', xmlKind: 'relation' }), false);

  const node = {
    '@_uid': 'P1',
    prodName: 'Widget',
    prod_name: 'legacy-widget',
  };

  assert.equal(readField(node, 'uid', 'attribute'), 'P1');
  assert.equal(readField(node, 'prodName', 'element'), 'Widget');
  assert.equal(readColumnField(node, explicitAttr), 'P1');
  assert.equal(readColumnField(node, explicitElem), 'Widget');
  assert.equal(readColumnField(node, fallbackElem), 'legacy-widget');
});

test('S3000L XML metadata finds relation columns by XML relation identity', () => {
  const entity = {
    columns: [
      { columnName: 'id', xmlKind: 'internal' },
      {
        columnName: 'maint_cap_id',
        xmlKind: 'relation',
        xmlName: 'maintCap',
        referencesEntity: 'maintenanceCapability',
      },
    ],
  };

  assert.deepEqual(
    relationColumn(entity, {
      fieldName: 'maintCap',
      targetEntity: 'maintenanceCapability',
    }),
    entity.columns[1],
  );

  assert.equal(
    relationColumn(entity, {
      fieldName: 'maintCap',
      targetEntity: 'otherEntity',
    }),
    null,
  );
});
