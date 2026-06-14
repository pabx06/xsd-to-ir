const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRepeatedPrimitiveEntity,
  idRefsJoinTable,
  inlineComplexElementColumn,
  primitiveElementColumn,
  repeatedPrimitiveRelation,
  simpleElementColumn,
  unknownElementColumn,
} = require('../src/ir-element-builders');

const toSnake = (s) => s
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g, '$1_$2')
  .replace(/-/g, '_')
  .toLowerCase();

const toCamel = (s) => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
const toPascal = (s) => { const c = toCamel(s); return c[0].toUpperCase() + c.slice(1); };

function helpers() {
  return {
    elementColumnMeta: (xmlName, minOccurs = 1, maxOccurs = 1) => ({
      xmlName,
      xmlKind: 'element',
      minOccurs,
      maxOccurs,
    }),
    internalColumnMeta: () => ({
      xmlName: null,
      xmlKind: 'internal',
      minOccurs: 0,
      maxOccurs: 1,
    }),
    shortenIdentifier: (name) => name,
    surrogateKey: () => ({
      name: 'id',
      columnName: 'id',
      xmlName: null,
      xmlKind: 'internal',
      minOccurs: 0,
      maxOccurs: 1,
      sqlType: 'BIGINT',
      jsonType: 'integer',
      nullable: false,
      isPrimaryKey: true,
      isForeignKey: false,
      referencesEntity: null,
      isEnum: false,
      enumRef: null,
      constraints: {},
      xsdType: null,
    }),
    toCamel,
    toDbName: toSnake,
    toPascal,
    toSnake,
  };
}

test('primitiveElementColumn preserves scalar primitive constraints and IDREF metadata', () => {
  const column = primitiveElementColumn({
    fieldName: 'externalRef',
    typeName: 'xs:IDREF',
    resolved: {
      sqlType: 'VARCHAR(255)',
      jsonType: 'string',
      isIdRef: true,
      minimum: 1,
      maximum: 9,
      format: 'idref',
    },
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
    documentation: 'External reference',
    helpers: helpers(),
  });

  assert.deepEqual(column, {
    name: 'externalRef',
    columnName: 'external_ref',
    xmlName: 'externalRef',
    xmlKind: 'element',
    minOccurs: 0,
    maxOccurs: 1,
    sqlType: 'VARCHAR(255)',
    jsonType: 'string',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: true,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: {
      minimum: 1,
      maximum: 9,
      format: 'idref',
      isIdRef: true,
    },
    documentation: 'External reference',
    xsdType: 'xs:IDREF',
  });
});

test('repeated primitive helpers preserve child entity and relation metadata', () => {
  const parentEntity = { name: 'taskRevision', tableName: 'task_revision' };
  const entities = new Map();
  const childName = ensureRepeatedPrimitiveEntity({
    entities,
    parentEntity,
    fieldName: 'tag',
    typeName: 'xs:string',
    resolved: { sqlType: 'TEXT', jsonType: 'string' },
    minOccurs: 0,
    maxOccurs: 'unbounded',
    helpers: helpers(),
  });

  const child = entities.get(childName);
  assert.equal(childName, 'TaskRevisionTag');
  assert.equal(child.tableName, 'task_revision_tag');
  assert.equal(child.columns[1].columnName, 'task_revision_id');
  assert.equal(child.columns[1].referencesEntity, 'taskRevision');
  assert.deepEqual(child.columns[2], {
    name: 'value',
    columnName: 'value',
    xmlName: 'tag',
    xmlKind: 'element',
    minOccurs: 0,
    maxOccurs: 'unbounded',
    sqlType: 'TEXT',
    jsonType: 'string',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: null,
    xsdType: 'xs:string',
  });

  assert.deepEqual(repeatedPrimitiveRelation({
    parentEntity,
    fieldName: 'tag',
    childName,
    nullable: true,
    minOccurs: 0,
    maxOccurs: 'unbounded',
    helpers: helpers(),
  }), {
    kind: 'one-to-many',
    fieldName: 'tag',
    targetEntity: 'TaskRevisionTag',
    joinTable: null,
    parentColumn: 'task_revision_id',
    nullable: true,
    minOccurs: 0,
    maxOccurs: 'unbounded',
  });
});

test('simpleElementColumn preserves enum and restricted simple type columns', () => {
  const enumColumn = simpleElementColumn({
    fieldName: 'crud',
    typeName: 'crudCode',
    enumDef: { values: ['I', 'U', 'D'] },
    nullable: false,
    minOccurs: 1,
    maxOccurs: 1,
    documentation: null,
    helpers: helpers(),
  });
  const restrictedColumn = simpleElementColumn({
    fieldName: 'description',
    typeName: 'shortText',
    simpleType: {
      sqlType: 'VARCHAR(255)',
      jsonType: 'string',
      constraints: { maxLength: '255' },
    },
    enumDef: null,
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
    documentation: 'Short text',
    helpers: helpers(),
  });

  assert.equal(enumColumn.sqlType, 'VARCHAR(64)');
  assert.equal(enumColumn.isEnum, true);
  assert.equal(enumColumn.enumRef, 'crudCode');
  assert.deepEqual(enumColumn.constraints, { enum: ['I', 'U', 'D'] });

  assert.equal(restrictedColumn.sqlType, 'VARCHAR(255)');
  assert.equal(restrictedColumn.isEnum, false);
  assert.deepEqual(restrictedColumn.constraints, { maxLength: '255' });
  assert.equal(restrictedColumn.documentation, 'Short text');
});

test('complex and unknown element builders preserve fallback column contracts', () => {
  assert.deepEqual(inlineComplexElementColumn({
    fieldName: 'prodId',
    typeName: 'productIdentifier',
    nullable: false,
    minOccurs: 1,
    maxOccurs: 1,
    helpers: helpers(),
  }), {
    name: 'prodId',
    columnName: 'prod_id',
    xmlName: 'prodId',
    xmlKind: 'element',
    minOccurs: 1,
    maxOccurs: 1,
    sqlType: 'LONGTEXT',
    jsonType: 'object',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: false,
    referencesEntity: null,
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: 'Inline complex type productIdentifier (not a real S3000L entity)',
    xsdType: 'productIdentifier',
  });

  assert.equal(unknownElementColumn({
    fieldName: 'unknownField',
    typeName: 'missingType',
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
    helpers: helpers(),
  }).documentation, 'Unresolved type: missingType');
});

test('idRefsJoinTable preserves generated join-table naming', () => {
  const joinTable = idRefsJoinTable({
    entity: { name: 'taskRevision', tableName: 'task_revision' },
    fieldName: 'relatedTaskRefs',
    helpers: helpers(),
  });

  assert.deepEqual(joinTable, {
    name: 'task_revision__related_task_refs',
    tableName: 'task_revision__related_task_refs',
    leftEntity: 'taskRevision',
    leftColumn: 'task_revision_id',
    rightEntity: 'RelatedTaskRefs',
    rightColumn: 'related_task_refs_id',
    documentation: 'Join table for IDREFS taskRevision.relatedTaskRefs',
  });
});
