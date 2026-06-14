const test = require('node:test');
const assert = require('node:assert/strict');

const { attributeColumn } = require('../src/ir-attribute-builders');

const toSnake = (s) => s
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g, '$1_$2')
  .replace(/-/g, '_')
  .toLowerCase();

const toCamel = (s) => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());

function helpers() {
  return {
    attributeColumnMeta: (xmlName) => ({
      xmlName,
      xmlKind: 'attribute',
      minOccurs: 0,
      maxOccurs: 1,
    }),
    toCamel,
    toDbName: toSnake,
  };
}

test('attributeColumn preserves primitive attribute constraints and ID metadata', () => {
  const column = attributeColumn({
    fieldName: 'external-ref',
    typeName: 'xs:IDREF',
    resolved: {
      kind: 'primitive',
      sqlType: 'VARCHAR(255)',
      jsonType: 'string',
      minimum: 1,
      maximum: 10,
      format: 'idref',
      isIdRef: true,
    },
    nullable: true,
    defaultValue: null,
    documentation: 'External reference',
    isS3000LUid: false,
    helpers: helpers(),
  });

  assert.deepEqual(column, {
    name: 'externalRef',
    columnName: 'external_ref',
    xmlName: 'external-ref',
    xmlKind: 'attribute',
    minOccurs: 0,
    maxOccurs: 1,
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    documentation: 'External reference',
    xsdType: 'xs:IDREF',
    sqlType: 'VARCHAR(255)',
    jsonType: 'string',
    isEnum: false,
    enumRef: null,
    constraints: {
      minimum: 1,
      maximum: 10,
      format: 'idref',
      isIdRef: true,
    },
  });
});

test('attributeColumn preserves S3000L uid SQL override', () => {
  const column = attributeColumn({
    fieldName: 'uid',
    typeName: 'xs:ID',
    resolved: {
      kind: 'primitive',
      sqlType: 'TEXT',
      jsonType: 'string',
      isId: true,
    },
    nullable: false,
    defaultValue: null,
    documentation: null,
    isS3000LUid: true,
    helpers: helpers(),
  });

  assert.equal(column.sqlType, 'VARCHAR(255)');
  assert.equal(column.constraints.isId, true);
  assert.equal(column.nullable, false);
});

test('attributeColumn preserves enum attribute shape', () => {
  const column = attributeColumn({
    fieldName: 'crud',
    typeName: 'crudCode',
    resolved: { kind: 'simple' },
    enumDef: { values: ['I', 'U', 'D'] },
    nullable: false,
    defaultValue: 'I',
    documentation: null,
    isS3000LUid: false,
    helpers: helpers(),
  });

  assert.equal(column.sqlType, 'VARCHAR(64)');
  assert.equal(column.jsonType, 'string');
  assert.equal(column.isEnum, true);
  assert.equal(column.enumRef, 'crudCode');
  assert.deepEqual(column.constraints, { enum: ['I', 'U', 'D'] });
  assert.equal(column.defaultValue, 'I');
});

test('attributeColumn preserves non-enum fallback for non-primitive attributes', () => {
  const column = attributeColumn({
    fieldName: 'status',
    typeName: 'customStatus',
    resolved: { kind: 'unknown' },
    enumDef: null,
    nullable: true,
    defaultValue: null,
    documentation: null,
    isS3000LUid: false,
    helpers: helpers(),
  });

  assert.equal(column.sqlType, 'TEXT');
  assert.equal(column.jsonType, 'string');
  assert.equal(column.isEnum, false);
  assert.deepEqual(column.constraints, {});
});
