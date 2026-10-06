const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const Ajv = require('ajv');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { generateJSONSchema } = require('../src/json-schema-generator');
const { deserializeXML } = require('../src/xml-deserializer');

const paths = {
  1.1: 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd',
  '2.0': 's3000l/2_0/s3000l_2-0_lsaDataset.xsd',
};
const bundled = new Map();

function dialect(version) {
  if (!bundled.has(version)) {
    const ir = new IRBuilder(parseXSD(paths[version])).build();
    bundled.set(version, { ir, schema: generateJSONSchema(ir) });
  }
  return bundled.get(version);
}

function pointer(name) {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

function validator(schema, fragment) {
  const ajv = new Ajv({ allErrors: true, logger: false });
  ajv.addFormat('duration', /^-?P/);
  ajv.addSchema(schema, 'test-root');
  return ajv.compile({ $ref: `test-root#/${fragment}` });
}

function expectValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function elements(particle) {
  if (!particle) return [];
  return particle.kind === 'element' ? [particle] : particle.children.flatMap(elements);
}

function fixture(definitions, payload = 'type="Payload"') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-value-type-'));
  try {
    const file = path.join(dir, 'fixture.xsd');
    fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:complexType name="record">
        <xs:sequence><xs:element name="payload" ${payload}/></xs:sequence>
        <xs:attribute name="uid" type="xs:ID"/>
        <xs:attribute name="crud" type="xs:string"/>
      </xs:complexType>
      ${definitions}
    </xs:schema>`);
    const ir = new IRBuilder(parseXSD(file)).build();
    return { ir, schema: generateJSONSchema(ir) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const version of Object.keys(paths)) {
  test(`Issue ${version}: every inline column and nested reference has a value definition`, () => {
    const { ir, schema } = dialect(version);
    for (const entity of ir.entities.values()) {
      for (const column of entity.columns.filter((item) => item.sqlType === 'LONGTEXT' && item.jsonType === 'object')) {
        assert.ok(column.valueTypeRef, `${entity.name}.${column.name}`);
        assert.ok(ir.valueTypes.has(column.valueTypeRef), column.valueTypeRef);
        assert.ok(schema.definitions[column.valueTypeRef], column.valueTypeRef);
      }
    }
    for (const type of ir.valueTypes.values()) {
      for (const field of [...elements(type.content), ...type.attributes]) {
        if (field.type.valueTypeRef) assert.ok(ir.valueTypes.has(field.type.valueTypeRef), field.type.valueTypeRef);
      }
    }
    assert.doesNotThrow(() => JSON.stringify(ir.valueTypes ? Object.fromEntries(ir.valueTypes) : {}));
    const id = ir.valueTypes.get('productIdentifier');
    const fields = elements(id.content);
    assert.equal(fields.find((field) => field.name === 'id').minOccurs, 1);
    assert.equal(fields.find((field) => field.name === 'class').minOccurs, 0);
    assert.equal(fields.find((field) => field.name === 'setBy').minOccurs, 0);
    assert.equal(ir.entities.has('productIdentifier'), false);
  });

  test(`Issue ${version}: generated product identifier schema validates nested fields and repeats`, () => {
    const { schema } = dialect(version);
    const validate = validator(schema, '$defs/product/properties/prodId');
    expectValid(validate, { id: 'PRODUCT-1' });
    expectValid(validate, [{ id: 'PRODUCT-1' }, { id: 'PRODUCT-2' }]);
    expectValid(validate, { id: 'PRODUCT-1', setBy: { '@_uidRef': 'org1' } });
    assert.equal(validate({}), false);
    assert.equal(validate({ id: '' }), false);
    assert.equal(validate([]), false);
    assert.equal(validate(null), false);
    assert.equal(validate([{ id: 'PRODUCT-1' }, {}]), false);
    assert.equal(validate({ id: 'PRODUCT-1', setBy: {} }), false);
    assert.equal(validate({ id: 'PRODUCT-1', setBy: { '@_uidRef': 'org1', orgId: { id: 'ORG-1' } } }), false);
    assert.equal(validate({ id: 'PRODUCT-1', typo: 'unknown field' }), false);
  });
}

test('Issue 1.1 anonymous breakdown wrapper has a stable definition and preserves embedded record attributes', () => {
  const { ir, schema } = dialect('1.1');
  const column = ir.entities.get('product').columns.find((item) => item.name === 'bkdns');
  assert.match(column.valueTypeRef, /^@anonymous\//);
  const again = new IRBuilder(parseXSD(paths['1.1'])).build();
  assert.equal(again.entities.get('product').columns.find((item) => item.name === 'bkdns').valueTypeRef, column.valueTypeRef);
  const fields = elements(ir.valueTypes.get(column.valueTypeRef).content);
  const breakdown = ir.valueTypes.get(fields.find((field) => field.name === 'bkdn').type.valueTypeRef);
  assert.ok(breakdown.attributes.some((field) => field.jsonName === '@_uid'));
  assert.ok(schema.$defs[breakdown.name], 'database entity and raw value definitions coexist');
  const validate = validator(schema, `definitions/${pointer(column.valueTypeRef)}`);
  expectValid(validate, { bkdn: { '@_uid': 'bkdn1', bkdnType: { code: 'SY' } } });
  assert.equal(validate({ bkdn: {} }), false);
});

test('generated schemas accept numeric and boolean text exactly as imported into JSON columns', () => {
  const { ir, schema } = dialect('2.0');
  const xml = `<lsaDataset><msgId>NUMERIC-ID</msgId><msgDate>2026-10-06</msgDate>
    <msgType><code>B</code></msgType><logisticsSupportAnalysisData><lsaPrimaryData><products>
    <prod uid="p1" crud="I"><prodId><id>123</id></prodId></prod>
    <prod uid="p2" crud="I"><prodId><id>true</id></prodId></prod>
    </products></lsaPrimaryData></logisticsSupportAnalysisData></lsaDataset>`;
  const rows = deserializeXML(xml, ir).batches.get('product').insert;
  const values = rows.map((row) => JSON.parse(row.prod_id));
  assert.deepEqual(values, [{ id: 123 }, { id: true }]);
  const validate = validator(schema, '$defs/product/properties/prodId');
  values.forEach((value) => expectValid(validate, value));
  expectValid(validate, { id: '123' });
  assert.equal(validate({ id: '' }), false);
});

test('parser-coerced string enums, fixed values and numeric booleans retain restrictions', () => {
  const { schema } = fixture(`<xs:complexType name="Payload"><xs:sequence>
    <xs:element name="code"><xs:simpleType><xs:restriction base="xs:string">
      <xs:enumeration value="01"/><xs:enumeration value="true"/><xs:enumeration value="ABC"/>
    </xs:restriction></xs:simpleType></xs:element>
    <xs:element name="fixed" type="xs:string" fixed="123"/>
    <xs:element name="flag" type="xs:boolean"/>
    <xs:element name="short" minOccurs="0"><xs:simpleType><xs:restriction base="xs:string">
      <xs:maxLength value="3"/>
    </xs:restriction></xs:simpleType></xs:element>
  </xs:sequence><xs:attribute name="raw" type="xs:string"/></xs:complexType>`);
  const validate = validator(schema, 'definitions/Payload');
  expectValid(validate, {
    code: 1, fixed: 123, flag: 1, '@_raw': '123',
  });
  expectValid(validate, { code: true, fixed: '123', flag: false });
  expectValid(validate, { code: 'ABC', fixed: 123, flag: 0 });
  assert.equal(validate({ code: 2, fixed: 123, flag: true }), false);
  assert.equal(validate({ code: 'WRONG', fixed: 123, flag: true }), false);
  assert.equal(validate({ code: 'ABC', fixed: 12, flag: true }), false);
  assert.equal(validate({ code: 'ABC', fixed: 123, flag: 2 }), false);
  assert.equal(validate({
    code: 'ABC', fixed: 123, flag: true, '@_raw': 123,
  }), false);
  assert.equal(validate({
    code: 'ABC', fixed: 123, flag: true, short: 'long',
  }), false);
  assert.ok(schema.definitions.Payload['x-xsd-unsupported'].some((reason) => reason.includes('original text spelling')));
});

test('optional groups and choices enforce conditional requiredness without requiring every branch', () => {
  const { ir, schema } = fixture(`
    <xs:group name="pair"><xs:sequence>
      <xs:element name="first" type="xs:string"/>
      <xs:element name="second" type="xs:string"/>
    </xs:sequence></xs:group>
    <xs:complexType name="Payload"><xs:sequence>
      <xs:element name="id"><xs:simpleType><xs:restriction base="xs:string">
        <xs:minLength value="2"/><xs:maxLength value="4"/><xs:pattern value="^[A-Z]+$"/>
      </xs:restriction></xs:simpleType></xs:element>
      <xs:group ref="pair" minOccurs="0"/>
      <xs:choice minOccurs="0">
        <xs:element name="left" type="xs:string"/>
        <xs:sequence><xs:element name="right" type="xs:integer"/><xs:element name="label" type="xs:string"/></xs:sequence>
      </xs:choice>
    </xs:sequence></xs:complexType>`);
  const fields = elements(ir.valueTypes.get('Payload').content);
  assert.equal(fields.find((field) => field.name === 'id').type.constraints.minLength, '2');
  const validate = validator(schema, 'definitions/Payload');
  for (const value of [{ id: 'AB' }, { id: 'AB', first: 'a', second: 'b' }, { id: 'AB', left: 'a' },
    { id: 'AB', right: 1, label: 'b' }]) expectValid(validate, value);
  for (const value of [{ id: 'A' }, { id: 'abc' }, { id: 'ABCDE' }, { id: 'AB', first: 'a' },
    { id: 'AB', right: 1 }, {
      id: 'AB', left: 'a', right: 1, label: 'b',
    }]) {
    assert.equal(validate(value), false, JSON.stringify(value));
  }
});

test('recursive anonymous values, bounded arrays and nillable fields produce working references', () => {
  const { ir, schema } = fixture(`
    <xs:complexType name="Node"><xs:sequence>
      <xs:element name="label" type="xs:string"/>
      <xs:element name="child" type="Node" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence></xs:complexType>
    <xs:complexType name="Payload"><xs:sequence>
      <xs:element name="nodes" minOccurs="2" maxOccurs="3"><xs:complexType><xs:sequence>
        <xs:element name="root" type="Node"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="note" type="xs:string" minOccurs="0" nillable="true"/>
    </xs:sequence></xs:complexType>`);
  const child = elements(ir.valueTypes.get('Node').content).find((field) => field.name === 'child');
  assert.equal(child.type.valueTypeRef, 'Node');
  const validate = validator(schema, 'definitions/Payload');
  const node = { root: { label: 'root', child: { label: 'leaf' } } };
  expectValid(validate, { nodes: [node, node] });
  expectValid(validate, { nodes: [node, node], note: { '@_xsi:nil': 'true' } });
  assert.equal(validate({ nodes: node }), false);
  assert.equal(validate({ nodes: [node] }), false);
  assert.equal(validate({ nodes: [node, node, node, node] }), false);
  assert.equal(validate({ nodes: [node, node], note: null }), false);
  assert.equal(validate({ nodes: [node, node], note: { '@_xsi:nil': 'true', '#text': 'content' } }), false);
  assert.equal(validate({ nodes: [node, { root: { label: 'root', child: {} } }] }), false);
});

test('attributes, simple content and extension retain their XML JSON representation', () => {
  const { schema } = fixture(`
    <xs:attribute name="unit" type="xs:string"/>
    <xs:attributeGroup name="units"><xs:attribute ref="unit" use="required"/></xs:attributeGroup>
    <xs:complexType name="Measure"><xs:simpleContent><xs:extension base="xs:decimal">
      <xs:attributeGroup ref="units"/>
    </xs:extension></xs:simpleContent></xs:complexType>
    <xs:complexType name="Base"><xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence>
      <xs:attribute name="version" type="xs:string" fixed="A"/>
    </xs:complexType>
    <xs:complexType name="Payload"><xs:complexContent><xs:extension base="Base"><xs:sequence>
      <xs:element name="mass" type="Measure" nillable="true"/>
    </xs:sequence><xs:attribute name="state" use="required"><xs:simpleType><xs:restriction base="xs:string">
      <xs:enumeration value="ON"/><xs:enumeration value="OFF"/>
    </xs:restriction></xs:simpleType></xs:attribute></xs:extension></xs:complexContent></xs:complexType>`);
  const validate = validator(schema, 'definitions/Payload');
  const good = { id: 'P1', mass: { '#text': 2.5, '@_unit': 'kg' }, '@_state': 'ON' };
  expectValid(validate, good);
  expectValid(validate, { ...good, mass: { '@_unit': 'kg', '@_xsi:nil': 'true' } });
  expectValid(validate, { ...good, '@_version': 'A' });
  assert.equal(validate({ ...good, mass: 2.5 }), false);
  assert.equal(validate({ ...good, mass: { '@_xsi:nil': 'true' } }), false);
  assert.equal(validate({ ...good, mass: { '#text': 2.5 } }), false);
  assert.equal(validate({ ...good, '@_state': 'WRONG' }), false);
  assert.equal(validate({ ...good, '@_version': 'B' }), false);
  const missingId = { ...good };
  delete missingId.id;
  assert.equal(validate(missingId), false);
});

test('local assertions and union members are retained and enforced where representable', () => {
  const { ir, schema } = fixture(`
    <xs:simpleType name="codeOrCount"><xs:union memberTypes="xs:integer">
      <xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="AUTO"/></xs:restriction></xs:simpleType>
    </xs:union></xs:simpleType>
    <xs:complexType name="Payload"><xs:sequence><xs:element name="reference"><xs:complexType>
      <xs:sequence><xs:element name="id" type="codeOrCount" minOccurs="0"/></xs:sequence>
      <xs:attribute name="uidRef" type="xs:string"/>
      <xs:assert test="(@uidRef and not(id)) or (not(@uidRef) and id)"/>
    </xs:complexType></xs:element></xs:sequence></xs:complexType>`);
  const field = elements(ir.valueTypes.get('Payload').content)[0];
  assert.equal(ir.valueTypes.get(field.type.valueTypeRef).assertionRefs.length, 1);
  const validate = validator(schema, 'definitions/Payload');
  expectValid(validate, { reference: { '@_uidRef': 'item1' } });
  expectValid(validate, { reference: { id: 'AUTO' } });
  expectValid(validate, { reference: { id: 3 } });
  assert.equal(validate({ reference: {} }), false);
  assert.equal(validate({ reference: { '@_uidRef': 'item1', id: 'AUTO' } }), false);
  assert.equal(validate({ reference: { id: 'wrong' } }), false);
});

test('CLI exports value type definitions and JSON Schema references together', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-value-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, ['index.js', paths['1.1'], '--out', dir, '--no-sql'], {
    cwd: path.join(__dirname, '..'), stdio: 'pipe',
  });
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'json-schema.json'), 'utf8'));
  const column = ir.entities.product.columns.find((item) => item.name === 'prodId');
  assert.ok(ir.valueTypes[column.valueTypeRef]);
  expectValid(validator(schema, '$defs/product/properties/prodId'), { id: 'P1' });
});
