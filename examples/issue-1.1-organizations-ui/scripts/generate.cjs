const fs = require('node:fs');
const path = require('node:path');
const {
  IRBuilder, parseXSD, generateTypeScript, generateUIJSONSchema,
} = require('../../../lib');
const { UIModel } = require('../../../src/ui-contract');

const ir = new IRBuilder(parseXSD(path.join(__dirname, '../../../s3000l/1_1/s3000l_1-1_lsa_dataset.xsd'))).build();
const model = new UIModel(ir);
const schema = generateUIJSONSchema(ir, { rootEntity: 'organization' });
// Keep the complete transitive schema, including assertions and their annotations.
const refs = new Set();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref && !refs.has(value.$ref)) {
    refs.add(value.$ref);
    const target = value.$ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((object, key) => object[key], schema);
    visit(target);
  }
  Object.values(value).forEach(visit);
}
visit({ $ref: schema.$ref });
for (const section of ['$defs', 'definitions']) {
  schema[section] = Object.fromEntries(Object.entries(schema[section]).filter(([name]) => refs.has(
    `#/${section}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`,
  )));
}
const labels = {
  orgId: 'Identifiers', id: 'Identifier', name: 'Name', descr: 'Description', class: 'Class',
  lang: 'Language', docs: 'Documents', doc: 'Document assignment', rmks: 'Remarks', rmk: 'Remark',
  applic: 'Applicability', applicDef: 'Applicability definition', datedApplicDef: 'Dated applicability',
  applicRef: 'Applicability reference', docRef: 'Document reference', docIssRef: 'Document issue reference',
  uidRef: 'UID reference', orgInfos: 'Organization assignments', orgRef: 'Organization reference',
  uid: 'XML UID', crud: 'Change action', docId: 'Document identifier', docIssId: 'Document issue identifier',
  dmc: 'Data module code', pmc: 'Publication module code', text: 'Text', providedBy: 'Provided by',
  docRole: 'Document role',
};
const label = (name) => labels[name] || name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase());
function enumLabels(use) {
  const entries = Object.entries(use.enumAnnotations || {}).flatMap(([code, annotation]) => {
    const source = (annotation.appInfo || []).find((text) => /^(SX001G|ISO639-1988):[a-zA-Z][a-zA-Z0-9]*$/.test(text));
    if (!source) return [];
    // Humanize the annotated identifier; never guess a meaning from the code.
    const words = source.slice(source.indexOf(':') + 1)
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
    const text = words.map((word, index) => {
      if (index === 0) return word[0].toUpperCase() + word.slice(1);
      return /^[A-Z][a-z]/.test(word) ? word[0].toLowerCase() + word.slice(1) : word;
    }).join(' ');
    return [[code, text]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function requiredFields(particle, required = true) {
  if (!particle || particle.maxOccurs === 0 || particle.minOccurs === 0 || !required) return [];
  if (particle.kind === 'element') return [particle.jsonName];
  return (particle.children || []).flatMap((child) => requiredFields(child, particle.kind !== 'choice'));
}
function alternatives(particle) {
  if (!particle || particle.maxOccurs === 0) return [[]];
  if (particle.kind === 'element') return [[particle.jsonName]];
  const children = (particle.children || []).filter((child) => child.maxOccurs !== 0);
  if (particle.kind === 'choice') return children.flatMap(alternatives);
  return children.reduce((rows, child) => rows.flatMap(
    (row) => alternatives(child).map((tail) => [...row, ...tail]),
  ), [[]]);
}
function choices(particle, optional = false, repeated = false) {
  if (!particle || particle.maxOccurs === 0) return [];
  const isOptional = optional || particle.minOccurs === 0;
  const isRepeated = repeated || particle.maxOccurs === 'unbounded' || particle.maxOccurs > 1;
  if (particle.kind === 'choice') {
    return [{
      branches: alternatives(particle).filter((branch) => branch.length), optional: isOptional, repeated: isRepeated,
    }];
  }
  return (particle.children || []).flatMap((child) => choices(child, isOptional, isRepeated));
}
const types = {};
const queue = ['organization'];
while (queue.length) {
  const name = queue.shift();
  if (types[name]) continue;
  const shape = model.shape(name);
  const required = requiredFields(shape.content);
  const fields = [...shape.fields, ...shape.attributes].filter((field) => field.maxOccurs !== 0).map((field) => ({
    name: field.uiName, label: label(field.uiName), ref: field.type.valueTypeRef || undefined,
    enumLabels: enumLabels(field.type),
    kind: field.type.jsonType || 'object', constraints: field.type.constraints,
    min: field.minOccurs,
    max: field.maxOccurs,
    required: required.includes(field.uiName) || (field.kind === 'attribute' && field.minOccurs > 0),
    nullable: !!field.nillable, system: field.kind === 'attribute' && ['uid', 'crud'].includes(field.uiName),
    defaultValue: field.defaultValue, fixedValue: field.fixedValue,
  }));
  if (shape.text && !shape.scalarText) {
    fields.unshift({
      name: shape.textName, label: 'Value', kind: shape.text.jsonType,
      enumLabels: enumLabels(shape.text),
      constraints: shape.text.constraints, required: true, min: 1, max: 1, nullable: false, system: false,
    });
  }
  let groups = choices(shape.content);
  const reference = shape.attributes.some((field) => field.uiName === 'uidRef');
  if (reference) groups = [{ branches: [['uidRef'], ...alternatives(shape.content).filter((branch) => branch.length)], optional: false, repeated: false }];
  types[name] = {
    name, fields, choices: groups, reference,
    scalar: shape.scalarText ? { ...shape.text, enumLabels: enumLabels(shape.text) } : undefined,
  };
  fields.forEach((field) => { if (field.ref) queue.push(field.ref); });
}
const warnings = new Set();
function collectWarnings(value) {
  if (!value || typeof value !== 'object') return;
  (value['x-xsd-unsupported'] || []).forEach((warning) => warnings.add(warning));
  Object.values(value).forEach(collectWarnings);
}
collectWarnings(schema);
const output = path.join(__dirname, '../src/generated');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'types.ts'), generateTypeScript(ir));
fs.writeFileSync(path.join(output, 'organization.schema.json'), `${JSON.stringify(schema)}\n`);
fs.writeFileSync(path.join(output, 'form-metadata.json'), `${JSON.stringify({
  issue: '1.1', root: 'organization', types, warnings: [...warnings],
}, null, 2)}\n`);
console.log(`Issue 1.1 types, Organization schema, and ${Object.keys(types).length - 1} nested form types generated.`);
