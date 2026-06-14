const test = require('node:test');
const assert = require('node:assert/strict');

const { DBAdapter } = require('../src/db-adapter');

function makeFakeKnex(seed = {}) {
  const tables = seed;
  const ids = new Map();

  function nextId(table) {
    const next = (ids.get(table) || 0) + 1;
    ids.set(table, next);
    return next;
  }

  function knex(table) {
    if (!tables[table]) tables[table] = [];
    return new Query(tables[table], table);
  }

  knex.transaction = async (fn) => fn(knex);
  knex._tables = tables;

  function Query(rows, table) {
    this.rows = rows;
    this.table = table;
    this.predicates = [];
  }

  Query.prototype.where = function where(column, opOrValue, maybeValue) {
    const hasOperator = maybeValue !== undefined;
    const op = hasOperator ? opOrValue : '=';
    const value = hasOperator ? maybeValue : opOrValue;
    this.predicates.push((row) => {
      if (op === '=') return row[column] === value;
      if (op === '<') return row[column] < value;
      if (op === '>') return row[column] > value;
      throw new Error(`Unsupported fake where operator: ${op}`);
    });
    return this;
  };

  Query.prototype.whereNull = function whereNull(column) {
    this.predicates.push((row) => row[column] === null || row[column] === undefined);
    return this;
  };

  Query.prototype.whereNotNull = function whereNotNull(column) {
    this.predicates.push((row) => row[column] !== null && row[column] !== undefined);
    return this;
  };

  Query.prototype._filtered = function filtered() {
    return this.rows.filter((row) => this.predicates.every((fn) => fn(row)));
  };

  Query.prototype.insert = async function insert(payload) {
    const row = { ...payload };
    if (row.id === undefined || row.id === null) row.id = nextId(this.table);
    this.rows.push(row);
    return [row.id];
  };

  Query.prototype.select = async function select(...columns) {
    const selected = this._filtered();
    if (columns.length === 0 || columns.includes('*')) return selected.map((row) => ({ ...row }));
    return selected.map((row) => Object.fromEntries(columns.map((col) => [col, row[col]])));
  };

  Query.prototype.update = async function update(payload) {
    const selected = this._filtered();
    for (const row of selected) Object.assign(row, payload);
    return selected.length;
  };

  Query.prototype.max = async function max(expr) {
    const [, alias = 'max'] = expr.split(/\s+as\s+/i);
    const col = expr.split(/\s+as\s+/i)[0];
    const m = Math.max(0, ...this.rows.map((row) => Number(row[col] || 0)));
    return [{ [alias]: m }];
  };

  return knex;
}

function productIr() {
  return {
    entities: new Map([
      ['product', {
        tableName: 'product',
        columns: [
          { columnName: 'id' },
          { columnName: 'uid' },
          { columnName: '_deleted_at' },
          { columnName: '_msg_seq' },
        ],
      }],
    ]),
  };
}

function helperIr() {
  return {
    entities: new Map([
      ['product', {
        tableName: 'product',
        columns: [
          { columnName: 'id' },
          { columnName: 'uid' },
          { columnName: '_deleted_at' },
          { columnName: '_msg_seq' },
        ],
      }],
      ['helperChild', {
        tableName: 'helper_child',
        columns: [
          { columnName: 'id' },
          { columnName: 'uid' },
          { columnName: 'product_parent_id' },
          { columnName: 'branch_id' },
          { columnName: 'value' },
        ],
      }],
      ['branch', {
        tableName: 'branch',
        columns: [
          { columnName: 'id' },
          { columnName: 'uid' },
          { columnName: '_deleted_at' },
          { columnName: '_msg_seq' },
        ],
      }],
    ]),
  };
}

test('DBAdapter uses _msg_seq 0 as dirty state for net-change export', async () => {
  const knex = makeFakeKnex();
  const db = new DBAdapter(knex, productIr());

  const inserted = await db.insert('product', { uid: 'P1' });
  assert.equal(inserted.id, 1);
  assert.equal(inserted._msg_seq, 0);

  await db.markExported(['product'], 5);
  assert.equal(knex._tables.product[0]._msg_seq, 5);
  assert.deepEqual(await db.queryEntity('product', { since: 5 }), []);

  await db.update('product', 'P1', { name: 'changed' });
  assert.equal(knex._tables.product[0]._msg_seq, 0);
  assert.equal((await db.queryEntity('product', { since: 5 }))[0].uid, 'P1');

  await db.softDelete('product', 'P1');
  assert.deepEqual(await db.queryEntity('product', { since: 5 }), []);
  assert.equal((await db.queryDeleted('product', 5))[0].uid, 'P1');

  await db.markExported(['product'], 6);
  assert.equal(knex._tables.product[0]._msg_seq, 6);
  assert.deepEqual(await db.queryDeleted('product', 5), []);
});

test('DBAdapter handles related helper tables without lifecycle columns', async () => {
  const knex = makeFakeKnex();
  const db = new DBAdapter(knex, helperIr());

  const batches = new Map([
    ['product', {
      insert: [{ uid: 'P1' }],
      update: [],
      delete: [],
    }],
    ['helperChild', {
      insert: [{
        uid: 'H1',
        value: 'nested',
        _xmlParent: {
          entityName: 'product',
          uid: 'P1',
          fkColumn: 'product_parent_id',
        },
        _xmlRelations: [{
          entityName: 'branch',
          uid: 'B1',
          fkColumn: 'branch_id',
        }],
      }],
      update: [],
      delete: [],
    }],
    ['branch', {
      insert: [{ uid: 'B1' }],
      update: [],
      delete: [],
    }],
  ]);

  const stats = await db.persistMessage(batches, { msgId: 'MSG-HELPER' });
  assert.deepEqual(stats, { inserted: 3, updated: 0, deleted: 0 });
  assert.equal(knex._tables.helper_child[0].product_parent_id, 1);
  assert.equal(knex._tables.helper_child[0].branch_id, 1);
  assert.equal(knex._tables.helper_child[0]._msg_seq, undefined);

  const related = await db.queryRelated('helperChild', 'product_parent_id', 1, { since: 5 });
  assert.equal(related.length, 1);
  assert.equal(related[0].uid, 'H1');
  assert.equal((await db.queryById('branch', 1)).uid, 'B1');

  await db.markExported(['product', 'helperChild'], 7);
  assert.equal(knex._tables.product[0]._msg_seq, 7);
  assert.equal(knex._tables.helper_child[0]._msg_seq, undefined);
  assert.deepEqual(await db.queryDeleted('helperChild', 5), []);
});

test('DBAdapter reports missing nested parent uid before resolving parent FK', async () => {
  const knex = makeFakeKnex();
  const db = new DBAdapter(knex, helperIr());

  const batches = new Map([
    ['helperChild', {
      insert: [{
        uid: 'H1',
        _xmlParent: {
          entityName: 'product',
          uid: null,
          fkColumn: 'product_parent_id',
        },
      }],
      update: [],
      delete: [],
    }],
  ]);

  await assert.rejects(
    () => db.persistMessage(batches, { msgId: 'MSG-MISSING-PARENT-UID' }),
    /Cannot resolve parent FK product_parent_id: parent uid is missing/,
  );
});

test('DBAdapter reports unresolved nested parent uid with FK context', async () => {
  const knex = makeFakeKnex();
  const db = new DBAdapter(knex, helperIr());

  const batches = new Map([
    ['helperChild', {
      insert: [{
        uid: 'H1',
        _xmlParent: {
          entityName: 'product',
          uid: 'MISSING',
          fkColumn: 'product_parent_id',
        },
      }],
      update: [],
      delete: [],
    }],
  ]);

  await assert.rejects(
    () => db.persistMessage(batches, { msgId: 'MSG-MISSING-PARENT' }),
    /Cannot resolve parent FK product_parent_id: product uid "MISSING" was not found/,
  );
});

test('DBAdapter reports unresolved relation uid with entity and FK context', async () => {
  const knex = makeFakeKnex();
  const db = new DBAdapter(knex, helperIr());

  const batches = new Map([
    ['helperChild', {
      insert: [{
        uid: 'H1',
        _xmlRelations: [{
          entityName: 'branch',
          uid: 'MISSING',
          fkColumn: 'branch_id',
        }],
      }],
      update: [],
      delete: [],
    }],
  ]);

  await assert.rejects(
    () => db.persistMessage(batches, { msgId: 'MSG-MISSING-RELATION' }),
    /Cannot resolve relation FK helperChild\.branch_id: branch uid "MISSING" was not found/,
  );
});
