/**
 * Regression contract for REV-004.
 *
 * Run only this suite with:
 *   npm run test:rev-004
 *
 * REV-012 and REV-013 are active green regression checks. REV-011 is a green
 * baseline: XSD validation proved that prefixed local children are invalid for
 * the bundled schemas, while the valid prefixed-root form already works.
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
const ISSUE_2_NIL_METADATA_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-2-nil-metadata-valid.xml'),
  'utf8',
);
const ISSUE_2_RELATED_REFS_XML = fs.readFileSync(
  path.join(FIXTURE_DIR, 'rev-004-issue-2-related-refs-valid.xml'),
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

test('REV-012: extracts the complete supported header contract', () => {
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
      relatedMsgId: 'BASELINE-I1',
    },
    issue2: {
      msgId: 'REV-004-I2',
      msgType: 'B',
      relatedMsgId: 'BASELINE-I2',
    },
  });
});

test('REV-012: nillable metadata wrappers remain null', () => {
  const issue1Meta = deserializeXML(ISSUE_1_NIL_CONTENT_XML, EMPTY_IR).msgMeta;
  const issue2Meta = deserializeXML(ISSUE_2_NIL_METADATA_XML, EMPTY_IR).msgMeta;

  assert.deepEqual(issue1Meta, {
    msgId: null,
    msgType: null,
    msgStatus: null,
    msgDate: null,
    relatedMsgId: null,
  });
  assert.deepEqual(issue2Meta, {
    msgId: null,
    msgType: null,
    msgStatus: null,
    msgDate: null,
    relatedMsgId: null,
  });
});

test('REV-012: flattens related-message ID, UID, and URI references', () => {
  const { relatedMsgId } = deserializeXML(ISSUE_2_RELATED_REFS_XML, EMPTY_IR).msgMeta;

  assert.deepEqual(relatedMsgId, [
    'BASELINE-BY-ID',
    'msg2',
    'https://example.test/messages/baseline',
  ]);
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

test('REV-013: rejects Issue 1 content even when Issue 2 content is present', () => {
  const hybrid = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>HYBRID-I2-BOTH</id></msgId>',
    '<logisticsSupportAnalysisData/>',
    '<msgContent/>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(hybrid, EMPTY_IR),
    /msgContent/,
    'an Issue 2 root must not silently ignore an Issue 1 container',
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

test('REV-013: rejects Issue 2 content even when valid Issue 1 content is present', () => {
  const hybrid = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgContent xsi:nil="true"/>',
    '<logisticsSupportAnalysisData/>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(hybrid, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'an Issue 1 root must not silently ignore an Issue 2 container',
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

test('REV-013: accepts an empty Issue 2 content container', () => {
  const emptyContent = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>EMPTY-I2-CONTENT</id></msgId>',
    '<logisticsSupportAnalysisData/>',
    '</s:lsaDataset>',
  ].join('');
  const result = deserializeXML(emptyContent, EMPTY_IR);

  assert.equal(result.version, '2.0');
  assert.equal(result.batches.size, 0);
});

test('REV-013: rejects nil Issue 2 content', () => {
  const nilContent = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgId><id>NIL-I2-CONTENT</id></msgId>',
    '<logisticsSupportAnalysisData xsi:nil="true"/>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(nilContent, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'Issue 2 content is required and not nillable',
  );
});

test('REV-013: rejects duplicate Issue 2 content containers', () => {
  const duplicateContent = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>DUPLICATE-I2-CONTENT</id></msgId>',
    '<logisticsSupportAnalysisData/>',
    '<logisticsSupportAnalysisData/>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(duplicateContent, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'Issue 2 content must occur exactly once',
  );
});

test('REV-013: rejects text-only Issue 2 content', () => {
  const textContent = [
    '<s:lsaDataset xmlns:s="http://www.asd-europe.org/s-series/s3000l">',
    '<msgId><id>TEXT-I2-CONTENT</id></msgId>',
    '<logisticsSupportAnalysisData>not-elements</logisticsSupportAnalysisData>',
    '</s:lsaDataset>',
  ].join('');

  assert.throws(
    () => deserializeXML(textContent, EMPTY_IR),
    /logisticsSupportAnalysisData/,
    'Issue 2 content has an element-only content model',
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

test('REV-013: rejects content inside nil Issue 1 msgContent', () => {
  const nilWithContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgContent xsi:nil="true">',
    '<messageContentItems/><supportingContentItems/>',
    '</msgContent>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(nilWithContent, EMPTY_IR),
    /msgContent/,
    'a nil Issue 1 content container must not contain child elements',
  );
});

test('REV-013: rejects duplicate Issue 1 content containers', () => {
  const duplicateContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgContent xsi:nil="true"/>',
    '<msgContent xsi:nil="true"/>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(duplicateContent, EMPTY_IR),
    /msgContent/,
    'Issue 1 content must not occur more than once',
  );
});

test('REV-013: accepts numeric nil through an alternate XSI prefix', () => {
  const nilContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:si="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgContent si:nil="1"/>',
    '</s:lsaDataSet>',
  ].join('');
  const result = deserializeXML(nilContent, EMPTY_IR);

  assert.equal(result.version, '1.1');
  assert.equal(result.batches.size, 0);
});

test('REV-013: does not trust nil from a foreign namespace', () => {
  const foreignNil = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:foreign="urn:not-xml-schema-instance">',
    '<msgContent foreign:nil="true"/>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(foreignNil, EMPTY_IR),
    /messageContentItems/,
    'only XML Schema-instance nil may suppress required Issue 1 content',
  );
});

test('REV-013: does not treat xsi:nil="false" as nil Issue 1 content', () => {
  const nonNilContent = [
    '<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<msgContent xsi:nil="false"/>',
    '</s:lsaDataSet>',
  ].join('');

  assert.throws(
    () => deserializeXML(nonNilContent, EMPTY_IR),
    /messageContentItems/,
    'xsi:nil="false" content must still contain the required children',
  );
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
