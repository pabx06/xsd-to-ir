const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const ts = require('typescript');
const { IRBuilder } = require('../src/ir-builder');
const { parseXSD } = require('../src/xsd-parser');
const { generateTypeScript } = require('../src/typescript-generator');
const { generateUIJSONSchema } = require('../src/ui-json-schema');
const { generateJSONSchema } = require('../src/json-schema-generator');
const { UIAdapter } = require('../src/ui-adapter');
const { bundle } = require('./helpers/assertion-baseline');

const fixturePath = path.join(__dirname, 'fixtures/typescript-shapes.xsd');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-ui-typescript-'));
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
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => dir,
    getNewLine: () => '\n',
  }));
}

test('clean UI declarations use arrays, business attributes, strict scalars and null nil values', (t) => {
  const dir = directory(t);
  const ir = new IRBuilder(parseXSD(fixturePath)).build();
  const generated = generateTypeScript(ir);
  assert.doesNotMatch(generated, /"@_|"#text"|@_xmlns/);
  compile(dir, {
    types: generated,
    use: `
      import type { Entities, ValueTypes } from './types';
      const base: ValueTypes['Payload'] = {
        code: 'A', fixed: '123', nodes: [{ id: '001' }, { id: '002' }], flag: true,
      };
      const entity: Entities['record'] = { uid: 'record1', crud: 'I', payload: base };
      const text: ValueTypes['Label'] = { value: 'Text', lang: 'en' };
      const nil: ValueTypes['Payload']['note'] = null;
      const pair: ValueTypes['Payload'] = { ...base, first: 'one', second: 'two' };
      const choice: ValueTypes['Payload'] = { ...base, right: 'R', label: 'Label' };
      const attribute: ValueTypes['a-b'] = { dash: 'value' };
      // @ts-expect-error repeating fields stay arrays even for one item
      const singleton: ValueTypes['Payload'] = { ...base, nodes: { id: '001' } };
      // @ts-expect-error repeating fields are nonempty when present
      const empty: ValueTypes['Payload'] = { ...base, nodes: [] };
      // @ts-expect-error XSD strings do not accept parser-coerced numbers in UI values
      const legacyString: ValueTypes['Payload'] = { ...base, fixed: 123 };
      // @ts-expect-error UI booleans are booleans
      const legacyBoolean: ValueTypes['Payload'] = { ...base, flag: 1 };
      // @ts-expect-error simple content uses value instead of #text
      const xmlText: ValueTypes['Label'] = { '#text': 'Text', lang: 'en' };
      // @ts-expect-error business attributes have clean names
      const xmlAttribute: ValueTypes['a-b'] = { '@_dash': 'value' };
      // @ts-expect-error optional groups remain correlated
      const partialPair: ValueTypes['Payload'] = {
        code: 'A', fixed: '123', nodes: [{ id: '001' }, { id: '002' }], first: 'one',
      };
      // @ts-expect-error choice branches remain exclusive
      const twoChoices: ValueTypes['Payload'] = { ...base, left: 'L', right: 'R', label: 'Label' };
    `,
  });
});

test('UI JSON Schema rejects legacy XML shapes and validates the clean equivalent', () => {
  const ir = new IRBuilder(parseXSD(fixturePath)).build();
  const schema = generateUIJSONSchema(ir, { rootEntity: 'record' });
  const xmlSchema = generateJSONSchema(ir);
  assert.notEqual(schema.$id, xmlSchema.$id);
  const ajv = new Ajv({ schemaId: 'auto', allErrors: true });
  ajv.addSchema(xmlSchema);
  const validate = ajv.compile(schema);
  const payload = { code: 'A', fixed: '123', nodes: [{ id: '001' }, { id: '002' }] };
  assert.equal(validate({ uid: 'record1', crud: 'I', payload }), true, validate.errors?.[0]?.message);
  assert.equal(validate({ uid: 'record1', crud: 'I', payload: { ...payload, note: null } }), true);
  assert.equal(validate({ uid: 'record1', crud: 'I', payload: { ...payload, fixed: 123 } }), false);
  assert.equal(validate({ uid: 'record1', crud: 'I', payload: { ...payload, flag: 1 } }), false);
  assert.equal(validate({
    uid: 'record1', crud: 'I', payload: { ...payload, note: { '#text': 'Text', '@_lang': 'en' } },
  }), false);
});

test('scalar simple content and UI name collisions stay unambiguous', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'names.xsd');
  fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:complexType name="record"><xs:sequence>
      <xs:element name="plain" type="Plain"/><xs:element name="rich" type="Rich"/>
      <xs:element name="collision" type="Collision"/><xs:element name="derived" type="Derived"/>
    </xs:sequence><xs:attribute name="uid" type="xs:ID" use="required"/>
      <xs:attribute name="crud" type="xs:string" use="required"/>
    </xs:complexType>
    <xs:complexType name="Plain"><xs:simpleContent><xs:extension base="xs:string"/></xs:simpleContent></xs:complexType>
    <xs:complexType name="Rich"><xs:simpleContent><xs:extension base="xs:string">
      <xs:attribute name="value" type="xs:string" use="required"/>
    </xs:extension></xs:simpleContent></xs:complexType>
    <xs:complexType name="Collision"><xs:sequence><xs:element name="uid" type="xs:string"/></xs:sequence>
      <xs:attribute name="uid" type="xs:string" use="required"/>
    </xs:complexType>
    <xs:complexType name="Base"><xs:sequence><xs:element name="base" type="xs:string"/></xs:sequence></xs:complexType>
    <xs:complexType name="Derived"><xs:complexContent><xs:extension base="Base"><xs:sequence>
      <xs:element name="own" type="xs:string"/>
    </xs:sequence></xs:extension></xs:complexContent></xs:complexType>
  </xs:schema>`);
  const ir = new IRBuilder(parseXSD(file)).build();
  compile(dir, {
    types: generateTypeScript(ir),
    use: `
      import type { ValueTypes } from './types';
      const scalar: ValueTypes['Plain'] = 'text';
      const textCollision: ValueTypes['Rich'] = { value: 'attribute', textValue: 'text' };
      const attributeCollision: ValueTypes['Collision'] = { uid: 'element', attribute_uid: 'attribute' };
      const inherited: ValueTypes['Derived'] = { base: 'base', own: 'own' };
      // @ts-expect-error scalar simple content has no XML text wrapper
      const wrapped: ValueTypes['Plain'] = { '#text': 'text' };
      // @ts-expect-error inherited required fields stay required
      const missingBase: ValueTypes['Derived'] = { own: 'own' };
    `,
  });
});

test('S3000L UI declarations expose clean product and exactly-one reference fields', (t) => {
  const dir = directory(t);
  const generated = generateTypeScript(bundle('1.1').ir);
  compile(dir, {
    types: generated,
    types20: generateTypeScript(bundle('2.0').ir),
    use: `
      import type { Entities, ValueTypes } from './types';
      const product: Entities['product'] = {
        uid: 'prod1', crud: 'I', prodId: [{ id: '001234' }],
      };
      const uidReference: ValueTypes['organizationReference'] = { uidRef: 'org1' };
      const idReference: ValueTypes['organizationReference'] = { orgId: { id: 'ORG-1' } };
      // @ts-expect-error product identifiers repeat in the UI contract
      const singleton: Entities['product'] = { uid: 'prod1', crud: 'I', prodId: { id: '001234' } };
      // @ts-expect-error identifier text remains a string
      const numeric: Entities['product'] = { uid: 'prod1', crud: 'I', prodId: [{ id: 1234 }] };
      // @ts-expect-error exactly one reference form is allowed
      const both: ValueTypes['organizationReference'] = { uidRef: 'org1', orgId: { id: 'ORG-1' } };
      const modern: import('./types20').Entities['product'] = {
        uid: 'prod1', crud: 'I', prodId: [{ id: '001234' }], prodName: [{ name: 'New project' }],
      };
      const legacy: Entities['product']['name'] = [{ descr: 'Legacy project' }];
      // @ts-expect-error Issue 2.0 has its own field names
      type WrongName = import('./types20').Entities['product']['name'];
      // @ts-expect-error parent foreign keys are not editable business fields
      type ParentKey = Entities['messageSender']['messageMsgSendParentId'];
      // @ts-expect-error storage choice discriminators stay out of the UI
      type StorageChoice = Entities['messageContext']['choiceType'];
      // @ts-expect-error relation foreign keys are not editable business fields
      type RelationKey = Entities['allowedProductConfigurationByConfigurationIdentifier']['authToOpId'];
      // A similarly named real business element must remain available.
      type BusinessIdentifier = Entities['authorityToOperate']['authToOpId'];
      const language: Entities['message']['msgLang'] = 'en';
      // @ts-expect-error optional primitive columns are absent, not null
      const absentLanguage: Entities['message']['msgLang'] = null;
      const exactRatio: Entities['samplingDefinitionByRatio']['samplRo'] = '0.12345678901234567890';
      const exactCount: Entities['failureModeThresholdDefinition']['nrOfEvnts'] = '9007199254740993';
    `,
  });
});

test('UI entity schemas close inherited fields without rejecting business ID references', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'entities.xsd');
  fs.writeFileSync(file, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:complexType name="Base"><xs:sequence>
      <xs:element name="label" type="xs:string"/>
      <xs:element name="target" type="xs:IDREF"/>
    </xs:sequence></xs:complexType>
    <xs:complexType name="Derived"><xs:complexContent><xs:extension base="Base"><xs:sequence>
      <xs:element name="flag" type="xs:boolean"/>
    </xs:sequence></xs:extension></xs:complexContent></xs:complexType>
  </xs:schema>`);
  const ir = new IRBuilder(parseXSD(file)).build();
  const validate = new Ajv().compile(generateUIJSONSchema(ir, { rootEntity: 'Derived' }));
  const adapter = new UIAdapter(ir);
  const value = { label: 'Text', target: 'ref1', flag: true };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.deepEqual(adapter.encodeEntity('Derived', value), value);
  assert.equal(validate({ target: 'ref1', flag: true }), false);
  assert.equal(validate({ ...value, typo: 123 }), false);
  assert.throws(() => adapter.encodeEntity('Derived', { ...value, typo: 123 }), /unknown UI field/);
  compile(dir, {
    types: generateTypeScript(ir),
    use: `
      import type { Entities } from './types';
      const value: Entities['Derived'] = { label: 'Text', target: 'ref1', flag: true };
      // @ts-expect-error inherited business fields remain required
      const missing: Entities['Derived'] = { flag: true };
    `,
  });
});
