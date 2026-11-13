const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const knexFactory = require('knex');

const { DBAdapter } = require('../src/db-adapter');

const skip = sqliteSkipReason();

function sqliteSkipReason() {
  try {
    require.resolve('better-sqlite3');
    return false;
  } catch {
    return 'Install the optional better-sqlite3 dependency to run import-hook transaction tests';
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t) {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  t.after(() => knex.destroy());
  const entities = new Map();
  for (const [name, tableName] of [
    ['product', 'product'], ['branch', 'branch'], ['helperChild', 'helper_child'],
  ]) {
    const lifecycle = name !== 'helperChild';
    await knex.schema.createTable(tableName, (table) => {
      table.increments('id');
      table.string('uid').notNullable().unique();
      table.string('name');
      table.text('payload');
      table.integer('product_parent_id');
      table.integer('branch_id');
      if (lifecycle) {
        table.integer('_msg_seq').notNullable().defaultTo(0);
        table.timestamp('_deleted_at');
      }
    });
    const columns = ['id', 'uid', 'name', 'payload', 'product_parent_id', 'branch_id'];
    if (lifecycle) columns.push('_msg_seq', '_deleted_at');
    entities.set(name, {
      tableName,
      columns: columns.map((columnName) => ({ columnName, nullable: columnName !== 'uid' })),
    });
  }
  await knex.schema.createTable('import_history', (table) => {
    table.increments('id');
    table.string('message');
  });
  return { knex, db: new DBAdapter(knex, { entities }) };
}

test('persistMessage awaits both hooks and resolves relations before afterImport', { skip, timeout: 5000 }, async (t) => {
  const { knex, db } = await setup(t);
  const beforeEntered = deferred();
  const releaseBefore = deferred();
  const afterEntered = deferred();
  const releaseAfter = deferred();
  const msgMeta = { msgId: 'MSG-HOOKS' };
  let importTrx;
  let committed = false;
  const batches = new Map([
    ['product', { insert: [{ uid: 'P1' }], update: [], delete: [] }],
    ['helperChild', {
      insert: [{
        uid: 'H1',
        _xmlParent: { entityName: 'product', uid: 'P1', fkColumn: 'product_parent_id' },
        _xmlRelations: [{ entityName: 'branch', uid: 'B1', fkColumn: 'branch_id' }],
      }],
      update: [],
      delete: [],
    }],
    ['branch', { insert: [{ uid: 'B1' }], update: [], delete: [] }],
  ]);
  const importing = db.persistMessage(batches, msgMeta, {
    beforeImport: async ({ trx, msgMeta: meta }) => {
      assert.equal(meta, msgMeta);
      importTrx = trx;
      beforeEntered.resolve();
      await releaseBefore.promise;
    },
    afterImport: async ({ trx, msgMeta: meta, changes }) => {
      assert.equal(trx, importTrx);
      assert.equal(meta, msgMeta);
      assert.deepEqual(changes, [
        { entityName: 'product', id: 1, previousRow: null },
        { entityName: 'helperChild', id: 1, previousRow: null },
        { entityName: 'branch', id: 1, previousRow: null },
      ]);
      const row = await trx('helper_child').where('id', 1).first();
      assert.equal(row.product_parent_id, 1);
      assert.equal(row.branch_id, 1);
      afterEntered.resolve();
      await releaseAfter.promise;
      await trx('import_history').insert({ message: meta.msgId });
    },
  }).then((stats) => {
    committed = true;
    return stats;
  });

  try {
    await beforeEntered.promise;
    await nextTurn();
    assert.deepEqual(await importTrx('product').select('*'), []);
    assert.equal(committed, false);
    releaseBefore.resolve();
    await afterEntered.promise;
    await nextTurn();
    assert.equal(committed, false);
    releaseAfter.resolve();
    assert.deepEqual(await importing, { inserted: 3, updated: 0, deleted: 0 });
    assert.deepEqual(await knex('import_history').select('message'), [{ message: msgMeta.msgId }]);
  } finally {
    releaseBefore.resolve();
    releaseAfter.resolve();
    await importing;
  }
});

test('persistMessage retains the first snapshot across repeated writes and omits missing targets', { skip }, async (t) => {
  const { knex, db } = await setup(t);
  const original = await db.insert('product', { uid: 'P1', name: 'original', payload: '{"remark":"old"}' });
  const deleted = await db.insert('product', { uid: 'P2', name: 'delete only' });
  const untouched = await db.insert('product', { uid: 'P3', name: 'untouched' });
  await db.insert('product', { uid: 'P4', name: 'already deleted' });
  await db.softDelete('product', 'P4');
  await db.insert('helperChild', { uid: 'H1' });
  let calls = 0;
  const stats = await db.persistMessage(new Map([
    ['product', {
      insert: [{ uid: 'NEW', name: 'new' }],
      update: [
        { _xmlUid: 'P1', name: 'intermediate' },
        { _xmlUid: 'P1', name: 'final', payload: '{"remark":"new"}' },
        { _xmlUid: 'NEW', name: 'new edited' },
        { _xmlUid: 'MISSING', name: 'unmatched' },
        { _xmlUid: 'P4', name: 'must stay deleted' },
      ],
      delete: ['P1', 'NEW', 'P2', 'MISSING', 'P4'],
    }],
    ['helperChild', { insert: [], update: [], delete: ['H1'] }],
    ['branch', { insert: [{ uid: 'B1' }], update: [], delete: [] }],
  ]), {}, {
    afterImport: async ({ trx, changes }) => {
      calls++;
      assert.equal(changes.length, 4);
      assert.deepEqual(changes, [
        { entityName: 'product', id: 5, previousRow: null },
        { entityName: 'product', id: original.id, previousRow: original },
        { entityName: 'product', id: deleted.id, previousRow: deleted },
        { entityName: 'branch', id: 1, previousRow: null },
      ]);
      const final = await trx('product').where('id', original.id).first();
      assert.equal(final.name, 'final');
      assert.equal(final.payload, '{"remark":"new"}');
      assert.notEqual(final._deleted_at, null);
      const created = await trx('product').where('uid', 'NEW').first();
      assert.equal(created.name, 'new edited');
      assert.notEqual(created._deleted_at, null);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(stats, { inserted: 2, updated: 5, deleted: 6 });
  assert.deepEqual(await knex('product').where('uid', 'P3').first(), untouched);
  assert.equal((await knex('product').where('uid', 'P4').first()).name, 'already deleted');
  assert.equal((await knex('helper_child').select('*')).length, 1);
});

for (const failingHook of ['beforeImport', 'afterImport']) {
  test(`persistMessage rolls back data and history when ${failingHook} rejects`, { skip }, async (t) => {
    const { knex, db } = await setup(t);
    await db.insert('product', { uid: 'P1', name: 'before' });
    await db.insert('product', { uid: 'P2', name: 'keep' });
    const original = await knex('product').orderBy('id');
    const failure = new Error(`${failingHook} failed`);
    let afterCalled = false;

    await assert.rejects(db.persistMessage(new Map([
      ['product', {
        insert: [{ uid: 'NEW' }],
        update: [{ _xmlUid: 'P1', name: 'changed' }],
        delete: ['P2'],
      }],
    ]), {}, {
      beforeImport: async ({ trx }) => {
        await trx('import_history').insert({ message: 'before' });
        if (failingHook === 'beforeImport') {
          await nextTurn();
          throw failure;
        }
      },
      afterImport: async ({ trx }) => {
        afterCalled = true;
        assert.equal((await trx('product').where('uid', 'P1').first()).name, 'changed');
        assert.notEqual((await trx('product').where('uid', 'P2').first())._deleted_at, null);
        assert.ok(await trx('product').where('uid', 'NEW').first());
        await trx('import_history').insert({ message: 'after' });
        await nextTurn();
        throw failure;
      },
    }), (error) => error === failure);

    assert.equal(afterCalled, failingHook === 'afterImport');
    assert.deepEqual(await knex('product').orderBy('id'), original);
    assert.deepEqual(await knex('import_history').select('*'), []);
  });
}

test('persistMessage skips afterImport and rolls back when relation resolution fails', { skip }, async (t) => {
  const { knex, db } = await setup(t);
  let afterCalled = false;
  await assert.rejects(db.persistMessage(new Map([
    ['product', {
      insert: [{
        uid: 'P1',
        _xmlRelations: [{ entityName: 'branch', uid: 'MISSING', fkColumn: 'branch_id' }],
      }],
      update: [],
      delete: [],
    }],
  ]), {}, {
    beforeImport: async ({ trx }) => {
      await trx('import_history').insert({ message: 'before' });
    },
    afterImport: async () => { afterCalled = true; },
  }), /Cannot resolve relation FK product\.branch_id: branch uid "MISSING" was not found/);
  assert.equal(afterCalled, false);
  assert.deepEqual(await knex('product').select('*'), []);
  assert.deepEqual(await knex('import_history').select('*'), []);
});

test('persistMessage runs hooks for an empty import', { skip }, async (t) => {
  const { knex, db } = await setup(t);
  const stats = await db.persistMessage(new Map(), {}, {
    afterImport: async ({ trx, changes }) => {
      assert.deepEqual(changes, []);
      await nextTurn();
      await trx('import_history').insert({ message: 'empty import' });
    },
  });
  assert.deepEqual(stats, { inserted: 0, updated: 0, deleted: 0 });
  assert.deepEqual(await knex('import_history').select('message'), [{ message: 'empty import' }]);
});
