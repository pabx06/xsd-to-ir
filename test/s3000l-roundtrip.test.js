const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');

const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { generateSQL } = require('../src/sql-generator');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');
const { detectS3000LEntities } = require('../src/s3000l-ir-metadata');
const {
  relationshipHeavyPrimaryXml,
  relationshipMissingChoiceBranchUidXml,
  relationshipMissingParentUidXml,
  relationshipUnsupportedChoiceBranchXml,
  s3000lEnvelope,
} = require('./helpers/s3000l-fixtures');

let cachedIr = null;
let cachedSchema = null;

function loadSchema() {
  if (!cachedSchema) {
    cachedSchema = parseXSD('s3000l/s3000l_2-0_lsaDataset.xsd');
  }
  return cachedSchema;
}

function buildIr() {
  if (!cachedIr) {
    cachedIr = new IRBuilder(loadSchema()).build();
  }
  return cachedIr;
}

function fakeDb(rowsByEntity, deletedByEntity = {}) {
  return {
    async queryEntity(entityName) {
      return rowsByEntity[entityName] || [];
    },
    async queryDeleted(entityName) {
      return deletedByEntity[entityName] || [];
    },
  };
}

function parseXml(xml) {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
  }).parse(xml);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

test('IR contains S3000L collection metadata from the real Issue 2.0 XSD', () => {
  const ir = buildIr();

  assert.deepEqual(ir.s3000lCollections.get('product'), {
    entityName: 'product',
    section: 'lsaPrimaryData',
    collectionName: 'products',
    recordName: 'prod',
  });
  assert.deepEqual(ir.s3000lCollections.get('taskRequirement'), {
    entityName: 'taskRequirement',
    section: 'lsaPrimaryData',
    collectionName: 'taskRequirements',
    recordName: 'taskReq',
  });
  assert.deepEqual(ir.s3000lCollections.get('operationalTask'), {
    entityName: 'operationalTask',
    section: 'lsaPrimaryData',
    collectionName: 'tasks',
    recordName: 'opTask',
  });
});

test('S3000L entity totals distinguish direct uid+crud types from synthetic helpers', () => {
  const directEntities = detectS3000LEntities(loadSchema());
  const ir = buildIr();

  const synthetic = [...ir.entities.keys()]
    .filter((entityName) => !directEntities.has(entityName))
    .sort();

  assert.equal(directEntities.size, 187);
  assert.equal(ir.entities.size, 193);
  assert.deepEqual(synthetic, [
    'DecisionTreeTemplateRevisionDecisionTreeTemplateActionDefinitionNonAbstractClasses',
    'InServiceOptimizationAnalysisRevisionInServiceOptimizationAnalysisStepNonAbstractClasses',
    'LogicalANDEvaluationCriteriaNonAbstractClasses',
    'LogicalOREvaluationCriteriaNonAbstractClasses',
    'LogicalXOREvaluationCriteriaNonAbstractClasses',
    'TaskRevisionSubtaskNonAbstractClasses',
  ]);
});

test('IR gives repeating real-entity relationships parent FK metadata', () => {
  const ir = buildIr();

  const productRel = ir.entities.get('product').relations
    .find((r) => r.fieldName === 'prodVar');
  const productVariant = ir.entities.get('productVariant');
  assert.equal(productRel.kind, 'one-to-many');
  assert.equal(productRel.targetEntity, 'productVariant');
  assert.equal(productRel.parentColumn, 'product_prod_var_parent_id');
  assert.equal(
    productVariant.columns.find((c) => c.columnName === productRel.parentColumn).referencesEntity,
    'product',
  );

  const taskRel = ir.entities.get('operationalTask').relations
    .find((r) => r.fieldName === 'taskRev');
  const taskRevision = ir.entities.get('taskRevision');
  assert.equal(taskRel.parentColumn, 'operational_task_task_rev_parent_id');
  assert.equal(
    taskRevision.columns.find((c) => c.columnName === taskRel.parentColumn).referencesEntity,
    'operationalTask',
  );
});

test('generated S3000L database identifiers fit MariaDB limits', () => {
  const ir = buildIr();
  const identifiers = [];

  for (const entity of ir.entities.values()) {
    identifiers.push(entity.tableName);
    for (const col of entity.columns) identifiers.push(col.columnName);
  }
  for (const enumDef of ir.enums.values()) identifiers.push(enumDef.tableName);
  for (const jt of ir.joinTables.values()) {
    identifiers.push(jt.tableName, jt.leftColumn, jt.rightColumn);
  }

  const sql = generateSQL(ir);
  for (const match of sql.matchAll(/`([^`]+)`/g)) identifiers.push(match[1]);

  const tooLong = identifiers.filter((name) => name.length > 64);
  assert.deepEqual(tooLong, []);
});

test('generated S3000L DDL includes uid, crud, and JSON column contracts', () => {
  const ir = buildIr();
  const product = ir.entities.get('product');
  const uid = product.columns.find((c) => c.columnName === 'uid');
  const crud = product.columns.find((c) => c.columnName === 'crud');
  const prodId = product.columns.find((c) => c.columnName === 'prod_id');

  assert.equal(uid.sqlType, 'VARCHAR(255)');
  assert.equal(uid.nullable, false);
  assert.equal(crud.nullable, false);
  assert.equal(crud.defaultValue, 'I');
  assert.equal(prodId.sqlType, 'LONGTEXT');

  const sql = generateSQL(ir);
  assert.match(sql, /`uid`\s+VARCHAR\(255\)\s+NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS `idx_product_uid` ON `product` \(`uid`\);/);
  assert.match(sql, /`crud`\s+VARCHAR\(64\)\s+NOT NULL DEFAULT 'I' CHECK \(`crud` IN \('I', 'D', 'U', 'R', 'N'\)\)/);
  assert.match(sql, /`prod_id`\s+LONGTEXT NOT NULL(?: COMMENT '[^']*')? CHECK \(JSON_VALID\(`prod_id`\)\)/);
});

test('IR preserves original XML field names separately from DB column names', () => {
  const ir = buildIr();
  const entity = ir.entities.get('maintenanceFacility');
  const col = entity.columns.find((c) => c.columnName === 'infr_str_compls');

  assert.equal(col.name, 'InfrStrCompls');
  assert.equal(col.xmlName, 'InfrStrCompls');
  assert.equal(col.xmlKind, 'element');
  assert.equal(col.columnName, 'infr_str_compls');
});

test('serializer writes primary product rows under lsaPrimaryData.products.prod', async () => {
  const ir = buildIr();
  const serializer = new XMLSerializer(ir, fakeDb({
    product: [{
      id: 1,
      uid: 'P1',
      crud: 'I',
      prod_id: JSON.stringify({ id: 'P1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
  }));

  const xml = await serializer.serialize({ msgId: 'MSG-PRODUCT' });
  const parsed = parseXml(xml);
  const lsaData = parsed.lsaDataset.logisticsSupportAnalysisData;

  assert.ok(lsaData.lsaPrimaryData.products.prod);
  assert.equal(lsaData.lsaPrimaryData.products.prod['@_uid'], 'P1');
  assert.equal(lsaData.lsaSupportingData, undefined);
});

test('serializer uses S3000L record names for task requirement and task variants', async () => {
  const ir = buildIr();
  const serializer = new XMLSerializer(ir, fakeDb({
    taskRequirement: [{
      id: 2,
      uid: 'TR1',
      crud: 'I',
      tr_id: JSON.stringify({ id: 'TR1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
    operationalTask: [{
      id: 3,
      uid: 'OT1',
      crud: 'I',
      task_id: JSON.stringify({ id: 'OT1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
  }));

  const xml = await serializer.serialize({ msgId: 'MSG-TASKS' });
  const parsed = parseXml(xml);
  const primary = parsed.lsaDataset.logisticsSupportAnalysisData.lsaPrimaryData;

  assert.ok(primary.taskRequirements.taskReq);
  assert.equal(primary.taskRequirements.taskReq['@_uid'], 'TR1');
  assert.ok(primary.tasks.opTask);
  assert.equal(primary.tasks.opTask['@_uid'], 'OT1');
});

test('serializer uses original XML field names, not DB-derived camelCase names', async () => {
  const ir = buildIr();
  const serializer = new XMLSerializer(ir, fakeDb({
    maintenanceFacility: [{
      id: 4,
      uid: 'fclty1',
      crud: 'I',
      infr_str_compls: JSON.stringify({ customFlag: 'Y' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
  }));

  const xml = await serializer.serialize({ msgId: 'MSG-FACILITY' });
  const parsed = parseXml(xml);
  const facilities = parsed.lsaDataset.logisticsSupportAnalysisData.lsaSupportingData.facilities;

  assert.equal(facilities.maintFclty['@_uid'], 'fclty1');
  assert.deepEqual(facilities.maintFclty.InfrStrCompls, { customFlag: 'Y' });
  assert.equal(facilities.maintFclty.infrStrCompls, undefined);
});

test('deserializer reads S3000L collection record names into the right entity batches', () => {
  const ir = buildIr();
  const xml = s3000lEnvelope({
    primary: [
      '<products><prod uid="P1" crud="I"><prodId><id>P1</id></prodId></prod></products>',
      '<tasks><opTask uid="OT1" crud="I"><taskId><id>OT1</id></taskId></opTask></tasks>',
    ].join(''),
  });

  const { batches } = deserializeXML(xml, ir);

  assert.equal(batches.get('product').insert[0].uid, 'P1');
  assert.equal(batches.get('operationalTask').insert[0].uid, 'OT1');
});

test('deserializer uses original XML field names for case-sensitive elements', () => {
  const ir = buildIr();
  const xml = s3000lEnvelope({
    supporting: [
      '<facilities><maintFclty uid="fclty1" crud="I">',
      '<InfrStrCompls><customFlag>Y</customFlag></InfrStrCompls>',
      '</maintFclty></facilities>',
    ].join(''),
  });

  const { batches } = deserializeXML(xml, ir);
  const row = batches.get('maintenanceFacility').insert[0];

  assert.equal(row.uid, 'fclty1');
  assert.deepEqual(JSON.parse(row.infr_str_compls), { customFlag: 'Y' });
});

test('deserializer flattens nested relationship records with parent markers', () => {
  const ir = buildIr();
  const xml = relationshipHeavyPrimaryXml();

  const { batches } = deserializeXML(xml, ir);

  assert.equal(batches.get('product').insert.length, 1);
  assert.equal(batches.get('productVariant').insert.length, 2);
  assert.deepEqual(batches.get('productVariant').insert[0]._xmlParent, {
    entityName: 'product',
    uid: 'prod1',
    fkColumn: 'product_prod_var_parent_id',
  });

  assert.equal(batches.get('operationalTask').insert.length, 1);
  assert.equal(batches.get('taskRevision').insert.length, 1);
  assert.deepEqual(batches.get('taskRevision').insert[0]._xmlParent, {
    entityName: 'operationalTask',
    uid: 'task1',
    fkColumn: 'operational_task_task_rev_parent_id',
  });
  assert.equal(batches.get('taskJustification').insert.length, 1);
  assert.deepEqual(batches.get('taskJustification').insert[0]._xmlParent, {
    entityName: 'taskRevision',
    uid: 'taskrev1',
    fkColumn: 'task_revision_task_just_parent_id',
  });

  assert.equal(batches.get('TaskRevisionSubtaskNonAbstractClasses').insert.length, 1);
  assert.deepEqual(batches.get('TaskRevisionSubtaskNonAbstractClasses').insert[0]._xmlParent, {
    entityName: 'taskRevision',
    uid: 'taskrev1',
    fkColumn: 'task_revision_id',
  });
  assert.equal(
    batches.get('TaskRevisionSubtaskNonAbstractClasses').insert[0].choice_type,
    'subtByDef',
  );
  assert.deepEqual(
    batches.get('TaskRevisionSubtaskNonAbstractClasses').insert[0]._xmlRelations,
    [{ entityName: 'subtaskByDefinition', uid: 'subt1', fkColumn: 'subt_by_def_id' }],
  );
  assert.equal(batches.get('subtaskByDefinition').insert.length, 1);
  assert.equal(batches.get('subtaskByDefinition').insert[0].uid, 'subt1');
  assert.deepEqual(JSON.parse(batches.get('subtaskByDefinition').insert[0].subt_id), {
    id: 'SUBT-1',
  });
});

test('deserializer rejects nested relationship records when parent uid is missing', () => {
  const ir = buildIr();

  assert.throws(
    () => deserializeXML(relationshipMissingParentUidXml(), ir),
    /Cannot persist nested prodVar records for product: parent record has no uid/,
  );
});

test('deserializer rejects flattened relationship branch records without child uid', () => {
  const ir = buildIr();

  assert.throws(
    () => deserializeXML(relationshipMissingChoiceBranchUidXml(), ir),
    /Cannot persist nested TaskRevisionSubtaskNonAbstractClasses\.subtByDef: child record has no uid/,
  );
});

test('deserializer rejects unsupported flattened relationship branch shapes', () => {
  const ir = buildIr();

  assert.throws(
    () => deserializeXML(relationshipUnsupportedChoiceBranchXml(), ir),
    /Unsupported XML relation shape for taskRevision\.subtByDef: expected object record, got string/,
  );
});

test('serializer reconstructs nested relationship records from parent FK columns', async () => {
  const ir = buildIr();
  const serializer = new XMLSerializer(ir, fakeDb({
    product: [{
      id: 1,
      uid: 'prod1',
      crud: 'I',
      prod_id: JSON.stringify({ id: 'PROD-1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
    productVariant: [
      {
        id: 10,
        product_prod_var_parent_id: 1,
        uid: 'prodv1',
        crud: 'I',
        prod_var_id: JSON.stringify({ id: 'PV-1' }),
        _created_at: '2026-06-13T08:00:00.000Z',
        _updated_at: '2026-06-13T08:00:00.000Z',
        _deleted_at: null,
        _msg_seq: 0,
      },
      {
        id: 11,
        product_prod_var_parent_id: 1,
        uid: 'prodv2',
        crud: 'I',
        prod_var_id: JSON.stringify({ id: 'PV-2' }),
        _created_at: '2026-06-13T08:00:00.000Z',
        _updated_at: '2026-06-13T08:00:00.000Z',
        _deleted_at: null,
        _msg_seq: 0,
      },
    ],
    operationalTask: [{
      id: 2,
      uid: 'task1',
      crud: 'I',
      task_id: JSON.stringify({ id: 'TASK-1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
    taskRevision: [{
      id: 20,
      operational_task_task_rev_parent_id: 2,
      uid: 'taskrev1',
      crud: 'I',
      rev_id: JSON.stringify({ id: 'REV-1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
    taskJustification: [{
      id: 30,
      task_revision_task_just_parent_id: 20,
      uid: 'taskjust1',
      crud: 'I',
      tr_rev_ref: JSON.stringify({ '@_uidRef': 'trrev1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
    TaskRevisionSubtaskNonAbstractClasses: [{
      id: 40,
      task_revision_id: 20,
      subt_by_def_id: 50,
      choice_type: 'subtByDef',
    }],
    subtaskByDefinition: [{
      id: 50,
      uid: 'subt1',
      crud: 'I',
      subt_id: JSON.stringify({ id: 'SUBT-1' }),
      _created_at: '2026-06-13T08:00:00.000Z',
      _updated_at: '2026-06-13T08:00:00.000Z',
      _deleted_at: null,
      _msg_seq: 0,
    }],
  }));

  const xml = await serializer.serialize({ msgId: 'MSG-REL-OUT' });
  const parsed = parseXml(xml);
  const primary = parsed.lsaDataset.logisticsSupportAnalysisData.lsaPrimaryData;

  const product = primary.products.prod;
  const variants = asArray(product.prodVar);
  assert.equal(variants.length, 2);
  assert.equal(variants[0]['@_uid'], 'prodv1');
  assert.deepEqual(variants[0].prodVarId, { id: 'PV-1' });
  assert.equal(variants[1]['@_uid'], 'prodv2');
  assert.deepEqual(variants[1].prodVarId, { id: 'PV-2' });

  const taskRev = primary.tasks.opTask.taskRev;
  assert.equal(taskRev['@_uid'], 'taskrev1');
  assert.deepEqual(taskRev.revId, { id: 'REV-1' });
  assert.equal(taskRev.subtaskNonAbstractClasses, undefined);
  assert.equal(taskRev.subtByDef['@_uid'], 'subt1');
  assert.deepEqual(taskRev.subtByDef.subtId, { id: 'SUBT-1' });
  assert.equal(taskRev.taskJust['@_uid'], 'taskjust1');
  assert.deepEqual(taskRev.taskJust.trRevRef, { '@_uidRef': 'trrev1' });
});
