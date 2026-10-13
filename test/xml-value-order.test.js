const assert = require('node:assert/strict');
const test = require('node:test');
const { XMLParser } = require('fast-xml-parser');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { XMLSerializer } = require('../src/xml-serializer');

const XSD = 'test/fixtures/xml-value-order.xsd';
const literalParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function schema() {
  return new IRBuilder(parseXSD(XSD)).build();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

async function serialize(ir, row) {
  const db = {
    queryEntity: async (name) => (name === 'product' ? [{ uid: 'prod-order', ...row }] : []),
  };
  return new XMLSerializer(ir, db).serialize({ msgId: 'VALUE-ORDER', collections: ['product'] });
}

function product(xml) {
  return literalParser.parse(xml)
    .lsaDataset.logisticsSupportAnalysisData.lsaPrimaryData.products.prod;
}

function elementKeys(value) {
  return Object.keys(value).filter((key) => key !== '#text' && !key.startsWith('@_'));
}

test('typed JSON columns use inherited, grouped, selected-choice and nested XSD order', async () => {
  const value = deepFreeze({
    derivedLast: 'last',
    scalar: 'plain',
    nilValue: { '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', '@_xsi:nil': 'true' },
    measure: { '@_unit': 'kg', '#text': '42' },
    recursive: { child: { child: { name: 'leaf' }, name: 'middle' }, name: 'root' },
    items: [
      { second: 'item-1-second', first: 'item-1-first' },
      { second: 'item-2-second', first: 'item-2-first' },
    ],
    b: 'choice-first',
    a: 'choice-second',
    groupSecond: 'pair-second',
    groupFirst: 'pair-first',
    baseFirst: 'base',
    '@_state': 'ready',
    '@_baseCode': 'base-code',
  });
  const before = JSON.stringify(value);
  const output = product(await serialize(schema(), { payload: value })).payload;

  assert.deepEqual(elementKeys(output), [
    'baseFirst', 'groupFirst', 'groupSecond', 'b', 'a', 'items', 'recursive',
    'measure', 'nilValue', 'scalar', 'derivedLast',
  ]);
  assert.deepEqual(output.items.map(elementKeys), [['first', 'second'], ['first', 'second']]);
  assert.deepEqual(elementKeys(output.recursive), ['name', 'child']);
  assert.deepEqual(elementKeys(output.recursive.child), ['name', 'child']);
  assert.deepEqual(output.items.map((item) => item.first), ['item-1-first', 'item-2-first']);
  assert.deepEqual(output.measure, { '#text': '42', '@_unit': 'kg' });
  assert.deepEqual(output.nilValue, {
    '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    '@_xsi:nil': 'true',
  });
  assert.equal(output.scalar, 'plain');
  assert.equal(output['@_state'], 'ready');
  assert.equal(output['@_baseCode'], 'base-code');
  assert.equal(JSON.stringify(value), before);
});

test('decoded objects and JSON text produce the same recursively ordered XML', async () => {
  const decoded = deepFreeze({
    derivedLast: 'last',
    items: [{ second: 'second', first: 'first' }],
    groupFirst: 'group',
    baseFirst: 'base',
  });
  const ir = schema();
  assert.equal(
    await serialize(ir, { payload: decoded }),
    await serialize(ir, { payload: JSON.stringify(decoded) }),
  );
});

test('IR and export preserve declaration order when elements surround choices and groups', async () => {
  const ir = schema();
  const particles = ir.valueTypes.get('InterleavedPayload').content.children[0].children;
  assert.deepEqual(particles.map((particle) => particle.xmlName || particle.kind), [
    'sequence', 'first', 'choice', 'middle', 'group', 'last',
  ]);
  const value = deepFreeze({
    last: 'last',
    groupSecond: 'pair-second',
    groupFirst: 'pair-first',
    middle: 'middle',
    pickC: 'choice-second',
    pickB: 'choice-first',
    first: 'first',
  });
  const output = product(await serialize(ir, { interleaved: value })).interleaved;
  assert.deepEqual(elementKeys(output), [
    'first', 'pickB', 'pickC', 'middle', 'groupFirst', 'groupSecond', 'last',
  ]);
});

test('unknown keys keep their input slots while known children take XSD order', async () => {
  const value = deepFreeze({
    derivedLast: 'last',
    unknownMiddle: 'middle',
    baseFirst: 'base',
    unknownTail: 'tail',
  });
  const output = product(await serialize(schema(), { payload: value })).payload;
  assert.deepEqual(elementKeys(output), ['baseFirst', 'unknownMiddle', 'derivedLast', 'unknownTail']);
});

test('complex-content restriction uses its own particle order', async () => {
  const value = deepFreeze({ keptSecond: 'second', removed: 'unknown', keptFirst: 'first' });
  const output = product(await serialize(schema(), { restricted: value })).restricted;
  assert.deepEqual(elementKeys(output), ['keptFirst', 'removed', 'keptSecond']);
});

test('mixed content keeps its direct child order while typed nested children are ordered', async () => {
  const value = deepFreeze({
    knownLast: 'last',
    nested: { second: 'second', first: 'first' },
    knownFirst: 'first',
  });
  const output = product(await serialize(schema(), { mixed: value })).mixed;
  assert.deepEqual(elementKeys(output), ['knownLast', 'nested', 'knownFirst']);
  assert.deepEqual(elementKeys(output.nested), ['first', 'second']);
});

test('repeated multi-element groups keep field arrays without inventing lost interleaving', async () => {
  const value = deepFreeze({
    tag: ['tag-1', 'tag-2'],
    entry: [
      { second: 'entry-1-second', first: 'entry-1-first' },
      { second: 'entry-2-second', first: 'entry-2-first' },
    ],
  });
  const output = product(await serialize(schema(), { repeated: value })).repeated;
  assert.deepEqual(elementKeys(output), ['tag', 'entry']);
  assert.deepEqual(output.tag, ['tag-1', 'tag-2']);
  assert.deepEqual(output.entry.map(elementKeys), [['first', 'second'], ['first', 'second']]);
  assert.deepEqual(output.entry.map((entry) => entry.first), ['entry-1-first', 'entry-2-first']);
});

test('LONGTEXT columns without value type metadata retain insertion order', async () => {
  const ir = schema();
  const payload = ir.entities.get('product').columns.find((column) => column.name === 'payload');
  payload.valueTypeRef = null;
  const value = deepFreeze({ derivedLast: 'last', baseFirst: 'base' });
  const output = product(await serialize(ir, { payload: value })).payload;
  assert.deepEqual(elementKeys(output), ['derivedLast', 'baseFirst']);
});

test('names reused in separate sequence positions keep a valid existing order', async () => {
  const value = deepFreeze({ b: 'middle', a: { second: 'second', first: 'first' } });
  const output = product(await serialize(schema(), { reused_name: value })).reusedName;
  assert.deepEqual(elementKeys(output), ['b', 'a']);
  assert.deepEqual(elementKeys(output.a), ['first', 'second']);
});

test('absent or single-name repeated groups allow surrounding siblings to take XSD order', async () => {
  const ir = schema();
  for (const omitted of [{}, { entry: [], tag: [] }]) {
    const value = deepFreeze({ after: 'last', ...omitted, before: 'first' });
    const output = product(await serialize(ir, { optional_repeated: value })).optionalRepeated;
    assert.deepEqual(elementKeys(output), ['before', 'after']);
  }
  const value = deepFreeze({
    after: 'last',
    entry: [{ second: 'b1', first: 'a1' }, { second: 'b2', first: 'a2' }],
    before: 'first',
  });
  const output = product(await serialize(ir, { optional_repeated: value })).optionalRepeated;
  assert.deepEqual(elementKeys(output), ['before', 'entry', 'after']);
  assert.deepEqual(output.entry.map(elementKeys), [['first', 'second'], ['first', 'second']]);
  assert.deepEqual(output.entry.map((entry) => entry.first), ['a1', 'a2']);
});
