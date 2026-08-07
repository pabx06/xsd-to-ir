/**
 * Regression contract for REV-004.
 *
 * Run only this suite with:
 *   npm run test:rev-004
 *
 * The REV-012 and REV-013 assertions are intentionally active (not skipped or
 * marked TODO). They stay red until the corresponding production defects are
 * fixed. REV-011 is a green baseline: XSD validation proved that prefixed local
 * children are invalid for the bundled schemas, while the valid prefixed-root
 * form already works.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { deserializeXML } = require('../src/xml-deserializer');
const { validateXMLSync } = require('../src/xml-validator');

const ISSUE_1_XSD = 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd';
const ISSUE_2_XSD = 's3000l/2_0/s3000l_2-0_lsaDataset.xsd';
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

const ISSUE_1_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-1-valid.xml'),
  'utf8',
);
const ISSUE_2_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-2-valid.xml'),
  'utf8',
);
const ISSUE_2_DATE_ONLY_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-2-date-only-valid.xml'),
  'utf8',
);
const ISSUE_1_NIL_CONTENT_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-1-nil-content-valid.xml'),
  'utf8',
);

let issue1Ir;
let issue2Ir;

function buildIssue1Ir() {
  if (!issue1Ir) issue1Ir = new IRBuilder(parseXSD(ISSUE_1_XSD)).build();
  return issue1Ir;
}

function buildIssue2Ir() {
  if (!issue2Ir) issue2Ir = new IRBuilder(parseXSD(ISSUE_2_XSD)).build();
  return issue2Ir;
}

// Metadata and rejection tests do not need entity definitions. Keeping their
// IR empty ensures a failure comes from the envelope, not record processing.
const EMPTY_IR = {
  entities: new Map(),
  s3000lCollections: new Map(),
};

function importedProductUids(result) {
  return (result.batches.get('product')?.insert ?? []).map((row) => row.uid);
}

test('REV-011: schema-valid Issue 1 namespace form validates and imports', () => {
  // The global root is namespace-qualified; locally declared children are not.
  const validation = validateXMLSync(ISSUE_1_XML, ISSUE_1_XSD, {
    throw: false,
    structuralOnly: true,
  });
  const result = deserializeXML(ISSUE_1_XML, buildIssue1Ir());

  assert.equal(validation.valid, true);
  assert.equal(result.version, '1.1');
  assert.equal(result.msgMeta.msgId, 'REV-004-I1');
  assert.deepEqual(importedProductUids(result), ['prod1']);
});

test('REV-011: schema-valid Issue 2 namespace form validates and imports', () => {
  // This has the same namespace form as Issue 1: prefixed root, local children.
  const validation = validateXMLSync(ISSUE_2_XML, ISSUE_2_XSD, {
    throw: false,
    structuralOnly: true,
  });
  const result = deserializeXML(ISSUE_2_XML, buildIssue2Ir());

  assert.equal(validation.valid, true);
  assert.equal(result.version, '2.0');
  assert.equal(result.msgMeta.msgId, 'REV-004-I2');
  assert.deepEqual(importedProductUids(result), ['prod2']);
});

test('REV-012: Issue 1 extracts msgDate.dateTime', () => {
  const { msgMeta } = deserializeXML(ISSUE_1_XML, EMPTY_IR);

  assert.equal(msgMeta.msgDate, '2026-08-07T12:34:56Z');
});

test('REV-012: Issue 2 extracts msgStatus.state', () => {
  const { msgMeta } = deserializeXML(ISSUE_2_XML, EMPTY_IR);

  assert.equal(msgMeta.msgStatus, 'F');
});

test('REV-012: Issue 2 combines msgDate.date and optional time', () => {
  const { msgMeta } = deserializeXML(ISSUE_2_XML, EMPTY_IR);

  assert.equal(msgMeta.msgDate, '2026-08-07T12:34:56Z');
});

test('REV-012: Issue 2 preserves msgDate.date when optional time is absent', () => {
  const { msgMeta } = deserializeXML(ISSUE_2_DATE_ONLY_XML, EMPTY_IR);

  assert.equal(msgMeta.msgDate, '2026-08-07');
});

test('REV-012: already-supported header wrappers keep their values', () => {
  const issue1Meta = deserializeXML(ISSUE_1_XML, EMPTY_IR).msgMeta;
  const issue2Meta = deserializeXML(ISSUE_2_XML, EMPTY_IR).msgMeta;

  assert.deepEqual({
    issue1: {
      msgId: issue1Meta.msgId,
      msgStatus: issue1Meta.msgStatus,
      msgType: issue1Meta.msgType,
      relatedMsgId: issue1Meta.relatedMsgId,
    },
    issue2: {
      msgId: issue2Meta.msgId,
      msgType: issue2Meta.msgType,
      relatedMsgId: issue2Meta.relatedMsgId,
    },
  }, {
    issue1: {
      msgId: 'REV-004-I1',
      msgStatus: 'F',
      msgType: null,
      relatedMsgId: null,
    },
    issue2: {
      msgId: 'REV-004-I2',
      msgType: 'B',
      relatedMsgId: null,
    },
  });
});

test('REV-013: rejects an Issue 2 root containing Issue 1 content', () => {
  const hybrid = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>HYBRID-I2-I1</id></msgId>',
    '<msgContent><messageContentItems/><supportingContentItems/></msgContent>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(hybrid, EMPTY_IR),
    /msgContent/,
    'an Issue 2 root must reject the Issue 1 msgContent container',
  );
});

test('REV-013: rejects an Issue 1 root containing Issue 2 content', () => {
  const hybrid = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>HYBRID-I1-I2</id></msgId>',
    '<logisticsSupportAnalysisData/>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(hybrid, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'an Issue 1 root must reject the Issue 2 logisticsSupportAnalysisData container',
  );
});

test('REV-013: rejects Issue 2 when required content is missing', () => {
  const missingContent = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>MISSING-I2-CONTENT</id></msgId>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(missingContent, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'Issue 2 requires logisticsSupportAnalysisData',
  );
});

test('REV-013: allows an empty Issue 1 envelope because msgContent is optional', () => {
  const emptyEnvelope = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l"/>',
  ].join('');
  const result = deserializeXML(emptyEnvelope, EMPTY_IR);

  assert.equal(result.version, '1.1');
  assert.equal(result.batches.size, 0);
});

test('REV-013: allows an explicitly nil Issue 1 msgContent', () => {
  const result = deserializeXML(ISSUE_1_NIL_CONTENT_XML, EMPTY_IR);

  assert.equal(result.version, '1.1');
  assert.equal(result.batches.size, 0);
});

test('REV-013: rejects Issue 1 msgContent without messageContentItems', () => {
  const partialContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgContent><supportingContentItems/></msgContent>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(partialContent, EMPTY_IR),
    /messageContentItems/,
    'Issue 1 msgContent requires messageContentItems when msgContent is present',
  );
});

test('REV-013: rejects Issue 1 msgContent without supportingContentItems', () => {
  const partialContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgContent><messageContentItems/></msgContent>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(partialContent, EMPTY_IR),
    /supportingContentItems/,
    'Issue 1 msgContent requires supportingContentItems when msgContent is present',
  );
});
