const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  AssertionValidationError, validateNodeAssertions, validateValueAssertions,
} = require('../src/assertion-validator');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');
const {
  bundle, realCases, runtimeResult, schemaValidator, shapeCases,
} = require('./helpers/assertion-baseline');
const { s3000lEnvelope } = require('./helpers/s3000l-fixtures');

const invalidRef = { '@_uidRef': 'ref1', id: 'ID-1' };

test('value traversal uses retained type links without an assertion path catalog, including serialized IR', () => {
  const { ir } = bundle('fixture');
  const withoutPaths = { ...ir, assertionPaths: undefined };
  const serialized = JSON.parse(JSON.stringify({
    valueTypes: Object.fromEntries(ir.valueTypes), assertions: Object.fromEntries(ir.assertions),
  }));
  for (const input of [withoutPaths, serialized]) {
    const result = validateValueAssertions(input, 'Deep', { outer: { middle: { ref: invalidRef } } });
    assert.deepEqual(result.errors.map((error) => [error.ruleId, error.path]), [
      ['Reference#assert1', ['outer', 'middle', 'ref']],
    ]);
    const recursive = { child: { child: { ref: invalidRef } } };
    assert.equal(validateNodeAssertions(input, 'Recursive', recursive).valid, true);
    assert.deepEqual(validateValueAssertions(input, 'Recursive', recursive).errors[0].path, ['child', 'child', 'ref']);
  }
});

test('diagnostics identify every root and nested array position exactly once', () => {
  const item = shapeCases.find((candidate) => candidate.id === 'recursive-array-invalid');
  const result = runtimeResult(item);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0].path, [1, 'child', 1, 'ref', 1]);
  const { ir } = bundle('fixture');
  assert.throws(() => validateValueAssertions(ir, 'Recursive', item.value, { throw: true }), (error) => {
    assert.ok(error instanceof AssertionValidationError);
    assert.deepEqual(error.errors, result.errors);
    return true;
  });
});

test('mutual recursion reaches anonymous, inherited and skipped assertions with complete paths', () => {
  const { ir } = bundle('fixture');
  const value = {
    branch: {
      child: {
        ref: {},
        branch: { anonymous: { ref: invalidRef }, window: { lower: 3, upper: 2 } },
      },
    },
  };
  const result = validateValueAssertions(ir, 'MutualA', value);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(result.errors.slice(0, 2).map((error) => [error.ruleId, error.path]), [
    ['Reference#assert1', ['branch', 'child', 'ref']],
    ['LocalReference#assert1', ['branch', 'child', 'ref']],
  ]);
  assert.match(result.errors[2].typeName, /^@anonymous\//);
  assert.deepEqual(result.errors[2].path, ['branch', 'child', 'branch', 'anonymous', 'ref']);
  assert.deepEqual(result.skipped.map((skip) => [skip.ruleId, skip.path]), [
    ['Window#assert1', ['branch', 'child', 'branch', 'window']],
  ]);
});

test('shared object instances are validated at every occurrence without mutating the input', () => {
  const { ir } = bundle('fixture');
  const leaf = Object.freeze({ ref: Object.freeze({ ...invalidRef }) });
  const child = Object.freeze([leaf, leaf]);
  const value = Object.freeze({ child });
  const result = validateValueAssertions(ir, 'Recursive', value);
  assert.deepEqual(result.errors.map((error) => error.path), [['child', 0, 'ref'], ['child', 1, 'ref']]);
  assert.equal(value.child[0], value.child[1]);
});

test('recursive type references terminate on absent values, while input object and array cycles fail clearly', () => {
  const { ir } = bundle('fixture');
  const leaf = { child: [] };
  assert.equal(validateValueAssertions(ir, 'Recursive', leaf).valid, true);
  leaf.child.push(leaf);
  assert.throws(() => validateValueAssertions(ir, 'Recursive', leaf), {
    name: 'TypeError', message: 'Cyclic JSON value at ["child",0]',
  });
  const array = [];
  array.push(array);
  assert.throws(() => validateValueAssertions(ir, 'Recursive', array), {
    name: 'TypeError', message: 'Cyclic JSON value at [0]',
  });
});

test('deep finite values do not depend on the JavaScript call stack or a fixed type traversal depth', () => {
  const { ir } = bundle('fixture');
  const depth = 12000;
  const leaf = { ref: { id: 'ID-1' } };
  let value = leaf;
  for (let index = 0; index < depth; index++) value = { child: value };
  assert.equal(validateValueAssertions(ir, 'Recursive', value).valid, true);
  leaf.ref['@_uidRef'] = 'ref1';
  const result = validateValueAssertions(ir, 'Recursive', value);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path.length, depth + 1);
  assert.ok(result.errors[0].path.slice(0, -1).every((step) => step === 'child'));
  assert.equal(result.errors[0].path.at(-1), 'ref');
});

test('only present declared children are traversed; empty complex occurrences still receive assertions', () => {
  const { ir } = bundle('fixture');
  const value = { child: [{}, { ref: [] }, { ref: undefined }, Object.create({ ref: invalidRef })] };
  value.unrecognized = { ref: invalidRef };
  assert.equal(validateValueAssertions(ir, 'Recursive', value).valid, true);
  for (const empty of ['', null, {}]) {
    const result = validateValueAssertions(ir, 'Recursive', { child: { ref: empty } });
    assert.deepEqual(result.errors.map((error) => error.path), [['child', 'ref']]);
  }
});

test('repeated declarations of the same child type do not duplicate diagnostics', () => {
  const { ir } = bundle('fixture');
  const original = ir.valueTypes.get('Nested');
  const duplicate = {
    ...original, content: {
      kind: 'sequence', children: [original.content, original.content],
    },
  };
  const input = { ...ir, valueTypes: new Map(ir.valueTypes).set('Nested', duplicate) };
  const result = validateValueAssertions(input, 'Nested', { ref: [invalidRef, invalidRef] });
  assert.deepEqual(result.errors.map((error) => error.path), [['ref', 0], ['ref', 1]]);
});

test('legacy IR retains finite assertion-path validation with array positions', () => {
  const { ir } = bundle('fixture');
  const legacy = { assertions: ir.assertions, assertionPaths: ir.assertionPaths };
  const serialized = JSON.parse(JSON.stringify({
    assertions: Object.fromEntries(ir.assertions), assertionPaths: Object.fromEntries(ir.assertionPaths),
  }));
  for (const input of [legacy, serialized]) {
    const result = validateValueAssertions(input, 'Nested', { ref: [{ id: 'ID-1' }, invalidRef] });
    assert.deepEqual(result.errors.map((error) => [error.ruleId, error.path]), [['Reference#assert1', ['ref', 1]]]);
  }
});

for (const [issue, prefix, field] of [
  ['1.1', 'issue-1-1-deep-applicability', 'name'],
  ['2.0', 'issue-2-0-recursive-set-by', 'prodId'],
]) {
  test(`Issue ${issue}: import/export enforce deep references in persisted product JSON`, async () => {
    const { ir } = bundle(issue);
    const valid = realCases.find((item) => item.id === `${prefix}-valid`);
    const invalid = realCases.find((item) => item.id === `${prefix}-invalid`);
    const col = ir.entities.get('product').columns.find((item) => item.name === field);
    const wrap = (item) => {
      const fragment = item.xml.replace(/<probe>|<\/probe>/g, (tag) => (tag === '<probe>' ? `<${field}>` : `</${field}>`));
      return issue === '1.1'
        ? fs.readFileSync('test/fixtures/rev-004-issue-1-valid.xml', 'utf8').replace('</prod>', `${fragment}</prod>`)
        : s3000lEnvelope({ primary: `<products><prod uid="prod1" crud="I">${fragment}</prod></products>` });
    };
    const row = deserializeXML(wrap(valid), ir).batches.get('product').insert[0];
    const value = JSON.parse(row[col.columnName]);
    assert.equal(schemaValidator(valid)(value), true);
    const db = { queryEntity: async (name) => (name === 'product' ? [row] : []) };
    const xml = await new XMLSerializer(ir, db).serialize({ collections: ['product'] });
    assert.match(xml, /<setBy uidRef="org1"/);
    if (issue === '2.0') {
      const again = deserializeXML(xml, ir).batches.get('product').insert[0];
      assert.deepEqual(JSON.parse(again[col.columnName]), value);
    }
    assert.throws(() => deserializeXML(wrap(invalid), ir), /XSD assertion failed while deserializing product\./);
    if (issue === '1.1') value.applic.applicRef.applicId.setBy.orgId = { id: 'ORG-1' };
    else value.setBy.orgId.setBy.orgId.setBy['@_uriRef'] = '';
    row[col.columnName] = JSON.stringify(value);
    await assert.rejects(
      () => new XMLSerializer(ir, db).serialize({ collections: ['product'] }),
      /XSD assertion failed while serializing product\./,
    );
  });
}
