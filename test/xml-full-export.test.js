const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const {
  IRBuilder, parseXSD, serializeToXML, deserializeXML, getS3000LSchemaPath, getS30001SchemaPath,
} = require('../lib');

const schemas = {
  1.1: 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd',
  '2.0': 's3000l/2_0/s3000l_2-0_lsaDataset.xsd',
};
for (const [version, file] of Object.entries(schemas)) {
  test(`${version} emits a baseline for an empty database and reports only emitted SQL records`, async () => {
    assert.equal(getS3000LSchemaPath(version), path.resolve(file));
    assert.equal(getS30001SchemaPath(version), path.resolve(file));
    const ir = new IRBuilder(parseXSD(file)).build();
    const db = { queryEntity: async () => [] };
    const empty = await serializeToXML(ir, db);
    const tree = new XMLParser({ ignoreAttributes: false }).parse(empty);
    const root = tree[version === '1.1' ? 's:lsaDataSet' : 's:lsaDataset'];
    assert.equal(root['@_xmlns:s'], 'http://www.asd-europe.org/s-series/s3000l');
    assert.equal(root['@_xmlns:xsi'], 'http://www.w3.org/2001/XMLSchema-instance');
    if (version === '1.1') {
      assert.deepEqual(
        Object.keys(root.msgContent.messageContentItems),
        ['products', 'breakdownElements', 'parts', 'taskRequirements', 'tasks'],
      );
      assert.ok(Object.hasOwn(root.msgContent, 'supportingContentItems'));
    }
    assert.equal(deserializeXML(empty, ir).batches.size, 0);
    const child = ir.entities.get('product').relations.find((rel) => rel.targetEntity === 'productVariant');
    const rows = {
      product: [{ id: '9007199254740993', uid: 'prod1', prod_id: '{"id":"001"}' }],
      productVariant: [
        {
          id: '42', uid: 'prodv1', [child.parentColumn]: '9007199254740993', prod_var_id: '{"id":"V"}',
        },
        { id: '43', uid: 'prodv2', [child.parentColumn]: 'unrelated' },
      ],
      organization: [{ id: '17', uid: 'org1' }],
    };
    db.queryEntity = async (name) => rows[name] || [];
    const options = {
      msgId: 'DUMP-1', msgType: 'B', collections: ['products'], includeExportedRecords: true,
      sendingSystem: 'Sender', receivingSystem: 'Recipient', relatedMsgId: 'Earlier',
    };
    const { xml, exportedRecords } = await serializeToXML(ir, db, options);
    assert.deepEqual(exportedRecords, [
      { entityName: 'product', id: '9007199254740993' }, { entityName: 'productVariant', id: '42' },
    ]);
    assert.deepEqual(deserializeXML(xml, ir).batches.get('productVariant').insert.map((row) => row.uid), ['prodv1']);
    assert.doesNotMatch(xml, /prodv2|org1/);
    rows.organization[0].org_id = '{"id":"A"}';
    rows.organization[0].rmks = { rmk: [{ '@_uid': 'rmk1', '@_crud': 'D' }] };
    const onlyOrg = await serializeToXML(ir, db, { collections: ['organization'] });
    assert.doesNotMatch(onlyOrg, /rmk1/);
    if (version === '1.1') assert.doesNotMatch(onlyOrg, /<rmks/);
    // Issue 2.0 requires a genuine wcn whenever the supporting section is present.
    rows.warningCautionNote = [{ id: '6', uid: 'wcn1', wcn_id: '{"id":"NOTE-1"}' }];
    const supporting = version === '1.1' ? onlyOrg : await serializeToXML(ir, db, {
      collections: ['organization', 'warningCautionNote'],
    });
    if (process.env.XSD11_EXPORT_TEST === '1') {
      const dir = await mkdtemp(path.join(tmpdir(), 'xml-full-export-'));
      try {
        const validate = (output) => execFileSync(process.execPath, [
          'scripts/validate-xsd11.js', '--skip-self-test', '--xsd', file, '--xml', output,
        ], { stdio: 'pipe' });
        for (const [label, bytes] of Object.entries({ empty, populated: xml, supporting })) {
          const output = path.join(dir, `${label}.xml`);
          await writeFile(output, bytes);
          validate(output);
        }
        if (version === '2.0') {
          const output = path.join(dir, 'missing-required-wcn.xml');
          await writeFile(output, onlyOrg);
          assert.throws(() => validate(output), /warningCautionNotes/);
        }
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    await assert.rejects(() => serializeToXML(ir, db, { version: version === '1.1' ? '2.0' : '1.1' }), /dialect/);
  });
}

test('a baseline converts inline updates to inserts and omits inline deletions without changing storage', async () => {
  const ir = new IRBuilder(parseXSD(schemas['1.1'])).build();
  const remarks = {
    rmk: [
      { '@_uid': 'rmk1', '@_crud': 'U', text: { descr: 'kept' } },
      { '@_uid': 'rmk2', '@_crud': 'D', text: { descr: 'removed' } },
    ],
  };
  const row = {
    id: 5, uid: 'org1', org_id: '{"id":"A"}', rmks: remarks,
  };
  const db = { queryEntity: async (name) => (name === 'organization' ? [row] : []) };
  const { xml, exportedRecords } = await serializeToXML(ir, db, { includeExportedRecords: true });
  assert.match(xml, /<rmk uid="rmk1" crud="I">/);
  assert.doesNotMatch(xml, /rmk2|removed/);
  assert.equal(remarks.rmk[0]['@_crud'], 'U');
  assert.deepEqual(exportedRecords, [{ entityName: 'organization', id: 5, omittedDeletionUids: ['rmk2'] }]);
});
