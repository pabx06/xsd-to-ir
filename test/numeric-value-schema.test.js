const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { generateJSONSchema } = require('../src/json-schema-generator');

const LARGE_INTEGER = '9007199254740993';
const LARGE_INTEGER_NEIGHBOR = '9007199254740992';
const PRECISE_DECIMAL = '1.234567890123456789';
const PRECISE_DECIMAL_NEIGHBOR = '1.234567890123456788';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-numeric-value-schema-'));
  try {
    const file = path.join(dir, 'fixture.xsd');
    fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:complexType name="record"><xs:sequence>
        <xs:element name="payload" type="Payload"/>
      </xs:sequence>
      <xs:attribute name="uid" type="xs:ID"/><xs:attribute name="crud" type="xs:string"/>
      </xs:complexType>
      <xs:simpleType name="LargeIntegerEnum"><xs:restriction base="xs:integer">
        <xs:enumeration value="${LARGE_INTEGER}"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="PreciseDecimalEnum"><xs:restriction base="xs:decimal">
        <xs:enumeration value="${PRECISE_DECIMAL}"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="BoundedInteger"><xs:restriction base="xs:integer">
        <xs:minInclusive value="2"/><xs:maxExclusive value="5"/><xs:totalDigits value="1"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="BoundedDecimal"><xs:restriction base="xs:decimal">
        <xs:minInclusive value="-1.50"/><xs:maxInclusive value="2.50"/>
        <xs:totalDigits value="3"/><xs:fractionDigits value="2"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="PatternDecimal"><xs:restriction base="xs:decimal">
        <xs:pattern value="[+]?[0-9]+\\.[0-9]{2}"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="NamedDecimal"><xs:restriction base="xs:decimal"/></xs:simpleType>
      <xs:simpleType name="NamedDouble"><xs:restriction base="xs:double"/></xs:simpleType>
      <xs:simpleType name="SmallDecimalEnum"><xs:restriction base="xs:decimal">
        <xs:enumeration value="1.2300"/><xs:enumeration value="-0.0005000"/>
        <xs:enumeration value="0"/><xs:enumeration value="0.00000000000000000000000000123"/>
      </xs:restriction></xs:simpleType>
      <xs:simpleType name="ExactBound"><xs:restriction base="xs:decimal">
        <xs:minExclusive value="${PRECISE_DECIMAL}"/>
      </xs:restriction></xs:simpleType>
      <xs:complexType name="IntegerText"><xs:simpleContent>
        <xs:extension base="LargeIntegerEnum"><xs:attribute name="unit" type="xs:string"/></xs:extension>
      </xs:simpleContent></xs:complexType>
      <xs:complexType name="Payload"><xs:sequence>
        <xs:element name="integer" type="xs:integer" minOccurs="0"/>
        <xs:element name="decimal" type="xs:decimal" minOccurs="0"/>
        <xs:element name="float" type="xs:float" minOccurs="0"/>
        <xs:element name="double" type="xs:double" minOccurs="0"/>
        <xs:element name="namedDecimal" type="NamedDecimal" minOccurs="0"/>
        <xs:element name="namedDouble" type="NamedDouble" minOccurs="0"/>
        <xs:element name="smallDecimalEnum" type="SmallDecimalEnum" minOccurs="0"/>
        <xs:element name="exactBound" type="ExactBound" minOccurs="0"/>
        <xs:element name="integerEnum" type="LargeIntegerEnum" minOccurs="0"/>
        <xs:element name="decimalEnum" type="PreciseDecimalEnum" minOccurs="0"/>
        <xs:element name="boundedInteger" type="BoundedInteger" minOccurs="0"/>
        <xs:element name="boundedDecimal" type="BoundedDecimal" minOccurs="0"/>
        <xs:element name="patternDecimal" type="PatternDecimal" minOccurs="0"/>
        <xs:element name="fixedInteger" type="xs:integer" fixed="${LARGE_INTEGER}" minOccurs="0"/>
        <xs:element name="fixedDecimal" type="xs:decimal" fixed="${PRECISE_DECIMAL}" minOccurs="0"/>
        <xs:element name="defaultInteger" type="xs:integer" default="${LARGE_INTEGER}" minOccurs="0"/>
        <xs:element name="defaultDecimal" type="xs:decimal" default="${PRECISE_DECIMAL}" minOccurs="0"/>
        <xs:element name="integerText" type="IntegerText" minOccurs="0"/>
        <xs:element name="repeatedDecimal" type="xs:decimal" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence>
      <xs:attribute name="integer" type="xs:integer"/>
      <xs:attribute name="decimal" type="xs:decimal"/>
      <xs:attribute name="double" type="xs:double"/>
      </xs:complexType>
    </xs:schema>`);
    const ir = new IRBuilder(parseXSD(file)).build();
    const schema = JSON.parse(JSON.stringify(generateJSONSchema(ir)));
    const ajv = new Ajv({ allErrors: true, coerceTypes: false, logger: false });
    ajv.addSchema(schema, 'numeric-root');
    return {
      ir,
      schema,
      validate: ajv.compile({ $ref: 'numeric-root#/definitions/Payload' }),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const bundle = fixture();

function expectValid(value) {
  assert.equal(bundle.validate(value), true, JSON.stringify(bundle.validate.errors));
}

function expectInvalid(value) {
  assert.equal(bundle.validate(value), false, `unexpectedly accepted ${JSON.stringify(value)}`);
}

function objectNodes(value) {
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objectNodes)];
}

function extension(schema, keyword) {
  const node = objectNodes(schema).find((item) => item[keyword] !== undefined);
  assert.ok(node, `${keyword} must be present in ${JSON.stringify(schema)}`);
  return node[keyword];
}

test('numeric elements accept exact strings and safe JSON numbers after schema serialization', () => {
  expectValid({
    integer: LARGE_INTEGER,
    decimal: PRECISE_DECIMAL,
    float: '1.25E+3',
    double: '-INF',
    repeatedDecimal: [PRECISE_DECIMAL, '-0.000000000000000001'],
  });
  expectValid({
    integer: 42, decimal: 12.5, float: 1250, double: -0.25,
  });
  expectValid({
    integer: '+00042', decimal: '-.5', float: 'NaN', double: 'INF',
  });
});

test('integer strings use the XSD integer lexical space', () => {
  expectValid({ integer: '  +0042  ' });
  for (const value of ['letters', '', '   ', '4 2', '0x2A', '42.0', '1e3']) {
    expectInvalid({ integer: value });
  }
});

test('decimal strings reject integer-incompatible and floating-point-only spellings', () => {
  expectValid({ decimal: '  -1.5  ' });
  for (const value of ['letters', '', '   ', '1 .5', '0x1.8', '1e3', 'INF', '-INF', 'NaN']) {
    expectInvalid({ decimal: value });
  }
  expectValid({ decimal: '42' });
  expectValid({ decimal: '+42.' });
  expectValid({ decimal: '.125' });
});

test('float and double strings accept XSD scientific and special forms', () => {
  for (const field of ['float', 'double']) {
    for (const value of ['1E3', '-2.5e-4', 'INF', '-INF', 'NaN']) expectValid({ [field]: value });
    for (const value of ['', '1 E3', 'Infinity', 'nan', '0x1p4']) expectInvalid({ [field]: value });
  }
});

test('named restrictions retain decimal versus double lexical behavior', () => {
  expectValid({ namedDecimal: PRECISE_DECIMAL, namedDouble: '1.0E20' });
  expectValid({ namedDouble: 'NaN' });
  expectInvalid({ namedDecimal: '1.0E20' });
  expectInvalid({ namedDecimal: 'NaN' });
});

test('numeric simpleContent, attributes and repeated fields accept exact lexical strings', () => {
  expectValid({ integerText: LARGE_INTEGER });
  expectValid({ integerText: { '#text': LARGE_INTEGER, '@_unit': 'count' } });
  expectValid({
    '@_integer': LARGE_INTEGER,
    '@_decimal': PRECISE_DECIMAL,
    '@_double': '1.25E+3',
    repeatedDecimal: [PRECISE_DECIMAL, '2.000000000000000001'],
  });
  expectInvalid({ integerText: { '#text': LARGE_INTEGER_NEIGHBOR, '@_unit': 'count' } });
  expectInvalid({ '@_integer': '1.5' });
  expectInvalid({ '@_decimal': '1E3' });
});

test('large numeric enum and fixed restrictions reject rounded neighbors', () => {
  expectValid({ integerEnum: LARGE_INTEGER, decimalEnum: PRECISE_DECIMAL });
  expectValid({ fixedInteger: LARGE_INTEGER, fixedDecimal: PRECISE_DECIMAL });
  expectValid({ fixedInteger: { '#text': LARGE_INTEGER } });
  expectInvalid({ integerEnum: LARGE_INTEGER_NEIGHBOR });
  expectInvalid({ decimalEnum: PRECISE_DECIMAL_NEIGHBOR });
  expectInvalid({ fixedInteger: LARGE_INTEGER_NEIGHBOR });
  expectInvalid({ fixedDecimal: PRECISE_DECIMAL_NEIGHBOR });
  expectInvalid({ fixedInteger: { '#text': LARGE_INTEGER_NEIGHBOR } });
  expectInvalid({ integerEnum: Number(LARGE_INTEGER) });
  expectInvalid({ decimalEnum: Number(PRECISE_DECIMAL) });
  expectInvalid({ fixedInteger: Number(LARGE_INTEGER) });
  expectInvalid({ fixedDecimal: Number(PRECISE_DECIMAL) });

  const properties = bundle.schema.definitions.Payload.properties;
  const integerEnum = extension(properties.integerEnum, 'x-xsd-enumeration');
  const decimalEnum = extension(properties.decimalEnum, 'x-xsd-enumeration');
  const fixedInteger = extension(properties.fixedInteger, 'x-xsd-fixed');
  const fixedDecimal = extension(properties.fixedDecimal, 'x-xsd-fixed');
  assert.deepEqual(integerEnum, [LARGE_INTEGER]);
  assert.deepEqual(decimalEnum, [PRECISE_DECIMAL]);
  assert.equal(fixedInteger, LARGE_INTEGER);
  assert.equal(fixedDecimal, PRECISE_DECIMAL);
});

test('numeric enum and fixed restrictions accept equivalent XSD lexical forms', () => {
  expectValid({ integerEnum: '+09007199254740993', fixedInteger: '09007199254740993' });
  expectValid({ decimalEnum: '+01.2345678901234567890', fixedDecimal: '1.23456789012345678900' });
});

test('large numeric defaults retain their exact strings in generated JSON Schema', () => {
  const properties = bundle.schema.definitions.Payload.properties;
  assert.equal(properties.defaultInteger.default, LARGE_INTEGER);
  assert.equal(properties.defaultDecimal.default, PRECISE_DECIMAL);
  assert.notEqual(properties.defaultInteger.default, Number(LARGE_INTEGER));
  assert.notEqual(properties.defaultDecimal.default, Number(PRECISE_DECIMAL));
});

test('safe number branches still enforce numeric bounds', () => {
  expectValid({ boundedInteger: 2, boundedDecimal: -1.5 });
  expectValid({ boundedInteger: 4, boundedDecimal: 2.5 });
  expectInvalid({ boundedInteger: 1 });
  expectInvalid({ boundedInteger: 5 });
  expectInvalid({ boundedDecimal: -1.51 });
  expectInvalid({ boundedDecimal: 2.51 });
});

test('unrepresentable string facets keep exact metadata and visible XSD warnings', () => {
  const { Payload } = bundle.schema.definitions;
  const warnings = Payload['x-xsd-unsupported'];
  assert.ok(Array.isArray(warnings));
  assert.ok(warnings.some((reason) => (
    /numeric bounds and digit facets on lexical strings require XSD validation/i.test(reason)
  )));

  const integerFacets = extension(Payload.properties.boundedInteger, 'x-xsd-facets');
  assert.deepEqual(integerFacets, { minInclusive: '2', maxExclusive: '5', totalDigits: '1' });
  const decimalFacets = extension(Payload.properties.boundedDecimal, 'x-xsd-facets');
  assert.deepEqual(decimalFacets, {
    minInclusive: '-1.50', maxInclusive: '2.50', totalDigits: '3', fractionDigits: '2',
  });

  // Stock JSON Schema cannot apply these numeric facets to arbitrary-precision strings.
  expectValid({ boundedInteger: '1', boundedDecimal: '1000.999' });
});

test('supported XSD patterns constrain numeric string branches', () => {
  expectValid({ patternDecimal: '+12.34' });
  expectInvalid({ patternDecimal: '12.3' });
  expectInvalid({ patternDecimal: 'prefix12.34suffix' });
  // The numeric branch remains available when the XML parser emitted a safe number.
  expectValid({ patternDecimal: 12.34 });
});

test('exact enum comparison handles negative fractions, signed zero and numbers printed as exponents', () => {
  for (const value of ['1.23', '+0001.23000', '-.00050', '-0', '+00.000', 1.23, -0.0005, 0, 1.23e-27]) {
    expectValid({ smallDecimalEnum: value });
  }
  for (const value of ['1.23001', '.0005', '-0.001', '-1.23', 1.24, 1.23e-28]) {
    expectInvalid({ smallDecimalEnum: value });
  }
});

test('unrepresentable bounds remain exact annotations instead of rounded JSON numeric keywords', () => {
  const { Payload } = bundle.schema.definitions;
  const property = Payload.properties.exactBound;
  assert.deepEqual(extension(property, 'x-xsd-facets'), { minExclusive: PRECISE_DECIMAL });
  assert.ok(objectNodes(property).every((node) => node.exclusiveMinimum === undefined));
  assert.ok(Payload['x-xsd-unsupported'].some((reason) => reason.includes('Exact numeric minExclusive')));
  expectValid({ exactBound: '1.234567890123456790' });
});
