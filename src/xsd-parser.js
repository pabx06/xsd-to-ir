/**
 * xsd-parser.js
 *
 * Parses an XSD file (and all its xs:include / xs:import siblings on disk)
 * into a single merged, namespace-stripped JS object tree.
 *
 * Multi-file support:
 *   - xs:include  → merged unconditionally (same target namespace)
 *   - xs:import   → merged only when schemaLocation is a relative path that
 *                   exists next to the entry file (external http imports are
 *                   silently skipped)
 *
 * All xs:/xsd: namespace prefixes are stripped so the rest of the pipeline
 * works with plain tag names.
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// ─── parser configuration ────────────────────────────────────────────────────

const ARRAY_TAGS = new Set([
  'element', 'attribute', 'complexType', 'simpleType',
  'sequence', 'choice', 'all', 'group', 'attributeGroup',
  'enumeration', 'extension', 'restriction',
  'complexContent', 'simpleContent',
  'annotation', 'documentation', 'assert',
  'import', 'include',
]);

function makeParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) => ARRAY_TAGS.has(stripNs(tagName)),
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function stripNs(name) {
  if (!name || typeof name !== 'string') return name;
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

function deepStripNs(node) {
  if (Array.isArray(node)) return node.map(deepStripNs);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const cleanKey = k.startsWith('@_') ? `@_${stripNs(k.slice(2))}` : stripNs(k);
      const cleanVal = typeof v === 'string' ? stripNs(v) : deepStripNs(v);
      out[cleanKey] = cleanVal;
    }
    return out;
  }
  return node;
}

// ─── top-level collection keys that can be merged across files ───────────────

const MERGE_KEYS = [
  'complexType', 'simpleType', 'element', 'group',
  'attributeGroup', 'attribute', 'notation',
];

/**
 * Merge schema node `src` into `target` by appending top-level definitions.
 * Non-array scalar attributes (like targetNamespace) are NOT overwritten.
 */
function mergeSchema(target, src) {
  for (const key of MERGE_KEYS) {
    if (!src[key]) continue;
    if (!target[key]) target[key] = [];
    // Avoid adding the exact same named definition twice (re-inclusion guard)
    const existingNames = new Set(
      target[key].filter((n) => n['@_name']).map((n) => n['@_name']),
    );
    for (const item of src[key]) {
      if (!item['@_name'] || !existingNames.has(item['@_name'])) {
        target[key].push(item);
        if (item['@_name']) existingNames.add(item['@_name']);
      }
    }
  }
}

// ─── recursive single-file parser ────────────────────────────────────────────

/**
 * Parse one XSD file and return its namespace-stripped schema node.
 * Does NOT follow includes/imports — that is done by parseXSD.
 */
function parseSingleFile(absPath) {
  const xml = fs.readFileSync(absPath, 'utf8');
  const parser = makeParser();
  const raw = parser.parse(xml);
  const nsKey = Object.keys(raw).find((k) => stripNs(k) === 'schema');
  if (!nsKey) throw new Error(`No <xs:schema> root in ${absPath}`);
  return deepStripNs(raw[nsKey]);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Parse an XSD entry-point file and all locally resolvable includes/imports
 * into a single merged schema object.
 *
 * @param {string} filePath           Entry .xsd file path.
 * @param {object} [opts]
 * @param {boolean} [opts.verbose] Log each included file to stderr.
 * @returns {object}                  Merged, namespace-stripped schema node.
 */
function parseXSD(filePath, opts = {}) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`XSD file not found: ${absPath}`);

  const visited = new Set(); // guard against circular includes

  function load(p) {
    const abs = path.resolve(p);
    if (visited.has(abs)) return null;
    visited.add(abs);

    if (opts.verbose) process.stderr.write(`  \\_ loading ${path.relative(process.cwd(), abs)}\n`);

    const schema = parseSingleFile(abs);
    const dir = path.dirname(abs);

    // Follow xs:include and xs:import with local schemaLocation
    const refs = [
      ...(schema.include || []),
      ...(schema.import || []),
    ];

    for (const ref of refs) {
      const loc = ref['@_schemaLocation'];
      if (!loc || loc.startsWith('http://') || loc.startsWith('https://')) continue;

      const refPath = path.resolve(dir, loc);
      if (!fs.existsSync(refPath)) {
        if (opts.verbose) process.stderr.write(`  /!\\ skipping missing: ${refPath}\n`);
        continue;
      }

      const child = load(refPath);
      if (child) mergeSchema(schema, child);
    }

    return schema;
  }

  return load(absPath);
}

module.exports = { parseXSD, stripNs };
