/**
 * Regression contracts for REV-019 and REV-020.
 *
 * Run only this suite with:
 *   npm run test:rev-020
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { DBAdapter } = require('../src/db-adapter');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { XMLDeserializer, deserializeXML } = require('../src/xml-deserializer');

const ISSUE_1_XSD = 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd';

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

const EMPTY_COLLECTION_XML = fixture('rev-004-issue-1-valid.xml');
const NIL_MAINT_LEVEL_XML = fixture('rev-019-issue-1-nil-maint-level-valid.xml');
const NIL_MAINT_LEVEL_DELETE_XML = fixture(
  'rev-019-issue-1-nil-maint-level-delete-valid.xml',
);
const NIL_PLANNED_TASK_DELETE_XML = fixture(
  'rev-019-issue-1-nil-planned-task-delete-valid.xml',
);
const UIDLESS_MAINT_LEVEL_XML = fixture('rev-020-issue-1-uidless-maint-level-valid.xml');

let cachedIr = null;

function buildIssue1Ir() {
  if (!cachedIr) cachedIr = new IRBuilder(parseXSD(ISSUE_1_XSD)).build();
  return cachedIr;
}

function processRecords(entityName, records, ir = buildIssue1Ir()) {
  const batches = new Map();
  new XMLDeserializer(ir)._processRecords(entityName, records, batches);
  return batches;
}

test('REV-019: empty mapped collections do not create phantom records', () => {
  const { batches } = deserializeXML(EMPTY_COLLECTION_XML, buildIssue1Ir());

  assert.equal(batches.has('taskRequirement'), false);
});

test('REV-019: an explicitly nil relation does not create a phantom record', () => {
  const { batches } = deserializeXML(NIL_MAINT_LEVEL_XML, buildIssue1Ir());

  assert.equal(batches.has('allocatedMaintenanceLevel'), false);
  assert.equal(batches.get('plannedTaskTarget').insert.length, 1);
});

test('REV-019: a uid-bearing explicitly nil delete remains an operation', () => {
  const { batches } = deserializeXML(NIL_MAINT_LEVEL_DELETE_XML, buildIssue1Ir());

  assert.deepEqual(batches.get('allocatedMaintenanceLevel').delete, ['allmlv1901']);
});

test('REV-019: a flattened nil delete does not create a relation helper', () => {
  const { batches } = deserializeXML(NIL_PLANNED_TASK_DELETE_XML, buildIssue1Ir());

  assert.deepEqual(batches.get('plannedTaskTarget').delete, ['tasktg1903']);
  assert.equal(
    batches.has('HardwarePartAsDesignedTaskTargetNonAbstractClasses'),
    false,
  );
});

test('REV-019: an explicitly nil relation containing data is rejected', () => {
  const malformed = NIL_MAINT_LEVEL_XML.replace(
    '<maintLevel xsi:nil="true"/>',
    '<maintLevel xsi:nil="true"><mlvRef/></maintLevel>',
  );

  assert.throws(
    () => deserializeXML(malformed, buildIssue1Ir()),
    /Invalid nil XML relation plannedTaskTarget\.maintLevel: nil records must not contain element content/,
  );
});

test('REV-020: content-bearing uidless maintLevel fails before persistence', () => {
  assert.throws(
    () => deserializeXML(UIDLESS_MAINT_LEVEL_XML, buildIssue1Ir()),
    {
      name: 'Error',
      message: 'Cannot persist allocatedMaintenanceLevel record with crud="I": '
        + 'uid is required by the generated database model',
    },
  );
});

for (const crud of ['I', 'U', 'D']) {
  test(`REV-020: uidless ${crud} records are rejected before batching`, () => {
    const batches = new Map();
    const deserializer = new XMLDeserializer(buildIssue1Ir());

    assert.throws(
      () => deserializer._processRecords('product', [{ '@_crud': crud }], batches),
      {
        name: 'Error',
        message: `Cannot persist product record with crud="${crud}": `
          + 'uid is required by the generated database model',
      },
    );
    assert.equal(batches.has('product'), false);
  });
}

test('REV-020: uid-bearing insert, update, and delete routing is unchanged', () => {
  const batches = processRecords('product', [
    { '@_uid': 'prod2001', '@_crud': 'I' },
    { '@_uid': 'prod2002', '@_crud': 'U' },
    { '@_uid': 'prod2003', '@_crud': 'D' },
  ]);
  const product = batches.get('product');

  assert.equal(product.insert[0].uid, 'prod2001');
  assert.equal(product.update[0]._xmlUid, 'prod2002');
  assert.deepEqual(product.delete, ['prod2003']);
});

test('REV-020: entities without a required uid retain generic compatibility', () => {
  const genericIr = {
    entities: new Map([['genericRecord', {
      name: 'genericRecord',
      columns: [{
        name: 'value',
        columnName: 'value',
        xmlName: 'value',
        xmlKind: 'element',
        sqlType: 'TEXT',
        nullable: true,
      }],
      relations: [],
    }]]),
    s3000lCollections: new Map(),
  };

  const batches = processRecords('genericRecord', [{ value: 'kept' }], genericIr);
  const uidlessDelete = processRecords('genericRecord', [{ '@_crud': 'D' }], genericIr);

  assert.equal(batches.get('genericRecord').insert[0].value, 'kept');
  assert.equal(uidlessDelete.has('genericRecord'), false);
});

function requiredUidDb() {
  let queryCalls = 0;
  const knex = () => {
    queryCalls += 1;
    throw new Error('database query should not be reached');
  };
  let transactionCalls = 0;
  knex.transaction = async (fn) => {
    transactionCalls += 1;
    return fn(knex);
  };
  const ir = {
    entities: new Map([['allocatedMaintenanceLevel', {
      name: 'allocatedMaintenanceLevel',
      tableName: 'allocated_maintenance_level',
      columns: [{ columnName: 'uid', nullable: false }],
    }]]),
  };
  return {
    db: new DBAdapter(knex, ir),
    queryCalls: () => queryCalls,
    transactionCalls: () => transactionCalls,
  };
}

test('REV-020: DBAdapter rejects a missing required uid before querying', async () => {
  const { db, queryCalls } = requiredUidDb();

  await assert.rejects(
    () => db.insert('allocatedMaintenanceLevel', { uid: null }),
    {
      name: 'Error',
      message: 'Cannot insert allocatedMaintenanceLevel: '
        + 'uid is required by the generated database model',
    },
  );
  assert.equal(queryCalls(), 0);
});

for (const [operation, call] of [
  ['update', (db) => db.update('allocatedMaintenanceLevel', null, {})],
  ['delete', (db) => db.softDelete('allocatedMaintenanceLevel', null)],
]) {
  test(`REV-020: DBAdapter rejects a uidless direct ${operation}`, async () => {
    const { db, queryCalls } = requiredUidDb();

    await assert.rejects(
      () => call(db),
      new RegExp(
        `Cannot ${operation} allocatedMaintenanceLevel: `
        + 'uid is required by the generated database model',
      ),
    );
    assert.equal(queryCalls(), 0);
  });
}

for (const [operation, batch] of [
  ['insert', { insert: [{ uid: null }], update: [], delete: [] }],
  ['update', { insert: [], update: [{ _xmlUid: null }], delete: [] }],
  ['delete', { insert: [], update: [], delete: [null] }],
]) {
  test(`REV-020: message persistence preflights uidless ${operation}s`, async () => {
    const { db, queryCalls, transactionCalls } = requiredUidDb();
    const batches = new Map([['allocatedMaintenanceLevel', batch]]);

    await assert.rejects(
      () => db.persistMessage(batches, { msgId: 'REV-020' }),
      new RegExp(
        `Cannot ${operation} allocatedMaintenanceLevel: `
        + 'uid is required by the generated database model',
      ),
    );
    assert.equal(transactionCalls(), 0);
    assert.equal(queryCalls(), 0);
  });
}
