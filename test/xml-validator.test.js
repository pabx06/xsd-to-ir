const test = require('node:test');
const assert = require('node:assert/strict');

const { validateXML, validateXMLSync, ValidationError } = require('../src/xml-validator');

const XSD_PATH = 's3000l/s3000l_2-0_lsaDataset.xsd';

const VALID_ENVELOPE = [
  '<lsaDataset>',
  '<msgId><id>MSG-1</id></msgId>',
  '<logisticsSupportAnalysisData/>',
  '</lsaDataset>',
].join('');

test('validateXMLSync can force structural validation', () => {
  const result = validateXMLSync(VALID_ENVELOPE, XSD_PATH, {
    throw: false,
    structuralOnly: true,
  });

  assert.equal(result.valid, true);
  assert.equal(result.engine, 'structural');
});

test('validateXML fallback rejects malformed XML', async () => {
  const malformed = '<lsaDataset><msgId><id>MSG-1</id></msgId><logisticsSupportAnalysisData/>';

  const result = await validateXML(malformed, XSD_PATH, { throw: false });

  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /Unclosed tag|parse/i);
});

test('validateXMLSync throws ValidationError for missing required envelope fields', () => {
  const missingMsgId = '<lsaDataset><logisticsSupportAnalysisData/></lsaDataset>';

  assert.throws(
    () => validateXMLSync(missingMsgId, XSD_PATH),
    (err) => err instanceof ValidationError && /msgId/.test(err.message),
  );
});
