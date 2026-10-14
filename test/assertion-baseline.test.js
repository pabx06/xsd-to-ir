const assert = require('node:assert/strict');
const test = require('node:test');
const { validateNodeAssertions } = require('../src/assertion-validator');
const {
  bundle, caseValue, exportCase, fixtureColumn, importCase, inventory,
  realCases, runtimeResult, schemaValidator, shapeCases,
} = require('./helpers/assertion-baseline');

const STRICT = process.env.ASSERTION_BASELINE_STRICT === '1';
function gapFor(item, layer) {
  if (item.id === 'issue-2-0-organization-empty-uri') return 'ASSERT-002';
  return item.gaps?.[layer];
}

function baselineTest(item, layer, fn) {
  const gap = gapFor(item, layer);
  const name = `${gap || (item.boundary ? 'XSD-only boundary' : 'control')}: ${item.id} / ${layer}`;
  test(name, { todo: gap && !STRICT ? gap : false }, fn);
}

for (const item of [...realCases, ...shapeCases]) {
  baselineTest(item, 'runtime', () => {
    const result = runtimeResult(item);
    // Arbitrary comparisons are an explicitly unsupported boundary, not a
    // promise to translate all XPath. Known reference-pattern gaps stay TODO.
    assert.equal(result.valid, item.boundary ? true : item.expectedAssertion, JSON.stringify(result));
    if (item.boundary) assert.equal(result.skipped.length, 1);
  });

  baselineTest(item, 'schema', () => {
    const validate = schemaValidator(item);
    assert.equal(validate(caseValue(item)), item.boundary ? true : item.expectedXsd, JSON.stringify(validate.errors));
  });
}

for (const item of shapeCases) {
  baselineTest(item, 'import', () => {
    if (item.expectedAssertion || item.boundary) {
      const row = importCase(item);
      assert.equal(row.uid, 'prod1');
      const stored = JSON.parse(row[fixtureColumn(item.field).columnName]);
      const expected = item.id === 'repeat-one-array' ? item.value[0] : item.value;
      assert.deepEqual(stored, expected);
    } else {
      assert.throws(() => importCase(item), /XSD assertion failed while deserializing/);
    }
  });

  baselineTest(item, 'export', async () => {
    if (item.expectedAssertion || item.boundary) {
      const xml = await exportCase(item);
      assert.match(xml, new RegExp(`<${item.field}[\\s/>]`));
    } else {
      await assert.rejects(() => exportCase(item), /XSD assertion failed while serializing/);
    }
  });
}

test('catalog IDs are unique; assertion-only negatives have distinct structural expectations', () => {
  const cases = [...realCases, ...shapeCases];
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const item of cases) {
    assert.equal(typeof item.expectedXsd, 'boolean', item.id);
    assert.equal(typeof item.expectedAssertion, 'boolean', item.id);
    if (!item.expectedXsd) assert.ok(item.xsdErrorMatch, item.id);
    if (!item.expectedAssertion) {
      assert.equal(item.expectedXsd, false, item.id);
      assert.equal(item.xsdErrorMatch, 'cvc-assertion', item.id);
    }
  }
});

for (const [issue, expected] of [['1.1', [36, 33, 3, 0, 36, 0]], ['2.0', [200, 200, 0, 0, 79, 121]]]) {
  test(`Issue ${issue}: distinguish extracted assertions from emitted value-definition coverage`, () => {
    const report = inventory(issue);
    assert.deepEqual([
      report.extracted, report.exactlyOne, report.exactlyOneGroup, report.rawXPath,
      report.referencedByValueDefinitions, report.outsideValueDefinitions.length,
    ], expected);
    const { ir, schema } = bundle(issue);
    const ids = new Set([...ir.assertions.values()].flatMap((set) => set.rules.map((rule) => rule.id)));
    for (const [name, type] of ir.valueTypes) {
      for (const id of type.assertionRefs) {
        assert.ok(ids.has(id), `Unresolved IR assertion ${id}`);
        assert.ok(schema.definitions[name]['x-xsd-assertions'].includes(id));
      }
    }
  });
}

test('raw XPath survives in IR and JSON Schema warnings, and runtime reports it as skipped', () => {
  for (const [issue, typeName] of [
    ['fixture', 'Window'],
  ]) {
    const { ir, schema } = bundle(issue);
    const rule = ir.assertions.get(typeName).rules[0];
    assert.equal(rule.kind, 'rawXPath');
    assert.equal(rule.enforceable, false);
    assert.ok(rule.test.length > 0);
    const result = validateNodeAssertions(ir, typeName, {});
    assert.equal(result.valid, true); // Partial result; skipped is not proof of XSD validity.
    assert.deepEqual(result.skipped.map((skip) => skip.ruleId), [rule.id]);
    assert.ok(schema.definitions[typeName]['x-xsd-assertions'].includes(rule.id));
    assert.ok(schema.definitions[typeName]['x-xsd-unsupported']
      .includes(`Assertion ${rule.id} requires XSD validation.`));
  }
});

test('anonymous assertion metadata is retained under valueTypeRef and works when addressed directly', () => {
  const { ir } = bundle('fixture');
  const col = fixtureColumn('anonymous');
  assert.notEqual(col.xsdType, col.valueTypeRef);
  const rule = ir.assertions.get(col.valueTypeRef).rules[0];
  assert.equal(rule.kind, 'exactlyOne');
  assert.equal(validateNodeAssertions(ir, col.valueTypeRef, { id: 'ID-1' }).valid, true);
  assert.equal(validateNodeAssertions(ir, col.valueTypeRef, { id: 'ID-1', '@_uidRef': 'ref1' }).valid, false);
});
