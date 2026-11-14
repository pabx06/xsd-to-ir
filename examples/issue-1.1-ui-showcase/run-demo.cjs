// Generate, compile, and validate the UI example without connecting to a database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const Ajv = require('ajv');
const {
  IRBuilder, parseXSD, UIAdapter, generateTypeScript, generateUIJSONSchema,
} = require('../../lib');
const apiResponse = require('./api-response.json');

const schemaPath = path.join(__dirname, '../../s3000l/1_1/s3000l_1-1_lsa_dataset.xsd');
const ir = new IRBuilder(parseXSD(schemaPath)).build();
const schema = generateUIJSONSchema(ir, { rootEntity: 'product' });
fs.writeFileSync(path.join(__dirname, 'types.ts'), generateTypeScript(ir));
fs.writeFileSync(path.join(__dirname, 'ui-json-schema.json'), `${JSON.stringify(schema, null, 2)}\n`);

execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'), '-p', path.join(__dirname, 'tsconfig.json'),
], { stdio: 'inherit' });
// Load the compiled example only after the compiler has succeeded.
const requireDemo = createRequire(__filename);
const {
  minimalProduct, exampleProduct, productWithNilName, renameProduct, productHeading, breakdownRows,
} = requireDemo('./dist/showcase');
const ajv = new Ajv({ allErrors: true, logger: false, coerceTypes: false });
ajv.addFormat('duration', /^-?P/);
const validate = ajv.compile(schema);
for (const value of [minimalProduct, exampleProduct, productWithNilName]) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

const adapter = new UIAdapter(ir);
// Simulate stored JSON with XML namespace metadata on the identifier.
const row = adapter.encodeRow('product', exampleProduct);
const storedIdentifiers = JSON.parse(row.prod_id);
storedIdentifiers[0].id = { '#text': '001234', '@_xmlns:source': 'urn:showcase' };
row.prod_id = JSON.stringify(storedIdentifiers);

const edit = adapter.decodeRow('product', row);
assert.deepEqual(edit.value, exampleProduct);
edit.value.prodId[0].id = '000567';
const updatedProduct = renameProduct(edit.value, 'Edited aircraft');
assert.equal(validate(updatedProduct), true, JSON.stringify(validate.errors));
// Keep state with this adapter instance. These columns are not a complete business save.
const savedColumns = adapter.encodeRow('product', updatedProduct, edit.state);
assert.deepEqual(JSON.parse(savedColumns.prod_id)[0].id, {
  '#text': '000567', '@_xmlns:source': 'urn:showcase',
});
assert.deepEqual(adapter.decodeRow('product', savedColumns).value, updatedProduct);
fs.writeFileSync(path.join(__dirname, 'product.json'), `${JSON.stringify(exampleProduct, null, 2)}\n`);

// The API can return parsed JSON objects and JSON strings in the same row.
const apiRow = apiResponse.data[0];
const apiEdit = adapter.decodeRow('product', apiRow);
assert.equal(validate(apiEdit.value), true, JSON.stringify(validate.errors));
assert.deepEqual(apiEdit.value.prodId, [{ id: 'YB' }]);
assert.equal(Object.hasOwn(apiEdit.value, 'id'), false);
assert.equal(Object.hasOwn(apiEdit.value, '_msg_seq'), false);

// Encode the original values before editing. Comparing with the raw response would
// mistake the object-to-string conversion of prod_id for a change to its content.
const originalColumns = adapter.encodeRow('product', apiEdit.value, apiEdit.state);
apiEdit.value.name[0].descr = 'Yeti Beti updated';
const editedColumns = adapter.encodeRow('product', apiEdit.value, apiEdit.state);
const patch = Object.fromEntries(Object.entries(editedColumns)
  .filter(([column, value]) => !isDeepStrictEqual(value, originalColumns[column])));
assert.deepEqual(patch, { name: '{"descr":"Yeti Beti updated"}' });
assert.deepEqual(adapter.decodeRow('product', { ...apiRow, ...patch }).value, apiEdit.value);
// The backend must apply CRUD transitions, timestamps, and export tracking when saving.

console.log('TypeScript compilation, UI JSON Schema validation, and adapter checks work.');
console.log(productHeading(exampleProduct));
console.log(JSON.stringify(breakdownRows(exampleProduct), null, 2));
console.log(`Edited values: ${productHeading(updatedProduct)}`);
console.log(`Example PATCH for product row ${apiRow.id}: ${JSON.stringify(patch)}`);
console.log('Leading zeroes and hidden XML metadata are preserved.');
