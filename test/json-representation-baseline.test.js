const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const Ajv = require('ajv');
const { XMLParser } = require('fast-xml-parser');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { generateJSONSchema } = require('../src/json-schema-generator');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');
const { s3000lEnvelope } = require('./helpers/s3000l-fixtures');

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const sources = {
  1.1: ['s3000l/1_1/s3000l_1-1_lsa_dataset.xsd', 'test/fixtures/rev-004-issue-1-valid.xml'],
  '2.0': ['s3000l/2_0/s3000l_2-0_lsaDataset.xsd', 'test/fixtures/rev-004-issue-2-valid.xml'],
  fixture: ['test/fixtures/json-representation-baseline.xsd'],
};
const bundles = new Map();

// The oracle must NOT repeat the importer's coercion or whitespace trimming.
const literalParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function bundle(key) {
  if (!bundles.has(key)) {
    const [xsd, xml] = sources[key];
    const ir = new IRBuilder(parseXSD(xsd)).build();
    const schema = generateJSONSchema(ir);
    const ajv = new Ajv({ allErrors: true, coerceTypes: false, logger: false });
    ajv.addFormat('duration', /^-?P/);
    ajv.addSchema(schema, 'baseline');
    bundles.set(key, {
      ir, schema, ajv, template: xml ? fs.readFileSync(xml, 'utf8') : null, validators: new Map(),
    });
  }
  return bundles.get(key);
}

function document(key, product) {
  const { template } = bundle(key);
  if (template) return template.replace(/<prod\b[^>]*>[\s\S]*?<\/prod>/, () => product);
  return s3000lEnvelope({ primary: `<products>${product}</products>` });
}

function importProduct(key, content) {
  const xml = document(key, `<prod uid="prod1" crud="I" xmlns:xsi="${XSI}">${content}</prod>`);
  const rows = deserializeXML(xml, bundle(key).ir).batches.get('product').insert;
  assert.equal(rows.length, 1);
  return rows[0];
}

function importPayload(content, attributes = '') {
  return JSON.parse(importProduct('fixture', `<payload${attributes}>${content}</payload>`).payload);
}

function validator(key, field) {
  const { ajv, validators } = bundle(key);
  if (!validators.has(field)) {
    validators.set(field, ajv.compile({ $ref: `baseline#/$defs/product/properties/${field}` }));
  }
  return validators.get(field);
}

function expectValid(key, field, value) {
  const validate = validator(key, field);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

async function serialize(key, row) {
  const db = { queryEntity: async (name) => (name === 'product' ? [{ uid: 'prod1', ...row }] : []) };
  return new XMLSerializer(bundle(key).ir, db).serialize({ msgId: 'BASELINE', collections: ['product'] });
}

// Ignore pretty-printer indentation ONLY in element-containing objects. Text in
// leaves and simpleContent (#text plus attributes) remains exact, including spaces.
function withoutIndentation(node) {
  if (Array.isArray(node)) return node.map(withoutIndentation);
  if (!node || typeof node !== 'object') return node;
  const hasElements = Object.keys(node).some((key) => key !== '#text' && !key.startsWith('@_'));
  return Object.fromEntries(Object.entries(node)
    .filter(([key, value]) => !(hasElements && key === '#text' && /^\s*$/.test(value)))
    .map(([key, value]) => [key, withoutIndentation(value)]));
}

function exportedProduct(xml) {
  // Both IRs currently export a 2.0 envelope (REV-005). These checks inspect the
  // record fragment; they do not certify a complete Issue 1.1 XML delivery.
  const parsed = withoutIndentation(literalParser.parse(xml));
  return parsed.lsaDataset.logisticsSupportAnalysisData.lsaPrimaryData.products.prod;
}

function reimportFragment(key, xml) {
  const fragment = xml.match(/<prod\b[^>]*>[\s\S]*?<\/prod>/);
  assert.ok(fragment, 'serializer must produce a product record');
  const rows = deserializeXML(document(key, fragment[0]), bundle(key).ir).batches.get('product').insert;
  assert.equal(rows.length, 1);
  return rows[0];
}

function defect(id, title, fn) {
  // TODO tests still execute their desired-behavior assertions. Strict mode turns
  // them into ordinary failing tests, independently reproducible before the fix.
  const todo = process.env.JSON_BASELINE_STRICT === '1' ? false : `${id}: known representation defect`;
  test(`${id}: ${title}`, { todo }, fn);
}

for (const issue of ['1.1', '2.0']) {
  for (const text of ['001234', '1234.00', '1234', 'true', 'false']) {
    defect('JSON-001', `Issue ${issue} stores prodId ${JSON.stringify(text)} as an XSD string`, () => {
      const row = importProduct(issue, `<prodId><id>${text}</id></prodId>`);
      assert.deepEqual(JSON.parse(row.prod_id), { id: text });
    });
  }

  for (const text of ['001234', '1234.00']) {
    defect('JSON-002', `Issue ${issue} preserves prodId ${text} through import and record export`, async () => {
      const row = importProduct(issue, `<prodId><id>${text}</id></prodId>`);
      const xml = await serialize(issue, row);
      assert.equal(exportedProduct(xml).prodId.id, text);
    });
  }

  test(`Issue ${issue}: numeric/boolean-looking text can survive XML output despite a JSON type change`, async () => {
    for (const text of ['1234', 'true', 'false']) {
      const row = importProduct(issue, `<prodId><id>${text}</id></prodId>`);
      assert.notEqual(typeof JSON.parse(row.prod_id).id, 'string');
      assert.equal(exportedProduct(await serialize(issue, row)).prodId.id, text);
    }
  });

  test(`Issue ${issue}: object and one-item array produce identical prodId XML, but reimport as an object`, async () => {
    const value = { id: 'PRODUCT-A', setBy: { '@_uidRef': 'org1' } };
    expectValid(issue, 'prodId', value);
    expectValid(issue, 'prodId', [value]);
    const objectXml = await serialize(issue, { prod_id: JSON.stringify(value) });
    const arrayXml = await serialize(issue, { prod_id: JSON.stringify([value]) });
    assert.equal(arrayXml, objectXml);
    assert.deepEqual(exportedProduct(arrayXml).prodId, value);
    assert.deepEqual(JSON.parse(reimportFragment(issue, arrayXml).prod_id), value);
    assert.notDeepEqual(JSON.parse(reimportFragment(issue, arrayXml).prod_id), [value]);
  });

  test(`Issue ${issue}: multiple prodId occurrences retain order and their attributes on record reimport`, async () => {
    const value = [
      { id: 'PRODUCT-A', setBy: { '@_uidRef': 'org1' } },
      { id: 'PRODUCT-B', class: 'EIAC' },
    ];
    expectValid(issue, 'prodId', value);
    const xml = await serialize(issue, { prod_id: JSON.stringify(value) });
    assert.deepEqual(exportedProduct(xml).prodId, value);
    assert.deepEqual(JSON.parse(reimportFragment(issue, xml).prod_id), value);
  });

  test(`Issue ${issue}: a nested bkdn object and one-item array produce identical XML`, async () => {
    const child = { bkdnType: { code: 'SY' }, '@_uid': 'bkdn1' };
    const object = { bkdn: child };
    const array = { bkdn: [child] };
    expectValid(issue, 'bkdns', object);
    expectValid(issue, 'bkdns', array);
    const objectXml = await serialize(issue, { bkdns: JSON.stringify(object) });
    const arrayXml = await serialize(issue, { bkdns: JSON.stringify(array) });
    assert.equal(arrayXml, objectXml);
    assert.deepEqual(exportedProduct(arrayXml).bkdns, object);
  });

  test(`Issue ${issue}: an empty required prodId array is rejected by JSON Schema but exports as absence`, async () => {
    assert.equal(validator(issue, 'prodId')([]), false);
    assert.equal(exportedProduct(await serialize(issue, { prod_id: '[]' })).prodId, undefined);
  });

  test(`Issue ${issue}: SQL null, JSON null, empty object and explicit nil have different XML effects`, async () => {
    const nil = { '@_xmlns:xsi': XSI, '@_xsi:nil': 'true' };
    expectValid(issue, 'bkdns', nil);
    const absentXml = await serialize(issue, {});
    assert.equal(await serialize(issue, { bkdns: null }), absentXml);
    assert.equal(exportedProduct(absentXml).bkdns, undefined);
    assert.equal(exportedProduct(await serialize(issue, { bkdns: 'null' })).bkdns, '');
    assert.equal(exportedProduct(await serialize(issue, { bkdns: '{}' })).bkdns, '');
    const nilXml = await serialize(issue, { bkdns: JSON.stringify(nil) });
    assert.deepEqual(exportedProduct(nilXml).bkdns, nil);
    assert.deepEqual(JSON.parse(reimportFragment(issue, nilXml).bkdns), nil);
  });

  test(`Issue ${issue}: serialized JSON text and an already decoded object produce identical XML`, async () => {
    const value = { id: 'PRODUCT-A' };
    assert.equal(
      await serialize(issue, { prod_id: JSON.stringify(value) }),
      await serialize(issue, { prod_id: value }),
    );
  });

  defect('JSON-007', `Issue ${issue} emits prodId children in XSD sequence order regardless of JSON key order`, async () => {
    const value = { class: 'EIAC', id: 'PRODUCT-A' };
    expectValid(issue, 'prodId', value);
    const xml = await serialize(issue, { prod_id: JSON.stringify(value) });
    assert.deepEqual(Object.keys(exportedProduct(xml).prodId), ['id', 'class']);
  });
}

test('Issue 2.0: complete current-envelope export/reimport retains safe inline JSON values', async () => {
  const row = importProduct('2.0', '<prodId><id>PRODUCT-A</id></prodId><prodId><id>PRODUCT-B</id></prodId>');
  const xml = await serialize('2.0', row);
  const again = deserializeXML(xml, bundle('2.0').ir).batches.get('product').insert[0];
  assert.deepEqual(JSON.parse(again.prod_id), JSON.parse(row.prod_id));
});

defect('JSON-003', 'xs:string preserves leading and trailing whitespace inside an inline JSON column', () => {
  assert.equal(importPayload('<text>  alpha  beta  </text>').text, '  alpha  beta  ');
});

test('xs:token boundary whitespace is trimmed, unlike whitespace that must survive in xs:string', () => {
  const value = importPayload('<token>  ALPHA  </token>');
  assert.equal(value.token, 'ALPHA');
  expectValid('fixture', 'payload', value);
});

defect('JSON-004', 'numeric-looking string enums retain their declared spelling in stored JSON', () => {
  assert.equal(importPayload('<code>01</code>').code, '01');
});

defect('JSON-004', 'an imported enum member exports as a declared enum member', async () => {
  const row = importProduct('fixture', '<payload><code>01</code></payload>');
  const { code } = exportedProduct(await serialize('fixture', row)).payload;
  const allowed = bundle('fixture').ir.enums.get('Code').values;
  assert.ok(allowed.includes(code), `Exported ${JSON.stringify(code)} is not in ${JSON.stringify(allowed)}`);
});

defect('JSON-005', 'xs:string simpleContent preserves numeric-looking #text alongside attributes', () => {
  const value = importPayload('<note lang="en">001234</note>');
  assert.deepEqual(value.note, { '#text': '001234', '@_lang': 'en' });
});

for (const [field, text] of [['integer', '9007199254740993'], ['decimal', '1.234567890123456789']]) {
  test(`large ${field}: the parser preserves this exact value as a string through record export`, async () => {
    const row = importProduct('fixture', `<payload><${field}>${text}</${field}></payload>`);
    assert.equal(JSON.parse(row.payload)[field], text);
    assert.equal(exportedProduct(await serialize('fixture', row)).payload[field], text);
  });

  defect('JSON-006', `generated JSON Schema accepts the exact ${field} string produced by import`, () => {
    const value = importPayload(`<${field}>${text}</${field}>`);
    expectValid('fixture', 'payload', value);
  });
}

test('safe integer and decimal values retain their numeric value through JSON and XML', async () => {
  const row = importProduct('fixture', '<payload><integer>42</integer><decimal>12.5</decimal></payload>');
  const value = JSON.parse(row.payload);
  assert.deepEqual(value, { integer: 42, decimal: 12.5 });
  expectValid('fixture', 'payload', value);
  assert.deepEqual(exportedProduct(await serialize('fixture', row)).payload, { integer: '42', decimal: '12.5' });
});

test('true/false and 1/0 are accepted boolean representations with different XML spelling', async () => {
  for (const [lexical, value] of [['true', true], ['false', false], ['1', 1], ['0', 0]]) {
    const row = importProduct('fixture', `<payload><flag>${lexical}</flag></payload>`);
    assert.deepEqual(JSON.parse(row.payload), { flag: value });
    expectValid('fixture', 'payload', { flag: value });
    assert.equal(exportedProduct(await serialize('fixture', row)).payload.flag, lexical);
  }
  assert.equal(validator('fixture', 'payload')({ flag: 2 }), false);
});

test('string attributes keep numeric/boolean-looking values and the @_ XML attribute convention', async () => {
  const row = importProduct('fixture', '<payload code="001234" label="true"><text>ABC</text></payload>');
  const value = { text: 'ABC', '@_code': '001234', '@_label': 'true' };
  assert.deepEqual(JSON.parse(row.payload), value);
  expectValid('fixture', 'payload', value);
  assert.deepEqual(exportedProduct(await serialize('fixture', row)).payload, value);
});

test('a plain property is an element, whereas @_ names an attribute', async () => {
  const attribute = exportedProduct(await serialize('fixture', { payload: '{"@_code":"ABC"}' })).payload;
  const element = exportedProduct(await serialize('fixture', { payload: '{"code":"ABC"}' })).payload;
  assert.deepEqual(attribute, { '@_code': 'ABC' });
  assert.deepEqual(element, { code: 'ABC' });
  assert.notDeepEqual(attribute, element);
});

test('simpleContent scalar and #text object produce the same text; attributes require the object', async () => {
  const scalarXml = await serialize('fixture', { payload: JSON.stringify({ note: 'ALPHA' }) });
  const objectXml = await serialize('fixture', { payload: JSON.stringify({ note: { '#text': 'ALPHA' } }) });
  assert.equal(scalarXml, objectXml);
  for (const note of ['ALPHA', { '#text': 'ALPHA' }, { '#text': 'ALPHA', '@_lang': 'en' }]) {
    expectValid('fixture', 'payload', { note });
  }
  const value = { note: { '#text': 'ALPHA', '@_lang': 'en' } };
  const xml = await serialize('fixture', { payload: JSON.stringify(value) });
  assert.deepEqual(exportedProduct(xml).payload, value);
  assert.deepEqual(JSON.parse(reimportFragment('fixture', xml).payload), value);
});

test('repeatable primitive and complex fields accept singleton or array; multiple occurrences retain order', async () => {
  for (const [field, first, second] of [['tag', 'ALPHA', 'BETA'], ['item', { value: 'ALPHA' }, { value: 'BETA' }]]) {
    const xml = await serialize('fixture', { payload: JSON.stringify({ [field]: first }) });
    assert.equal(await serialize('fixture', { payload: JSON.stringify({ [field]: [first] }) }), xml);
    const multiple = { [field]: [first, second] };
    expectValid('fixture', 'payload', { [field]: first });
    expectValid('fixture', 'payload', { [field]: [first] });
    expectValid('fixture', 'payload', multiple);
    const multipleXml = await serialize('fixture', { payload: JSON.stringify(multiple) });
    assert.deepEqual(exportedProduct(multipleXml).payload, multiple);
    assert.deepEqual(JSON.parse(reimportFragment('fixture', multipleXml).payload), multiple);
  }
});

test('an optional empty array exports as absence, but the current JSON Schema requires omission', async () => {
  const value = { text: 'ALPHA', item: [] };
  assert.equal(validator('fixture', 'payload')(value), false);
  const xml = await serialize('fixture', { payload: JSON.stringify(value) });
  const absent = { text: 'ALPHA' };
  assert.equal(xml, await serialize('fixture', { payload: JSON.stringify(absent) }));
  assert.deepEqual(JSON.parse(reimportFragment('fixture', xml).payload), absent);
});

test('arrays on a non-repeatable field can serialize, but are rejected by its JSON Schema', async () => {
  for (const values of [['ALPHA'], ['ALPHA', 'BETA']]) {
    assert.equal(validator('fixture', 'payload')({ text: values }), false);
    const xml = await serialize('fixture', { payload: JSON.stringify({ text: values }) });
    assert.deepEqual(exportedProduct(xml).payload.text, values.length === 1 ? values[0] : values);
  }
});

test('missing and empty string values remain different through inline import/export', async () => {
  for (const [fragment, value] of [['<payload><text/></payload>', { text: '' }], ['<payload><tag>A</tag></payload>', { tag: 'A' }]]) {
    const row = importProduct('fixture', fragment);
    assert.deepEqual(JSON.parse(row.payload), value);
    expectValid('fixture', 'payload', value);
    assert.deepEqual(exportedProduct(await serialize('fixture', row)).payload, value);
  }
});

test('nested JSON null emits an empty element; explicit xsi:nil retains nil and its attributes', async () => {
  const nil = { '@_xmlns:xsi': XSI, '@_xsi:nil': 'true', '@_code': '001234' };
  const value = { optional: nil };
  expectValid('fixture', 'payload', value);
  assert.equal(validator('fixture', 'payload')({ optional: null }), false);
  const xml = await serialize('fixture', { payload: JSON.stringify(value) });
  assert.deepEqual(exportedProduct(xml).payload, value);
  assert.deepEqual(JSON.parse(reimportFragment('fixture', xml).payload), value);
  const empty = await serialize('fixture', { payload: JSON.stringify({ optional: null }) });
  assert.equal(exportedProduct(empty).payload.optional, '');
  assert.notEqual(empty, xml);
});

test('escaped XML characters and Unicode retain their text through import and export', async () => {
  const row = importProduct('fixture', '<payload><text>A &amp; B &lt; C — café</text></payload>');
  const value = { text: 'A & B < C — café' };
  assert.deepEqual(JSON.parse(row.payload), value);
  const xml = await serialize('fixture', row);
  assert.match(xml, /A &amp; B &lt; C — café/);
  assert.deepEqual(exportedProduct(xml).payload, value);
});
