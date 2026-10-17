import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const stats = JSON.parse(
  await readFile(new URL('../dist/organizations/browser-stats.json', import.meta.url), 'utf8'),
);
const inputs = Object.keys(stats.inputs);
assert(inputs.length > 0, 'Build statistics must include the bundle inputs.');
const forbidden =
  /(^|\/)(ui-adapter|db-adapter|xml-parser|xml-serializer|xml-value-normalizer|ir-builder)\.[cm]?js$|fast-xml-parser|node_modules\/(knex|better-sqlite3|mysql2|libxmljs2)\/|^node:/;
assert.deepEqual(
  inputs.filter((input) => forbidden.test(input)),
  [],
  'Node adapters must not enter the browser bundle.',
);
for (const input of Object.values(stats.inputs)) {
  assert.deepEqual(
    (input.imports || []).filter((item) => item.path.startsWith('node:')),
    [],
  );
}
const html = await readFile(
  new URL('../dist/organizations/browser/index.html', import.meta.url),
  'utf8',
);
assert(
  !/(src|href)=["']https?:\/\//.test(html),
  'The app must not load remote scripts, styles, fonts, or icons.',
);
console.log('Browser bundle checks work.');
