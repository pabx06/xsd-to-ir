const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AssertionValidationError, validateNodeAssertions, validateValueAssertions,
} = require('../src/assertion-validator');
const { bundle, fixtureColumn } = require('./helpers/assertion-baseline');

test('inherited rules keep declaration IDs, base-first order and derived value context', () => {
  const { ir, schema } = bundle('fixture');
  const anonymous = fixtureColumn('anonymousDerived').valueTypeRef;
  const expectations = [
    ['DerivedReference', ['Reference#assert1']],
    ['LocalReference', ['Reference#assert1', 'LocalReference#assert1']],
    ['RestrictedReference', ['Reference#assert1', 'LocalReference#assert1', 'RestrictedReference#assert1']],
    ['RestrictedNested', ['Reference#assert1']],
    ['DerivedTextReference', ['TextReference#assert1', 'DerivedTextReference#assert1']],
    ['RestrictedTextReference', [
      'TextReference#assert1', 'DerivedTextReference#assert1', 'RestrictedTextReference#assert1',
    ]],
    [anonymous, ['Reference#assert1', `${anonymous}#assert1`]],
  ];
  for (const [name, ids] of expectations) {
    const result = validateNodeAssertions(ir, name, {});
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((error) => error.ruleId), ids);
    assert.ok(result.errors.every((error) => error.typeName === name));
    assert.deepEqual(schema.definitions[name]['x-xsd-assertions'], ids);
    // IR inventories declarations once; inheritance stays in baseTypeRef.
    assert.deepEqual(
      ir.valueTypes.get(name).assertionRefs,
      ir.assertions.get(name)?.rules.map((rule) => rule.id) || [],
    );
  }
  assert.equal(ir.assertions.has('DerivedReference'), false);
  assert.throws(() => validateNodeAssertions(ir, 'LocalReference', {}, { throw: true }), (error) => {
    assert.ok(error instanceof AssertionValidationError);
    assert.deepEqual(error.errors.map((item) => item.ruleId), ['Reference#assert1', 'LocalReference#assert1']);
    return true;
  });
});

test('nested assertion paths cover inherited children and children with inherited rules', () => {
  const { ir } = bundle('fixture');
  const inheritedChild = ir.assertionPaths.get('DerivedNested').paths;
  assert.deepEqual(inheritedChild.map((item) => [item.path.map((step) => step.name), item.ruleIds]), [
    [['ref'], ['Reference#assert1']],
  ]);
  const derivedChildren = ir.assertionPaths.get('NestedDerived').paths;
  assert.deepEqual(derivedChildren.map((item) => [item.typeName, item.ruleIds]), [
    ['DerivedReference', ['Reference#assert1']],
    ['LocalReference', ['Reference#assert1', 'LocalReference#assert1']],
  ]);
});

test('restriction replaces base content without losing base assertions', () => {
  const { ir, schema } = bundle('fixture');
  assert.equal(ir.assertionPaths.has('RestrictedNested'), false);
  assert.equal(Object.hasOwn(schema.definitions.RestrictedNested.properties, 'ref'), false);
  assert.equal(Object.hasOwn(schema.definitions.RestrictedReference.properties, 'label'), false);
  assert.deepEqual(validateNodeAssertions(ir, 'RestrictedNested', {}).errors.map((error) => error.ruleId), [
    'Reference#assert1',
  ]);
});

test('inherited diagnostics and array occurrence paths survive IR serialization', () => {
  const { ir } = bundle('fixture');
  const serialized = JSON.parse(JSON.stringify({
    assertions: Object.fromEntries(ir.assertions),
    assertionPaths: Object.fromEntries(ir.assertionPaths),
    valueTypes: Object.fromEntries(ir.valueTypes),
  }));
  for (const input of [ir, serialized]) {
    const repeated = validateValueAssertions(input, 'LocalReference', [{ id: 'ID-1', '@_left': 'L' }, {}]);
    assert.deepEqual(repeated.errors.map((error) => [error.ruleId, error.path]), [
      ['Reference#assert1', [1]], ['LocalReference#assert1', [1]],
    ]);
    const nested = validateValueAssertions(input, 'NestedDerived', {
      ref: { '@_uidRef': 'ref1', id: 'ID-1' }, localRef: {},
    });
    assert.deepEqual(nested.errors.map((error) => [error.ruleId, error.path]), [
      ['Reference#assert1', ['ref']],
      ['Reference#assert1', ['localRef']], ['LocalReference#assert1', ['localRef']],
    ]);
  }
});

test('inherited raw XPath stays annotated and skipped under its original rule ID', () => {
  const { ir, schema } = bundle('fixture');
  const result = validateNodeAssertions(ir, 'DerivedWindow', { lower: 3, upper: 2 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.skipped.map((item) => [item.typeName, item.ruleId]), [['DerivedWindow', 'Window#assert1']]);
  assert.deepEqual(schema.definitions.DerivedWindow['x-xsd-assertions'], ['Window#assert1']);
  assert.ok(schema.definitions.DerivedWindow['x-xsd-unsupported']
    .includes('Assertion Window#assert1 requires XSD validation.'));
});

test('direct assertion evaluation remains available on legacy IR without valueTypes', () => {
  const { ir } = bundle('fixture');
  const legacy = { assertions: Object.fromEntries(ir.assertions) };
  assert.equal(validateNodeAssertions(legacy, 'Reference', { id: 'ID-1' }).valid, true);
  assert.deepEqual(validateNodeAssertions(legacy, 'Reference', {}).errors.map((error) => error.ruleId), [
    'Reference#assert1',
  ]);
});

test('malformed inheritance cycles fail clearly instead of looping or skipping rules', () => {
  const ir = {
    valueTypes: new Map([['A', { baseTypeRef: 'B' }], ['B', { baseTypeRef: 'A' }]]),
    assertions: new Map(),
  };
  assert.throws(() => validateNodeAssertions(ir, 'A', {}), /Cyclic value type inheritance: A/);
});
