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

let cachedIr = null;

function buildIr() {
  if (!cachedIr) {
    cachedIr = new IRBuilder(parseXSD('s3000l/s3000l_2-0_lsaDataset.xsd')).build();
  }
  return cachedIr;
}

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
  assert.equal(assertionPathSets.length, 209);
  assert.equal(assertionPaths.length, 308);

  assert.deepEqual(ir.assertions.get('aggregatedElementRef').rules[0].fields, [
    { kind: 'attribute', name: 'uidRef', xmlName: '@_uidRef' },
    { kind: 'element', name: 'beId', xmlName: 'beId' },
    { kind: 'attribute', name: 'uriRef', xmlName: '@_uriRef' },
  ]);
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
