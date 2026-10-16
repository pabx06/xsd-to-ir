const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { XMLParser } = require('fast-xml-parser');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { deserializeXML } = require('../src/xml-deserializer');
const { XMLSerializer } = require('../src/xml-serializer');

const XSD = 'test/fixtures/xml-string-preservation.xsd';
let ir;

function schema() {
  if (!ir) ir = new IRBuilder(parseXSD(XSD)).build();
  return ir;
}

function productDocument(content, attributes = 'uid="prod1" crud="I"') {
  const xml = `<lsaDataset>
    <msgId>STRING-PRESERVATION</msgId><msgDate>2026-10-13</msgDate>
    <msgType><code>B</code></msgType>
    <logisticsSupportAnalysisData><lsaPrimaryData><products>
      <prod ${attributes}>${content}</prod>
    </products></lsaPrimaryData></logisticsSupportAnalysisData>
  </lsaDataset>`;
  return xml;
}

function importProduct(content) {
  const rows = deserializeXML(productDocument(content), schema()).batches.get('product').insert;
  assert.equal(rows.length, 1);
  return rows[0];
}

function fields(particle) {
  if (!particle) return [];
  if (particle.kind === 'element') return [particle];
  return particle.children.flatMap(fields);
}

test('IR carries effective whitespace rules for direct and inherited inline string types', () => {
  const columns = schema().entities.get('product').columns;
  assert.equal(columns.find((column) => column.name === 'directText').constraints.whiteSpace, 'preserve');
  assert.equal(columns.find((column) => column.name === 'directToken').constraints.whiteSpace, 'collapse');

  const baseFields = fields(schema().valueTypes.get('PayloadBase').content);
  const whitespace = Object.fromEntries(baseFields.map((field) => [
    field.name, field.type.constraints.whiteSpace,
  ]));
  assert.deepEqual(whitespace, {
    preserved: 'preserve',
    replaced: 'replace',
    collapsed: 'collapse',
    restricted: 'collapse',
  });
});

test('direct string columns preserve whitespace and empty strings while token columns collapse it', () => {
  assert.equal(importProduct('<directText>  alpha\t beta\n </directText>').direct_text, '  alpha\t beta\n ');
  assert.equal(importProduct('<directText/>').direct_text, '');
  assert.equal(
    importProduct('<directToken>  alpha\t beta\n gamma\u00a0 delta  </directToken>').direct_token,
    'alpha beta gamma\u00a0 delta',
  );
});

test('typed uid whitespace is normalized consistently for stored rows and update/delete identity', () => {
  const updated = deserializeXML(productDocument('', 'uid="  prod1  " crud="U"'), schema());
  const row = updated.batches.get('product').update[0];
  assert.equal(row.uid, 'prod1');
  assert.equal(row._xmlUid, row.uid);
  const deleted = deserializeXML(productDocument('', 'uid="  prod1  " crud="D"'), schema());
  assert.deepEqual(deleted.batches.get('product').delete, ['prod1']);
});

test('simple-content columns without attributes store JSON strings and preserve their spelling on export', async () => {
  const parser = new XMLParser({ parseTagValue: false, trimValues: false });
  for (const text of ['001234', '1234.00', 'true', '  note  ', '']) {
    const row = importProduct(`<note>${text}</note>`);
    assert.equal(JSON.parse(row.note), text);
    const db = { queryEntity: async (name) => (name === 'product' ? [row] : []) };
    const xml = await new XMLSerializer(schema(), db).serialize({ msgId: 'STRINGS', collections: ['product'] });
    assert.equal(parser.parse(xml).lsaDataset.logisticsSupportAnalysisData.lsaPrimaryData.products.prod.note, text);
  }
});

test('simple-content restrictions override inherited whitespace rules with or without attributes', () => {
  const scalar = importProduct('<restrictedNote>  A\t B  </restrictedNote>');
  assert.equal(JSON.parse(scalar.restricted_note), 'A B');
  const object = importProduct('<restrictedNote label="  X\t Y  ">  A\t B  </restrictedNote>');
  assert.deepEqual(JSON.parse(object.restricted_note), { '#text': 'A B', '@_label': 'X Y' });
});

test('inline inherited string types apply preserve, replace and collapse without treating NBSP as XML whitespace', () => {
  const row = importProduct(`<payload raw="  001  " count="0007" label="  A\t B\u00a0 C  ">
    <preserved>  alpha\t beta\n </preserved>
    <replaced> \talpha\n beta\u00a0 </replaced>
    <collapsed>  alpha\t beta\n gamma\u00a0 delta  </collapsed>
    <restricted>  inherited\t collapse  </restricted>
    <node><value>  root  </value><child><value>  leaf  </value></child></node>
    <note count="0012" label="  N\t B  ">  001234  </note>
    <mystery>  001.00  </mystery><choice>  001  </choice><numbers>  1\t 2\n 3  </numbers>
    <integer>42</integer><decimal>12.5</decimal><flag>true</flag>
  </payload>`);
  assert.deepEqual(JSON.parse(row.payload), {
    preserved: '  alpha\t beta\n ',
    replaced: '  alpha  beta\u00a0 ',
    collapsed: 'alpha beta gamma\u00a0 delta',
    restricted: 'inherited collapse',
    node: { value: '  root  ', child: { value: '  leaf  ' } },
    note: { '#text': '  001234  ', '@_count': '0012', '@_label': 'N B' },
    mystery: '  001.00  ',
    choice: '  001  ',
    numbers: '1 2 3',
    integer: 42,
    decimal: 12.5,
    flag: true,
    '@_raw': '  001  ',
    '@_count': '0007',
    '@_label': 'A B\u00a0 C',
  });
});

test('large numeric elements stay exact strings and boolean numeric spellings retain current values', () => {
  const common = `<preserved>x</preserved><replaced>x</replaced><collapsed>x</collapsed>
    <restricted>x</restricted><node><value>x</value></node><note>x</note>
    <mystery>x</mystery><choice>x</choice><numbers>1</numbers>`;
  const row = importProduct(`<payload>${common}<integer>9007199254740993</integer>
    <decimal>1.234567890123456789</decimal><flag>1</flag></payload>`);
  const value = JSON.parse(row.payload);
  assert.equal(value.integer, '9007199254740993');
  assert.equal(value.decimal, '1.234567890123456789');
  assert.equal(value.flag, 1);
});

test('malformed numeric and boolean text is preserved instead of partially coerced', () => {
  const row = importProduct(`<payload>
    <preserved>x</preserved><replaced>x</replaced><collapsed>x</collapsed><restricted>x</restricted>
    <node><value>x</value></node><note>x</note><mystery>x</mystery><choice>x</choice>
    <numbers>1</numbers><integer>12oops</integer><decimal>1.2oops</decimal><flag>yes</flag>
  </payload>`);
  const value = JSON.parse(row.payload);
  assert.equal(value.integer, '12oops');
  assert.equal(value.decimal, '1.2oops');
  assert.equal(value.flag, 'yes');
});

test('element-only indentation is removed recursively while mixed text is retained', () => {
  const row = importProduct(`<payload>
    <preserved>x</preserved><replaced>x</replaced><collapsed>x</collapsed><restricted>x</restricted>
    <node>
      <value>  root  </value>
      <child>
        <value>  leaf  </value>
      </child>
    </node>
    <note>  note  </note><mystery>x</mystery><choice>x</choice><numbers>1</numbers>
    <integer>1</integer><decimal>1.5</decimal><flag>false</flag>
  </payload><mixed> before <em>  emphasized  </em> after </mixed>`);
  const value = JSON.parse(row.payload);
  assert.equal(Object.hasOwn(value, '#text'), false);
  assert.equal(Object.hasOwn(value.node, '#text'), false);
  assert.equal(Object.hasOwn(value.node.child, '#text'), false);
  assert.deepEqual(JSON.parse(row.mixed), { em: '  emphasized  ', '#text': ' before  after ' });
});

for (const [issue, xsd, fixture] of [
  ['1.1', 's3000l/1_1/s3000l_1-1_lsa_dataset.xsd', 'test/fixtures/rev-004-issue-1-valid.xml'],
  ['2.0', 's3000l/2_0/s3000l_2-0_lsaDataset.xsd', 'test/fixtures/rev-004-issue-2-valid.xml'],
]) {
  let realIr;
  const realSchema = () => {
    if (!realIr) realIr = new IRBuilder(parseXSD(xsd)).build();
    return realIr;
  };
  const source = fs.readFileSync(fixture, 'utf8');

  test(`Issue ${issue}: anonymous uid restrictions normalize stored and related identities`, () => {
    const uid = source.match(/<prod uid="([^"]+)"/)[1];
    const padded = source.replace(`<prod uid="${uid}" crud="I">`, `<prod uid="  ${uid}  " crud="U">`);
    const nested = padded.replace('</prod>', '<prodVar uid="  prodv1  " crud="I"><prodVarId><id>V1</id></prodVarId></prodVar></prod>');
    const { batches } = deserializeXML(nested, realSchema());
    const row = batches.get('product').update[0];
    assert.equal(row.uid, uid);
    assert.equal(row._xmlUid, uid);
    const child = batches.get('productVariant').insert[0];
    assert.equal(child.uid, 'prodv1');
    assert.equal(child._xmlParent.uid, uid);
    const deleted = deserializeXML(padded.replace('crud="U"', 'crud="D"'), realSchema());
    assert.deepEqual(deleted.batches.get('product').delete, [uid]);
  });

  test(`Issue ${issue}: header identifiers stay strings and date/time whitespace collapses`, () => {
    const padded = source
      .replace(/<(dateTime|date|time)>([^<]+)<\/(dateTime|date|time)>/g, (_match, tag, value) => `<${tag}>  ${value}  </${tag}>`)
      .replace(/<msgId>\s*<id>[^<]+<\/id>/, '<msgId><id>  001234  </id>');
    // Metadata extraction also supports callers without the full entity IR.
    for (const model of [realSchema(), { entities: new Map() }]) {
      const { msgMeta } = deserializeXML(padded, model);
      assert.equal(msgMeta.msgId, '001234');
      assert.equal(msgMeta.msgDate, '2026-08-07T12:34:56Z');
    }
  });
}

test('header message references collapse identifier, IDREF and URI whitespace', () => {
  const source = fs.readFileSync('test/fixtures/rev-004-issue-2-related-refs-valid.xml', 'utf8');
  const padded = source.replace('BASELINE-BY-ID', '  BASELINE-BY-ID  ')
    .replace('uidRef="msg2"', 'uidRef="  msg2  "')
    .replace('uriRef="https://example.test/messages/baseline"', 'uriRef="  https://example.test/messages/baseline  "');
  const { msgMeta } = deserializeXML(padded, { entities: new Map() });
  assert.deepEqual(msgMeta.relatedMsgId, ['BASELINE-BY-ID', 'msg2', 'https://example.test/messages/baseline']);
});
