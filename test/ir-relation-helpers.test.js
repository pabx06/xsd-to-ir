const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addChoiceDiscriminator,
  addRelationToEntity,
  ensureSyntheticGroupEntity,
  flattenedGroupRelation,
} = require('../src/ir-relation-helpers');

const toSnake = (s) => s
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g, '$1_$2')
  .replace(/-/g, '_')
  .toLowerCase();

const toCamel = (s) => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
const toPascal = (s) => { const c = toCamel(s); return c[0].toUpperCase() + c.slice(1); };

function helpers() {
  return {
    internalColumnMeta: () => ({
      xmlName: null,
      xmlKind: 'internal',
      minOccurs: 0,
      maxOccurs: 1,
    }),
    relationColumnMeta: (xmlName, minOccurs = 1, maxOccurs = 1) => ({
      xmlName,
      xmlKind: 'relation',
      minOccurs,
      maxOccurs,
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

test('addRelationToEntity preserves one-to-many parent FK metadata', () => {
  const parent = { name: 'product', columns: [], relations: [] };
  const child = { name: 'productVariant', columns: [], relations: [] };
  const entities = new Map([['productVariant', child]]);

  addRelationToEntity({
    entity: parent,
    entities,
    fieldName: 'prodVar',
    targetEntity: 'productVariant',
    nullable: false,
    minOccurs: 1,
    maxOccurs: 'unbounded',
    helpers: helpers(),
  });

  assert.deepEqual(parent.relations[0], {
    kind: 'one-to-many',
    fieldName: 'prodVar',
    targetEntity: 'productVariant',
    joinTable: null,
    parentColumn: 'product_prod_var_parent_id',
    nullable: false,
    minOccurs: 1,
    maxOccurs: 'unbounded',
  });
  assert.equal(child.columns[0].columnName, 'product_prod_var_parent_id');
  assert.equal(child.columns[0].name, 'productProdVarParentId');
  assert.equal(child.columns[0].referencesEntity, 'product');
});

test('addRelationToEntity preserves one-to-one relation FK column shape', () => {
  const entity = { name: 'maintenanceFacility', columns: [], relations: [] };

  addRelationToEntity({
    entity,
    entities: new Map(),
    fieldName: 'maintCap',
    targetEntity: 'maintenanceCapability',
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
    helpers: helpers(),
  });

  assert.deepEqual(entity.relations[0], {
    kind: 'one-to-one',
    fieldName: 'maintCap',
    targetEntity: 'maintenanceCapability',
    joinTable: null,
    parentColumn: null,
    nullable: true,
    minOccurs: 0,
    maxOccurs: 1,
  });
  assert.deepEqual(entity.columns[0], {
    name: 'maintCapId',
    columnName: 'maint_cap_id',
    xmlName: 'maintCap',
    xmlKind: 'relation',
    minOccurs: 0,
    maxOccurs: 1,
    sqlType: 'BIGINT',
    jsonType: 'integer',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isForeignKey: true,
    referencesEntity: 'maintenanceCapability',
    isEnum: false,
    enumRef: null,
    constraints: {},
    documentation: 'FK → maintenanceCapability',
    xsdType: 'maintenanceCapability',
  });
});

test('addChoiceDiscriminator adds choice_type once with branch names', () => {
  const entity = { columns: [] };

  addChoiceDiscriminator(entity, ['subtByDef', 'subtByItem'], helpers());
  addChoiceDiscriminator(entity, ['otherBranch', 'thirdBranch'], helpers());

  assert.equal(entity.columns.length, 1);
  assert.equal(entity.columns[0].columnName, 'choice_type');
  assert.deepEqual(entity.columns[0].constraints, {
    enum: ['subtByDef', 'subtByItem'],
  });
});

test('synthetic flattened group helpers preserve generated entity and relation metadata', () => {
  const parent = { name: 'taskRevision', columns: [], relations: [] };
  const entities = new Map();
  const opts = {
    entities,
    parentEntity: parent,
    groupName: 'subtaskNonAbstractClasses',
    helpers: helpers(),
  };

  const { childName, createdEntity } = ensureSyntheticGroupEntity(opts);
  const existing = ensureSyntheticGroupEntity(opts);

  assert.equal(childName, 'TaskRevisionSubtaskNonAbstractClasses');
  assert.equal(existing.createdEntity, null);
  assert.equal(createdEntity.tableName, 'task_revision_subtask_non_abstract_classes');
  assert.equal(createdEntity.columns[1].columnName, 'task_revision_id');
  assert.equal(createdEntity.columns[1].referencesEntity, 'taskRevision');

  assert.deepEqual(flattenedGroupRelation({
    parentEntity: parent,
    groupName: 'subtaskNonAbstractClasses',
    childName,
    minOccurs: 0,
    maxOccurs: 'unbounded',
    helpers: helpers(),
  }), {
    kind: 'one-to-many',
    fieldName: 'subtaskNonAbstractClasses',
    targetEntity: 'TaskRevisionSubtaskNonAbstractClasses',
    joinTable: null,
    parentColumn: 'task_revision_id',
    flattened: true,
    nullable: true,
    minOccurs: 0,
    maxOccurs: 'unbounded',
  });
});
