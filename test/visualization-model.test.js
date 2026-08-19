const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { buildNeighborhood, buildVisualizationModel } = require('../src/visualization-model');
const { createVisualizationServer, parseArgs } = require('../scripts/visualize');

const xsdPath = path.join(__dirname, '..', 's3000l', '1_1', 's3000l_1-1_lsa_dataset.xsd');
let model;

function issue11Model() {
  if (!model) {
    const ir = new IRBuilder(parseXSD(xsdPath)).build();
    model = buildVisualizationModel(ir, { source: xsdPath });
  }
  return model;
}

function request(server, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: address.address, port: address.port, path: requestPath }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('Issue 1.1 visualization model preserves IR counts and mappings', () => {
  const current = issue11Model();
  assert.equal(current.dialect, '1.1');
  assert.deepEqual(current.stats, {
    entities: 286,
    recordEntities: 169,
    syntheticEntities: 117,
    columns: 2632,
    relations: 299,
    joinTables: 0,
    enums: 149,
    simpleTypes: 24,
    assertions: 36,
    assertionPaths: 131,
  });
  assert.equal(current.collections.product.collectionName, 'products');
  assert.equal(current.collections.product.recordName, 'prod');
  assert.equal(current.collections.product.section, 'lsaPrimaryData');
  assert.ok(current.entities.some((entity) => entity.synthetic));
  assert.equal(current.edges.filter((edge) => edge.unresolved).length, 0);
  assert.equal(JSON.stringify(current).includes('[object Map]'), false);
  assert.equal(JSON.stringify(current).includes('"undefined"'), false);
});

test('focused neighborhoods include incoming, outgoing, and two-hop relations', () => {
  const current = issue11Model();
  const product = buildNeighborhood(current, 'product', 1);
  assert.ok(product.entityNames.includes('product'));
  assert.ok(product.entityNames.includes('productVariant'));
  assert.ok(product.edges.some((edge) => edge.source === 'product'));

  const deep = buildNeighborhood(current, 'product', 2);
  assert.ok(deep.entityNames.length >= product.entityNames.length);
  assert.ok(deep.edges.length >= product.edges.length);

  const incoming = buildNeighborhood(current, 'productVariant', 1);
  assert.ok(incoming.edges.some((edge) => edge.target === 'productVariant'));
});

test('focused neighborhoods handle isolated and synthetic entities', () => {
  const current = issue11Model();
  const isolated = current.entities.find((entity) => (
    entity.relations.length === 0
      && !current.edges.some((edge) => edge.source === entity.name || edge.target === entity.name)
  ));
  assert.ok(isolated);
  assert.deepEqual(buildNeighborhood(current, isolated.name, 2), {
    entityNames: [isolated.name],
    edges: [],
    omitted: 0,
  });

  const synthetic = current.entities.find((entity) => entity.synthetic);
  assert.ok(synthetic);
  assert.ok(buildNeighborhood(current, synthetic.name, 1).entityNames.includes(synthetic.name));
});

test('visualization server serves the UI and JSON model safely', async (t) => {
  const current = issue11Model();
  const server = createVisualizationServer({ model: current });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => server.close());

  const page = await request(server, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/html/);
  assert.match(page.body, /S3000L IR Viewer/);

  const data = await request(server, '/api/model');
  assert.equal(data.status, 200);
  assert.match(data.type, /^application\/json/);
  assert.equal(JSON.parse(data.body).dialect, '1.1');

  const missing = await request(server, '/not-found');
  assert.equal(missing.status, 404);
  assert.equal((await request(server, '/app.js')).status, 200);
});

test('visualizer argument parsing defaults to bundled Issue 1.1 schema', () => {
  const options = parseArgs([]);
  assert.equal(options.port, 4173);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.open, false);
  assert.equal(fs.existsSync(options.xsdFile), true);
  assert.deepEqual(parseArgs(['custom.xsd', '--port', '0', '--host', 'localhost', '--open']), {
    xsdFile: 'custom.xsd',
    port: 0,
    host: 'localhost',
    open: true,
  });
});
