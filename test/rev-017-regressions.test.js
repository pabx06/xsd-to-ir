/**
 * Regression contract for REV-017.
 *
 * Run only this suite with:
 *   npm run test:rev-017
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');

const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { XMLDeserializer, deserializeXML } = require('../src/xml-deserializer');

const XSD_BY_DIALECT = new Map([
  ['1.1', 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd'],
  ['2.0', 's3000l/2_0/s3000l_2-0_lsaDataset.xsd'],
]);
const XML_BY_DIALECT = new Map([
  ['1.1', fs.readFileSync(
    path.join(__dirname, 'fixtures', 'rev-004-issue-1-valid.xml'),
    'utf8',
  )],
  ['2.0', fs.readFileSync(
    path.join(__dirname, 'fixtures', 'rev-004-issue-2-valid.xml'),
    'utf8',
  )],
]);
const EXPECTED_PRODUCT_UID = new Map([
  ['1.1', 'prod1'],
  ['2.0', 'prod2'],
]);
const REPO_ROOT = path.join(__dirname, '..');

const irByDialect = new Map();

function buildDialectIr(dialect) {
  if (!irByDialect.has(dialect)) {
    irByDialect.set(
      dialect,
      new IRBuilder(parseXSD(XSD_BY_DIALECT.get(dialect))).build(),
    );
  }
  return irByDialect.get(dialect);
}

function buildGenericIr() {
  return new IRBuilder({
    complexType: [{
      '@_name': 'GenericRecord',
      sequence: [{
        element: [{ '@_name': 'value', '@_type': 'string' }],
      }],
    }],
  }).build();
}

function importedProductUids(result) {
  return (result.batches.get('product')?.insert ?? []).map((row) => row.uid);
}

function assertMismatchBeforeCollections(xmlDialect, irDialect) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(XML_BY_DIALECT.get(xmlDialect));
  const deserializer = new XMLDeserializer(buildDialectIr(irDialect));
  let collectionCalls = 0;

  deserializer._processCollection = () => {
    collectionCalls += 1;
  };

  assert.throws(
    () => deserializer.deserialize(parsed),
    {
      name: 'Error',
      message: `S3000L dialect mismatch: XML is ${xmlDialect} but IR expects ${irDialect}`,
    },
  );
  assert.equal(collectionCalls, 0, 'mismatch must be rejected before processing batches');
}

test('REV-017: generated IR records its S3000L source dialect', () => {
  assert.equal(buildDialectIr('1.1').s3000lDialect, '1.1');
  assert.equal(buildDialectIr('2.0').s3000lDialect, '2.0');
  assert.equal(buildGenericIr().s3000lDialect, null);
});

test('REV-017: generated ir.json preserves the S3000L source dialect', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-to-ir-rev-017-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  for (const [dialect, xsdPath] of XSD_BY_DIALECT) {
    const outDir = path.join(tempRoot, dialect.replace('.', '_'));
    execFileSync(process.execPath, [
      'index.js',
      xsdPath,
      '--out', outDir,
      '--no-sql',
      '--no-json',
    ], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    const serializedIr = JSON.parse(fs.readFileSync(path.join(outDir, 'ir.json'), 'utf8'));
    assert.equal(serializedIr.s3000lDialect, dialect);
  }
});

for (const dialect of XSD_BY_DIALECT.keys()) {
  test(`REV-017: Issue ${dialect} XML imports with its matching IR`, () => {
    const result = deserializeXML(XML_BY_DIALECT.get(dialect), buildDialectIr(dialect));

    assert.equal(result.version, dialect);
    assert.deepEqual(importedProductUids(result), [EXPECTED_PRODUCT_UID.get(dialect)]);
  });
}

test('REV-017: Issue 1.1 XML is rejected by an Issue 2.0 IR before batches', () => {
  assertMismatchBeforeCollections('1.1', '2.0');
});

test('REV-017: Issue 2.0 XML is rejected by an Issue 1.1 IR before batches', () => {
  assertMismatchBeforeCollections('2.0', '1.1');
});

test('REV-017: generic and legacy manual IRs remain dialect-unbound', () => {
  const genericResult = deserializeXML(XML_BY_DIALECT.get('2.0'), buildGenericIr());
  const legacyResult = deserializeXML(XML_BY_DIALECT.get('1.1'), {
    entities: new Map(),
    s3000lCollections: new Map(),
  });

  assert.equal(genericResult.version, '2.0');
  assert.equal(genericResult.batches.size, 0);
  assert.equal(legacyResult.version, '1.1');
  assert.equal(legacyResult.batches.size, 0);
});
