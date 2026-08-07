/**
 * Regression contract for REV-018.
 *
 * Run only this suite with:
 *   npm run test:rev-018
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { deserializeXML } = require('../src/xml-deserializer');

const XSD_BY_DIALECT = {
  issue1: 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd',
  issue2: 's3000l/2_0/s3000l_2-0_lsaDataset.xsd',
};
const ISSUE_1_XML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'rev-018-issue-1-anonymous-wrapper-valid.xml'),
  'utf8',
);

const irByDialect = new Map();

function buildDialectIr(dialect) {
  if (!irByDialect.has(dialect)) {
    irByDialect.set(
      dialect,
      new IRBuilder(parseXSD(XSD_BY_DIALECT[dialect])).build(),
    );
  }
  return irByDialect.get(dialect);
}

function danglingRelations(ir) {
  const dangling = [];

  for (const [entityName, entity] of ir.entities) {
    for (const relation of (entity.relations || [])) {
      if (!ir.entities.has(relation.targetEntity)) {
        dangling.push(`${entityName}.${relation.fieldName}->${relation.targetEntity}`);
      }
    }
  }

  return dangling;
}

function wrapperShape(ir, entityName) {
  const entity = ir.entities.get(entityName);
  assert.ok(entity, `missing ${entityName} entity`);

  return {
    columns: entity.columns
      .filter((column) => column.xmlName === 'bkdns')
      .map((column) => ({
        name: column.name,
        columnName: column.columnName,
        xmlName: column.xmlName,
        xmlKind: column.xmlKind,
        sqlType: column.sqlType,
        jsonType: column.jsonType,
        isForeignKey: column.isForeignKey,
        referencesEntity: column.referencesEntity,
      })),
    relations: entity.relations
      .filter((relation) => relation.fieldName === 'bkdns'),
  };
}

test('REV-018: bundled S3000L dialects have no dangling relation targets', () => {
  const actual = Object.fromEntries(
    Object.keys(XSD_BY_DIALECT).map((dialect) => {
      const dangling = danglingRelations(buildDialectIr(dialect));
      return [dialect, {
        count: dangling.length,
        sample: dangling.slice(0, 5),
      }];
    }),
  );

  assert.deepEqual(actual, {
    issue1: { count: 0, sample: [] },
    issue2: { count: 0, sample: [] },
  });
});

test('REV-018: S3000L bkdns wrappers are inline JSON columns', () => {
  const expected = {
    columns: [{
      name: 'bkdns',
      columnName: 'bkdns',
      xmlName: 'bkdns',
      xmlKind: 'element',
      sqlType: 'LONGTEXT',
      jsonType: 'object',
      isForeignKey: false,
      referencesEntity: null,
    }],
    relations: [],
  };

  for (const dialect of Object.keys(XSD_BY_DIALECT)) {
    const ir = buildDialectIr(dialect);
    for (const entityName of ['product', 'productVariant']) {
      assert.deepEqual(
        wrapperShape(ir, entityName),
        expected,
        `${dialect} ${entityName}.bkdns must not be a UID-backed relation`,
      );
    }
  }
});

test('REV-018: Issue 1 import preserves both bkdns subtrees and real parentage', () => {
  const result = deserializeXML(ISSUE_1_XML, buildDialectIr('issue1'));
  const product = result.batches.get('product').insert[0];
  const variant = result.batches.get('productVariant').insert[0];
  const productBkdns = JSON.parse(product.bkdns);
  const variantBkdns = JSON.parse(variant.bkdns);

  assert.equal(result.version, '1.1');
  assert.equal(product.uid, 'prod1801');
  assert.equal(productBkdns.bkdn['@_uid'], 'bkdn1801');
  assert.equal(productBkdns.bkdn.bkdnType.code, 'SY');
  assert.equal(variant.uid, 'prodv1801');
  assert.equal(variantBkdns.bkdn['@_uid'], 'bkdn1802');
  assert.equal(variantBkdns.bkdn.bkdnType.code, 'HY');
  assert.deepEqual(variant._xmlParent, {
    entityName: 'product',
    uid: 'prod1801',
    fkColumn: 'product_prod_var_parent_id',
  });
});

test('REV-018: generic schemas retain anonymous complex-type relations', () => {
  const genericSchema = {
    complexType: [{
      '@_name': 'Parent',
      sequence: [{
        element: [{
          '@_name': 'payload',
          '@_minOccurs': '0',
          complexType: [{
            sequence: [{
              element: [{ '@_name': 'value', '@_type': 'string' }],
            }],
          }],
        }],
      }],
    }],
  };
  const ir = new IRBuilder(genericSchema).build();
  const parent = ir.entities.get('Parent');

  assert.equal(ir.s3000lMode, false);
  assert.ok(ir.entities.has('ParentPayload'));
  assert.deepEqual(parent.relations, [{
    kind: 'one-to-one',
    fieldName: 'payload',
    targetEntity: 'ParentPayload',
    joinTable: null,
    parentColumn: null,
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
  }]);
  assert.equal(
    parent.columns.find((column) => column.columnName === 'payload_id').referencesEntity,
    'ParentPayload',
  );
});
