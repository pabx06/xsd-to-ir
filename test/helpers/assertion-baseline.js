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
  const column = item.issue === 'fixture' ? fixtureColumn(item.field) : null;
  const type = column ? column.valueTypeRef || column.xsdType : item.typeName;
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
  shapeCase('direct-empty-text', 'direct', '<direct/>', '', false),
  shapeCase('direct-both', 'direct', '<direct uidRef="ref1"><id>ID-1</id></direct>', both, false),
  shapeCase('empty-element', 'direct', '<direct><id/></direct>', { id: '' }, true),
  shapeCase('empty-attribute', 'direct', '<direct uidRef=""/>', { '@_uidRef': '' }, true),
  shapeCase(
    'uid-and-empty-element',
    'direct',
    '<direct uidRef="ref1"><id/></direct>',
    { '@_uidRef': 'ref1', id: '' },
    false,
  ),
  shapeCase(
    'empty-attribute-and-identifier',
    'direct',
    '<direct uidRef=""><id>ID-1</id></direct>',
    { '@_uidRef': '', id: 'ID-1' },
    false,
  ),
  shapeCase(
    'empty-attribute-and-empty-element',
    'direct',
    '<direct uidRef=""><id/></direct>',
    { '@_uidRef': '', id: '' },
    false,
  ),
  shapeCase(
    'nil-element',
    'direct',
    '<direct><id xsi:nil="true"/></direct>',
    { id: { '@_xsi:nil': 'true' } },
    true,
  ),
  shapeCase(
    'uid-and-nil-element',
    'direct',
    '<direct uidRef="ref1"><id xsi:nil="true"/></direct>',
    { '@_uidRef': 'ref1', id: { '@_xsi:nil': 'true' } },
    false,
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
  shapeCase(
    'repeat-empty-values',
    'repeated',
    '<repeated><id/></repeated><repeated uidRef=""/>',
    [{ id: '' }, { '@_uidRef': '' }],
    true,
  ),
  shapeCase(
    'repeat-empty-conflict',
    'repeated',
    '<repeated><id>ID-1</id></repeated><repeated uidRef=""><id/></repeated>',
    [{ id: 'ID-1' }, { '@_uidRef': '', id: '' }],
    false,
  ),
  shapeCase('anonymous-valid', 'anonymous', '<anonymous><id>ID-1</id></anonymous>', { id: 'ID-1' }, true),
  shapeCase('anonymous-empty-id', 'anonymous', '<anonymous><id/></anonymous>', { id: '' }, true),
  shapeCase('anonymous-neither', 'anonymous', '<anonymous/>', {}, false),
  shapeCase('anonymous-empty-text', 'anonymous', '<anonymous/>', '', false),
  shapeCase(
    'anonymous-repeated-valid',
    'anonymous',
    '<anonymous><id>ID-1</id></anonymous><anonymous uidRef="ref1"/>',
    [{ id: 'ID-1' }, { '@_uidRef': 'ref1' }],
    true,
  ),
  shapeCase(
    'anonymous-repeated-invalid',
    'anonymous',
    '<anonymous><id>ID-1</id></anonymous><anonymous uidRef="ref1"><id>ID-1</id></anonymous>',
    [{ id: 'ID-1' }, both],
    false,
  ),
  shapeCase(
    'anonymous-invalid',
    'anonymous',
    '<anonymous uidRef="ref1"><id>ID-1</id></anonymous>',
    both,
    false,
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
  ),
  shapeCase(
    'derived-repeated-valid',
    'derived',
    '<derived><id>ID-1</id></derived><derived uidRef="ref1"/>',
    [{ id: 'ID-1' }, { '@_uidRef': 'ref1' }],
    true,
  ),
  shapeCase(
    'derived-repeated-invalid',
    'derived',
    '<derived><id>ID-1</id></derived><derived uidRef="ref1"><id>ID-1</id></derived>',
    [{ id: 'ID-1' }, both],
    false,
  ),
  shapeCase(
    'derived-local-valid',
    'derivedLocal',
    '<derivedLocal left="L"><id>ID-1</id><label>label</label></derivedLocal>',
    { '@_left': 'L', id: 'ID-1', label: 'label' },
    true,
  ),
  shapeCase(
    'derived-local-invalid-base',
    'derivedLocal',
    '<derivedLocal left="L" uidRef="ref1"><id>ID-1</id></derivedLocal>',
    { '@_left': 'L', ...both },
    false,
  ),
  shapeCase(
    'derived-local-invalid-own',
    'derivedLocal',
    '<derivedLocal><id>ID-1</id></derivedLocal>',
    { id: 'ID-1' },
    false,
  ),
  shapeCase('derived-local-invalid-both', 'derivedLocal', '<derivedLocal/>', {}, false),
  shapeCase(
    'restricted-valid',
    'restricted',
    '<restricted left="L"><id>ID-1</id></restricted>',
    { '@_left': 'L', id: 'ID-1' },
    true,
  ),
  shapeCase(
    'restricted-invalid-base',
    'restricted',
    '<restricted right="R" uidRef="ref1"><id>ID-1</id></restricted>',
    { '@_right': 'R', ...both },
    false,
  ),
  shapeCase(
    'restricted-invalid-middle',
    'restricted',
    '<restricted left="L" right="R"><id>ID-1</id></restricted>',
    { '@_left': 'L', '@_right': 'R', id: 'ID-1' },
    false,
  ),
  shapeCase(
    'restricted-invalid-own',
    'restricted',
    '<restricted right="R"><id>ID-1</id></restricted>',
    { '@_right': 'R', id: 'ID-1' },
    false,
  ),
  shapeCase(
    'derived-nested-valid',
    'derivedNested',
    '<derivedNested><ref><id>ID-1</id></ref><label>label</label></derivedNested>',
    { ref: { id: 'ID-1' }, label: 'label' },
    true,
  ),
  shapeCase(
    'derived-nested-invalid',
    'derivedNested',
    '<derivedNested><ref><id>ID-1</id></ref><ref uidRef="ref1"><id>ID-1</id></ref></derivedNested>',
    { ref: [{ id: 'ID-1' }, both] },
    false,
  ),
  shapeCase(
    'nested-derived-valid',
    'nestedDerived',
    '<nestedDerived><ref><id>ID-1</id></ref><localRef left="L"><id>ID-2</id></localRef></nestedDerived>',
    { ref: { id: 'ID-1' }, localRef: { '@_left': 'L', id: 'ID-2' } },
    true,
  ),
  shapeCase(
    'nested-derived-invalid',
    'nestedDerived',
    '<nestedDerived><ref><id>ID-1</id></ref><ref uidRef="ref1"><id>ID-1</id></ref></nestedDerived>',
    { ref: [{ id: 'ID-1' }, both] },
    false,
  ),
  shapeCase(
    'restricted-nested-valid',
    'restrictedNested',
    '<restrictedNested><id>ID-1</id></restrictedNested>',
    { id: 'ID-1' },
    true,
  ),
  shapeCase(
    'restricted-nested-invalid',
    'restrictedNested',
    '<restrictedNested uidRef="ref1"><id>ID-1</id></restrictedNested>',
    both,
    false,
  ),
  shapeCase(
    'anonymous-derived-valid',
    'anonymousDerived',
    '<anonymousDerived left="L"><id>ID-1</id></anonymousDerived>',
    { '@_left': 'L', id: 'ID-1' },
    true,
  ),
  shapeCase(
    'anonymous-derived-invalid-base',
    'anonymousDerived',
    '<anonymousDerived left="L" uidRef="ref1"><id>ID-1</id></anonymousDerived>',
    { '@_left': 'L', ...both },
    false,
  ),
  shapeCase(
    'anonymous-derived-invalid-own',
    'anonymousDerived',
    '<anonymousDerived><id>ID-1</id></anonymousDerived>',
    { id: 'ID-1' },
    false,
  ),
  shapeCase(
    'text-derived-valid',
    'textDerived',
    '<textDerived code="ID-1" left="L">text</textDerived>',
    { '@_code': 'ID-1', '@_left': 'L', '#text': 'text' },
    true,
  ),
  shapeCase(
    'text-derived-invalid-base',
    'textDerived',
    '<textDerived code="ID-1" uidRef="ref1" left="L">text</textDerived>',
    {
      '@_code': 'ID-1', '@_uidRef': 'ref1', '@_left': 'L', '#text': 'text',
    },
    false,
  ),
  shapeCase(
    'text-derived-invalid-own',
    'textDerived',
    '<textDerived code="ID-1">text</textDerived>',
    { '@_code': 'ID-1', '#text': 'text' },
    false,
  ),
  shapeCase(
    'text-restricted-valid',
    'textRestricted',
    '<textRestricted code="ID-1" left="L">text</textRestricted>',
    { '@_code': 'ID-1', '@_left': 'L', '#text': 'text' },
    true,
  ),
  shapeCase(
    'text-restricted-invalid-own',
    'textRestricted',
    '<textRestricted code="ID-1" right="R">text</textRestricted>',
    { '@_code': 'ID-1', '@_right': 'R', '#text': 'text' },
    false,
  ),
  {
    ...shapeCase(
      'derived-comparison-invalid',
      'derivedComparison',
      '<derivedComparison><lower>3</lower><upper>2</upper></derivedComparison>',
      { lower: 3, upper: 2 },
      false,
    ), boundary: true,
  },
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
  ),
  shapeCase(
    'recursive-valid',
    'recursive',
    '<recursive><child><ref><id>ID-1</id></ref></child></recursive>',
    { child: { ref: { id: 'ID-1' } } },
    true,
  ),
  shapeCase(
    'recursive-chain-valid',
    'recursive',
    '<recursive><child><child><child><ref><id>ID-1</id></ref></child></child></child></recursive>',
    { child: { child: { child: { ref: { id: 'ID-1' } } } } },
    true,
  ),
  shapeCase(
    'recursive-chain-invalid',
    'recursive',
    '<recursive><child><child><child><ref uidRef="ref1"><id>ID-1</id></ref></child></child></child></recursive>',
    { child: { child: { child: { ref: both } } } },
    false,
  ),
  shapeCase(
    'recursive-array-valid',
    'recursive',
    '<recursive><ref><id>ROOT-1</id></ref></recursive>'
      + '<recursive><child><ref uidRef="ref1"/></child>'
      + '<child><ref><id>ID-1</id></ref><ref uidRef="ref2"/></child></recursive>',
    [{ ref: { id: 'ROOT-1' } }, {
      child: [
        { ref: { '@_uidRef': 'ref1' } }, { ref: [{ id: 'ID-1' }, { '@_uidRef': 'ref2' }] },
      ],
    }],
    true,
  ),
  shapeCase(
    'recursive-array-invalid',
    'recursive',
    '<recursive><ref><id>ROOT-1</id></ref></recursive>'
      + '<recursive><child><ref uidRef="ref1"/></child>'
      + '<child><ref><id>ID-1</id></ref><ref uidRef="ref1"><id>ID-1</id></ref></child></recursive>',
    [{ ref: { id: 'ROOT-1' } }, {
      child: [
        { ref: { '@_uidRef': 'ref1' } }, { ref: [{ id: 'ID-1' }, both] },
      ],
    }],
    false,
  ),
  shapeCase(
    'recursive-empty-ref',
    'recursive',
    '<recursive><child><child><ref/></child></child></recursive>',
    { child: { child: { ref: '' } } },
    false,
  ),
  shapeCase(
    'recursive-null-ref',
    'recursive',
    '<recursive><child><child><ref/></child></child></recursive>',
    { child: { child: { ref: null } } },
    false,
  ),
  shapeCase(
    'mutual-anonymous-valid',
    'mutual',
    '<mutual><branch><child><branch><anonymous><ref><id>ID-1</id></ref></anonymous></branch></child></branch></mutual>',
    { branch: { child: { branch: { anonymous: { ref: { id: 'ID-1' } } } } } },
    true,
  ),
  shapeCase(
    'mutual-anonymous-invalid',
    'mutual',
    '<mutual><branch><child><branch><anonymous><ref uidRef="ref1"><id>ID-1</id></ref></anonymous></branch></child></branch></mutual>',
    { branch: { child: { branch: { anonymous: { ref: both } } } } },
    false,
  ),
  shapeCase(
    'mutual-inherited-valid',
    'mutual',
    '<mutual><branch><child><ref left="L"><id>ID-1</id></ref></child></branch></mutual>',
    { branch: { child: { ref: { '@_left': 'L', id: 'ID-1' } } } },
    true,
  ),
  shapeCase(
    'mutual-inherited-invalid',
    'mutual',
    '<mutual><branch><child><ref left="L" uidRef="ref1"><id>ID-1</id></ref></child></branch></mutual>',
    { branch: { child: { ref: { '@_left': 'L', ...both } } } },
    false,
  ),
  shapeCase(
    'mutual-nil-wrapper',
    'mutual',
    '<mutual><branch><child><branch><anonymous xsi:nil="true"/></branch></child></branch></mutual>',
    { branch: { child: { branch: { anonymous: { '@_xsi:nil': 'true' } } } } },
    true,
  ),
  {
    ...shapeCase(
      'mutual-raw-xpath',
      'mutual',
      '<mutual><branch><child><branch><window><lower>3</lower><upper>2</upper></window></branch></child></branch></mutual>',
      { branch: { child: { branch: { window: { lower: 3, upper: 2 } } } } },
      false,
    ), boundary: true,
  },
  shapeCase(
    'anonymous-nested-valid',
    'anonymousNested',
    '<anonymousNested><ref><id/></ref></anonymousNested>',
    { ref: { id: '' } },
    true,
  ),
  shapeCase(
    'anonymous-nested-invalid',
    'anonymousNested',
    '<anonymousNested><ref uidRef="ref1"><id>ID-1</id></ref></anonymousNested>',
    { ref: both },
    false,
  ),
  shapeCase(
    'anonymous-nested-repeated-valid',
    'anonymousNested',
    '<anonymousNested><ref><id>ID-1</id></ref><ref uidRef="ref1"/></anonymousNested>',
    { ref: [{ id: 'ID-1' }, { '@_uidRef': 'ref1' }] },
    true,
  ),
  shapeCase(
    'anonymous-nested-repeated-invalid',
    'anonymousNested',
    '<anonymousNested><ref><id>ID-1</id></ref><ref uidRef="ref1"><id>ID-1</id></ref></anonymousNested>',
    { ref: [{ id: 'ID-1' }, both] },
    false,
  ),
  shapeCase(
    'anonymous-wrapper-valid',
    'anonymousWrapper',
    '<anonymousWrapper><wrapper><ref><id>ID-1</id></ref></wrapper></anonymousWrapper>',
    { wrapper: { ref: { id: 'ID-1' } } },
    true,
  ),
  shapeCase(
    'anonymous-wrapper-invalid',
    'anonymousWrapper',
    '<anonymousWrapper><wrapper><ref uidRef="ref1"><id>ID-1</id></ref></wrapper></anonymousWrapper>',
    { wrapper: { ref: both } },
    false,
  ),
  shapeCase(
    'anonymous-comparison-valid',
    'anonymousComparison',
    '<anonymousComparison><lower>1</lower><upper>2</upper></anonymousComparison>',
    { lower: 1, upper: 2 },
    true,
  ),
  {
    ...shapeCase(
      'anonymous-comparison-invalid',
      'anonymousComparison',
      '<anonymousComparison><lower>3</lower><upper>2</upper></anonymousComparison>',
      { lower: 3, upper: 2 },
      false,
    ), boundary: true,
  },
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
