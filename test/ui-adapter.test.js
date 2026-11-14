const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const { XMLParser } = require('fast-xml-parser');
const {
  UIAdapter, IRBuilder, parseXSD, generateUIJSONSchema, deserializeXML, XMLSerializer,
} = require('../lib');
const { generateJSONSchema } = require('../src/json-schema-generator');

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const paths = {
  1.1: 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd',
  '2.0': 's3000l/2_0/s3000l_2-0_lsaDataset.xsd',
  fixture: 'test/fixtures/typescript-shapes.xsd',
};
const bundles = new Map();

function bundle(issue) {
  if (!bundles.has(issue)) {
    const ir = new IRBuilder(parseXSD(path.join(__dirname, '..', paths[issue]))).build();
    const ajv = new Ajv({ allErrors: true, logger: false, coerceTypes: false });
    ajv.addFormat('duration', /^-?P/);
    ajv.addSchema(generateJSONSchema(ir), 'xml');
    ajv.addSchema(generateUIJSONSchema(ir, { schemaId: 'urn:test:ui' }), 'ui');
    bundles.set(issue, { ir, ajv });
  }
  return bundles.get(issue);
}

function valid(issue, profile, entity, value) {
  const validate = bundle(issue).ajv.compile({ $ref: `${profile}#/$defs/${entity}` });
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function payload() {
  return {
    code: 'A', fixed: '123', nodes: [{ id: '001' }, { id: '002' }],
    note: { '#text': 'Keep  two spaces', '@_lang': 'en', '@_xmlns:local': 'urn:note' },
  };
}

for (const issue of ['1.1', '2.0']) {
  test(`Issue ${issue}: clean entity boundaries exclude storage columns and reject unknown fields`, () => {
    const { ir, ajv } = bundle(issue);
    const adapter = new UIAdapter(ir);
    const schema = generateUIJSONSchema(ir);
    const xmlSchema = generateJSONSchema(ir);
    for (const [name, entity] of ir.entities) {
      const internal = entity.columns.filter((column) => ['internal', 'relation'].includes(column.xmlKind));
      const row = Object.fromEntries(internal.map((column) => [column.columnName, 42]));
      assert.deepEqual(adapter.decodeRow(name, row).value, {}, name);
      for (const column of internal) {
        assert.equal(Object.hasOwn(schema.$defs[name].properties, column.name), false, `${name}.${column.name}`);
        assert.throws(() => adapter.encodeRow(name, { [column.name]: 9 }), /unknown UI field/);
        if (!column.isPrimaryKey && !column.columnName.startsWith('_')) {
          assert.equal(Object.hasOwn(xmlSchema.$defs[name].properties, column.name), true, 'legacy XML schema stays unchanged');
        }
      }
    }
    const validate = ajv.compile({ $ref: 'ui#/$defs/product' });
    const product = { uid: 'p1', crud: 'I', prodId: [{ id: 'P' }] };
    assert.equal(validate(product), true);
    assert.equal(validate({ ...product, typo: 123 }), false);
    assert.throws(() => adapter.encodeEntity('product', { ...product, typo: 123 }), /unknown UI field/);
  });

  test(`Issue ${issue}: clean Product UI values preserve XML metadata through edits`, () => {
    const adapter = new UIAdapter(bundle(issue).ir);
    const product = {
      uid: 'prod1', crud: 'I', prodId: {
        id: { '#text': '001234', '@_xmlns:local': 'urn:identifier' },
        class: { '@_xsi:nil': '1', '@_xmlns:xsi': XSI },
        setBy: { '@_uidRef': 'org1' },
      },
    };
    valid(issue, 'xml', 'product', product);
    const original = structuredClone(product);
    const edit = adapter.decodeEntity('product', product);
    assert.deepEqual(edit.value, {
      uid: 'prod1', crud: 'I', prodId: [{ id: '001234', class: null, setBy: { uidRef: 'org1' } }],
    });
    valid(issue, 'ui', 'product', edit.value);
    assert.deepEqual(adapter.encodeEntity('product', edit.value, edit.state), product);

    edit.value.prodId[0].id = '009999';
    edit.value.prodId[0].setBy.uidRef = 'org2';
    const stored = adapter.encodeEntity('product', edit.value, edit.state);
    assert.deepEqual(stored.prodId.id, { '#text': '009999', '@_xmlns:local': 'urn:identifier' });
    assert.deepEqual(stored.prodId.class, product.prodId.class);
    assert.equal(stored.prodId.setBy['@_uidRef'], 'org2');
    valid(issue, 'xml', 'product', stored);
    assert.deepEqual(product, original, 'decoding and encoding never mutate the source object');
  });

  test(`Issue ${issue}: UI strings normalize legacy scalar values without inventing lost spelling`, () => {
    const adapter = new UIAdapter(bundle(issue).ir);
    const wire = { uid: 'prod1', crud: 'I', prodId: [{ id: 1234 }, { id: true }] };
    const edit = adapter.decodeEntity('product', wire);
    assert.deepEqual(edit.value.prodId.map((id) => id.id), ['1234', 'true']);
    valid(issue, 'ui', 'product', edit.value);
    assert.deepEqual(adapter.encodeEntity('product', edit.value, edit.state), wire);
    assert.throws(() => adapter.encodeEntity('product', { ...edit.value, prodId: [{ id: 1234 }] }), /UI string/);
    assert.throws(() => adapter.encodeEntity('product', { ...edit.value, prodId: { id: '1234' } }), /must be arrays/);
  });

  test(`Issue ${issue}: a new clean draft can be converted without existing XML metadata`, () => {
    const adapter = new UIAdapter(bundle(issue).ir);
    const draft = { uid: 'prod1', crud: 'I', prodId: [{ id: '001234', class: null }] };
    const wire = adapter.encodeEntity('product', draft);
    assert.equal(wire.prodId[0].id, '001234');
    assert.deepEqual(wire.prodId[0].class, { '@_xmlns:xsi': XSI, '@_xsi:nil': 'true' });
    valid(issue, 'xml', 'product', wire);
    assert.deepEqual(adapter.decodeEntity('product', wire).value, draft);
  });

  test(`Issue ${issue}: SQL NULL stays distinct from explicit nil and field deletion`, () => {
    const adapter = new UIAdapter(bundle(issue).ir);
    const row = {
      id: 1, _msg_seq: 9, uid: 'prod1', crud: 'I',
      prod_id: JSON.stringify({ id: '001234' }), bkdns: null,
    };
    const edit = adapter.decodeRow('product', row);
    assert.equal(Object.hasOwn(edit.value, 'bkdns'), false);
    edit.value.bkdns = null;
    const nilRow = adapter.encodeRow('product', edit.value, edit.state);
    assert.equal(JSON.parse(nilRow.bkdns)['@_xsi:nil'], 'true');
    assert.equal(Object.hasOwn(nilRow, 'id'), false);
    assert.equal(Object.hasOwn(nilRow, '_msg_seq'), false);
    const nilEdit = adapter.decodeRow('product', nilRow);
    assert.equal(nilEdit.value.bkdns, null);
    delete nilEdit.value.bkdns;
    assert.equal(adapter.encodeRow('product', nilEdit.value, nilEdit.state).bkdns, null);
    delete nilEdit.value.prodId;
    assert.throws(() => adapter.encodeRow('product', nilEdit.value, nilEdit.state), /required column/);
  });

  test(`Issue ${issue}: imported Product edits survive XML record export and reimport`, async () => {
    const template = fs.readFileSync(path.join(__dirname, `fixtures/rev-004-issue-${issue === '1.1' ? '1' : '2'}-valid.xml`), 'utf8');
    const fragment = '<prod uid="prod1" crud="I"><prodId><id xmlns:local="urn:kept">001234</id></prodId></prod>';
    const source = template.replace(/<prod\b[^>]*>[\s\S]*?<\/prod>/, fragment);
    const ir = bundle(issue).ir;
    const row = deserializeXML(source, ir).batches.get('product').insert[0];
    const adapter = new UIAdapter(ir);
    const edit = adapter.decodeRow('product', row);
    edit.value.prodId[0].id = '000567';
    const updated = { ...row, ...adapter.encodeRow('product', edit.value, edit.state) };
    const db = { queryEntity: async (name) => (name === 'product' ? [updated] : []) };
    const xml = await new XMLSerializer(ir, db).serialize({ msgId: 'UI-EDIT', collections: ['product'] });
    const exported = xml.match(/<prod\b[^>]*>[\s\S]*?<\/prod>/)[0];
    const literal = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(exported);
    assert.equal(literal.prod.prodId.id['#text'], '000567');
    assert.equal(literal.prod.prodId.id['@_xmlns:local'], 'urn:kept');
    // Validate record behavior; the known Issue 1.1 export-envelope limitation is separate.
    const reimported = deserializeXML(template.replace(/<prod\b[^>]*>[\s\S]*?<\/prod>/, exported), ir)
      .batches.get('product').insert[0];
    assert.deepEqual(JSON.parse(reimported.prod_id), JSON.parse(updated.prod_id));
  });
}

test('Issue 1.1 primitive columns agree on absence, booleans and exact numeric strings', () => {
  const { ir, ajv } = bundle('1.1');
  const adapter = new UIAdapter(ir);
  for (const [name, field, column, value] of [
    ['message', 'msgLang', 'msg_lang', 'en'],
    ['samplingDefinitionByRatio', 'samplRo', 'sampl_ro', '0.12345678901234567890'],
    ['failureModeThresholdDefinition', 'nrOfEvnts', 'nr_of_evnts', '9007199254740993'],
    ['hardwarePartAsDesigned', 'emi', 'emi', true],
  ]) {
    const validate = ajv.compile({ $ref: `ui#/$defs/${name}/properties/${field}` });
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate(null), false);
    const edit = adapter.decodeRow(name, { [column]: value });
    assert.deepEqual(edit.value, { [field]: value });
    assert.deepEqual(adapter.encodeRow(name, edit.value, edit.state), { [column]: value });
    assert.deepEqual(adapter.decodeRow(name, { [column]: null }).value, {});
    assert.throws(() => adapter.encodeEntity(name, { [field]: null }), /nillable/);
    delete edit.value[field];
    assert.deepEqual(adapter.encodeRow(name, edit.value, edit.state), { [column]: null });
  }
});

test('simple content, exact numerics and booleans have predictable UI forms', () => {
  const adapter = new UIAdapter(bundle('fixture').ir);
  const source = {
    ...payload(), count: '9007199254740993', amount: '0.12345678901234567890', flag: 0,
  };
  const edit = adapter.decodeValue('Payload', source);
  assert.deepEqual(edit.value.note, { lang: 'en', value: 'Keep  two spaces' });
  assert.equal(edit.value.flag, false);
  assert.equal(edit.value.count, source.count);
  assert.equal(edit.value.amount, source.amount);
  edit.value.flag = true;
  edit.value.note.value = 'New  text';
  const stored = adapter.encodeValue('Payload', edit.value, edit.state);
  assert.equal(stored.flag, true);
  assert.equal(stored.note['#text'], 'New  text');
  assert.equal(stored.note['@_lang'], 'en');
  assert.equal(stored.note['@_xmlns:local'], 'urn:note');
});

test('empty text with attributes or namespace metadata stays editable', () => {
  const adapter = new UIAdapter(bundle('fixture').ir);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const label = parser.parse('<note lang="en"/>').note;
  assert.equal(Object.hasOwn(label, '#text'), false);
  const edit = adapter.decodeValue('Label', label);
  assert.deepEqual(edit.value, { lang: 'en', value: '' });
  assert.deepEqual(adapter.encodeValue('Label', edit.value, edit.state), label);
  edit.value.value = 'New text';
  assert.deepEqual(adapter.encodeValue('Label', edit.value, edit.state), { '@_lang': 'en', '#text': 'New text' });

  const first = parser.parse('<first xmlns:local="urn:kept"/>').first;
  const source = { ...payload(), first, second: 'Two' };
  const nested = adapter.decodeValue('Payload', source);
  assert.equal(nested.value.first, '');
  valid('fixture', 'ui', 'record', { uid: 'r1', crud: 'I', payload: nested.value });
  assert.deepEqual(adapter.encodeValue('Payload', nested.value, nested.state), source);
  nested.value.first = 'One';
  assert.deepEqual(adapter.encodeValue('Payload', nested.value, nested.state).first, {
    '@_xmlns:local': 'urn:kept', '#text': 'One',
  });
});

test('mixed content is rejected before editing, including inherited mixed content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-ui-mixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mixed.xsd');
  fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:complexType name="record"><xs:sequence>
      <xs:element name="payload" type="Derived"/>
    </xs:sequence><xs:attribute name="uid" type="xs:ID" use="required"/>
      <xs:attribute name="crud" type="xs:string" use="required"/>
    </xs:complexType>
    <xs:complexType name="Base" mixed="true"><xs:sequence>
      <xs:element name="base" type="xs:string"/>
    </xs:sequence></xs:complexType>
    <xs:complexType name="Derived"><xs:complexContent><xs:extension base="Base"><xs:sequence>
      <xs:element name="own" type="xs:string"/>
    </xs:sequence></xs:extension></xs:complexContent></xs:complexType>
  </xs:schema>`);
  const ir = new IRBuilder(parseXSD(file)).build();
  const adapter = new UIAdapter(ir);
  const source = { '#text': 'Keep this text', base: 'B', own: 'O' };
  for (const name of ['Base', 'Derived']) {
    assert.throws(() => adapter.decodeValue(name, source), /mixed or wildcard/);
    assert.throws(() => adapter.encodeValue(name, { base: 'B', own: 'O' }), /mixed or wildcard/);
  }
  assert.throws(() => adapter.decodeEntity('record', { uid: 'r1', crud: 'I', payload: source }), /mixed or wildcard/);
});

test('nil retains required attributes and cannot invent them for a new value', () => {
  const adapter = new UIAdapter(bundle('fixture').ir);
  const edit = adapter.decodeValue('Payload', payload());
  edit.value.note = null;
  const nil = adapter.encodeValue('Payload', edit.value, edit.state);
  assert.equal(nil.note['@_lang'], 'en');
  assert.equal(nil.note['@_xsi:nil'], 'true');
  assert.equal(Object.hasOwn(nil.note, '#text'), false);
  valid('fixture', 'xml', 'record', { uid: 'r1', crud: 'I', payload: nil });
  assert.throws(() => adapter.encodeValue('Payload', { ...edit.value, note: null }), /requires attribute lang/);
  const next = adapter.decodeValue('Payload', nil);
  next.value.note = { value: 'Restored', lang: 'fr' };
  const restored = adapter.encodeValue('Payload', next.value, next.state);
  assert.equal(restored.note['#text'], 'Restored');
  assert.equal(restored.note['@_lang'], 'fr');
  assert.equal(Object.hasOwn(restored.note, '@_xsi:nil'), false);
});

test('editing non-nil values retains false nil markers, and switching to nil replaces aliases', () => {
  const adapter = new UIAdapter(bundle('1.1').ir);
  for (const marker of ['false', '0', false, 0]) {
    const original = { '#text': 'A', '@_xmlns:n': XSI, '@_n:nil': marker };
    const edit = adapter.decodeValue('productIdentifier', { id: original });
    edit.value.id = 'B';
    assert.deepEqual(adapter.encodeValue('productIdentifier', edit.value, edit.state).id, {
      ...original, '#text': 'B',
    });
  }
  const edit = adapter.decodeValue('productIdentifier', {
    id: 'P', class: { '#text': 'PID', '@_xmlns:n': XSI, '@_n:nil': 'false' },
  });
  edit.value.class = null;
  const encoded = adapter.encodeValue('productIdentifier', edit.value, edit.state);
  assert.equal(Object.hasOwn(encoded.class, '@_n:nil'), false, 'XML cannot contain two expanded nil attributes');
  assert.equal(encoded.class['@_xsi:nil'], 'true');
  assert.equal(adapter.decodeValue('productIdentifier', encoded).value.class, null);
});

test('UID-based reordering preserves the metadata of each breakdown after a JSON API round trip', () => {
  const adapter = new UIAdapter(bundle('1.1').ir);
  const source = {
    uid: 'prod1', crud: 'I', prodId: { id: 'P' }, bkdns: {
      bkdn: [
        { '@_uid': 'bkdn1', '@_xmlns:local': 'urn:first', bkdnType: { code: 'SY' } },
        { '@_uid': 'bkdn2', '@_xmlns:local': 'urn:second', bkdnType: { code: 'SY' } },
      ],
    },
  };
  const edit = adapter.decodeEntity('product', source);
  const fromUI = JSON.parse(JSON.stringify(edit.value));
  fromUI.bkdns.bkdn.reverse();
  fromUI.bkdns.bkdn[0].crud = 'U';
  const stored = adapter.encodeEntity('product', fromUI, edit.state);
  assert.deepEqual(stored.bkdns.bkdn.map((item) => [item['@_uid'], item['@_xmlns:local']]), [
    ['bkdn2', 'urn:second'], ['bkdn1', 'urn:first'],
  ]);
});

test('uid-less edits preserve item metadata and reject ambiguous detached edits', () => {
  const adapter = new UIAdapter(bundle('1.1').ir);
  const source = {
    uid: 'prod1', crud: 'I', prodId: [
      { id: { '#text': 'A', '@_xmlns:local': 'urn:first' } },
      { id: { '#text': 'B', '@_xmlns:local': 'urn:second' } },
    ],
  };
  const edit = adapter.decodeEntity('product', source);
  const detached = JSON.parse(JSON.stringify(edit.value));
  detached.prodId.forEach((item) => { item.id += '-edit'; });
  assert.throws(() => adapter.encodeEntity('product', detached, edit.state), /cannot safely match/);
  edit.value.prodId.reverse();
  edit.value.prodId.forEach((item) => { item.id += '-edit'; });
  const stored = adapter.encodeEntity('product', edit.value, edit.state);
  assert.deepEqual(stored.prodId.map((item) => [item.id['#text'], item.id['@_xmlns:local']]), [
    ['B-edit', 'urn:second'], ['A-edit', 'urn:first'],
  ]);
});

test('adapter state is isolated by instance, operation and type, and serialized IR works', () => {
  const ir = bundle('1.1').ir;
  const snapshot = JSON.parse(JSON.stringify(ir, (_key, value) => (
    value instanceof Map ? Object.fromEntries(value) : value
  )));
  const adapter = new UIAdapter(snapshot);
  const edit = adapter.decodeEntity('product', { uid: 'prod1', crud: 'I', prodId: { id: '001234' } });
  assert.throws(() => new UIAdapter(ir).encodeEntity('product', edit.value, edit.state), /different adapter/);
  assert.throws(() => adapter.encodeRow('product', edit.value, edit.state), /different adapter/);
  assert.throws(() => adapter.encodeEntity('productVariant', edit.value, edit.state), /different adapter/);
  assert.deepEqual(Object.keys(edit.state), []);
  assert.deepEqual(adapter.decodeEntity('product', adapter.encodeEntity('product', edit.value, edit.state)).value, edit.value);
});

test('metadata-bearing values require their edit state and cannot silently move between fields', () => {
  const adapter = new UIAdapter(bundle('1.1').ir);
  const edit = adapter.decodeEntity('product', {
    uid: 'prod1', crud: 'I', prodId: { id: { '#text': 'P', '@_xmlns:local': 'urn:kept' } },
  });
  assert.throws(() => adapter.encodeEntity('product', edit.value), /matching edit state/);
  const other = adapter.decodeEntity('product', { uid: 'prod2', crud: 'I', prodId: { id: 'Q' } });
  other.value.prodId = edit.value.prodId;
  assert.throws(() => adapter.encodeEntity('product', other.value, other.state), /different edit location/);
});
