const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXSD } = require('../src/xsd-parser');
const { TypeResolver } = require('../src/type-resolver');
const {
  detectS3000LEntities,
  extractS3000LCollections,
} = require('../src/s3000l-ir-metadata');

let cachedSchema = null;

function loadSchema() {
  if (!cachedSchema) {
    cachedSchema = parseXSD('s3000l/2_0/s3000l_2-0_lsaDataset.xsd');
  }
  return cachedSchema;
}

test('detectS3000LEntities finds the real S3000L uid+crud entity set', () => {
  const directEntities = detectS3000LEntities(loadSchema());

  assert.equal(directEntities.size, 187);
  assert.equal(directEntities.has('product'), true);
  assert.equal(directEntities.has('operationalTask'), true);
  assert.equal(directEntities.has('logisticsSupportAnalysisMessageContent'), false);
});

test('detectS3000LEntities returns null for schemas without the uid+crud pattern', () => {
  const schema = {
    complexType: [{
      '@_name': 'ordinaryType',
      attribute: [{ '@_name': 'uid' }],
    }],
  };

  assert.equal(detectS3000LEntities(schema), null);
});

test('extractS3000LCollections preserves real S3000L collection and record names', () => {
  const schema = loadSchema();
  const directEntities = detectS3000LEntities(schema);
  const collections = extractS3000LCollections({
    schema,
    resolver: new TypeResolver(schema),
    entityTypes: directEntities,
  });

  assert.deepEqual(collections.get('product'), {
    entityName: 'product',
    section: 'lsaPrimaryData',
    collectionName: 'products',
    recordName: 'prod',
  });
  assert.deepEqual(collections.get('taskRequirement'), {
    entityName: 'taskRequirement',
    section: 'lsaPrimaryData',
    collectionName: 'taskRequirements',
    recordName: 'taskReq',
  });
  assert.deepEqual(collections.get('operationalTask'), {
    entityName: 'operationalTask',
    section: 'lsaPrimaryData',
    collectionName: 'tasks',
    recordName: 'opTask',
  });
});
