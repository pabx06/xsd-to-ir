const path = require('node:path');
const Ajv = require('ajv');
const { XMLParser } = require('fast-xml-parser');
const { IRBuilder } = require('../../src/ir-builder');
const { parseXSD } = require('../../src/xsd-parser');
const { generateJSONSchema } = require('../../src/json-schema-generator');
const { validateValueAssertions } = require('../../src/assertion-validator');
const { deserializeXML } = require('../../src/xml-deserializer');
const { XMLSerializer } = require('../../src/xml-serializer');
const { s3000lEnvelope } = require('./s3000l-fixtures');
const realCases = require('../fixtures/assertion-baseline-cases.json');

const ROOT = path.resolve(__dirname, '../..');
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const sources = {
  1.1: 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd',
  '2.0': 's3000l/2_0/s3000l_2-0_lsaDataset.xsd',
  fixture: 'test/fixtures/assertion-baseline-shapes.xsd',
};
const bundles = new Map();
const literalParser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false,
});
const pointer = (name) => name.replace(/~/g, '~0').replace(/\//g, '~1');

function bundle(issue) {
  if (!bundles.has(issue)) {
    const ir = new IRBuilder(parseXSD(path.join(ROOT, sources[issue]))).build();
    const schema = generateJSONSchema(ir);
    const ajv = new Ajv({ allErrors: true, coerceTypes: false, logger: false });
    ajv.addFormat('duration', /^-?P/);
    ajv.addSchema(schema, 'baseline');
    bundles.set(issue, { ir, schema, ajv });
  }
  return bundles.get(issue);
}

function fixtureColumn(field) {
  const col = bundle('fixture').ir.entities.get('product').columns.find((item) => item.name === field);
  if (!col?.valueTypeRef) throw new Error(`Missing inline value column: ${field}`);
  return col;
}

function caseValue(item) {
  // Catalog probes are complex values: an empty root represents {}. Empty
  // primitive leaves remain '', which matters for XPath node existence.
  return item.issue === 'fixture' ? item.value : literalParser.parse(item.xml).probe || {};
}

function runtimeResult(item) {
  const type = item.issue === 'fixture' ? fixtureColumn(item.field).xsdType : item.typeName;
  return validateValueAssertions(bundle(item.issue).ir, type, caseValue(item));
}

function schemaValidator(item) {
  const target = item.issue === 'fixture'
    ? `$defs/product/properties/${pointer(item.field)}` : `definitions/${pointer(item.typeName)}`;
  return bundle(item.issue).ajv.compile({ $ref: `baseline#/${target}` });
}

function productXml(item) {
  return `<prod uid="prod1" crud="I" xmlns:xsi="${XSI}">${item.xml}</prod>`;
}

function importCase(item) {
  const xml = s3000lEnvelope({ primary: `<products>${productXml(item)}</products>` });
  return deserializeXML(xml, bundle('fixture').ir).batches.get('product').insert[0];
}

async function exportCase(item) {
  const row = { uid: 'prod1', [fixtureColumn(item.field).columnName]: JSON.stringify(item.value) };
  const db = { queryEntity: async (name) => (name === 'product' ? [row] : []) };
  return new XMLSerializer(bundle('fixture').ir, db).serialize({ collections: ['product'] });
}

function oracleCase(item) {
  if (item.issue === 'fixture') return { xsd: sources.fixture, xml: productXml(item) };
  const probe = item.xml.replace('<probe', `<probe xsi:type="s:${item.typeName}"`);
  return {
    xsd: `test/fixtures/assertion-baseline-issue-${item.issue}.xsd`,
    xml: `<case xmlns:s="http://www.asd-europe.org/s-series/s3000l" xmlns:xsi="${XSI}">`
      + `<anchor uid="${item.anchorUid || 'ref1'}"/>${probe}</case>`,
  };
}

function shapeCase(id, field, xml, value, expectedXsd, gaps = {}) {
  return {
    id, issue: 'fixture', field, xml, value, expectedXsd, expectedAssertion: expectedXsd,
    ...(!expectedXsd ? { xsdErrorMatch: 'cvc-assertion' } : {}),
    gaps,
  };
}

const runtimeGap = (id) => ({ runtime: id, import: id, export: id });
const allGap = (id) => ({ ...runtimeGap(id), schema: id });
const both = { '@_uidRef': 'ref1', id: 'ID-1' };
const shapeCases = [
  shapeCase('grouped-uid', 'grouped', '<grouped uidRef="ref1"/>', { '@_uidRef': 'ref1' }, true),
  shapeCase('grouped-id', 'grouped', '<grouped><id>ID-1</id></grouped>', { id: 'ID-1' }, true),
  shapeCase('grouped-code', 'grouped', '<grouped><code>CODE-1</code></grouped>', { code: 'CODE-1' }, true),
  shapeCase(
    'grouped-two-members',
    'grouped',
    '<grouped><id>ID-1</id><code>CODE-1</code></grouped>',
    { id: 'ID-1', code: 'CODE-1' },
    true,
  ),
  shapeCase('grouped-neither', 'grouped', '<grouped/>', {}, false),
  shapeCase('grouped-both-groups', 'grouped', '<grouped uidRef="ref1"><id>ID-1</id></grouped>', both, false),
  shapeCase('grouped-empty-id', 'grouped', '<grouped><id/></grouped>', { id: '' }, true),
  shapeCase(
    'grouped-repeated-valid',
    'grouped',
    '<grouped uidRef="ref1"/><grouped><id>ID-1</id></grouped>',
    [{ '@_uidRef': 'ref1' }, { id: 'ID-1' }],
    true,
  ),
  shapeCase(
    'grouped-repeated-invalid',
    'grouped',
    '<grouped uidRef="ref1"/><grouped uidRef="ref2"><code>CODE-1</code></grouped>',
    [{ '@_uidRef': 'ref1' }, { '@_uidRef': 'ref2', code: 'CODE-1' }],
    false,
  ),
  shapeCase(
    'grouped-uid-empty-id',
    'grouped',
    '<grouped uidRef="ref1"><id/></grouped>',
    { '@_uidRef': 'ref1', id: '' },
    false,
  ),
  shapeCase('direct-identifier', 'direct', '<direct><id>ID-1</id></direct>', { id: 'ID-1' }, true),
  shapeCase('direct-uid', 'direct', '<direct uidRef="ref1"/>', { '@_uidRef': 'ref1' }, true),
  shapeCase('direct-neither', 'direct', '<direct/>', {}, false),
  shapeCase('direct-both', 'direct', '<direct uidRef="ref1"><id>ID-1</id></direct>', both, false),
  shapeCase('empty-element', 'direct', '<direct><id/></direct>', { id: '' }, true, allGap('ASSERT-002')),
  shapeCase('empty-attribute', 'direct', '<direct uidRef=""/>', { '@_uidRef': '' }, true, allGap('ASSERT-002')),
  shapeCase(
    'uid-and-empty-element',
    'direct',
    '<direct uidRef="ref1"><id/></direct>',
    { '@_uidRef': 'ref1', id: '' },
    false,
    allGap('ASSERT-002'),
  ),
  shapeCase(
    'nil-element',
    'direct',
    '<direct><id xsi:nil="true"/></direct>',
    { id: { '@_xsi:nil': 'true' } },
    true,
  ),
  shapeCase('false-element', 'flag', '<flag><flag>false</flag></flag>', { flag: false }, true),
  shapeCase('zero-element', 'number', '<number><number>0</number></number>', { number: 0 }, true),
  shapeCase(
    'uid-and-false-element',
    'flag',
    '<flag uidRef="ref1"><flag>false</flag></flag>',
    { '@_uidRef': 'ref1', flag: false },
    false,
  ),
  shapeCase('repeat-singleton', 'repeated', '<repeated><id>ID-1</id></repeated>', { id: 'ID-1' }, true),
  shapeCase(
    'repeat-one-array',
    'repeated',
    '<repeated><id>ID-1</id></repeated>',
    [{ id: 'ID-1' }],
    true,
  ),
  shapeCase(
    'repeat-two-array',
    'repeated',
    '<repeated><id>ID-1</id></repeated><repeated uidRef="ref1"/>',
    [{ id: 'ID-1' }, { '@_uidRef': 'ref1' }],
    true,
  ),
  shapeCase(
    'repeat-invalid-member',
    'repeated',
    '<repeated><id>ID-1</id></repeated><repeated uidRef="ref1"><id>ID-1</id></repeated>',
    [{ id: 'ID-1' }, both],
    false,
  ),
  shapeCase('anonymous-valid', 'anonymous', '<anonymous><id>ID-1</id></anonymous>', { id: 'ID-1' }, true),
  shapeCase(
    'anonymous-invalid',
    'anonymous',
    '<anonymous uidRef="ref1"><id>ID-1</id></anonymous>',
    both,
    false,
    runtimeGap('ASSERT-004'),
  ),
  shapeCase(
    'derived-valid',
    'derived',
    '<derived><id>ID-1</id><label>L</label></derived>',
    { id: 'ID-1', label: 'L' },
    true,
  ),
  shapeCase(
    'derived-invalid',
    'derived',
    '<derived uidRef="ref1"><id>ID-1</id></derived>',
    both,
    false,
    runtimeGap('ASSERT-005'),
  ),
  shapeCase(
    'nested-valid-array',
    'nested',
    '<nested><ref><id>ID-1</id></ref><ref uidRef="ref1"/></nested>',
    { ref: [{ id: 'ID-1' }, { '@_uidRef': 'ref1' }] },
    true,
  ),
  shapeCase(
    'nested-invalid-array',
    'nested',
    '<nested><ref><id>ID-1</id></ref><ref uidRef="ref1"><id>ID-1</id></ref></nested>',
    { ref: [{ id: 'ID-1' }, both] },
    false,
  ),
  shapeCase(
    'depth-two-invalid',
    'depthTwo',
    '<depthTwo><middle><ref uidRef="ref1"><id>ID-1</id></ref></middle></depthTwo>',
    { middle: { ref: both } },
    false,
  ),
  shapeCase(
    'depth-three-invalid',
    'deep',
    '<deep><outer><middle><ref uidRef="ref1"><id>ID-1</id></ref></middle></outer></deep>',
    { outer: { middle: { ref: both } } },
    false,
    runtimeGap('ASSERT-006'),
  ),
  shapeCase(
    'depth-three-valid',
    'deep',
    '<deep><outer><middle><ref><id>ID-1</id></ref></middle></outer></deep>',
    { outer: { middle: { ref: { id: 'ID-1' } } } },
    true,
  ),
  shapeCase(
    'recursive-invalid',
    'recursive',
    '<recursive><child><ref uidRef="ref1"><id>ID-1</id></ref></child></recursive>',
    { child: { ref: both } },
    false,
    runtimeGap('ASSERT-006'),
  ),
  shapeCase(
    'recursive-valid',
    'recursive',
    '<recursive><child><ref><id>ID-1</id></ref></child></recursive>',
    { child: { ref: { id: 'ID-1' } } },
    true,
  ),
  shapeCase(
    'anonymous-nested-invalid',
    'anonymousNested',
    '<anonymousNested><ref uidRef="ref1"><id>ID-1</id></ref></anonymousNested>',
    { ref: both },
    false,
    runtimeGap('ASSERT-004'),
  ),
  shapeCase(
    'comparison-valid',
    'comparison',
    '<comparison><lower>1</lower><upper>2</upper></comparison>',
    { lower: 1, upper: 2 },
    true,
  ),
  {
    ...shapeCase(
      'comparison-invalid',
      'comparison',
      '<comparison><lower>3</lower><upper>2</upper></comparison>',
      { lower: 3, upper: 2 },
      false,
    ), boundary: true,
  },
];

function inventory(issue) {
  const { ir, schema } = bundle(issue);
  const rules = [...ir.assertions.values()].flatMap((set) => set.rules);
  const emitted = new Set(Object.values(schema.definitions).flatMap((def) => def['x-xsd-assertions'] || []));
  return {
    issue,
    extracted: rules.length,
    exactlyOne: rules.filter((rule) => rule.kind === 'exactlyOne').length,
    exactlyOneGroup: rules.filter((rule) => rule.kind === 'exactlyOneGroup').length,
    rawXPath: rules.filter((rule) => rule.kind === 'rawXPath').length,
    referencedByValueDefinitions: emitted.size,
    outsideValueDefinitions: rules.filter((rule) => !emitted.has(rule.id)).map((rule) => rule.id).sort(),
  };
}

module.exports = {
  ROOT, bundle, caseValue, exportCase, fixtureColumn, importCase, inventory,
  literalParser, oracleCase, realCases, runtimeResult, schemaValidator, shapeCases,
};
