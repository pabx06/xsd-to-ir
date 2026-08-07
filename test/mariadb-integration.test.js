const test = require('node:test');
const assert = require('node:assert/strict');

const knexFactory = require('knex');
const { XMLParser } = require('fast-xml-parser');

const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { generateSQL } = require('../src/sql-generator');
const { DBAdapter } = require('../src/db-adapter');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');
const { relationshipHeavyRoundTripXml } = require('./helpers/s3000l-fixtures');

const skipReason = _mariadbSkipReason();
let cachedIr = null;
let cachedDDL = null;

function _mariadbSkipReason() {
  if (!process.env.MARIADB_TEST_URL) {
    return 'Set MARIADB_TEST_URL to run MariaDB integration tests';
  }
  try {
    require.resolve('mysql2');
  } catch {
    return 'mysql2 is not installed';
  }
  return false;
}

function _connectionFromURL(urlString) {
  const url = new URL(urlString);
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new Error('MARIADB_TEST_URL must include a database name');

  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database,
  };
}

function _makeKnex() {
  return knexFactory({
    client: 'mysql2',
    connection: _connectionFromURL(process.env.MARIADB_TEST_URL),
    pool: { min: 0, max: 2 },
  });
}

function _s3000lIr() {
  if (!cachedIr) {
    cachedIr = new IRBuilder(parseXSD('s3000l/2_0/s3000l_2-0_lsaDataset.xsd')).build();
  }
  return cachedIr;
}

function _s3000lDDL() {
  if (!cachedDDL) {
    cachedDDL = generateSQL(_s3000lIr());
  }
  return cachedDDL;
}

function _parseXml(xml) {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
  }).parse(xml);
}

function _asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function _resetDatabase(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  const [rows] = await knex.raw(
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  for (const row of rows) {
    await knex.raw('DROP TABLE IF EXISTS ??', [row.name]);
  }
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}

async function _tableCount(knex) {
  const [rows] = await knex.raw(
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  return Number(rows[0].n);
}

function _productIr() {
  return {
    entities: new Map([
      ['product', {
        name: 'product',
        tableName: 'it_product',
        columns: [
          {
            name: 'id', columnName: 'id', sqlType: 'BIGINT', jsonType: 'integer',
            nullable: false, isPrimaryKey: true, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: 'uid', columnName: 'uid', sqlType: 'VARCHAR(255)', jsonType: 'string',
            nullable: false, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: 'name', columnName: 'name', sqlType: 'VARCHAR(255)', jsonType: 'string',
            nullable: true, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: 'payload', columnName: 'payload', sqlType: 'LONGTEXT', jsonType: 'object',
            nullable: true, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: '_createdAt', columnName: '_created_at', sqlType: 'DATETIME(3)', jsonType: 'string',
            nullable: false, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: '_updatedAt', columnName: '_updated_at', sqlType: 'DATETIME(3)', jsonType: 'string',
            nullable: false, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: '_deletedAt', columnName: '_deleted_at', sqlType: 'DATETIME(3)', jsonType: 'string',
            nullable: true, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
          {
            name: '_msgSeq', columnName: '_msg_seq', sqlType: 'BIGINT', jsonType: 'integer',
            nullable: false, isPrimaryKey: false, isForeignKey: false,
            referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
          },
        ],
        relations: [],
      }],
    ]),
    joinTables: new Map(),
    enums: new Map(),
    simpleTypes: new Map(),
  };
}

test('generated S3000L DDL applies and can be replayed on MariaDB', { skip: skipReason }, async (t) => {
  const knex = _makeKnex();
  t.after(async () => knex.destroy());

  await _resetDatabase(knex);

  const ir = _s3000lIr();
  const ddl = _s3000lDDL();
  const db = new DBAdapter(knex, ir);

  await db.applyDDL(ddl);
  assert.equal(await _tableCount(knex), ir.entities.size + ir.enums.size + ir.joinTables.size);

  const productExists = await knex.schema.hasTable('product');
  assert.equal(productExists, true);

  await db.applyDDL(ddl);
  assert.equal(await _tableCount(knex), ir.entities.size + ir.enums.size + ir.joinTables.size);
});

test('generated S3000L DDL enforces uid, crud, and JSON contracts on MariaDB', { skip: skipReason }, async (t) => {
  const knex = _makeKnex();
  t.after(async () => knex.destroy());

  await _resetDatabase(knex);

  const ir = _s3000lIr();
  const db = new DBAdapter(knex, ir);
  await db.applyDDL(_s3000lDDL());

  await knex('product').insert({
    uid: 'prod-contract-1',
    prod_id: JSON.stringify({ id: 'PROD-CONTRACT-1' }),
  });

  const [inserted] = await knex('product')
    .where('uid', 'prod-contract-1')
    .select('uid', 'crud', 'prod_id');
  assert.equal(inserted.uid, 'prod-contract-1');
  assert.equal(inserted.crud, 'I');
  assert.deepEqual(JSON.parse(inserted.prod_id), { id: 'PROD-CONTRACT-1' });

  await assert.rejects(
    () => knex('product').insert({
      uid: 'prod-contract-1',
      prod_id: JSON.stringify({ id: 'DUPLICATE' }),
    }),
    /Duplicate|ER_DUP_ENTRY|unique/i,
  );

  await assert.rejects(
    () => knex('product').insert({
      prod_id: JSON.stringify({ id: 'MISSING-UID' }),
    }),
    /uid|not null|ER_NO_DEFAULT/i,
  );

  await assert.rejects(
    () => knex('product').insert({
      uid: 'prod-contract-invalid-crud',
      crud: 'X',
      prod_id: JSON.stringify({ id: 'BAD-CRUD' }),
    }),
    /CONSTRAINT|check|crud/i,
  );

  await assert.rejects(
    () => knex('product').insert({
      uid: 'prod-contract-invalid-json',
      prod_id: 'not-json',
    }),
    /CONSTRAINT|check|JSON_VALID|prod_id/i,
  );
});

test('DBAdapter lifecycle works through mysql2 against MariaDB', { skip: skipReason }, async (t) => {
  const knex = _makeKnex();
  t.after(async () => knex.destroy());

  await _resetDatabase(knex);

  const ir = _productIr();
  const db = new DBAdapter(knex, ir);
  await db.applyDDL(generateSQL(ir));

  const inserted = await db.insert('product', {
    uid: 'P1',
    name: 'before',
    payload: JSON.stringify({ nested: true }),
  });

  assert.equal(inserted.uid, 'P1');
  assert.equal(Number(inserted._msg_seq), 0);

  await db.markExported(['product'], 5);
  assert.deepEqual(await db.queryEntity('product', { since: 5 }), []);
  assert.equal(await db.currentMaxSeq(), 5);

  await db.update('product', 'P1', { name: 'after' });
  const dirty = await db.queryEntity('product', { since: 5 });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].name, 'after');
  assert.equal(Number(dirty[0]._msg_seq), 0);

  await db.softDelete('product', 'P1');
  assert.deepEqual(await db.queryEntity('product', { since: 5 }), []);

  const deleted = await db.queryDeleted('product', 5);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].uid, 'P1');

  await db.markExported(['product'], 6);
  assert.deepEqual(await db.queryDeleted('product', 5), []);
  assert.equal(await db.currentMaxSeq(), 6);
});

test('S3000L XML fixture round-trips through MariaDB', { skip: skipReason }, async (t) => {
  const knex = _makeKnex();
  t.after(async () => knex.destroy());

  await _resetDatabase(knex);

  const ir = _s3000lIr();
  const db = new DBAdapter(knex, ir);
  await db.applyDDL(_s3000lDDL());

  const inputXml = relationshipHeavyRoundTripXml('MSG-ROUNDTRIP-IN');

  const { msgMeta, batches } = deserializeXML(inputXml, ir);
  assert.equal(msgMeta.msgId, 'MSG-ROUNDTRIP-IN');

  const stats = await db.persistMessage(batches, msgMeta);
  assert.deepEqual(stats, { inserted: 9, updated: 0, deleted: 0 });

  const [productRow] = await db.queryEntity('product');
  assert.equal(productRow.uid, 'prod1');
  assert.deepEqual(JSON.parse(productRow.prod_id), { id: 'PROD-1' });
  assert.deepEqual(JSON.parse(productRow.prod_name), { name: 'Round Trip Product' });

  const [variantRow] = await db.queryEntity('productVariant');
  assert.equal(variantRow.uid, 'prodv1');
  assert.equal(Number(variantRow.product_prod_var_parent_id), Number(productRow.id));
  assert.deepEqual(JSON.parse(variantRow.prod_var_id), { id: 'PV-1' });

  const [taskRow] = await db.queryEntity('operationalTask');
  assert.equal(taskRow.uid, 'task1');
  assert.deepEqual(JSON.parse(taskRow.task_id), { id: 'TASK-1' });

  const [taskRevisionRow] = await db.queryEntity('taskRevision');
  assert.equal(taskRevisionRow.uid, 'taskrev1');
  assert.equal(Number(taskRevisionRow.operational_task_task_rev_parent_id), Number(taskRow.id));
  assert.deepEqual(JSON.parse(taskRevisionRow.rev_id), { id: 'REV-1' });

  const [taskJustificationRow] = await db.queryEntity('taskJustification');
  assert.equal(taskJustificationRow.uid, 'taskjust1');
  assert.equal(Number(taskJustificationRow.task_revision_task_just_parent_id), Number(taskRevisionRow.id));
  assert.deepEqual(JSON.parse(taskJustificationRow.tr_rev_ref), { '@_uidRef': 'trrev1' });

  const [subtaskRow] = await db.queryEntity('subtaskByDefinition');
  assert.equal(subtaskRow.uid, 'subt1');
  assert.deepEqual(JSON.parse(subtaskRow.subt_id), { id: 'SUBT-1' });

  const [subtaskHelperRow] = await db.queryEntity('TaskRevisionSubtaskNonAbstractClasses');
  assert.equal(Number(subtaskHelperRow.task_revision_id), Number(taskRevisionRow.id));
  assert.equal(Number(subtaskHelperRow.subt_by_def_id), Number(subtaskRow.id));
  assert.equal(subtaskHelperRow.choice_type, 'subtByDef');

  const [facilityRow] = await db.queryEntity('maintenanceFacility');
  assert.equal(facilityRow.uid, 'fclty1');
  assert.deepEqual(JSON.parse(facilityRow.fclty_id), { id: 'FCLTY-1' });
  assert.deepEqual(JSON.parse(facilityRow.infr_str_compls), { customFlag: 'Y' });

  const [facilityRelationshipRow] = await db.queryEntity('facilityRelationship');
  assert.equal(facilityRelationshipRow.uid, 'fcltyrel1');
  assert.equal(
    Number(facilityRelationshipRow.maintenance_facility_fclty_rel_parent_id),
    Number(facilityRow.id),
  );
  assert.deepEqual(JSON.parse(facilityRelationshipRow.facility_ref), { '@_uidRef': 'fclty2' });

  const outputXml = await new XMLSerializer(ir, db).serialize({
    msgId: 'MSG-ROUNDTRIP-OUT',
    msgType: 'B',
    msgStatus: 'F',
  });
  const parsed = _parseXml(outputXml);
  const data = parsed.lsaDataset.logisticsSupportAnalysisData;

  assert.equal(parsed.lsaDataset.msgId, 'MSG-ROUNDTRIP-OUT');
  assert.equal(data.lsaPrimaryData.products.prod['@_uid'], 'prod1');
  assert.deepEqual(data.lsaPrimaryData.products.prod.prodId, { id: 'PROD-1' });
  assert.deepEqual(data.lsaPrimaryData.products.prod.prodName, { name: 'Round Trip Product' });
  const variants = _asArray(data.lsaPrimaryData.products.prod.prodVar);
  assert.equal(variants.length, 1);
  assert.equal(variants[0]['@_uid'], 'prodv1');
  assert.deepEqual(variants[0].prodVarId, { id: 'PV-1' });

  const taskRev = data.lsaPrimaryData.tasks.opTask.taskRev;
  assert.equal(data.lsaPrimaryData.tasks.opTask['@_uid'], 'task1');
  assert.equal(taskRev['@_uid'], 'taskrev1');
  assert.deepEqual(taskRev.revId, { id: 'REV-1' });
  assert.equal(taskRev.subtaskNonAbstractClasses, undefined);
  assert.equal(taskRev.subtByDef['@_uid'], 'subt1');
  assert.deepEqual(taskRev.subtByDef.subtId, { id: 'SUBT-1' });
  assert.equal(taskRev.taskJust['@_uid'], 'taskjust1');
  assert.deepEqual(taskRev.taskJust.trRevRef, { '@_uidRef': 'trrev1' });

  const maintFclty = data.lsaSupportingData.facilities.maintFclty;
  assert.equal(maintFclty['@_uid'], 'fclty1');
  assert.deepEqual(maintFclty.fcltyId, { id: 'FCLTY-1' });
  assert.equal(maintFclty.fcltyRel['@_uid'], 'fcltyrel1');
  assert.deepEqual(maintFclty.fcltyRel.facilityRef, { '@_uidRef': 'fclty2' });
  assert.deepEqual(maintFclty.InfrStrCompls, { customFlag: 'Y' });
  assert.equal(maintFclty.infrStrCompls, undefined);
});
