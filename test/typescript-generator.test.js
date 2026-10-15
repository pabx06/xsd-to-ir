const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const ts = require('typescript');
const {
  IRBuilder, parseXSD, generateTypeScript, deserializeXML,
} = require('../lib');
const { TypeScriptSchema } = require('../src/typescript-schema');
const {
  bundle, realCases, shapeCases, caseValue,
} = require('./helpers/assertion-baseline');

const fixturePath = path.join(__dirname, 'fixtures/typescript-shapes.xsd');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-typescript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compile(dir, sources) {
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(dir, `${name}.ts`);
    fs.writeFileSync(file, source);
    return file;
  });
  const program = ts.createProgram(files, {
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => dir,
    getNewLine: () => '\n',
  });
  assert.equal(diagnostics.length, 0, formatted);
}

function assignment(name, type, value, valid) {
  return `${valid ? '' : `// @ts-expect-error ${name}\n`}const ${name}: ${type} = ${JSON.stringify(value)};`;
}

test('both issue modules compile together and check real UI and assertion examples', (t) => {
  const dir = directory(t);
  const sources = {};
  for (const issue of ['1.1', '2.0', 'fixture']) {
    sources[`issue-${issue}`] = generateTypeScript(bundle(issue).ir);
  }
  const catalog = [
    // Facets such as minimum string length remain a runtime concern.
    ...realCases.filter((item) => item.expectedXsd || !item.expectedAssertion),
    ...shapeCases,
  ];
  sources.assertions = catalog.map((item, index) => {
    const registry = item.issue === 'fixture' ? 'Entities' : 'ValueTypes';
    const type = item.issue === 'fixture' ? `['product'][${JSON.stringify(item.field)}]`
      : `[${JSON.stringify(item.typeName)}]`;
    return assignment(
      `case${index}_${item.id.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      `import('./issue-${item.issue}').${registry}${type}`,
      caseValue(item),
      item.boundary || item.expectedXsd,
    );
  }).join('\n');
  sources.ui = `
    import type { Entities as Issue11, EntityProduct as Product11, ValueTypes as Values11 } from './issue-1.1';
    import type { Entities as Issue20, EntityProduct as Product20, ValueTypes as Values20 } from './issue-2.0';
    const product11: Product11 = { uid: 'prod1', crud: 'I', prodId: { id: '001234' } };
    const product20: Product20 = { uid: 'prod1', crud: 'I', prodId: [{ id: '001234' }] };
    const throughMap: Issue11['product'] = product11;
    const breakdown: NonNullable<Issue11['product']['bkdns']> = {
      bkdn: { '@_uid': 'bkdn1', bkdnType: { code: 'SY' } }
    };
    const nativeName11: Issue11['product']['name'] = { descr: 'Old project' };
    const nativeName20: Issue20['product']['prodName'] = { name: 'New project' };
    // @ts-expect-error Issue 2.0 uses prodName
    type Missing20 = Issue20['product']['name'];
    // @ts-expect-error Issue 1.1 uses name
    type Missing11 = Issue11['product']['prodName'];
    const legacyNumber: Values11['productIdentifier'] = { id: 1234 };
    const legacyBoolean: Values20['productIdentifier'] = { id: true };
    const textObject: Values11['productIdentifier'] = { id: { '#text': '001234', '@_xmlns:custom': 'urn:test' } };
    // @ts-expect-error required prodId
    const missing: Product11 = { uid: 'prod1', crud: 'I' };
    // @ts-expect-error JSON cell contents are typed, not serialized strings
    const rawCell: Product11 = { uid: 'prod1', crud: 'I', prodId: '{"id":"001234"}' };
    // @ts-expect-error empty occurrences
    const empty: Product11['prodId'] = [];
    // @ts-expect-error nested identifier required
    const missingId: Product20['prodId'] = [{}];
    // @ts-expect-error nested breakdown fields required
    const missingBreakdown: Product11['bkdns'] = { bkdn: {} };
    // @ts-expect-error nested attribute is string
    const wrongAttribute: Product11['bkdns'] = { bkdn: { '@_uid': 1, bkdnType: { code: 'SY' } } };
    // @ts-expect-error unknown inline field
    const typo: Values11['productIdentifier'] = { id: '1', wrong: true };
    // @ts-expect-error enum membership
    const badCrud: Product11 = { uid: 'prod1', crud: 'WRONG', prodId: { id: '1' } };
    const both = { '@_uidRef': 'org1', orgId: { id: 'ORG-1' } };
    // @ts-expect-error assertions also reject existing variables, not only fresh literals
    const bothReference: Values11['organizationReference'] = both;
    // @ts-expect-error absence differs from an explicitly undefined field
    const undefinedReference: Values11['organizationReference'] = { '@_uidRef': 'org1', orgId: undefined };
  `;
  // Test the current importer output as well as hand-authored UI input.
  const xml = `<lsaDataset><msgId>TYPES</msgId><msgDate>2026-10-06</msgDate><msgType><code>B</code></msgType>
    <logisticsSupportAnalysisData><lsaPrimaryData><products>
    <prod uid="prod1" crud="I"><prodId><id>001234</id></prodId></prod>
    </products></lsaPrimaryData></logisticsSupportAnalysisData></lsaDataset>`;
  const row = deserializeXML(xml, bundle('2.0').ir).batches.get('product').insert[0];
  const value = JSON.parse(row.prod_id);
  assert.equal(value.id, '001234');
  sources.ui += assignment('imported', 'Product20["prodId"]', value, true);
  compile(dir, sources);
});

test('choices, optional groups, bounded arrays, nil attributes, literals and names stay typed', (t) => {
  const dir = directory(t);
  const ir = new IRBuilder(parseXSD(fixturePath)).build();
  const generated = generateTypeScript(ir);
  const base = { code: 'A', fixed: '123', nodes: [{ id: '001' }, { id: '002' }] };
  const cases = [
    ['base', base, true],
    ['legacyFixed', { ...base, fixed: 123 }, true],
    ['exactNumbers', { ...base, count: '9007199254740993', amount: '0.12345678901234567890' }, true],
    ['numericBoolean', { ...base, flag: 1 }, true],
    ['pair', { ...base, first: '1', second: '2' }, true],
    ['left', { ...base, left: 'L' }, true],
    ['right', { ...base, right: 'R', label: 'Label' }, true],
    ['three', { ...base, nodes: [...base.nodes, { id: '003' }] }, true],
    ['recursive', { ...base, child: base }, true],
    ['text', { ...base, note: { '#text': 'Text', '@_lang': 'en' } }, true],
    ['nil', { ...base, note: { '@_xsi:nil': true, '@_lang': 'en' } }, true],
    ['namespace', { ...base, '@_xmlns': 'urn:test', '@_xmlns:local': 'urn:local' }, true],
    ['wrongCode', { ...base, code: 'OTHER' }, false],
    ['wrongFixed', { ...base, fixed: 12 }, false],
    ['singleton', { ...base, nodes: { id: '001' } }, false],
    ['one', { ...base, nodes: [{ id: '001' }] }, false],
    ['four', { ...base, nodes: [...base.nodes, ...base.nodes] }, false],
    ['missingNested', { ...base, nodes: [{ id: '001' }, {}] }, false],
    ['partialPair', { ...base, first: '1' }, false],
    ['partialRight', { ...base, right: 'R' }, false],
    ['twoChoices', {
      ...base, left: 'L', right: 'R', label: 'Label',
    }, false],
    ['wrongFlag', { ...base, flag: 2 }, false],
    ['nilMissingAttribute', { ...base, note: { '@_xsi:nil': true } }, false],
    ['nilWithContent', { ...base, note: { '@_xsi:nil': true, '@_lang': 'en', '#text': 'Text' } }, false],
    ['nullNote', { ...base, note: null }, false],
    ['prohibited', { ...base, '@_forbidden': 'bad' }, false],
    ['badNamespace', { ...base, '@_xmlns:local': 1 }, false],
  ];
  const use = `import type { ValueTypes, Enums } from './types';\n${
    cases.map(([name, value, valid]) => assignment(name, "ValueTypes['Payload']", value, valid)).join('\n')
  }
      const dash: ValueTypes['a-b'] = { '@_dash': 'a' };
      const underscore: ValueTypes['a_b'] = { '@_underscore': 'b' };
      // @ts-expect-error colliding aliases must not conflate definitions
      const wrongAlias: ValueTypes['a_b'] = dash;
      const reserved: ValueTypes['class'] = { '@_default': 'c' };
      const unicode: ValueTypes['café'] = { '@_clé': 'd' };
      const mapName: ValueTypes['Types'] = { '@_tag': 'e' };
      const enumValue: Enums['Code'] = 'A';
      // @ts-expect-error enum membership
      const enumWrong: Enums['Code'] = 'C';
    `;
  assert.match(generated, /Keep \* \/ comment delimiters inert/);
  compile(dir, { types: generated, use });
});

test('live IR and serialized snapshots produce the same stable output without mutation', () => {
  const ir = new IRBuilder(parseXSD(fixturePath)).build();
  const snapshot = JSON.parse(JSON.stringify(ir, (_key, value) => (
    value instanceof Map ? Object.fromEntries(value) : value
  )));
  const before = JSON.stringify(snapshot);
  const generated = generateTypeScript(ir);
  assert.equal(JSON.stringify(ir, (_key, value) => (
    value instanceof Map ? Object.fromEntries(value) : value
  )), before, 'generation does not mutate the live IR');
  assert.equal(generateTypeScript(snapshot), generated);
  for (const value of Object.values(ir)) {
    if (value instanceof Map) {
      const entries = [...value].reverse();
      value.clear();
      entries.forEach(([key, item]) => value.set(key, item));
    }
  }
  assert.equal(generateTypeScript(ir), generated, 'registry insertion order does not rename types');
  assert.equal(JSON.stringify(snapshot), before);
  const ast = ts.createSourceFile('types.ts', generated, ts.ScriptTarget.Latest, true);
  function visit(node) {
    assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, 'no implicit untyped JSON blobs');
    ts.forEachChild(node, visit);
  }
  visit(ast);
});

test('generic schemas retain inherited entity fields and compile without S3000L version logic', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'generic.xsd');
  fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:simpleType name="Types"><xs:restriction base="xs:string"><xs:minLength value="1"/></xs:restriction></xs:simpleType>
    <xs:complexType name="Base"><xs:sequence><xs:element name="title" type="Types"/></xs:sequence></xs:complexType>
    <xs:complexType name="Child"><xs:complexContent><xs:extension base="Base">
      <xs:attribute name="enabled" type="xs:boolean" use="required"/>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:schema>`);
  const ir = new IRBuilder(parseXSD(file)).build();
  assert.equal(ir.s3000lMode, false);
  compile(dir, {
    types: generateTypeScript(ir),
    use: `
      import type { Entities, SimpleTypes } from './types';
      const name: SimpleTypes['Types'] = 'Hello';
      const value: Entities['Child'] = { BaseId: 1, title: name, enabled: true };
      // @ts-expect-error inherited required field
      const missing: Entities['Child'] = { BaseId: 1, enabled: true };
      // @ts-expect-error derived required field
      const missingOwn: Entities['Child'] = { BaseId: 1, title: 'Hello' };
    `,
  });
});

test('CLI emits the same TypeScript module and supports --no-typescript', (t) => {
  const dir = directory(t);
  const run = (out, extra) => execFileSync(process.execPath, [
    path.join(__dirname, '../index.js'), fixturePath, '--out', out, '--no-sql', '--no-json', ...extra,
  ], { stdio: 'pipe' });
  run(dir, []);
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'types.ts'), 'utf8'), generateTypeScript(snapshot));
  const skipped = path.join(dir, 'skip');
  run(skipped, ['--no-typescript']);
  assert.equal(fs.existsSync(path.join(skipped, 'types.ts')), false);
});

test('unsupported structural changes fail instead of silently widening generated types', () => {
  const emitter = new TypeScriptSchema(() => { throw new Error('Unresolved reference'); });
  assert.throws(() => emitter.type({ contains: { type: 'string' } }), /Unsupported TypeScript schema keyword/);
  assert.throws(() => emitter.type({ not: { type: 'string' } }), /Unsupported TypeScript negation/);
  assert.throws(() => emitter.type({ $ref: '#/missing' }), /Unresolved reference/);
});
