const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const {
  AssertionValidationError,
  validateNodeAssertions,
  validateValueAssertions,
} = require('../src/assertion-validator');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');
const { classifyAssert } = require('../src/xsd-assertion-metadata');
const { s3000lEnvelope } = require('./helpers/s3000l-fixtures');

let cachedIr = null;

test('grouped presence classification retains alternatives and tolerates whitespace and member order', () => {
  const rule = classifyAssert(' ( @uidRef and not ( id or code ) ) or\n( not ( @uidRef ) and ( code or id ) ) ');
  assert.equal(rule.kind, 'exactlyOneGroup');
  assert.equal(rule.enforceable, true);
  assert.deepEqual(rule.groups.map((group) => group.map((field) => field.xmlName)), [['@_uidRef'], ['code', 'id']]);
  assert.deepEqual(rule.fields, rule.groups.flat());
});

test('grouped classification leaves unsupported and non-equivalent XPath raw', () => {
  for (const xpath of [
    '(@uidRef and not(id or code)) or (not(@other) and (id or code))',
    '(@uidRef and not(id or code)) or (not(@uidRef) and (id or other))',
    '(@uidRef and not(id or code)) or (not(@uidRef) and (id and code))',
    '(@uidRef and not(id or code)) or (not(@uidRef) and (id or code or other))',
    '(@uidRef and not(id or @uidRef)) or (not(@uidRef) and (id or @uidRef))',
    '(@uidRef and not(id or id)) or (not(@uidRef) and (id or id))',
    '(@uidRef and not(id or code)) or (not(@uidRef) and (id or id))',
    '(@uidRef and not(id/value or code)) or (not(@uidRef) and (id/value or code))',
    '(@uidRef and not(s:id or code)) or (not(@uidRef) and (s:id or code))',
    '(@uidRef and not(id or code)) or (not(@uidRef) and (id or code)) or other',
    'lower le upper',
  ]) {
    assert.equal(classifyAssert(xpath).kind, 'rawXPath', xpath);
  }
});

test('grouped assertion metadata survives JSON serialization and counts XML nodes independently of text', () => {
  const rule = {
    id: 'Reference#assert1', ...classifyAssert(
      '(@uidRef and not(id or code)) or (not(@uidRef) and (id or code))',
    ),
  };
  const ir = JSON.parse(JSON.stringify({ assertions: { Reference: { rules: [rule] } } }));
  for (const [node, expected] of [
    [{}, false], [{ id: '' }, true], [{ id: null }, true], [{ id: [] }, false],
    [{ id: [''] }, true], [{ id: 'A', code: 'B' }, true], [{ '@_uidRef': '' }, true],
    [{ '@_uidRef': 'R', id: '' }, false], [{ uidRef: 'R' }, false], [{ '@_uidRef': null }, false],
  ]) {
    const result = validateNodeAssertions(ir, 'Reference', node);
    assert.equal(result.valid, expected, JSON.stringify(node));
    assert.deepEqual(result.skipped, []);
  }
  assert.throws(() => validateNodeAssertions(ir, 'Reference', {}, { throw: true }), AssertionValidationError);
});

test('exactly-one assertions use XML node names and presence in serialized IR', () => {
  const rule = {
    id: 'Reference#assert1',
    ...classifyAssert('(@uidRef and not(id)) or (not(@uidRef) and id)'),
  };
  const ir = JSON.parse(JSON.stringify({ assertions: { Reference: { rules: [rule] } } }));
  for (const [node, expected] of [
    [{ id: '' }, true], [{ '@_uidRef': '' }, true], [{ id: 0 }, true], [{ id: false }, true],
    [{ id: { '@_xsi:nil': 'true' } }, true], [{ id: null }, true],
    [{ id: [] }, false], [{ id: [''] }, true], [{ id: undefined }, false],
    [{ '@_uidRef': null }, false], [{ uidRef: 'R' }, false],
    [Object.create({ id: '' }), false],
  ]) {
    assert.equal(validateNodeAssertions(ir, 'Reference', node).valid, expected, JSON.stringify(node));
  }
  const invalid = { '@_uidRef': '', id: '' };
  const result = validateNodeAssertions(ir, 'Reference', invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0].presentFields, ['@uidRef', 'id']);
  assert.throws(() => validateNodeAssertions(ir, 'Reference', invalid, { throw: true }), AssertionValidationError);
});

function buildIr() {
  if (!cachedIr) {
    cachedIr = new IRBuilder(parseXSD('s3000l/2_0/s3000l_2-0_lsaDataset.xsd')).build();
  }
  return cachedIr;
}

test('value assertions validate each root occurrence and retain its index in diagnostics', () => {
  const ir = buildIr();
  const valid = { '@_uidRef': 'org1' };
  assert.equal(validateValueAssertions(ir, 'organizationRef', [valid]).valid, true);
  assert.equal(validateValueAssertions(ir, 'organizationRef', [valid, valid]).valid, true);
  const invalid = validateValueAssertions(ir, 'organizationRef', [valid, {}, valid]);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors.map((error) => error.path), [[1]]);
  assert.throws(
    () => validateValueAssertions(ir, 'organizationRef', [valid, {}], { throw: true }),
    AssertionValidationError,
  );
});

test('root arrays also traverse nested assertions within every occurrence', () => {
  const ir = buildIr();
  const valid = { providedBy: { '@_uidRef': 'org1' } };
  const invalid = { providedBy: { '@_uidRef': 'org1', orgId: { id: 'ORG-1' } } };
  assert.equal(validateValueAssertions(ir, 'breakdownElementName', [valid, valid]).valid, true);
  const result = validateValueAssertions(ir, 'breakdownElementName', [valid, invalid]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.path), [[1, 'providedBy']]);
});

test('root arrays retain skipped rules per occurrence; cardinality stays a schema responsibility', () => {
  const ir = { assertions: { Window: { rules: [{ id: 'Window#assert1', kind: 'rawXPath', test: 'lower le upper' }] } } };
  const result = validateValueAssertions(ir, 'Window', [{ lower: 1 }, { lower: 2 }]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.skipped.map((skip) => skip.path), [[0], [1]]);
  assert.deepEqual(validateValueAssertions(buildIr(), 'organizationRef', []), { valid: true, errors: [], skipped: [] });
});

test('Issue 1.1 repeatable document references accept valid arrays and reject an invalid member', () => {
  const ir = new IRBuilder(parseXSD('s3000l/1_1/s3000l_1-1_lsa_dataset.xsd')).build();
  const col = ir.entities.get('subtaskByExternalReference').columns.find((item) => item.name === 'docRef');
  assert.equal(col.maxOccurs, 'unbounded');
  const refs = [{ '@_uidRef': 'doc1' }, { docId: { id: 'DOC-2' } }];
  assert.equal(validateValueAssertions(ir, col.xsdType, refs).valid, true);
  const invalid = validateValueAssertions(ir, col.xsdType, [...refs, { '@_uidRef': 'doc3', docId: { id: 'DOC-3' } }]);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors.map((error) => error.path), [[2]]);
});

test('IR extracts and classifies S3000L xsd:assert rules', () => {
  const ir = buildIr();
  const assertionSets = [...ir.assertions.values()];
  const rules = assertionSets.flatMap((set) => set.rules);
  const assertionPathSets = [...ir.assertionPaths.values()];
  const assertionPaths = assertionPathSets.flatMap((set) => set.paths);

  assert.equal(assertionSets.length, 200);
  assert.equal(rules.length, 200);
  assert.equal(rules.filter((rule) => rule.kind === 'exactlyOne').length, 200);
  assert.equal(rules.filter((rule) => rule.enforceable).length, 200);
  assert.equal(assertionPathSets.length, 381);
  assert.equal(assertionPaths.length, 771);
  assert.equal(assertionPaths.filter((path) => path.direct).length, 308);
  assert.equal(assertionPaths.filter((path) => !path.direct).length, 463);

  assert.deepEqual(ir.assertions.get('aggregatedElementRef').rules[0].fields, [
    { kind: 'attribute', name: 'uidRef', xmlName: '@_uidRef' },
    { kind: 'element', name: 'beId', xmlName: 'beId' },
    { kind: 'attribute', name: 'uriRef', xmlName: '@_uriRef' },
  ]);

  assert.ok(ir.assertionPaths.get('organizationRef').paths.some((path) => (
    path.typeName === 'organizationRef'
    && path.direct === false
    && path.path.map((step) => step.name).join('.') === 'orgId.setBy'
  )));
});

test('assertion validator accepts exactly one present reference field', () => {
  const ir = buildIr();

  assert.equal(
    validateNodeAssertions(ir, 'aggregatedElementRef', { '@_uidRef': 'be1' }).valid,
    true,
  );
  assert.equal(
    validateNodeAssertions(ir, 'aggregatedElementRef', { beId: { id: 'BE-1' } }).valid,
    true,
  );
  assert.equal(
    validateNodeAssertions(ir, 'aggregatedElementRef', { '@_uriRef': 'urn:test' }).valid,
    true,
  );
});

test('Issue 2.0 empty URI references survive XML import, stored JSON, export and reimport', async () => {
  const ir = buildIr();
  const xml = s3000lEnvelope({
    primary: '<products><prod uid="prod1" crud="I">'
      + '<prodId><id>PROD-1</id><setBy uriRef=""/></prodId></prod></products>',
  });
  const row = deserializeXML(xml, ir).batches.get('product').insert[0];
  assert.deepEqual(JSON.parse(row.prod_id), { id: 'PROD-1', setBy: { '@_uriRef': '' } });
  const db = { queryEntity: async (name) => (name === 'product' ? [row] : []) };
  const exported = await new XMLSerializer(ir, db).serialize({ collections: ['product'] });
  assert.match(exported, /<setBy uriRef=""/);
  const again = deserializeXML(exported, ir).batches.get('product').insert[0];
  assert.deepEqual(JSON.parse(again.prod_id), JSON.parse(row.prod_id));
});

test('Issue 2.0 import and export reject an empty URI combined with another reference', async () => {
  const ir = buildIr();
  for (const [xml, reference] of [
    ['<setBy uidRef="org1" uriRef=""/>', { '@_uidRef': 'org1', '@_uriRef': '' }],
    ['<setBy uriRef=""><orgId><id>ORG-1</id></orgId></setBy>', { '@_uriRef': '', orgId: { id: 'ORG-1' } }],
  ]) {
    const source = s3000lEnvelope({
      primary: `<products><prod uid="prod1" crud="I"><prodId><id>PROD-1</id>${xml}</prodId></prod></products>`,
    });
    assert.throws(() => deserializeXML(source, ir), /XSD assertion failed while deserializing product\.prodId/);
    const row = { uid: 'prod1', prod_id: JSON.stringify({ id: 'PROD-1', setBy: reference }) };
    const db = { queryEntity: async (name) => (name === 'product' ? [row] : []) };
    await assert.rejects(
      () => new XMLSerializer(ir, db).serialize({ collections: ['product'] }),
      /XSD assertion failed while serializing product\.prodId/,
    );
  }
});

test('assertion validator walks nested asserted reference paths', () => {
  const ir = buildIr();

  const valid = validateValueAssertions(ir, 'breakdownElementName', {
    providedBy: { '@_uidRef': 'org1' },
  });
  assert.equal(valid.valid, true);

  const invalid = validateValueAssertions(ir, 'breakdownElementName', {
    providedBy: {
      '@_uidRef': 'org1',
      orgId: { id: 'ORG-1' },
    },
  });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors[0].path, ['providedBy']);
  assert.equal(invalid.errors[0].typeName, 'organizationRef');
});

test('assertion validator walks recursive asserted reference paths', () => {
  const ir = buildIr();

  const valid = validateValueAssertions(ir, 'productIdentifier', {
    id: 'PROD-1',
    applic: {
      applicDefRef: { '@_uidRef': 'applst1' },
    },
  });
  assert.equal(valid.valid, true);

  const invalid = validateValueAssertions(ir, 'productIdentifier', {
    id: 'PROD-1',
    applic: {
      applicDefRef: {
        '@_uidRef': 'applst1',
        applicId: { id: 'APPLIC-1' },
      },
    },
  });

  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors[0].path, ['applic', 'applicDefRef']);
  assert.equal(invalid.errors[0].typeName, 'applicabilityStatementRef');
});

test('assertion validator rejects missing or multiple reference fields', () => {
  const ir = buildIr();

  const missing = validateNodeAssertions(ir, 'aggregatedElementRef', {});
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.errors[0].presentFields, []);

  const multiple = validateNodeAssertions(ir, 'aggregatedElementRef', {
    '@_uidRef': 'be1',
    beId: { id: 'BE-1' },
  });
  assert.equal(multiple.valid, false);
  assert.deepEqual(multiple.errors[0].presentFields, ['@uidRef', 'beId']);
});

test('assertion validator can throw a typed error', () => {
  const ir = buildIr();

  assert.throws(
    () => validateNodeAssertions(ir, 'aggregatedElementRef', {}, { throw: true }),
    (err) => err instanceof AssertionValidationError && err.errors.length === 1,
  );
});

test('IR columns retain direct asserted inline XSD types', () => {
  const ir = buildIr();
  const entity = ir.entities.get('maintenanceFacility');
  const col = entity.columns.find((c) => c.columnName === 'maint_cap');

  assert.equal(col.xsdType, 'maintenanceLevelRef');
  assert.equal(ir.assertions.has(col.xsdType), true);
});

test('deserializer rejects invalid direct asserted inline reference objects', () => {
  const ir = buildIr();
  const xml = [
    '<lsaDataset>',
    '<msgId>MSG-ASSERT</msgId><msgDate>2026-06-13</msgDate><msgType><code>B</code></msgType>',
    '<logisticsSupportAnalysisData><lsaSupportingData><facilities>',
    '<maintFclty uid="fclty1" crud="I">',
    '<maintCap uidRef="mlv1"><mlvId><id>MLV-1</id></mlvId></maintCap>',
    '</maintFclty>',
    '</facilities></lsaSupportingData></logisticsSupportAnalysisData>',
    '</lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(xml, ir),
    /XSD assertion failed while deserializing maintenanceFacility\.maintCap/,
  );
});

test('deserializer rejects invalid nested asserted inline reference objects', () => {
  const ir = buildIr();
  const xml = [
    '<lsaDataset>',
    '<msgId>MSG-ASSERT-NESTED</msgId><msgDate>2026-06-13</msgDate><msgType><code>B</code></msgType>',
    '<logisticsSupportAnalysisData><lsaPrimaryData><breakdownElements>',
    '<beAggr uid="be1" crud="I">',
    '<beName><providedBy uidRef="org1"><orgId><id>ORG-1</id></orgId></providedBy></beName>',
    '</beAggr>',
    '</breakdownElements></lsaPrimaryData></logisticsSupportAnalysisData>',
    '</lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(xml, ir),
    /XSD assertion failed while deserializing aggregatedElement\.beName/,
  );
});

test('deserializer rejects invalid recursive asserted inline reference objects', () => {
  const ir = buildIr();
  const xml = [
    '<lsaDataset>',
    '<msgId>MSG-ASSERT-RECURSIVE</msgId><msgDate>2026-06-13</msgDate><msgType><code>B</code></msgType>',
    '<logisticsSupportAnalysisData><lsaPrimaryData><products>',
    '<prod uid="prod1" crud="I">',
    '<prodId><id>PROD-1</id><applic><applicDefRef uidRef="applst1"><applicId><id>APPLIC-1</id></applicId></applicDefRef></applic></prodId>',
    '</prod>',
    '</products></lsaPrimaryData></logisticsSupportAnalysisData>',
    '</lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(xml, ir),
    /XSD assertion failed while deserializing product\.prodId/,
  );
});

test('serializer rejects invalid direct asserted inline reference JSON', async () => {
  const ir = buildIr();
  const fakeDb = {
    async queryEntity(entityName) {
      if (entityName !== 'maintenanceFacility') return [];
      return [{
        id: 1,
        uid: 'fclty1',
        crud: 'I',
        maint_cap: JSON.stringify({
          '@_uidRef': 'mlv1',
          mlvId: { id: 'MLV-1' },
        }),
        _created_at: '2026-06-13T08:00:00.000Z',
        _updated_at: '2026-06-13T08:00:00.000Z',
        _deleted_at: null,
        _msg_seq: 0,
      }];
    },
    async queryDeleted() {
      return [];
    },
  };

  await assert.rejects(
    () => new XMLSerializer(ir, fakeDb).serialize({ msgId: 'MSG-ASSERT' }),
    /XSD assertion failed while serializing maintenanceFacility\.maintCap/,
  );
});

test('serializer rejects invalid nested asserted inline reference JSON', async () => {
  const ir = buildIr();
  const fakeDb = {
    async queryEntity(entityName) {
      if (entityName !== 'aggregatedElement') return [];
      return [{
        id: 1,
        uid: 'be1',
        crud: 'I',
        be_name: JSON.stringify({
          providedBy: {
            '@_uidRef': 'org1',
            orgId: { id: 'ORG-1' },
          },
        }),
        _created_at: '2026-06-13T08:00:00.000Z',
        _updated_at: '2026-06-13T08:00:00.000Z',
        _deleted_at: null,
        _msg_seq: 0,
      }];
    },
    async queryDeleted() {
      return [];
    },
  };

  await assert.rejects(
    () => new XMLSerializer(ir, fakeDb).serialize({ msgId: 'MSG-ASSERT-NESTED' }),
    /XSD assertion failed while serializing aggregatedElement\.beName/,
  );
});

test('serializer rejects invalid recursive asserted inline reference JSON', async () => {
  const ir = buildIr();
  const fakeDb = {
    async queryEntity(entityName) {
      if (entityName !== 'product') return [];
      return [{
        id: 1,
        uid: 'prod1',
        crud: 'I',
        prod_id: JSON.stringify({
          id: 'PROD-1',
          applic: {
            applicDefRef: {
              '@_uidRef': 'applst1',
              applicId: { id: 'APPLIC-1' },
            },
          },
        }),
        _created_at: '2026-06-13T08:00:00.000Z',
        _updated_at: '2026-06-13T08:00:00.000Z',
        _deleted_at: null,
        _msg_seq: 0,
      }];
    },
    async queryDeleted() {
      return [];
    },
  };

  await assert.rejects(
    () => new XMLSerializer(ir, fakeDb).serialize({ msgId: 'MSG-ASSERT-RECURSIVE' }),
    /XSD assertion failed while serializing product\.prodId/,
  );
});
