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

test('Issue 1.1 example retains every variant identifier and its metadata in one node', async () => {
  const identifiers = [
    { id: 'YBSB5', class: 'PVC', setBy: { orgId: { id: 'ORG-1' } } },
    { id: 'B5', class: 'UOC' },
    { id: 'ALT-B5' },
    { id: 'B5', class: 'PVC' },
  ];

  for (const identifierCell of [JSON.stringify(identifiers), identifiers]) {
    const rows = exampleRows();
    rows.productVariant[0].prod_var_id = identifierCell;
    rows.productVariant[0].name = JSON.stringify({ descr: 'Yeti SB5 Beti' });

    const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
    const variants = nodes[0].children.filter((node) => node.kind === 'product-variant');

    assert.equal(variants.length, 1);
    assert.deepEqual(variants[0].identifiers, identifiers);
    assert.equal(variants[0].identifier, 'YBSB5');
    assert.equal(variants[0].key, 'productVariant:prodv1');
    assert.equal(variants[0].label, 'Yeti SB5 Beti (YBSB5 [PVC], B5 [UOC], ALT-B5, B5 [PVC])');
    assert.deepEqual(variants[0].children.map((node) => node.label), ['HY breakdown']);
    assert.ok(renderTextTree(nodes).includes(variants[0].label));
  }
});

test('Issue 1.1 example handles varying numbers of variants and identifiers per variant', async () => {
  for (const variantCount of [0, 1, 3, 7]) {
    const rows = exampleRows();
    const template = rows.productVariant[0];
    const expectedVariants = Array.from({ length: variantCount }, (_, position) => ({
      ...template,
      id: position + 2,
      uid: `prodv${position + 1}`,
      prod_var_id: JSON.stringify(Array.from({ length: position + 1 }, (_identifier, identifierPosition) => ({
        id: `PV-${position + 1}-${identifierPosition + 1}`,
      }))),
    }));
    rows.productVariant = [...expectedVariants].reverse();
    rows.productVariant.push({
      ...template,
      id: 100,
      uid: 'prodv100',
      product_prod_var_parent_id: 100,
    });

    const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));
    const variants = nodes[0].children.filter((node) => node.kind === 'product-variant');

    assert.deepEqual(variants.map((node) => node.uid), expectedVariants.map((row) => row.uid));
    variants.forEach((variant, position) => {
      const identifiers = JSON.parse(expectedVariants[position].prod_var_id);
      assert.deepEqual(variant.identifiers, identifiers);
      for (const identifier of identifiers) assert.ok(variant.label.includes(identifier.id));
    });
  }
});

test('Issue 1.1 example retains repeated product identifiers and normalizes singleton variant identifiers', async () => {
  const rows = exampleRows();
  const identifiers = [{ id: 'PROD-1' }, { id: 'ALT-PROD-1' }];
  rows.product[0].prod_id = JSON.stringify(identifiers);

  const nodes = await loadIssue11ProductBreakdown(getIssue11Ir(), fakeDb(rows));

  assert.deepEqual(nodes[0].identifiers, identifiers);
  assert.equal(nodes[0].identifier, 'PROD-1');
  assert.equal(nodes[0].label, 'Aircraft Product (PROD-1, ALT-PROD-1)');
  const variant = nodes[0].children.find((node) => node.kind === 'product-variant');
  assert.deepEqual(variant.identifiers, [{ id: 'PV-1' }]);
  assert.equal(variant.label, 'Trainer Variant (PV-1)');
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
