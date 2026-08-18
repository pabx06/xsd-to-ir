const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { generateSQL } = require('../src/sql-generator');
const { XMLSerializer } = require('../src/xml-serializer');

const ISSUE_1_1_XSD = 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd';

let cachedIssue11Ir = null;

function issue11Ir() {
  if (!cachedIssue11Ir) {
    cachedIssue11Ir = new IRBuilder(parseXSD(ISSUE_1_1_XSD)).build();
  }
  return cachedIssue11Ir;
}

function fakeDb(rowsByEntity) {
  return {
    async queryEntity(entityName) {
      return rowsByEntity[entityName] || [];
    },
  };
}

async function serializePackTasks(values) {
  const rows = values.map((value, index) => ({
    id: index + 1,
    uid: `RECT-${index + 1}`,
    pack_task: value,
  }));
  const serializer = new XMLSerializer(issue11Ir(), fakeDb({ rectifyingTask: rows }));

  return serializer.serialize({
    msgId: 'MSG-BOOLEAN-REGRESSION',
    collections: ['rectifyingTask'],
  });
}

function packTaskLexemes(xml) {
  return [...xml.matchAll(/<packTask>([^<]*)<\/packTask>/g)]
    .map((match) => match[1]);
}

function minimalBooleanIr() {
  const entityName = 'booleanFixture';
  const column = (name, sqlType, jsonType, xmlKind = 'element') => ({
    name,
    columnName: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    xmlName: name,
    xmlKind,
    sqlType,
    jsonType,
  });

  return {
    entities: new Map([[entityName, {
      name: entityName,
      tableName: 'boolean_fixture',
      columns: [
        {
          name: 'id',
          columnName: 'id',
          xmlName: null,
          xmlKind: 'internal',
          sqlType: 'BIGINT',
          jsonType: 'integer',
        },
        column('logicalFlag', 'BOOLEAN', 'string'),
        column('jsonFlag', 'VARCHAR(255)', 'boolean'),
        column('enabled', 'TINYINT(1)', 'integer', 'attribute'),
        column('count', 'INTEGER', 'integer'),
      ],
      relations: [],
    }]]),
    s3000lCollections: new Map([[entityName, {
      entityName,
      section: 'lsaPrimaryData',
      collectionName: 'booleanFixtures',
      recordName: 'booleanFixture',
    }]]),
    enums: new Map(),
    joinTables: new Map(),
    simpleTypes: new Map(),
  };
}

test('Issue 1.1 rectifyingTask.packTask remains logical BOOLEAN in IR and TINYINT(1) in DDL', () => {
  const ir = issue11Ir();
  const entity = ir.entities.get('rectifyingTask');
  const packTask = entity.columns.find((candidate) => candidate.name === 'packTask');

  assert.equal(packTask.xmlName, 'packTask');
  assert.equal(packTask.xmlKind, 'element');
  assert.equal(packTask.xsdType, 'packagedTask');
  assert.equal(packTask.sqlType, 'BOOLEAN');
  assert.equal(packTask.jsonType, 'boolean');

  const ddl = generateSQL(ir);
  const rectifyingTaskTable = ddl.match(
    /CREATE TABLE IF NOT EXISTS `rectifying_task` \([\s\S]*?\n\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/,
  );

  assert.ok(rectifyingTaskTable, 'expected generated DDL for rectifying_task');
  assert.match(rectifyingTaskTable[0], /`pack_task`\s+TINYINT\(1\) DEFAULT NULL/);
});

test('DB-style numeric packTask values serialize as exact canonical boolean lexemes', async () => {
  const xml = await serializePackTasks([1, 0]);

  assert.deepEqual(packTaskLexemes(xml), ['true', 'false']);
  assert.doesNotMatch(xml, /<packTask>[01]<\/packTask>/);
});

test('packTask accepts supported JS, numeric, and trimmed case-insensitive string values', async () => {
  const xml = await serializePackTasks([
    true,
    false,
    1,
    0,
    ' TrUe ',
    '\tFaLsE\n',
    ' 1 ',
    ' 0 ',
  ]);

  assert.deepEqual(packTaskLexemes(xml), [
    'true',
    'false',
    'true',
    'false',
    'true',
    'false',
    'true',
    'false',
  ]);
});

test('null and undefined packTask values remain omitted', async () => {
  const xml = await serializePackTasks([null, undefined]);

  assert.deepEqual(packTaskLexemes(xml), []);
  assert.match(xml, /uid="RECT-1"/);
  assert.match(xml, /uid="RECT-2"/);
});

test('invalid packTask values fail with entity, field, value, and type context', async () => {
  const invalidCases = [
    { value: 'not-a-boolean', valuePattern: /not-a-boolean/, typePattern: /string/i },
    { value: 2, valuePattern: /\b2\b/, typePattern: /number/i },
  ];

  await Promise.all(invalidCases.map(({ value, valuePattern, typePattern }) => assert.rejects(
    () => serializePackTasks([value]),
    (error) => {
      assert.match(error.message, /rectifyingTask/);
      assert.match(error.message, /packTask|pack_task/);
      assert.match(error.message, valuePattern);
      assert.match(error.message, typePattern);
      return true;
    },
  )));
});

test('boolean metadata applies before attribute handling without changing ordinary integers', async () => {
  const ir = minimalBooleanIr();
  const serializer = new XMLSerializer(ir, fakeDb({
    booleanFixture: [
      {
        id: 1,
        logical_flag: 1,
        json_flag: ' TRUE ',
        enabled: 1,
        count: 1,
      },
      {
        id: 2,
        logical_flag: 0,
        json_flag: 'false',
        enabled: 0,
        count: 0,
      },
    ],
  }));

  const xml = await serializer.serialize({
    msgId: 'MSG-BOOLEAN-METADATA',
    collections: ['booleanFixture'],
  });

  assert.deepEqual(
    [...xml.matchAll(/\benabled="([^"]*)"/g)].map((match) => match[1]),
    ['true', 'false'],
  );
  assert.deepEqual(
    [...xml.matchAll(/<logicalFlag>([^<]*)<\/logicalFlag>/g)].map((match) => match[1]),
    ['true', 'false'],
  );
  assert.deepEqual(
    [...xml.matchAll(/<jsonFlag>([^<]*)<\/jsonFlag>/g)].map((match) => match[1]),
    ['true', 'false'],
  );
  assert.deepEqual(
    [...xml.matchAll(/<count>([^<]*)<\/count>/g)].map((match) => match[1]),
    ['1', '0'],
  );
});
