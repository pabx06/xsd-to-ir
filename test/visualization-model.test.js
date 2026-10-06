const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { buildNeighborhood, buildVisualizationModel } = require('../src/visualization-model');
const { createVisualizationServer, parseArgs } = require('../scripts/visualize');

const xsdPath = path.join(__dirname, '..', 's3000l', '1_1', 's3000l_1-1_lsa_dataset.xsd');
const visualizerPath = path.join(__dirname, '..', 'visualizer', 'app.js');
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

function loadVisualizerRenderer(currentModel) {
  const source = fs.readFileSync(visualizerPath, 'utf8');
  const sandbox = {
    URLSearchParams,
    window: { addEventListener() {} },
  };
  vm.runInNewContext(`${source}\n;globalThis.__renderer = { state, renderValueTypeDefinition, renderValueTypeReference, toggleValueType };`, sandbox, {
    filename: visualizerPath,
  });
  sandbox.__renderer.state.model = currentModel;
  return sandbox.__renderer;
}

test('Issue 1.1 visualization model preserves IR counts and mappings', () => {
  const current = issue11Model();
  assert.equal(current.dialect, '1.1');
  assert.equal(current.stats.entities, 286);
  assert.equal(current.stats.recordEntities, 169);
  assert.equal(current.stats.syntheticEntities, 117);
  assert.equal(current.stats.columns, 2632);
  assert.equal(current.stats.relations, 299);
  assert.equal(current.stats.islands, 57);
  assert.equal(current.stats.crudUis, 169);
  assert.equal(current.stats.joinTables, 0);
  assert.equal(current.stats.enums, 149);
  assert.equal(current.stats.simpleTypes, 24);
  assert.equal(current.stats.valueTypes, Object.keys(current.valueTypes).length);
  assert.equal(current.stats.assertions, 36);
  assert.equal(current.stats.assertionPaths, 131);
  assert.equal(current.collections.product.collectionName, 'products');
  assert.equal(current.collections.product.recordName, 'prod');
  assert.equal(current.collections.product.section, 'lsaPrimaryData');
  assert.ok(current.entities.some((entity) => entity.synthetic));
  assert.equal(current.edges.filter((edge) => edge.unresolved).length, 0);
  assert.equal(current.entities.every((entity) => entity.islandId), true);
  assert.equal(current.islands.reduce((total, island) => total + island.entityCount, 0), 286);
  assert.equal(current.islands.reduce((total, island) => total + island.crudUiCount, 0), 169);
  assert.equal(current.islands.filter((island) => island.entityCount === 1).length, 34);
  const itemIsland = current.islands.find((island) => island.entityNames.includes('itemInProductVariant'));
  assert.deepEqual(itemIsland, {
    id: 'island-017',
    index: 17,
    entityNames: ['itemInProductVariant'],
    recordEntities: ['itemInProductVariant'],
    syntheticEntities: [],
    entityCount: 1,
    relationCount: 0,
    recordEntityCount: 1,
    syntheticEntityCount: 0,
    crudUiCount: 1,
    sections: ['unmapped'],
  });
  assert.equal(JSON.stringify(current).includes('[object Map]'), false);
  assert.equal(JSON.stringify(current).includes('"undefined"'), false);
});

test('visualization model carries named and anonymous value types and column references', () => {
  const namedType = {
    name: 'displayName',
    documentation: 'A documented structured name.',
    content: {
      kind: 'sequence', minOccurs: 1, maxOccurs: 1, children: [],
    },
    attributes: [],
    text: null,
    baseTypeRef: null,
    derivation: null,
    mixed: false,
    assertionRefs: [],
    unsupported: [],
  };
  const anonymousKey = 'record/value/anonymous-1';
  const anonymousType = {
    ...namedType,
    name: null,
    content: {
      kind: 'choice',
      minOccurs: 1,
      maxOccurs: 1,
      children: [{
        kind: 'element',
        name: 'label',
        xmlName: 'label',
        jsonName: 'label',
        type: {
          xsdType: 'displayName',
          valueTypeRef: 'displayName',
          jsonType: 'object',
          constraints: {},
          unsupported: [],
        },
        minOccurs: 1,
        maxOccurs: 1,
        nillable: false,
        defaultValue: null,
        fixedValue: null,
        documentation: null,
      }],
    },
  };
  const ir = {
    entities: new Map([['record', {
      name: 'record',
      tableName: 'record',
      columns: [{ name: 'value', valueTypeRef: anonymousKey }],
      relations: [],
    }]]),
    valueTypes: new Map([['displayName', namedType], [anonymousKey, anonymousType]]),
  };

  const current = buildVisualizationModel(ir);
  assert.equal(current.stats.valueTypes, 2);
  assert.equal(current.entities[0].columns[0].valueTypeRef, anonymousKey);
  assert.equal(current.valueTypes.displayName.name, 'displayName');
  assert.equal(current.valueTypes[anonymousKey].content.kind, 'choice');
  assert.equal(current.valueTypes[anonymousKey].content.children[0].type.valueTypeRef, 'displayName');
  assert.equal(JSON.stringify(current).includes('[object Map]'), false);
});

test('visualizer lazily renders real inline value structures safely', () => {
  const current = issue11Model();
  const product = current.entities.find((entity) => entity.name === 'product');
  const prodId = product.columns.find((column) => column.name === 'prodId');
  const bkdns = product.columns.find((column) => column.name === 'bkdns');
  assert.equal(prodId.valueTypeRef, 'productIdentifier');
  assert.match(bkdns.valueTypeRef, /^@anonymous\//);

  const modelWithUnsafeDocumentation = {
    ...current,
    valueTypes: {
      ...current.valueTypes,
      productIdentifier: {
        ...current.valueTypes.productIdentifier,
        documentation: '<unsafe & "quoted">',
      },
    },
  };
  const renderer = loadVisualizerRenderer(modelWithUnsafeDocumentation);
  const productIdentifier = renderer.renderValueTypeDefinition(prodId.valueTypeRef, []);
  assert.match(productIdentifier, /<strong>id<\/strong>[\s\S]*?1\.\.1 · required/);
  assert.match(productIdentifier, /<strong>class<\/strong>[\s\S]*?0\.\.1 · optional · nillable/);
  assert.match(productIdentifier, /<strong>setBy<\/strong>[\s\S]*?0\.\.1 · optional · nillable/);
  assert.match(productIdentifier, /enum: EIAC, MOI, PID/);
  assert.match(productIdentifier, /&lt;unsafe &amp; &quot;quoted&quot;&gt;/);
  assert.doesNotMatch(productIdentifier, /<unsafe/);
  assert.match(productIdentifier, /Structure: organizationReference/);

  const choice = renderer.renderValueTypeDefinition('subtaskWarningCautionNote', []);
  assert.match(choice, /choice · 1\.\.1/);
  assert.match(choice, /required when branch selected/);

  const anonymousReference = renderer.renderValueTypeReference(bkdns.valueTypeRef, []);
  assert.match(anonymousReference, /data-value-type-ref="@anonymous\//);
  const anonymousNested = renderer.renderValueTypeDefinition('itemInAllowedProductConfiguration', []);
  assert.match(anonymousNested, /structured value/);
  assert.match(anonymousNested, /Structure: @anonymous\//);

  const organizationReference = renderer.renderValueTypeDefinition('organizationReference', ['productIdentifier']);
  assert.match(organizationReference, /<strong>@_uidRef<\/strong>/);
  assert.match(organizationReference, /JSON string/);
  const organizationIdentifier = renderer.renderValueTypeDefinition(
    'organizationIdentifier',
    ['productIdentifier', 'organizationReference'],
  );
  assert.match(organizationIdentifier, /recursive organizationReference/);
  assert.doesNotMatch(organizationIdentifier, /data-value-type-ref="organizationReference"/);

  let writes = 0;
  let renderedHtml = '';
  const slot = { dataset: {}, hidden: false };
  Object.defineProperty(slot, 'innerHTML', {
    get: () => renderedHtml,
    set: (value) => { renderedHtml = value; writes += 1; },
  });
  const wrapper = { querySelector: () => slot };
  const attributes = { 'aria-expanded': 'false' };
  const control = {
    dataset: { valueTypeRef: prodId.valueTypeRef, valueTypePath: encodeURIComponent('[]') },
    closest: () => wrapper,
    getAttribute: (name) => attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; },
  };
  assert.equal(renderer.toggleValueType(control), true);
  assert.equal(writes, 1);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(slot.hidden, false);
  assert.match(renderedHtml, /<strong>id<\/strong>/);
  assert.equal(renderer.toggleValueType(control), true);
  assert.equal(writes, 1);
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(slot.hidden, true);
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
  assert.match(page.body, /Graph islands/);

  const data = await request(server, '/api/model');
  assert.equal(data.status, 200);
  assert.match(data.type, /^application\/json/);
  const dataModel = JSON.parse(data.body);
  assert.equal(dataModel.dialect, '1.1');
  assert.equal(dataModel.stats.islands, 57);
  assert.equal(dataModel.islands.length, 57);

  const missing = await request(server, '/not-found');
  assert.equal(missing.status, 404);
  assert.equal((await request(server, '/app.js')).status, 200);
  assert.match((await request(server, '/app.js')).body, /renderValueTypeDefinition/);
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
