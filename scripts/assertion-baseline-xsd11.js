#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ROOT, oracleCase, realCases, shapeCases,
} = require('../test/helpers/assertion-baseline');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'assertion-baseline-'));
const failures = [];
try {
  const cases = [...realCases, ...shapeCases];
  for (const [index, item] of cases.entries()) {
    const { xsd, xml } = oracleCase(item);
    const file = path.join(temp, `${item.id}.xml`);
    fs.writeFileSync(file, xml);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/validate-xsd11.js'),
      ...(index ? ['--skip-self-test'] : []), '--xsd', xsd, '--xml', file,
    ], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, XSD11_SKIP_SELF_TEST: '0' },
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    try {
      if (result.error) throw result.error;
      assert.equal(result.signal, null, 'Validator terminated by signal');
      if (item.expectedXsd) {
        assert.equal(result.status, 0, 'Expected XSD acceptance');
      } else {
        assert.equal(result.status, 1, 'Expected a validation failure');
        const errors = output.split('\n').filter((line) => /^(?:error|fatal):/.test(line));
        assert.ok(errors.length > 0, 'Missing XSD validation diagnostics');
        assert.ok(errors.every((line) => /\bcvc-/.test(line)), 'Non-validation error');
        assert.ok(errors.some((line) => line.includes(item.xsdErrorMatch)), 'Wrong rejection reason');
        if (item.xsdErrorMatch === 'cvc-assertion') {
          assert.ok(errors.every((line) => line.includes('cvc-assertion')), 'Unrelated error in assertion-only case');
        } else {
          assert.ok(errors.every((line) => !line.includes('cvc-assertion')), 'Unexpected assertion failure');
        }
      }
    } catch (error) {
      failures.push(`${item.id}: ${error.message}\n${output}`);
    }
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Assertion XSD 1.1 baseline: ${cases.length} cases passed (${realCases.length} real, ${shapeCases.length} synthetic).`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
