#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VALIDATOR = path.join(PROJECT_ROOT, 'scripts', 'validate-xsd11.js');
const DEFAULT_XSD = 's3000l/2_0/s3000l_2-0_lsaDataset.xsd';
const DEFAULT_XML = 'test/fixtures/s3000l-minimal-invalid-missing-msg-id.xml';

function parseArgs(argv) {
  const out = {
    xsd: DEFAULT_XSD,
    xml: DEFAULT_XML,
    match: '\\b(error|fatal): .*cvc-',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--xsd') out.xsd = argv[++i];
    else if (arg === '--xml') out.xml = argv[++i];
    else if (arg === '--match') out.match = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function usage() {
  return [
    'Usage: node scripts/expect-xsd11-failure.js [--xsd schema.xsd] [--xml invalid.xml] [--match regex]',
    '',
    'Runs scripts/validate-xsd11.js and passes only when the target XML is rejected',
    'with a schema validation error matching the supplied regex.',
  ].join('\n');
}

function runInvalidValidation(args) {
  return spawnSync(process.execPath, [
    VALIDATOR,
    '--skip-self-test',
    '--xsd', args.xsd,
    '--xml', args.xml,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const result = runInvalidValidation(args);
  if (result.error) throw result.error;

  const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (result.status === 0) {
    console.error(`Expected XSD 1.1 validation to reject ${args.xml}, but it passed.`);
    return 1;
  }

  const pattern = new RegExp(args.match, 'i');
  if (!pattern.test(output)) {
    console.error(`XSD 1.1 validation failed for ${args.xml}, but not with the expected validation error.`);
    console.error(output);
    return 1;
  }

  console.log(`XSD 1.1 rejection passed: ${args.xml}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
