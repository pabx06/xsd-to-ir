const assert = require('node:assert/strict');
const test = require('node:test');

const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const {
  ISSUE_11_XSD,
  loadIssue11ProductBreakdown,
  renderTextTree,
} = require('../examples/issue-1.1-product-breakdown');

let issue11Ir;

function getIssue11Ir() {
  if (!issue11Ir) issue11Ir = new IRBuilder(parseXSD(ISSUE_11_XSD)).build();
  return issue11Ir;
}

function fakeDb(rowsByEntity) {
  return {
    async queryEntity(entityName) {
      return rowsByEntity[entityName] || [];
    },
    async queryRelated(entityName, parentColumn, parentId) {
      return (rowsByEntity[entityName] || [])
        .filter((row) => String(row[parentColumn]) === String(parentId));
    },
  };
}

function exampleRows() {
  return {
    product: [{
      id: 1,
      uid: 'prod1',
      prod_id: JSON.stringify({ id: 'PROD-1' }),
      name: JSON.stringify({ descr: 'Aircraft Product' }),
      bkdns: JSON.stringify({
        bkdn: {
          '@_uid': 'bkdn1',
          bkdnType: { code: 'SY' },
          bkdnRev: {
            '@_uid': 'bkdnr1',
            bkdnRevId: { id: 'A' },
            beUsage: [
              {
                '@_uid': 'beu1',
                beRef: { '@_uidRef': 'ber1' },
                beChild: {
                  '@_uid': 'bes1',
                  rfd: { id: '1' },
                  qty: { unit: 'EA', value: '2' },
                  beChildRef: { '@_uidRef': 'beu2' },
                },
              },
              {
                '@_uid': 'beu2',
                beRef: {
                  beId: { id: 'ENG-1' },
                  beRevId: { id: '1.0' },
                },
              },
            ],
          },
        },
      }),
    }],
    productVariant: [{
      id: 2,
      uid: 'prodv1',
      product_prod_var_parent_id: 1,
      prod_var_id: JSON.stringify({ id: 'PV-1' }),
      name: JSON.stringify({ descr: 'Trainer Variant' }),
      bkdns: JSON.stringify({
        bkdn: {
          '@_uid': 'bkdn2',
          bkdnType: { code: 'HY' },
        },
      }),
    }],
    aggregatedElement: [{
      id: 10,
      uid: 'be1',
      be_id: JSON.stringify({ id: 'SYS-1' }),
      name: JSON.stringify({ descr: 'Aircraft' }),
    }],
    aggregatedElementRevision: [{
      id: 11,
      uid: 'ber1',
      aggregated_element_be_rev_parent_id: 10,
      be_rev_id: JSON.stringify({ id: '1.0' }),
    }],
    hardwareElement: [{
      id: 20,
      uid: 'be2',
      be_id: JSON.stringify({ id: 'ENG-1' }),
      name: JSON.stringify({ descr: 'Engine' }),
    }],
    hardwareElementRevision: [{
      id: 21,
      uid: 'ber2',
      hardware_element_be_rev_parent_id: 20,
      be_rev_id: JSON.stringify({ id: '1.0' }),
    }],
  };
}

function allTreeNodes(nodes) {
  return nodes.flatMap((node) => [node, ...allTreeNodes(node.children)]);
}

test('Issue 1.1 example builds a display tree from database entities and inline breakdown JSON', async () => {
  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(exampleRows()));

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].entityName, 'product');
  assert.equal(nodes[0].children[0].schemaType, 'breakdown');
  assert.equal(nodes[0].children[0].children[0].children[0].resolvedEntity.entityName, 'aggregatedElement');
  assert.equal(
    nodes[0].children[0].children[0].children[0].children[0].resolvedEntity.entityName,
    'hardwareElement',
  );
  assert.equal(nodes[0].children[1].entityName, 'productVariant');

  assert.equal(renderTextTree(nodes), [
    'Aircraft Product (PROD-1)',
    '├─ SY breakdown',
    '│  └─ Revision A',
    '│     └─ Aircraft (SYS-1)',
    '│        └─ Engine (ENG-1) × 2 EA [1]',
    '└─ Trainer Variant (PV-1)',
    '   └─ HY breakdown',
  ].join('\n'));
});

test('Issue 1.1 example can select one product UID', async () => {
  const rows = exampleRows();
  rows.product.push({
    id: 3,
    uid: 'prod2',
    prod_id: JSON.stringify({ id: 'PROD-2' }),
    name: null,
    bkdns: null,
  });

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows), {
    productUid: 'prod2',
  });

  assert.deepEqual(nodes.map((node) => node.uid), ['prod2']);
  assert.equal(renderTextTree(nodes), 'PROD-2');
});

test('Issue 1.1 example displays unresolved element and usage references', async () => {
  const rows = exampleRows();
  rows.hardwareElement = [];
  rows.hardwareElementRevision = [];
  const bkdns = JSON.parse(rows.product[0].bkdns);
  bkdns.bkdn.bkdnRev.beUsage[1].beChild = {
    beChildRef: { '@_uidRef': 'beu-missing' },
  };
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const labels = allTreeNodes(nodes).map((node) => node.label);

  assert.ok(labels.includes('Unresolved breakdown element ENG-1'));
  assert.ok(labels.includes('Unresolved usage beu-missing'));
});

test('Issue 1.1 example stops at cyclic usage references', async () => {
  const rows = exampleRows();
  const bkdns = JSON.parse(rows.product[0].bkdns);
  bkdns.bkdn.bkdnRev.beUsage[1].beChild = {
    beChildRef: { '@_uidRef': 'beu1' },
  };
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const cycleNodes = allTreeNodes(nodes).filter((node) => node.cycle);

  assert.ok(cycleNodes.length > 0);
  assert.ok(cycleNodes.every((node) => node.label.endsWith('[cycle]')));
});

for (const identifiers of [[{ id: 'ENG-1' }], [{ id: 'ENG-1' }, { id: 'ALT-ENGINE' }]]) {
  test(`Issue 1.1 example resolves each of ${identifiers.length} array-wrapped identifiers`, async () => {
    const rows = exampleRows();
    rows.hardwareElement[0].be_id = JSON.stringify(identifiers);
    const bkdns = JSON.parse(rows.product[0].bkdns);
    bkdns.bkdn.bkdnRev.beUsage = identifiers.map((identifier, position) => ({
      '@_uid': `beu${position + 1}`,
      beRef: { beId: identifier, beRevId: { id: '1.0' } },
    }));
    rows.product[0].bkdns = JSON.stringify(bkdns);

    const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
    const usages = allTreeNodes(nodes).filter((node) => node.kind === 'breakdown-element');

    assert.equal(usages.length, identifiers.length);
    assert.ok(usages.every((node) => node.resolvedEntity?.revisionUid === 'ber2'));
  });
}

test('Issue 1.1 example retains identifier qualifiers and revision IDs when resolving aliases', async () => {
  const rows = exampleRows();
  rows.hardwareElement[0].be_id = JSON.stringify([
    { id: 'ENG-1' },
    { id: 'ALT-ENGINE', setBy: { '@_uidRef': 'org1' } },
  ]);
  const bkdns = JSON.parse(rows.product[0].bkdns);
  bkdns.bkdn.bkdnRev.beUsage = [
    { beRef: { beId: { setBy: { '@_uidRef': 'org1' }, id: 'ALT-ENGINE' }, beRevId: { id: '1.0' } } },
    { beRef: { beId: { id: 'ALT-ENGINE', setBy: { '@_uidRef': 'org2' } }, beRevId: { id: '1.0' } } },
    { beRef: { beId: { id: 'ENG-1' }, beRevId: { id: '2.0' } } },
  ];
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const usages = allTreeNodes(nodes).filter((node) => node.kind === 'breakdown-element');

  assert.deepEqual(usages.map((node) => node.resolvedEntity?.revisionUid ?? null), ['ber2', null, null]);
});

test('Issue 1.1 example displays disconnected cycles alongside ordinary roots', async () => {
  const rows = exampleRows();
  const bkdns = JSON.parse(rows.product[0].bkdns);
  bkdns.bkdn.bkdnRev.beUsage.push(
    {
      '@_uid': 'beu3',
      beRef: { '@_uidRef': 'ber1' },
      beChild: { beChildRef: { '@_uidRef': 'beu4' } },
    },
    {
      '@_uid': 'beu4',
      beRef: { '@_uidRef': 'ber2' },
      beChild: { beChildRef: { '@_uidRef': 'beu3' } },
    },
    {
      '@_uid': 'beu5',
      beRef: { '@_uidRef': 'ber2' },
      beChild: { beChildRef: { '@_uidRef': 'beu5' } },
    },
  );
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const revision = nodes[0].children[0].children[0];
  const usages = allTreeNodes(revision.children);

  assert.deepEqual(revision.children.map((node) => node.uid), ['beu1', 'beu3', 'beu5']);
  assert.deepEqual(new Set(usages.map((node) => node.uid)), new Set(['beu1', 'beu2', 'beu3', 'beu4', 'beu5']));
  assert.deepEqual(usages.filter((node) => node.cycle).map((node) => node.uid), ['beu3', 'beu5']);
});

test('Issue 1.1 example keeps shared children under each parent without reporting a cycle', async () => {
  const rows = exampleRows();
  const bkdns = JSON.parse(rows.product[0].bkdns);
  bkdns.bkdn.bkdnRev.beUsage.push({
    '@_uid': 'beu3',
    beRef: { '@_uidRef': 'ber1' },
    beChild: { beChildRef: { '@_uidRef': 'beu2' }, rfd: { id: 'R' } },
  });
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const roots = nodes[0].children[0].children[0].children;

  assert.deepEqual(roots.map((node) => node.uid), ['beu1', 'beu3']);
  assert.deepEqual(roots.map((node) => node.children[0].uid), ['beu2', 'beu2']);
  assert.deepEqual(roots.map((node) => node.children[0].referenceDesignator), ['1', 'R']);
  assert.ok(allTreeNodes(nodes).every((node) => !node.cycle));
});

for (const nilValue of ['true', '1', true, 1]) {
  test(`Issue 1.1 example displays explicit nil entries (${JSON.stringify(nilValue)}) without unresolved warnings`, async () => {
    const rows = exampleRows();
    const bkdns = JSON.parse(rows.product[0].bkdns);
    const revision = bkdns.bkdn.bkdnRev;
    const nil = { '@_xsi:nil': nilValue };
    revision.beUsage[1].beChild = { ...nil, '@_uid': 'bes2' };
    revision.beUsage.push({ ...nil, '@_uid': 'beu3' }, nil);
    bkdns.bkdn.bkdnRev = [revision, { ...nil, '@_uid': 'bkdnr2' }];
    rows.product[0].bkdns = JSON.stringify(bkdns);

    const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
    const flatNodes = allTreeNodes(nodes);
    const nilNodes = flatNodes.filter((node) => node.nil);

    assert.equal(nilNodes.length, 4);
    assert.equal(new Set(nilNodes.map((node) => node.key)).size, 4);
    assert.deepEqual(nilNodes.map((node) => node.uid), ['bes2', 'beu3', null, 'bkdnr2']);
    assert.ok(nilNodes.every((node) => node.label.endsWith('[nil]') && node.children.length === 0));
    assert.ok(flatNodes.every((node) => !node.label.startsWith('Unresolved')));
    assert.match(renderTextTree(nodes), /\[nil\]/);
  });
}

test('Issue 1.1 example renders content normally when xsi:nil is false or zero', async () => {
  const rows = exampleRows();
  const bkdns = JSON.parse(rows.product[0].bkdns);
  const revision = bkdns.bkdn.bkdnRev;
  revision['@_xsi:nil'] = 'false';
  revision.beUsage[0]['@_xsi:nil'] = '0';
  revision.beUsage[0].beChild['@_xsi:nil'] = false;
  revision.beUsage[1]['@_xsi:nil'] = 0;
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const control = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(exampleRows()));

  assert.equal(renderTextTree(nodes), renderTextTree(control));
  assert.ok(allTreeNodes(nodes).every((node) => !node.nil));
});

test('Issue 1.1 example retains all designators on resolved and unresolved child references', async () => {
  const rows = exampleRows();
  const bkdns = JSON.parse(rows.product[0].bkdns);
  const revision = bkdns.bkdn.bkdnRev;
  revision.beUsage[0].beChild.rfd = [{ id: 'L' }, { '@_xsi:nil': 'true' }, { id: 'R' }];
  revision.beUsage[1].beChild = {
    beChildRef: { '@_uidRef': 'beu99' },
    rfd: [{ id: '001' }, { id: '002' }],
  };
  rows.product[0].bkdns = JSON.stringify(bkdns);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
  const engine = allTreeNodes(nodes).find((node) => node.uid === 'beu2');
  const unresolved = engine.children[0];

  assert.deepEqual(engine.referenceDesignators, ['L', 'R']);
  assert.equal(engine.referenceDesignator, 'L, R');
  assert.deepEqual(unresolved.referenceDesignators, ['001', '002']);
  assert.equal(unresolved.referenceDesignator, '001, 002');
  assert.match(renderTextTree(nodes), /Engine \(ENG-1\) × 2 EA \[L, R\]/);
  assert.match(renderTextTree(nodes), /Unresolved usage beu99 \[001, 002\]/);
});

test('Issue 1.1 example rejects a different IR dialect', async () => {
  await assert.rejects(
    loadIssue11ProductBreakdown({ s3000lDialect: '2.0' }, fakeDb({})),
    /Issue 1\.1 IR required; received 2\.0/,
  );
});
