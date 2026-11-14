const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const {
  parseXSD, IRBuilder, generateUIJSONSchema,
} = require('../lib');
const { generateJSONSchema } = require('../src/json-schema-generator');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-enum-annotations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schema.xsd');
  fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:simpleType name="RoleCode"><xs:restriction base="xs:string">
      <xs:enumeration value="DRW"><xs:annotation>
        <xs:appinfo source="https://example.com/roles">SX001G:drawingReference</xs:appinfo>
        <xs:documentation xml:lang="en">Role: drawing reference. See https://example.com/drawings.</xs:documentation>
      </xs:annotation></xs:enumeration>
      <xs:enumeration value="REF"><xs:annotation><xs:appinfo><source>SX001G:documentReference</source></xs:appinfo></xs:annotation></xs:enumeration>
      <xs:enumeration value="RAW"/>
    </xs:restriction></xs:simpleType>
    <xs:simpleType name="NarrowCode"><xs:restriction base="RoleCode"><xs:enumeration value="DRW"/></xs:restriction></xs:simpleType>
    <xs:simpleType name="UnannotatedCode"><xs:restriction base="RoleCode"><xs:enumeration value="RAW"/></xs:restriction></xs:simpleType>
    <xs:complexType name="Payload"><xs:sequence>
      <xs:element name="code" type="RoleCode"/>
      <xs:element name="narrow" type="NarrowCode" minOccurs="0"/>
      <xs:element name="raw" type="UnannotatedCode" minOccurs="0"/>
    </xs:sequence></xs:complexType>
    <xs:complexType name="record"><xs:sequence>
      <xs:element name="role" type="RoleCode"/>
      <xs:element name="payload" type="Payload"/>
    </xs:sequence><xs:attribute name="uid" type="xs:ID"/><xs:attribute name="crud" type="xs:string"/></xs:complexType>
  </xs:schema>`);
  return parseXSD(file);
}

const drawing = {
  appInfo: ['SX001G:drawingReference'],
  documentation: ['Role: drawing reference. See https://example.com/drawings.'],
};

test('XSD annotation text retains prefixes, colons and source URLs', (t) => {
  const schema = fixture(t);
  const annotation = schema.simpleType[0].restriction[0].enumeration[0].annotation[0];
  assert.equal(annotation.appinfo['#text'], 'SX001G:drawingReference');
  assert.equal(annotation.appinfo['@_source'], 'https://example.com/roles');
  assert.equal(annotation.documentation[0]['#text'], drawing.documentation[0]);
});

test('enum annotations reach the IR and both schemas without changing allowed values', (t) => {
  const ir = new IRBuilder(fixture(t)).build();
  assert.deepEqual(ir.enums.get('RoleCode').values, ['DRW', 'REF', 'RAW']);
  assert.deepEqual(ir.enums.get('RoleCode').enumAnnotations.DRW, drawing);
  assert.deepEqual(ir.enums.get('NarrowCode').enumAnnotations.DRW, drawing);
  const fields = ir.valueTypes.get('Payload').content.children[0].children;
  assert.deepEqual(fields[0].type.enumAnnotations.DRW, drawing);
  assert.deepEqual(Object.keys(fields[1].type.enumAnnotations), ['DRW']);
  assert.deepEqual(fields[2].type.enumAnnotations, {});
  for (const generate of [generateJSONSchema, generateUIJSONSchema]) {
    const schema = generate(ir, { rootEntity: 'record' });
    assert.deepEqual(schema.$defs.RoleCode['x-xsd-enum-annotations'].DRW, drawing);
    const code = schema.definitions.Payload.properties.code;
    const scalar = generate === generateJSONSchema ? code.anyOf[0] : code;
    assert.deepEqual(scalar['x-xsd-enum-annotations'].DRW, drawing);
    const validate = new Ajv({ logger: false }).compile(schema);
    const value = {
      uid: 'record1', crud: 'I', role: 'DRW', payload: { code: 'DRW' },
    };
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, payload: { code: 'Drawing reference' } }), false);
    assert.equal(validate({ ...value, role: 'Drawing reference' }), false);
  }
  const ui = generateUIJSONSchema(ir);
  assert.deepEqual(ui.$defs.record.properties.role['x-xsd-enum-annotations'].DRW, drawing);
});

test('bundled enum meanings stay specific to the issue and enumeration type', () => {
  const issue11 = new IRBuilder(parseXSD('s3000l/1_1/s3000l_1-1_lsa_dataset.xsd')).build();
  assert.deepEqual(issue11.enums.get('documentAssignmentRoleCodeValues').enumAnnotations.DRW, {
    appInfo: ['SX001G:drawingReference'],
  });
  assert.deepEqual(issue11.enums.get('documentTypeCodeValues').enumAnnotations.DRW, {
    appInfo: ['SX001G:drawingDocument'],
  });
  const issue20 = new IRBuilder(parseXSD('s3000l/2_0/s3000l_2-0_lsaDataset.xsd')).build();
  assert.deepEqual(issue20.enums.get('referencedDocumentRoleCode').enumAnnotations.DRW, {
    appInfo: ['SX001G:drawingDocumentReference'],
  });
});
