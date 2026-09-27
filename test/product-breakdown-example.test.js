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

test('Issue 1.1 example rejects a different IR dialect', async () => {
  await assert.rejects(
    loadIssue11ProductBreakdown({ s3000lDialect: '2.0' }, fakeDb({})),
    /Issue 1\.1 IR required; received 2\.0/,
  );
});
