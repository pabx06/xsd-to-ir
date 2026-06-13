# xsd-to-ir — Complete Source Files

> All 11 files. Copy each block into the corresponding path.

## Structure

```
xsd-to-ir/
├── package.json
├── index.js
└── src/
    ├── xsd-parser.js            # XSD → JS object (multi-file, ns-stripped)
    ├── type-resolver.js         # type name lookup table
    ├── ir-builder.js            # JS object → IR (entities, columns, relations)
    ├── sql-generator.js         # IR → PostgreSQL DDL
    ├── json-schema-generator.js # IR → JSON Schema
    ├── xml-validator.js         # XML string → XSD validation
    ├── xml-deserializer.js      # XML message → DB row batches
    ├── db-adapter.js            # DB insert / update / softDelete / query
    └── xml-serializer.js        # DB rows → XML message (round-trip)
```

## Quick-start

```bash
npm install
# optional: npm install libxmljs2   # full XSD validation (native)
# optional: npm install knex pg      # DB adapter
```

```javascript
// 1. Build IR from XSD
const { parseXSD }          = require('./src/xsd-parser');
const { IRBuilder }         = require('./src/ir-builder');
const { generateSQL }       = require('./src/sql-generator');
const { validateXML }       = require('./src/xml-validator');
const { deserializeXML }    = require('./src/xml-deserializer');
const { DBAdapter }         = require('./src/db-adapter');
const { serializeToXML }    = require('./src/xml-serializer');

const ir  = new IRBuilder(parseXSD('s3000l_lsaDataset.xsd')).build();
const sql = generateSQL(ir);          // CREATE TABLE DDL

// 2. Validate + deserialize incoming XML
await validateXML(xmlString, 'lsaDataset.xsd');
const { msgMeta, batches } = deserializeXML(xmlString, ir);

// 3. Persist to DB
const db = new DBAdapter(knex, ir);
await db.persistMessage(batches, msgMeta);

// 4. Export back to XML (full baseline)
const xml = await serializeToXML(ir, db, { msgType: 'B', msgStatus: 'F' });

// 5. Export net-change delta since seq 42
const delta = await serializeToXML(ir, db, { msgType: 'U', since: 42 });
```

---

## `package.json`

```json
{
  "name": "xsd-to-ir",
  "version": "2.0.0",
  "description": "Parse XSD schemas into an IR — generate DB schema, JSON Schema, and round-trip XML↔DB for S3000L",
  "main": "index.js",
  "bin": {
    "xsd-to-ir": "./index.js"
  },
  "scripts": {
    "start": "node index.js",
    "example": "node index.js test/s3000l-sample.xsd --out output --root Dmodule",
    "example:s3000l": "node index.js s3000l_3-0_lsaDataset.xsd --out output --verbose"
  },
  "keywords": ["xsd", "schema", "s3000l", "lsa", "database", "json-schema", "xml"],
  "license": "MIT",

  "dependencies": {
    "fast-xml-parser": "^4.5.3",
    "knex":            "^3.2.0"
  },

  "optionalDependencies": {
    "libxmljs2":      "^0.31.0",
    "mysql2":         "^3.0.0",
    "better-sqlite3": "^12.10.0"
  },

  "notes": {
    "knex":           "Query builder — required by db-adapter.js.",
    "mysql2":         "MariaDB/MySQL driver for knex (optionalDependencies).",
    "better-sqlite3": "SQLite driver — useful for local dev/test (optionalDependencies).",
    "libxmljs2":      "Native libxml2 bindings for full XSD 1.0 validation (optionalDependencies). Requires node-gyp. Falls back to structural check if absent."
  }
}
```

---

## `index.js`

```javascript
#!/usr/bin/env node
'use strict';

/**
 * index.js  –  CLI entry point
 *
 * Usage:
 *   node index.js <path/to/schema.xsd> [options]
 *
 * Options:
 *   --out <dir>            Output directory (default: ./output)
 *   --root <EntityName>    Root entity for JSON Schema $ref
 *   --schema-id <url>      $id for the JSON Schema document
 *   --no-sql               Skip SQL DDL generation
 *   --no-json              Skip JSON Schema generation
 *   --no-ir                Skip IR JSON dump
 *   --pretty               Pretty-print all JSON output (default: true)
 *
 * Outputs (in <out>/):
 *   ir.json                The Intermediate Representation
 *   schema.sql             PostgreSQL CREATE TABLE DDL
 *   json-schema.json       JSON Schema draft-07 validator
 */

const fs   = require('fs');
const path = require('path');

const { parseXSD }            = require('./src/xsd-parser');
const { IRBuilder }           = require('./src/ir-builder');
const { generateSQL }         = require('./src/sql-generator');
const { generateJSONSchema }  = require('./src/json-schema-generator');

// ─── arg parsing (no external dep) ───────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    xsdFile  : null,
    out      : './output',
    root     : null,
    schemaId : 'https://example.com/generated-schema.json',
    sql      : true,
    json     : true,
    ir       : true,
    pretty   : true,
    verbose  : false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out')       { opts.out       = args[++i]; }
    else if (a === '--root') { opts.root       = args[++i]; }
    else if (a === '--schema-id') { opts.schemaId  = args[++i]; }
    else if (a === '--no-sql')  { opts.sql   = false; }
    else if (a === '--no-json') { opts.json  = false; }
    else if (a === '--no-ir')   { opts.ir    = false; }
    else if (a === '--no-pretty') { opts.pretty = false; }
    else if (a === '--verbose')   { opts.verbose = true; }
    else if (!a.startsWith('--')) { opts.xsdFile = a; }
  }
  return opts;
}

// ─── IR serialiser (Maps → plain objects) ────────────────────────────────────

function irToJSON(ir) {
  return {
    entities   : Object.fromEntries(ir.entities),
    joinTables : Object.fromEntries(ir.joinTables),
    enums      : Object.fromEntries(ir.enums),
    simpleTypes: Object.fromEntries(ir.simpleTypes),
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);

  if (!opts.xsdFile) {
    console.error('Usage: node index.js <path/to/schema.xsd> [--out <dir>] [--root <Entity>]');
    process.exit(1);
  }

  // ── parse ──────────────────────────────────────────────────────────────────
  console.log(`\n📄  Parsing XSD: ${opts.xsdFile}`);
  let schema;
  try {
    schema = parseXSD(opts.xsdFile, { verbose: opts.verbose });
  } catch (err) {
    console.error(`\n❌  Parse error: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅  Parsed OK (${(schema.complexType||[]).length} complexTypes merged)`);

  // ── build IR ───────────────────────────────────────────────────────────────
  console.log(`\n🔨  Building Intermediate Representation…`);
  const ir = new IRBuilder(schema).build();

  if (ir.s3000lMode) {
    console.log(`   ✦  S3000L mode: filtering to uid+crud entities only`);
  }

  const stats = {
    entities   : ir.entities.size,
    joinTables : ir.joinTables.size,
    enums      : ir.enums.size,
    simpleTypes: ir.simpleTypes.size,
    columns    : [...ir.entities.values()].reduce((n, e) => n + e.columns.length, 0),
    relations  : [...ir.entities.values()].reduce((n, e) => n + e.relations.length, 0),
  };

  console.log(`   Entities   : ${stats.entities}`);
  console.log(`   Columns    : ${stats.columns}`);
  console.log(`   Relations  : ${stats.relations}`);
  console.log(`   Join tables: ${stats.joinTables}`);
  console.log(`   Enums      : ${stats.enums}`);
  console.log(`   SimpleTypes: ${stats.simpleTypes}`);

  // ── ensure output directory ────────────────────────────────────────────────
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n📁  Output directory: ${outDir}`);

  const indent = opts.pretty ? 2 : 0;

  // ── write IR ───────────────────────────────────────────────────────────────
  if (opts.ir) {
    const irPath = path.join(outDir, 'ir.json');
    fs.writeFileSync(irPath, JSON.stringify(irToJSON(ir), null, indent), 'utf8');
    console.log(`✅  IR written          → ${irPath}`);
  }

  // ── write SQL ──────────────────────────────────────────────────────────────
  if (opts.sql) {
    const sql     = generateSQL(ir);
    const sqlPath = path.join(outDir, 'schema.sql');
    fs.writeFileSync(sqlPath, sql, 'utf8');
    console.log(`✅  SQL DDL written     → ${sqlPath}`);
  }

  // ── write JSON Schema ──────────────────────────────────────────────────────
  if (opts.json) {
    const jsonSchema     = generateJSONSchema(ir, { rootEntity: opts.root, schemaId: opts.schemaId });
    const jsonSchemaPath = path.join(outDir, 'json-schema.json');
    fs.writeFileSync(jsonSchemaPath, JSON.stringify(jsonSchema, null, indent), 'utf8');
    console.log(`✅  JSON Schema written → ${jsonSchemaPath}`);
  }

  console.log('\n🎉  Done.\n');
}

main();
```

---

## `src/xsd-parser.js`

```javascript
'use strict';

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

const fs   = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// ─── parser configuration ────────────────────────────────────────────────────

const ARRAY_TAGS = new Set([
  'element', 'attribute', 'complexType', 'simpleType',
  'sequence', 'choice', 'all', 'group', 'attributeGroup',
  'enumeration', 'extension', 'restriction',
  'complexContent', 'simpleContent',
  'annotation', 'documentation',
  'import', 'include',
]);

function makeParser() {
  return new XMLParser({
    ignoreAttributes   : false,
    attributeNamePrefix: '@_',
    isArray            : (tagName) => ARRAY_TAGS.has(stripNs(tagName)),
    parseAttributeValue: false,
    trimValues         : true,
    processEntities    : false,
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
      const cleanKey = k.startsWith('@_') ? '@_' + stripNs(k.slice(2)) : stripNs(k);
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
      target[key].filter(n => n['@_name']).map(n => n['@_name'])
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
  const xml    = fs.readFileSync(absPath, 'utf8');
  const parser = makeParser();
  const raw    = parser.parse(xml);
  const nsKey  = Object.keys(raw).find(k => stripNs(k) === 'schema');
  if (!nsKey) throw new Error(`No <xs:schema> root in ${absPath}`);
  return deepStripNs(raw[nsKey]);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Parse an XSD entry-point file and all locally resolvable includes/imports
 * into a single merged schema object.
 *
 * @param {string} filePath        Entry .xsd file path.
 * @param {object} [opts]
 * @param {boolean} [opts.verbose] Log each included file to stderr.
 * @returns {object}               Merged, namespace-stripped schema node.
 */
function parseXSD(filePath, opts = {}) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`XSD file not found: ${absPath}`);

  const visited = new Set();   // guard against circular includes
  const baseDir = path.dirname(absPath);

  function load(p) {
    const abs = path.resolve(p);
    if (visited.has(abs)) return null;
    visited.add(abs);

    if (opts.verbose) process.stderr.write(`  ↳ loading ${path.relative(process.cwd(), abs)}\n`);

    const schema = parseSingleFile(abs);
    const dir    = path.dirname(abs);

    // Follow xs:include and xs:import with local schemaLocation
    const refs = [
      ...(schema.include || []),
      ...(schema.import  || []),
    ];

    for (const ref of refs) {
      const loc = ref['@_schemaLocation'];
      if (!loc || loc.startsWith('http://') || loc.startsWith('https://')) continue;

      const refPath = path.resolve(dir, loc);
      if (!fs.existsSync(refPath)) {
        if (opts.verbose) process.stderr.write(`  ⚠ skipping missing: ${refPath}\n`);
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
```

---

## `src/type-resolver.js`

```javascript
'use strict';

/**
 * type-resolver.js
 *
 * Builds lookup maps from the parsed schema tree so that any type reference
 * (e.g. @_type="PartInfo") can be immediately resolved to its definition.
 *
 * Handles:
 *   - Named complexTypes and simpleTypes
 *   - Named groups and attributeGroups
 *   - Built-in XSD primitive types → canonical SQL/JSON-schema type names
 */

// ─── XSD primitive → {sqlType, jsonType} map ─────────────────────────────────

const XSD_PRIMITIVES = {
  // strings
  string             : { sqlType: 'TEXT',      jsonType: 'string'  },
  normalizedString   : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  token              : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  Name               : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  NCName             : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  NMTOKEN            : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  NMTOKENS           : { sqlType: 'TEXT',      jsonType: 'string'  },
  anyURI             : { sqlType: 'TEXT',      jsonType: 'string', format: 'uri' },
  language           : { sqlType: 'VARCHAR',   jsonType: 'string'  },
  // identifiers
  ID                 : { sqlType: 'VARCHAR',   jsonType: 'string',  isId:     true },
  IDREF              : { sqlType: 'VARCHAR',   jsonType: 'string',  isIdRef:  true },
  IDREFS             : { sqlType: 'TEXT',      jsonType: 'string',  isIdRefs: true },
  // numbers
  integer            : { sqlType: 'INTEGER',   jsonType: 'integer' },
  int                : { sqlType: 'INTEGER',   jsonType: 'integer' },
  long               : { sqlType: 'BIGINT',    jsonType: 'integer' },
  short              : { sqlType: 'SMALLINT',  jsonType: 'integer' },
  byte               : { sqlType: 'SMALLINT',  jsonType: 'integer' },
  positiveInteger    : { sqlType: 'INTEGER',   jsonType: 'integer', minimum: 1  },
  nonNegativeInteger : { sqlType: 'INTEGER',   jsonType: 'integer', minimum: 0  },
  negativeInteger    : { sqlType: 'INTEGER',   jsonType: 'integer', maximum: -1 },
  nonPositiveInteger : { sqlType: 'INTEGER',   jsonType: 'integer', maximum: 0  },
  unsignedLong       : { sqlType: 'BIGINT',    jsonType: 'integer', minimum: 0  },
  unsignedInt        : { sqlType: 'INTEGER',   jsonType: 'integer', minimum: 0  },
  unsignedShort      : { sqlType: 'SMALLINT',  jsonType: 'integer', minimum: 0  },
  unsignedByte       : { sqlType: 'SMALLINT',  jsonType: 'integer', minimum: 0  },
  decimal            : { sqlType: 'DECIMAL',   jsonType: 'number'  },
  float              : { sqlType: 'FLOAT',     jsonType: 'number'  },
  double             : { sqlType: 'DOUBLE',     jsonType: 'number'  },
  // date/time
  date               : { sqlType: 'DATE',      jsonType: 'string', format: 'date'      },
  time               : { sqlType: 'TIME',      jsonType: 'string', format: 'time'      },
  dateTime           : { sqlType: 'TIMESTAMP', jsonType: 'string', format: 'date-time' },
  duration           : { sqlType: 'VARCHAR',   jsonType: 'string', format: 'duration'  },
  gYear              : { sqlType: 'CHAR(4)',   jsonType: 'string'  },
  gMonth             : { sqlType: 'CHAR(7)',   jsonType: 'string'  },
  gDay               : { sqlType: 'CHAR(10)',  jsonType: 'string'  },
  gYearMonth         : { sqlType: 'CHAR(7)',   jsonType: 'string'  },
  gMonthDay          : { sqlType: 'CHAR(10)',  jsonType: 'string'  },
  // boolean
  boolean            : { sqlType: 'BOOLEAN',   jsonType: 'boolean' },
  // binary
  base64Binary       : { sqlType: 'LONGBLOB',   jsonType: 'string', contentEncoding: 'base64' },
  hexBinary          : { sqlType: 'LONGBLOB',   jsonType: 'string'  },
  // catch-all / abstract
  anyType            : { sqlType: 'TEXT',      jsonType: {}        },
  anySimpleType      : { sqlType: 'TEXT',      jsonType: 'string'  },
};

// ─── TypeResolver class ───────────────────────────────────────────────────────

class TypeResolver {
  /**
   * @param {object} schema  The namespace-stripped, parsed schema root.
   */
  constructor(schema) {
    this.complexTypes    = new Map(); // name → node
    this.simpleTypes     = new Map(); // name → node
    this.groups          = new Map(); // name → node
    this.attributeGroups = new Map(); // name → node
    this._index(schema);
  }

  // ── indexing ──────────────────────────────────────────────────────────────

  _index(schema) {
    for (const ct of (schema.complexType || [])) {
      if (ct['@_name']) this.complexTypes.set(ct['@_name'], ct);
    }
    for (const st of (schema.simpleType || [])) {
      if (st['@_name']) this.simpleTypes.set(st['@_name'], st);
    }
    for (const g of (schema.group || [])) {
      if (g['@_name']) this.groups.set(g['@_name'], g);
    }
    for (const ag of (schema.attributeGroup || [])) {
      if (ag['@_name']) this.attributeGroups.set(ag['@_name'], ag);
    }
  }

  // ── public helpers ────────────────────────────────────────────────────────

  isPrimitive(typeName) {
    return Object.prototype.hasOwnProperty.call(XSD_PRIMITIVES, typeName);
  }

  /**
   * Resolve a type name to its primitive mapping (if it is one).
   * Returns null for complex / unknown types.
   */
  primitiveInfo(typeName) {
    return XSD_PRIMITIVES[typeName] ?? null;
  }

  getComplexType(name)    { return this.complexTypes.get(name)    ?? null; }
  getSimpleType(name)     { return this.simpleTypes.get(name)     ?? null; }
  getGroup(name)          { return this.groups.get(name)          ?? null; }
  getAttributeGroup(name) { return this.attributeGroups.get(name) ?? null; }

  /**
   * Resolve any type name:
   *   - primitive  → { kind: 'primitive', ...primitiveInfo }
   *   - complexType → { kind: 'complex',  node }
   *   - simpleType  → { kind: 'simple',   node }
   *   - unknown    → { kind: 'unknown' }
   */
  resolve(typeName) {
    if (!typeName) return { kind: 'unknown' };
    if (this.isPrimitive(typeName))
      return { kind: 'primitive', ...this.primitiveInfo(typeName) };
    const ct = this.complexTypes.get(typeName);
    if (ct) return { kind: 'complex', node: ct };
    const st = this.simpleTypes.get(typeName);
    if (st) return { kind: 'simple',  node: st };
    return { kind: 'unknown' };
  }
}

module.exports = { TypeResolver, XSD_PRIMITIVES };
```

---

## `src/ir-builder.js`

```javascript
'use strict';

/**
 * ir-builder.js
 *
 * Walks the namespace-stripped parsed-XSD tree and produces an
 * Intermediate Representation (IR) that is the single source-of-truth
 * for both the DB-schema generator and the JSON-schema generator.
 *
 * IR shape (TypeScript-style pseudo-types for documentation):
 *
 * IRModel {
 *   entities   : Map<string, IREntity>
 *   joinTables : Map<string, IRJoinTable>
 *   enums      : Map<string, IREnum>
 *   simpleTypes: Map<string, IRSimpleType>
 * }
 *
 * IREntity {
 *   name        : string          // PascalCase type / element name
 *   tableName   : string          // snake_case DB table name
 *   columns     : IRColumn[]
 *   relations   : IRRelation[]
 *   abstract    : boolean
 *   parentType  : string | null   // xs:extension base
 *   documentation: string | null
 * }
 *
 * IRColumn {
 *   name         : string        // camelCase attribute / element name
 *   columnName   : string        // snake_case DB column name
 *   sqlType      : string
 *   jsonType     : string | object
 *   nullable     : boolean
 *   isPrimaryKey : boolean
 *   isForeignKey : boolean
 *   referencesEntity : string | null
 *   isEnum       : boolean
 *   enumRef      : string | null
 *   constraints  : object        // minLength, maxLength, pattern, enum[], etc.
 *   documentation: string | null
 * }
 *
 * IRRelation {
 *   kind          : 'one-to-many' | 'many-to-many' | 'one-to-one' | 'idrefs'
 *   fieldName     : string
 *   targetEntity  : string
 *   joinTable     : string | null   // for many-to-many
 *   nullable      : boolean
 *   minOccurs     : number
 *   maxOccurs     : number | 'unbounded'
 * }
 *
 * IRJoinTable {
 *   name          : string
 *   tableName     : string
 *   leftEntity    : string
 *   leftColumn    : string
 *   rightEntity   : string
 *   rightColumn   : string
 * }
 *
 * IREnum { name, tableName, values: string[] }
 * IRSimpleType { name, sqlType, jsonType, constraints }
 */

const { TypeResolver } = require('./type-resolver');

// ─── naming helpers ───────────────────────────────────────────────────────────

const toSnake  = s => s
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g,    '$1_$2')
  .replace(/-/g, '_')
  .toLowerCase();

const toCamel  = s => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
const toPascal = s => { const c = toCamel(s); return c[0].toUpperCase() + c.slice(1); };

// ─── IR builder ───────────────────────────────────────────────────────────────

class IRBuilder {
  constructor(schema) {
    this.schema   = schema;
    this.resolver = new TypeResolver(schema);

    /** @type {Map<string, object>} */
    this.entities    = new Map();
    /** @type {Map<string, object>} */
    this.joinTables  = new Map();
    /** @type {Map<string, object>} */
    this.enums       = new Map();
    /** @type {Map<string, object>} */
    this.simpleTypes = new Map();

    // Guard against infinite recursion on self-referencing types
    this._visited = new Set();
  }

  // ── entry point ────────────────────────────────────────────────────────────

  build() {
    // 1. Collect all named simpleTypes (enumerations + restrictions)
    for (const st of (this.schema.simpleType || [])) {
      this._processSimpleType(st);
    }

    // 2. Identify S3000L "real entities" — complexTypes that carry both
    //    uid AND crud attributes.  When such a set exists we restrict
    //    entity generation to that list so envelope/wrapper types are
    //    never turned into DB tables.
    const s3000lRealTypes = this._detectS3000LEntities();
    this._s3000lMode = s3000lRealTypes !== null;
    this._s3000lSet  = s3000lRealTypes ?? new Set();

    // 3. Collect all named complexTypes → entities
    for (const ct of (this.schema.complexType || [])) {
      const name = ct['@_name'];
      if (!name) continue;
      // In S3000L mode skip types that are not real entities
      if (this._s3000lMode && !this._s3000lSet.has(name)) continue;
      this._processComplexType(name, ct);
    }

    // 4. Top-level element declarations that are not just references
    for (const el of (this.schema.element || [])) {
      if (el['@_name'] && el.complexType) {
        const name = toPascal(el['@_name']);
        if (this._s3000lMode && !this._s3000lSet.has(name)) continue;
        for (const anonCT of (el.complexType || [])) {
          this._processComplexType(name, anonCT);
        }
      }
    }

    return {
      entities   : this.entities,
      joinTables : this.joinTables,
      enums      : this.enums,
      simpleTypes: this.simpleTypes,
      s3000lMode : this._s3000lMode,
    };
  }

  /**
   * Detect whether this schema uses the S3000L uid+crud pattern.
   * Returns a Set of type names that have both attributes, or null if
   * the pattern is absent (non-S3000L schema).
   */
  _detectS3000LEntities() {
    const candidates = [];
    for (const ct of (this.schema.complexType || [])) {
      const name = ct['@_name'];
      if (!name) continue;
      const attrs = this._flatAttributes(ct);
      const hasUid  = attrs.some(a => a['@_name'] === 'uid');
      const hasCrud = attrs.some(a => a['@_name'] === 'crud');
      if (hasUid && hasCrud) candidates.push(name);
    }
    return candidates.length > 0 ? new Set(candidates) : null;
  }

  /** Collect all attribute nodes shallowly in a complexType (not nested). */
  _flatAttributes(ct) {
    const attrs = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const a of (node.attribute || [])) attrs.push(a);
      for (const cc of (node.complexContent || [])) walk(cc);
      for (const sc of (node.simpleContent  || [])) walk(sc);
      for (const ext of (node.extension     || [])) walk(ext);
      for (const res of (node.restriction   || [])) walk(res);
    };
    walk(ct);
    return attrs;
  }

  // ── simpleType processing ──────────────────────────────────────────────────

  _processSimpleType(st) {
    const name = st['@_name'];
    if (!name) return;

    const restriction = (st.restriction || [])[0];
    if (!restriction) return;

    const enumerations = (restriction.enumeration || []).map(e => e['@_value']).filter(Boolean);
    if (enumerations.length > 0) {
      // It's an enum
      this.enums.set(name, {
        name,
        tableName: toSnake(name),
        values   : enumerations,
        docs     : _docs(st),
      });
    } else {
      // It's a restricted primitive
      const base  = restriction['@_base'] || 'string';
      const prim  = this.resolver.primitiveInfo(base) || { sqlType: 'TEXT', jsonType: 'string' };
      this.simpleTypes.set(name, {
        name,
        sqlType    : prim.sqlType,
        jsonType   : prim.jsonType,
        constraints: _extractConstraints(restriction),
        docs       : _docs(st),
      });
    }
  }

  // ── complexType → entity ───────────────────────────────────────────────────

  _processComplexType(name, ct) {
    if (this._visited.has(name)) return;
    // In S3000L mode: only materialise real entities (uid+crud types).
    // Types referenced from within a real entity but not in the set are
    // flattened inline or treated as opaque columns — NOT separate tables.
    if (this._s3000lMode && !this._s3000lSet.has(name)) return;
    this._visited.add(name);

    const entity = {
      name,
      tableName    : toSnake(name),
      columns      : [],
      relations    : [],
      abstract     : ct['@_abstract'] === 'true',
      parentType   : null,
      documentation: _docs(ct),
    };

    // Always add a surrogate PK (MariaDB: BIGINT AUTO_INCREMENT)
    entity.columns.push({
      name        : 'id',
      columnName  : 'id',
      sqlType     : 'BIGINT',
      jsonType    : 'integer',
      nullable    : false,
      isPrimaryKey: true,
      isForeignKey: false,
      referencesEntity: null,
      isEnum      : false,
      enumRef     : null,
      constraints : {},
      documentation: 'Surrogate primary key',
    });

    // S3000L technical tracking columns (added once per real entity)
    if (this._s3000lMode) {
      for (const col of _s3000lTechColumns()) {
        entity.columns.push(col);
      }
    }

    // Handle xs:extension (inheritance)
    const extension = _dig(ct, 'complexContent', 'extension')
                   || _dig(ct, 'simpleContent',  'extension');
    if (extension) {
      const base = extension['@_base'];
      entity.parentType = base;
      // Add FK to parent table
      entity.columns.push({
        name        : toCamel(base) + 'Id',
        columnName  : toSnake(base) + '_id',
        sqlType     : 'BIGINT',
        jsonType    : 'integer',
        nullable    : false,
        isPrimaryKey: false,
        isForeignKey: true,
        referencesEntity: base,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `FK to parent type ${base}`,
      });
      // Ensure parent entity is processed first
      const parentCT = this.resolver.getComplexType(base);
      if (parentCT && !this._visited.has(base)) {
        this._processComplexType(base, parentCT);
      }
      this._processParticle(entity, extension);
    }

    // Handle xs:restriction
    const restriction = _dig(ct, 'complexContent', 'restriction');
    if (restriction) {
      this._processParticle(entity, restriction);
    }

    // Direct content (sequence / choice / all / attributes)
    this._processParticle(entity, ct);

    this.entities.set(name, entity);
  }

  // ── particle walker: sequence / choice / all / attributes ─────────────────

  _processParticle(entity, node) {
    if (!node) return;

    // xs:sequence and xs:all are treated identically
    for (const seqType of ['sequence', 'all']) {
      for (const seq of (node[seqType] || [])) {
        this._walkSequence(entity, seq, false);
      }
    }

    // xs:choice — all branches become nullable; add discriminator column
    for (const choice of (node.choice || [])) {
      this._walkChoice(entity, choice);
    }

    // xs:attribute declarations
    for (const attr of (node.attribute || [])) {
      this._processAttribute(entity, attr);
    }

    // xs:attributeGroup refs
    for (const ag of (node.attributeGroup || [])) {
      const ref  = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }

    // xs:group refs — walk the *inner* particle of the named group definition,
    // not the group node itself (which has no direct element children).
    // A group definition looks like:
    //   <xs:group name="Foo">
    //     <xs:sequence> ... </xs:sequence>   ← this is what we need to walk
    //   </xs:group>
    // We also respect the ref's own minOccurs/maxOccurs: if the ref says
    // maxOccurs="unbounded" we must honour that for every element inside.
    for (const g of (node.group || [])) {
      const ref     = g['@_ref'];
      const gDef    = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;

      const refMin = _parseOccurs(g['@_minOccurs'], 1);
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);

      if (refMax === 'unbounded' || refMax > 1) {
        // The whole group is repeating → treat it as a virtual child entity
        // so the one-to-many relationship is preserved.
        this._walkGroupAsRelation(entity, ref, gDef, refMin, refMax);
      } else {
        // Inline: flatten the group's content into the current entity
        this._walkGroupInline(entity, gDef);
      }
    }
  }

  /**
   * Flatten a named group's content into the current entity.
   * A <xs:group> wrapper holds exactly one of: sequence | choice | all.
   */
  _walkGroupInline(entity, gDef) {
    for (const seq of (gDef.sequence || [])) {
      this._walkSequence(entity, seq, false);
    }
    for (const all of (gDef.all || [])) {
      this._walkSequence(entity, all, false);   // <all> behaves like <sequence> for our purposes
    }
    for (const choice of (gDef.choice || [])) {
      this._walkChoice(entity, choice);
    }
    // A group can also carry attributes (unusual but legal)
    for (const attr of (gDef.attribute || [])) {
      this._processAttribute(entity, attr);
    }
    for (const ag of (gDef.attributeGroup || [])) {
      const ref   = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }
  }

  /**
   * A repeating group ref (maxOccurs > 1 or unbounded) is modelled as a
   * synthetic child entity containing the group's fields, related back to
   * the parent via a one-to-many.
   */
  _walkGroupAsRelation(entity, groupName, gDef, minOccurs, maxOccurs) {
    const childName = toPascal(entity.name + '_' + toPascal(groupName));
    if (!this.entities.has(childName)) {
      // Build the synthetic entity
      const child = {
        name         : childName,
        tableName    : toSnake(childName),
        columns      : [
          _surrogateKey(),
          {
            name        : toCamel(entity.name) + 'Id',
            columnName  : toSnake(entity.name) + '_id',
            sqlType     : 'BIGINT',
            jsonType    : 'integer',
            nullable    : false,
            isPrimaryKey: false,
            isForeignKey: true,
            referencesEntity: entity.name,
            isEnum      : false,
            enumRef     : null,
            constraints : {},
            documentation: `FK back to ${entity.name} (from group ${groupName})`,
          },
        ],
        relations    : [],
        abstract     : false,
        parentType   : null,
        documentation: `Synthetic entity for repeated xs:group "${groupName}" in ${entity.name}`,
      };
      this.entities.set(childName, child);
      // Now populate the child with the group's inner content
      this._walkGroupInline(child, gDef);
    }
    entity.relations.push({
      kind        : 'one-to-many',
      fieldName   : groupName,
      targetEntity: childName,
      joinTable   : null,
      nullable    : minOccurs === 0,
      minOccurs,
      maxOccurs,
    });
  }

  _walkSequence(entity, seq, insideChoice) {
    for (const el of (seq.element || [])) {
      this._processElement(entity, el, insideChoice);
    }
    for (const inner of (seq.sequence || [])) {
      this._walkSequence(entity, inner, insideChoice);
    }
    for (const all of (seq.all || [])) {
      this._walkSequence(entity, all, insideChoice);
    }
    for (const choice of (seq.choice || [])) {
      this._walkChoice(entity, choice);
    }
    for (const attr of (seq.attribute || [])) {
      this._processAttribute(entity, attr);
    }
    // xs:group refs inside a sequence
    for (const g of (seq.group || [])) {
      const ref  = g['@_ref'];
      const gDef = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;
      const refMin = _parseOccurs(g['@_minOccurs'], 1);
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);
      if (refMax === 'unbounded' || refMax > 1) {
        this._walkGroupAsRelation(entity, ref, gDef, refMin, refMax);
      } else {
        this._walkGroupInline(entity, gDef);
      }
    }
    // xs:attributeGroup refs inside a sequence
    for (const ag of (seq.attributeGroup || [])) {
      const ref   = ag['@_ref'];
      const agDef = ref ? this.resolver.getAttributeGroup(ref) : null;
      if (agDef) this._processParticle(entity, agDef);
    }
  }

  _walkChoice(entity, choice) {
    const elementBranches = (choice.element || []);
    const groupBranches   = (choice.group   || []);

    // Build discriminator values from both element names and group refs
    const allBranchNames = [
      ...elementBranches.map(b => b['@_name']).filter(Boolean),
      ...groupBranches.map(b => b['@_ref']).filter(Boolean),
    ];

    // Add choice_type discriminator only once per entity (avoid duplicates
    // when there are multiple xs:choice blocks in the same complexType)
    const alreadyHasDiscriminator = entity.columns.some(c => c.columnName === 'choice_type');
    if (allBranchNames.length > 1 && !alreadyHasDiscriminator) {
      entity.columns.push({
        name        : 'choiceType',
        columnName  : 'choice_type',
        sqlType     : 'VARCHAR(64)',
        jsonType    : 'string',
        nullable    : true,
        isPrimaryKey: false,
        isForeignKey: false,
        referencesEntity: null,
        isEnum      : false,
        enumRef     : null,
        constraints : { enum: allBranchNames },
        documentation: 'Discriminator for xs:choice',
      });
    }

    // Element branches are all nullable (only one fires at runtime)
    for (const el of elementBranches) {
      this._processElement(entity, el, true);
    }

    // Group branches inside a choice: flatten inline (each branch nullable)
    for (const g of groupBranches) {
      const ref  = g['@_ref'];
      const gDef = ref ? this.resolver.getGroup(ref) : null;
      if (!gDef) continue;
      const refMax = _parseOccurs(g['@_maxOccurs'], 1);
      if (refMax === 'unbounded' || refMax > 1) {
        this._walkGroupAsRelation(entity, ref, gDef, 0, refMax);
      } else {
        this._walkGroupInline(entity, gDef);
      }
    }

    // Nested sequences within choice
    for (const seq of (choice.sequence || [])) {
      this._walkSequence(entity, seq, true);
    }
    // Nested choices within choice
    for (const inner of (choice.choice || [])) {
      this._walkChoice(entity, inner);
    }
  }

  // ── element processing ─────────────────────────────────────────────────────

  _processElement(entity, el, nullable = false) {
    const elName    = el['@_name'];
    const elRef     = el['@_ref'];
    const typeName  = el['@_type'];
    const minOccurs = _parseOccurs(el['@_minOccurs'], 1);
    const maxOccurs = _parseOccurs(el['@_maxOccurs'], 1);

    const effectiveName = elName || elRef;
    if (!effectiveName) return;

    const isOptional  = nullable || minOccurs === 0;
    const isRepeating = maxOccurs === 'unbounded' || maxOccurs > 1;

    // ── inline anonymous complexType ─────────────────────────────────────────
    const anonCTs = el.complexType || [];
    if (anonCTs.length > 0) {
      const anonName = toPascal(entity.name + '_' + toPascal(effectiveName));
      for (const anonCT of anonCTs) {
        this._processComplexType(anonName, anonCT);
      }
      this._addRelation(entity, effectiveName, anonName, isOptional, minOccurs, maxOccurs);
      return;
    }

    // ── ref to another element (no type attribute) ───────────────────────────
    if (elRef && !typeName) {
      const refName = toPascal(elRef);
      // We assume the ref resolves to a complex type entity
      this._addRelation(entity, elRef, refName, isOptional, minOccurs, maxOccurs);
      return;
    }

    // ── typed element ────────────────────────────────────────────────────────
    if (typeName) {
      const resolved = this.resolver.resolve(typeName);

      if (resolved.kind === 'primitive') {
        if (isRepeating) {
          // Repeated primitive → child table (e.g. a list of codes)
          const childName = toPascal(entity.name + '_' + toPascal(effectiveName));
          if (!this.entities.has(childName)) {
            this.entities.set(childName, {
              name         : childName,
              tableName    : toSnake(childName),
              columns      : [
                _surrogateKey(),
                {
                  name        : toCamel(entity.name) + 'Id',
                  columnName  : toSnake(entity.name) + '_id',
                  sqlType     : 'BIGINT',
                  jsonType    : 'integer',
                  nullable    : false,
                  isPrimaryKey: false,
                  isForeignKey: true,
                  referencesEntity: entity.name,
                  isEnum      : false,
                  enumRef     : null,
                  constraints : {},
                  documentation: `FK back to ${entity.name}`,
                },
                {
                  name        : 'value',
                  columnName  : 'value',
                  sqlType     : resolved.sqlType,
                  jsonType    : resolved.jsonType,
                  nullable    : false,
                  isPrimaryKey: false,
                  isForeignKey: false,
                  referencesEntity: null,
                  isEnum      : false,
                  enumRef     : null,
                  constraints : {},
                  documentation: null,
                },
              ],
              relations    : [],
              abstract     : false,
              parentType   : null,
              documentation: `Repeated ${typeName} values for ${entity.name}.${effectiveName}`,
            });
          }
          entity.relations.push({
            kind        : 'one-to-many',
            fieldName   : effectiveName,
            targetEntity: childName,
            joinTable   : null,
            nullable    : isOptional,
            minOccurs,
            maxOccurs,
          });
        } else {
          // Simple scalar column
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : resolved.sqlType,
            jsonType    : resolved.jsonType,
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: resolved.isIdRef  || false,
            referencesEntity: resolved.isIdRef ? null : null, // resolved later if needed
            isEnum      : false,
            enumRef     : null,
            constraints : {
              ...(resolved.minimum  != null ? { minimum:  resolved.minimum  } : {}),
              ...(resolved.maximum  != null ? { maximum:  resolved.maximum  } : {}),
              ...(resolved.format   != null ? { format:   resolved.format   } : {}),
              ...(resolved.isId    ? { isId:    true } : {}),
              ...(resolved.isIdRef ? { isIdRef: true } : {}),
              ...(resolved.isIdRefs? { isIdRefs:true } : {}),
            },
            documentation: _docs(el),
          });

          // IDREFS → join table
          if (resolved.isIdRefs) {
            const joinName = `${entity.tableName}__${toSnake(effectiveName)}`;
            this.joinTables.set(joinName, {
              name       : joinName,
              tableName  : joinName,
              leftEntity : entity.name,
              leftColumn : toSnake(entity.name) + '_id',
              rightEntity: toPascal(effectiveName),   // best guess; override manually
              rightColumn: toSnake(effectiveName) + '_id',
              documentation: `Join table for IDREFS ${entity.name}.${effectiveName}`,
            });
          }
        }
        return;
      }

      if (resolved.kind === 'simple') {
        // Check if it's an enum
        const enumDef = this.enums.get(typeName);
        if (enumDef) {
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : 'VARCHAR(64)',
            jsonType    : 'string',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : true,
            enumRef     : typeName,
            constraints : { enum: enumDef.values },
            documentation: _docs(el),
          });
        } else {
          const stDef = this.simpleTypes.get(typeName);
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : stDef?.sqlType   || 'TEXT',
            jsonType    : stDef?.jsonType  || 'string',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : false,
            enumRef     : null,
            constraints : stDef?.constraints || {},
            documentation: _docs(el),
          });
        }
        return;
      }

      if (resolved.kind === 'complex') {
        // In S3000L mode, only create a relation if the target is a real entity.
        // Otherwise treat the nested type as an opaque JSON column.
        if (this._s3000lMode && !this._s3000lSet.has(typeName)) {
          entity.columns.push({
            name        : toCamel(effectiveName),
            columnName  : toSnake(effectiveName),
            sqlType     : 'LONGTEXT',          // MariaDB: store JSON as LONGTEXT
            jsonType    : 'object',
            nullable    : isOptional,
            isPrimaryKey: false,
            isForeignKey: false,
            referencesEntity: null,
            isEnum      : false,
            enumRef     : null,
            constraints : {},
            documentation: `Inline complex type ${typeName} (not a real S3000L entity)`,
          });
          return;
        }
        // Make sure the referenced entity is built
        if (!this._visited.has(typeName)) {
          this._processComplexType(typeName, resolved.node);
        }
        this._addRelation(entity, effectiveName, typeName, isOptional, minOccurs, maxOccurs);
        return;
      }

      // kind === 'unknown' — treat as text column for now
      entity.columns.push({
        name        : toCamel(effectiveName),
        columnName  : toSnake(effectiveName),
        sqlType     : 'TEXT',
        jsonType    : 'string',
        nullable    : isOptional,
        isPrimaryKey: false,
        isForeignKey: false,
        referencesEntity: null,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `Unresolved type: ${typeName}`,
      });
    }
  }

  // ── attribute processing ───────────────────────────────────────────────────

  _processAttribute(entity, attr) {
    const attrName  = attr['@_name'];
    const attrRef   = attr['@_ref'];
    const typeName  = attr['@_type'];
    const use       = attr['@_use'] || 'optional';
    const nullable  = use !== 'required';

    const effectiveName = attrName || attrRef;
    if (!effectiveName) return;

    const resolved = typeName ? this.resolver.resolve(typeName) : { kind: 'primitive', sqlType: 'TEXT', jsonType: 'string' };

    const colBase = {
      name        : toCamel(effectiveName),
      columnName  : toSnake(effectiveName),
      nullable,
      isPrimaryKey: false,
      isForeignKey: false,
      referencesEntity: null,
      documentation: _docs(attr),
    };

    if (resolved.kind === 'primitive') {
      entity.columns.push({
        ...colBase,
        sqlType    : resolved.sqlType,
        jsonType   : resolved.jsonType,
        isEnum     : false,
        enumRef    : null,
        constraints: {
          ...(resolved.minimum  != null ? { minimum:  resolved.minimum  } : {}),
          ...(resolved.maximum  != null ? { maximum:  resolved.maximum  } : {}),
          ...(resolved.format   != null ? { format:   resolved.format   } : {}),
          ...(resolved.isId    ? { isId:    true } : {}),
          ...(resolved.isIdRef ? { isIdRef: true } : {}),
        },
      });
    } else {
      const enumDef = this.enums.get(typeName);
      entity.columns.push({
        ...colBase,
        sqlType    : enumDef ? 'VARCHAR(64)' : 'TEXT',
        jsonType   : 'string',
        isEnum     : !!enumDef,
        enumRef    : enumDef ? typeName : null,
        constraints: enumDef ? { enum: enumDef.values } : {},
      });
    }
  }

  // ── relation helper ────────────────────────────────────────────────────────

  _addRelation(entity, fieldName, targetEntity, nullable, minOccurs, maxOccurs) {
    const isRepeating = maxOccurs === 'unbounded' || maxOccurs > 1;
    const kind        = isRepeating ? 'one-to-many' : 'one-to-one';

    entity.relations.push({
      kind,
      fieldName,
      targetEntity,
      joinTable : null,
      nullable,
      minOccurs,
      maxOccurs,
    });

    // For one-to-one, add the FK column on this side
    if (!isRepeating) {
      entity.columns.push({
        name        : toCamel(fieldName) + 'Id',
        columnName  : toSnake(fieldName) + '_id',
        sqlType     : 'BIGINT',
        jsonType    : 'integer',
        nullable,
        isPrimaryKey: false,
        isForeignKey: true,
        referencesEntity: targetEntity,
        isEnum      : false,
        enumRef     : null,
        constraints : {},
        documentation: `FK → ${targetEntity}`,
      });
    }
  }
}

// ─── private helpers ──────────────────────────────────────────────────────────

function _parseOccurs(val, defaultVal) {
  if (val === undefined || val === null) return defaultVal;
  if (val === 'unbounded') return 'unbounded';
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultVal : n;
}

function _docs(node) {
  try {
    const ann  = (node.annotation  || [])[0];
    const docs = (ann?.documentation || [])[0];
    if (!docs) return null;
    if (typeof docs === 'string') return docs.trim();
    if (typeof docs === 'object') return (docs['#text'] || '').trim();
  } catch { /* ignore */ }
  return null;
}

function _dig(node, ...keys) {
  let cur = node;
  for (const k of keys) {
    if (!cur) return null;
    const val = cur[k];
    if (val === undefined || val === null) return null;
    // Accept both array form (after isArray fix) and plain object
    cur = Array.isArray(val) ? val[0] : val;
    if (!cur) return null;
  }
  return cur || null;
}

function _extractConstraints(restriction) {
  const pick = (k) => restriction[k]?.[0]?.['@_value'];
  return Object.fromEntries(
    ['minLength','maxLength','minInclusive','maxInclusive',
     'minExclusive','maxExclusive','pattern','totalDigits','fractionDigits']
      .map(k => [k, pick(k)])
      .filter(([, v]) => v !== undefined)
  );
}

function _surrogateKey() {
  return {
    name        : 'id',
    columnName  : 'id',
    sqlType     : 'BIGINT',        // MariaDB: BIGINT AUTO_INCREMENT
    jsonType    : 'integer',
    nullable    : false,
    isPrimaryKey: true,
    isForeignKey: false,
    referencesEntity: null,
    isEnum      : false,
    enumRef     : null,
    constraints : {},
    documentation: 'Surrogate primary key',
  };
}

/**
 * Technical tracking columns added to every S3000L real entity.
 * Prefixed with _ so they are never serialised into the XML dump.
 * Types use MariaDB dialect.
 */
function _s3000lTechColumns() {
  const base = {
    isPrimaryKey: false, isForeignKey: false,
    referencesEntity: null, isEnum: false, enumRef: null, constraints: {},
  };
  return [
    { ...base, name: '_createdAt',  columnName: '_created_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: false, documentation: 'Technical: row insert timestamp' },
    { ...base, name: '_updatedAt',  columnName: '_updated_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: false, documentation: 'Technical: row last-update timestamp' },
    { ...base, name: '_deletedAt',  columnName: '_deleted_at',  sqlType: 'DATETIME(3)', jsonType: 'string',  nullable: true,  documentation: 'Technical: soft-delete (crud=D)' },
    { ...base, name: '_msgSeq',     columnName: '_msg_seq',     sqlType: 'BIGINT',      jsonType: 'integer', nullable: false, documentation: 'Technical: last export message sequence — used for net-change delta' },
  ];
}

module.exports = { IRBuilder };
```

---

## `src/sql-generator.js`

```javascript
'use strict';

/**
 * sql-generator.js
 *
 * Consumes the Intermediate Representation produced by ir-builder.js and
 * emits MariaDB-compatible CREATE TABLE DDL statements.
 *
 * MariaDB-specific choices vs PostgreSQL:
 *   BIGSERIAL        → BIGINT AUTO_INCREMENT
 *   DOUBLE PRECISION → DOUBLE
 *   BYTEA            → LONGBLOB
 *   JSONB            → LONGTEXT  (MariaDB has JSON alias but LONGTEXT is portable)
 *   DEFAULT NOW()    → DEFAULT CURRENT_TIMESTAMP
 *   Inline REFERENCES → not supported; FKs via ALTER TABLE only
 *
 * Output order:
 *   1. Preamble (charset / engine directives)
 *   2. Enum / lookup tables
 *   3. Entity tables (leaf-first via topological sort so FKs are valid)
 *   4. Join tables
 *   5. Foreign-key ALTER TABLE statements
 *   6. Re-enable FK checks
 */

// ─── MariaDB type map (IR sqlType → MariaDB DDL type) ─────────────────────────

const MARIADB_TYPE = {
  'BIGSERIAL'        : 'BIGINT',        // AUTO_INCREMENT added on PK col
  'BIGINT'           : 'BIGINT',
  'INTEGER'          : 'INT',
  'INT'              : 'INT',
  'SMALLINT'         : 'SMALLINT',
  'DECIMAL'          : 'DECIMAL(18,6)',
  'FLOAT'            : 'FLOAT',
  'DOUBLE PRECISION' : 'DOUBLE',
  'DOUBLE'           : 'DOUBLE',
  'BOOLEAN'          : 'TINYINT(1)',    // no native BOOLEAN in MariaDB
  'TEXT'             : 'TEXT',
  'VARCHAR'          : 'VARCHAR(255)',
  'VARCHAR(64)'      : 'VARCHAR(64)',
  'VARCHAR(255)'     : 'VARCHAR(255)',
  'CHAR(4)'          : 'CHAR(4)',
  'CHAR(7)'          : 'CHAR(7)',
  'CHAR(10)'         : 'CHAR(10)',
  'DATE'             : 'DATE',
  'TIME'             : 'TIME',
  'TIMESTAMP'        : 'DATETIME(3)',   // DATETIME supports fractional seconds
  'BYTEA'            : 'LONGBLOB',
  'JSONB'            : 'LONGTEXT',      // validate JSON in application layer
};

function _mariaType(sqlType) {
  return MARIADB_TYPE[sqlType] ?? sqlType;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} ir  The IR object returned by IRBuilder.build()
 * @returns {string}   Full SQL DDL string (MariaDB dialect)
 */
function generateSQL(ir) {
  const lines = [];

  lines.push('-- ================================================================');
  lines.push('-- AUTO-GENERATED FROM XSD — DO NOT EDIT BY HAND');
  lines.push('-- Target: MariaDB 10.4+');
  lines.push('-- ================================================================\n');

  lines.push('SET FOREIGN_KEY_CHECKS = 0;');
  lines.push('SET NAMES utf8mb4;\n');

  // 1. Enum lookup tables
  if (ir.enums.size > 0) {
    lines.push('-- ── Enum / lookup tables ───────────────────────────────────────────');
    for (const [, enumDef] of ir.enums) {
      lines.push(_enumTable(enumDef));
    }
  }

  // 2. Entity tables (topologically sorted so referenced tables come first)
  const sorted = _topoSort(ir.entities);
  lines.push('-- ── Entity tables ──────────────────────────────────────────────────');
  for (const entityName of sorted) {
    const entity = ir.entities.get(entityName);
    lines.push(_entityTable(entity));
  }

  // 3. Join tables
  if (ir.joinTables.size > 0) {
    lines.push('-- ── Join tables ────────────────────────────────────────────────────');
    for (const [, jt] of ir.joinTables) {
      lines.push(_joinTable(jt));
    }
  }

  // 4. Foreign-key constraints (after all tables exist)
  lines.push('-- ── Foreign-key constraints ────────────────────────────────────────');
  for (const entityName of sorted) {
    const entity = ir.entities.get(entityName);
    for (const col of entity.columns) {
      if (col.isForeignKey && col.referencesEntity) {
        const refEntity = ir.entities.get(col.referencesEntity);
        if (refEntity) {
          lines.push(
            `ALTER TABLE \`${entity.tableName}\`\n` +
            `  ADD CONSTRAINT \`fk_${entity.tableName}_${col.columnName}\`\n` +
            `  FOREIGN KEY (\`${col.columnName}\`)\n` +
            `  REFERENCES \`${refEntity.tableName}\`(\`id\`)\n` +
            `  ON DELETE RESTRICT;\n`
          );
        }
      }
    }
  }

  lines.push('SET FOREIGN_KEY_CHECKS = 1;');

  return lines.join('\n');
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _enumTable(enumDef) {
  const rows = enumDef.values.map(v => `  ('${v.replace(/'/g, "''")}')`).join(',\n');
  return (
    `-- ${enumDef.name}\n` +
    `CREATE TABLE IF NOT EXISTS \`${enumDef.tableName}\` (\n` +
    `  \`value\` VARCHAR(64) NOT NULL PRIMARY KEY\n` +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n` +
    `INSERT IGNORE INTO \`${enumDef.tableName}\` (\`value\`) VALUES\n${rows};\n`
  );
}

function _entityTable(entity) {
  const colLines = entity.columns.map(col => _columnDDL(col));

  const header = entity.documentation
    ? `-- ${entity.name}: ${entity.documentation}\n`
    : `-- ${entity.name}\n`;

  const tableSQL =
    header +
    `CREATE TABLE IF NOT EXISTS \`${entity.tableName}\` (\n` +
    colLines.map(l => '  ' + l).join(',\n') + '\n' +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n`;

  // Index on _msg_seq for fast delta queries
  const hasMsgSeq = entity.columns.some(c => c.columnName === '_msg_seq');
  const indexSQL  = hasMsgSeq
    ? `CREATE INDEX \`idx_${entity.tableName}_msg_seq\`` +
      ` ON \`${entity.tableName}\` (\`_msg_seq\`);\n`
    : '';

  return tableSQL + indexSQL;
}

function _columnDDL(col) {
  const mariaType = _mariaType(col.sqlType);
  const parts     = [`\`${col.columnName}\``.padEnd(34), mariaType];

  if (col.isPrimaryKey) {
    // MariaDB auto-increment PK syntax
    parts.push('NOT NULL AUTO_INCREMENT PRIMARY KEY');
  } else {
    if (col.columnName === '_created_at') {
      parts.push('NOT NULL DEFAULT CURRENT_TIMESTAMP');
    } else if (col.columnName === '_updated_at') {
      parts.push('NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    } else if (col.columnName === '_msg_seq') {
      parts.push('NOT NULL DEFAULT 0');
    } else if (!col.nullable) {
      parts.push('NOT NULL');
    } else {
      parts.push('DEFAULT NULL');
    }

    if (col.isEnum && col.enumRef) {
      const vals = (col.constraints.enum || []).map(v => `'${v}'`).join(', ');
      if (vals) parts.push(`CHECK (\`${col.columnName}\` IN (${vals}))`);
    }
  }

  if (col.documentation) {
    parts.push(`COMMENT '${col.documentation.replace(/'/g, "''").slice(0, 1024)}'`);
  }

  return parts.join(' ');
}

function _joinTable(jt) {
  return (
    `-- ${jt.documentation || jt.name}\n` +
    `CREATE TABLE IF NOT EXISTS \`${jt.tableName}\` (\n` +
    `  \`${jt.leftColumn}\``.padEnd(36) + ` BIGINT NOT NULL,\n` +
    `  \`${jt.rightColumn}\``.padEnd(36) + ` BIGINT NOT NULL,\n` +
    `  PRIMARY KEY (\`${jt.leftColumn}\`, \`${jt.rightColumn}\`)\n` +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n`
  );
}

/**
 * Kahn's algorithm: entities referenced by FK come first.
 */
function _topoSort(entities) {
  const indegree = new Map([...entities.keys()].map(k => [k, 0]));
  const deps     = new Map([...entities.keys()].map(k => [k, new Set()]));

  for (const [name, entity] of entities) {
    for (const col of entity.columns) {
      if (col.isForeignKey && col.referencesEntity && entities.has(col.referencesEntity)) {
        deps.get(name).add(col.referencesEntity);
        indegree.set(name, (indegree.get(name) || 0) + 1);
      }
    }
  }

  const queue  = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const result = [];

  while (queue.length > 0) {
    const node = queue.shift();
    result.push(node);
    for (const [name, depSet] of deps) {
      if (depSet.has(node)) {
        depSet.delete(node);
        const newDeg = (indegree.get(name) || 1) - 1;
        indegree.set(name, newDeg);
        if (newDeg === 0) queue.push(name);
      }
    }
  }

  // Append any remaining (cycles) at the end
  for (const k of entities.keys()) {
    if (!result.includes(k)) result.push(k);
  }

  return result;
}

module.exports = { generateSQL };
```

---

## `src/json-schema-generator.js`

```javascript
'use strict';

/**
 * json-schema-generator.js
 *
 * Consumes the Intermediate Representation produced by ir-builder.js and
 * emits a JSON Schema (draft-07) document that can validate XML-derived
 * JSON messages matching the original XSD structure.
 *
 * Each entity becomes a $defs entry; a root $schema object is emitted
 * that $refs all top-level entities.
 */

/**
 * @param {object} ir       The IR object returned by IRBuilder.build()
 * @param {object} options
 * @param {string} [options.rootEntity]    Name of the root entity to use as
 *                                          the document root (optional).
 * @param {string} [options.schemaId]      Value for the "$id" field.
 * @returns {object}  A JSON Schema draft-07 object (not yet serialised).
 */
function generateJSONSchema(ir, options = {}) {
  const {
    rootEntity = null,
    schemaId   = 'https://example.com/schema.json',
  } = options;

  const defs = {};

  // ── enum definitions ────────────────────────────────────────────────────────
  for (const [name, enumDef] of ir.enums) {
    defs[name] = {
      title      : name,
      description: enumDef.docs || undefined,
      type       : 'string',
      enum       : enumDef.values,
    };
  }

  // ── simpleType definitions ──────────────────────────────────────────────────
  for (const [name, st] of ir.simpleTypes) {
    defs[name] = _simpleTypeDef(name, st);
  }

  // ── entity definitions ──────────────────────────────────────────────────────
  for (const [name, entity] of ir.entities) {
    defs[name] = _entityDef(entity, ir);
  }

  // ── root schema ─────────────────────────────────────────────────────────────
  const schema = {
    $schema    : 'http://json-schema.org/draft-07/schema#',
    $id        : schemaId,
    title      : 'XSD-derived schema',
    description: 'Auto-generated from XSD via xsd-to-ir',
    $defs      : defs,
  };

  if (rootEntity && ir.entities.has(rootEntity)) {
    schema.$ref = `#/$defs/${rootEntity}`;
  } else {
    // Default: union of all top-level entities
    schema.oneOf = [...ir.entities.keys()].map(name => ({ $ref: `#/$defs/${name}` }));
  }

  return schema;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _simpleTypeDef(name, st) {
  const def = {
    title      : name,
    description: st.docs || undefined,
    type       : st.jsonType,
  };
  _applyConstraints(def, st.constraints);
  return def;
}

function _entityDef(entity, ir) {
  const properties  = {};
  const required    = [];

  // Columns → JSON Schema properties
  for (const col of entity.columns) {
    if (col.isPrimaryKey) continue; // internal DB id; skip in JSON schema
    if (col.columnName.startsWith('_')) continue; // S3000L tech columns; skip in JSON schema

    const prop = _columnToProp(col, ir);
    properties[col.name] = prop;

    if (!col.nullable) {
      required.push(col.name);
    }
  }

  // Relations → JSON Schema properties
  for (const rel of entity.relations) {
    const prop = _relationToProp(rel, ir);
    properties[rel.fieldName] = prop;

    if (!rel.nullable && rel.minOccurs > 0) {
      required.push(rel.fieldName);
    }
  }

  const def = {
    title      : entity.name,
    description: entity.documentation || undefined,
    type       : 'object',
    properties,
  };

  if (required.length > 0) def.required = required;

  // Inheritance: allOf parent ref
  if (entity.parentType && ir.entities.has(entity.parentType)) {
    return {
      allOf: [
        { $ref: `#/$defs/${entity.parentType}` },
        def,
      ],
    };
  }

  return def;
}

function _columnToProp(col, ir) {
  if (col.isEnum && col.enumRef) {
    return {
      description: col.documentation || undefined,
      $ref       : `#/$defs/${col.enumRef}`,
    };
  }

  const prop = {
    description: col.documentation || undefined,
    type       : col.nullable ? [col.jsonType, 'null'] : col.jsonType,
  };

  // Constraints
  const c = col.constraints || {};
  if (c.format)      prop.format      = c.format;
  if (c.minimum   != null) prop.minimum   = Number(c.minimum);
  if (c.maximum   != null) prop.maximum   = Number(c.maximum);
  if (c.minLength != null) prop.minLength = Number(c.minLength);
  if (c.maxLength != null) prop.maxLength = Number(c.maxLength);
  if (c.pattern)     prop.pattern     = c.pattern;
  if (c.enum)        prop.enum        = c.enum;
  if (c.contentEncoding) prop.contentEncoding = c.contentEncoding;

  return _clean(prop);
}

function _relationToProp(rel, ir) {
  const refSchema = ir.entities.has(rel.targetEntity)
    ? { $ref: `#/$defs/${rel.targetEntity}` }
    : { type: 'object' };

  if (rel.kind === 'one-to-many') {
    const prop = {
      type    : 'array',
      items   : refSchema,
    };
    if (rel.minOccurs > 0)            prop.minItems = rel.minOccurs;
    if (rel.maxOccurs !== 'unbounded') prop.maxItems = rel.maxOccurs;
    return prop;
  }

  // one-to-one / idrefs
  return rel.nullable ? { oneOf: [refSchema, { type: 'null' }] } : refSchema;
}

function _applyConstraints(def, constraints = {}) {
  if (!constraints) return;
  if (constraints.minLength  != null) def.minLength  = Number(constraints.minLength);
  if (constraints.maxLength  != null) def.maxLength  = Number(constraints.maxLength);
  if (constraints.pattern)   def.pattern   = constraints.pattern;
  if (constraints.minInclusive != null) def.minimum  = Number(constraints.minInclusive);
  if (constraints.maxInclusive != null) def.maximum  = Number(constraints.maxInclusive);
  if (constraints.minExclusive != null) def.exclusiveMinimum = Number(constraints.minExclusive);
  if (constraints.maxExclusive != null) def.exclusiveMaximum = Number(constraints.maxExclusive);
}

/** Remove keys whose value is undefined */
function _clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

module.exports = { generateJSONSchema };
```

---

## `src/xml-validator.js`

```javascript
'use strict';

/**
 * xml-validator.js
 *
 * Validates an XML string or Buffer against an XSD file using libxmljs2
 * (native libxml2 bindings — the most spec-complete validator available
 * in Node.js).
 *
 * Falls back to a structural "well-formed + envelope check" when libxmljs2
 * is not installed, so the rest of the pipeline can still run in
 * environments where native compilation is unavailable.
 *
 * Usage:
 *   const { validateXML, ValidationError } = require('./xml-validator');
 *
 *   // throws ValidationError on failure, returns void on success
 *   await validateXML(xmlString, '/path/to/s3000l_3-0_lsaDataset.xsd');
 *
 *   // soft mode — returns { valid, errors } instead of throwing
 *   const result = await validateXML(xmlString, xsdPath, { throw: false });
 */

const fs   = require('fs');
const path = require('path');

// ─── ValidationError ─────────────────────────────────────────────────────────

class ValidationError extends Error {
  /**
   * @param {string}   message   Human-readable summary
   * @param {object[]} errors    Array of { line, col, message } from libxml
   */
  constructor(message, errors = []) {
    super(message);
    this.name   = 'ValidationError';
    this.errors = errors;
  }
}

// ─── libxmljs2 loader (optional dep) ─────────────────────────────────────────

let libxml = null;

function _tryLoadLibxml() {
  if (libxml !== null) return libxml;
  try {
    libxml  = require('libxmljs2');
  } catch {
    libxml  = false; // mark as unavailable
  }
  return libxml;
}

// ─── fast-xml-parser (already a hard dep) ────────────────────────────────────

const { XMLParser } = require('fast-xml-parser');

const _fxpParser = new XMLParser({
  ignoreAttributes   : false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Lightweight well-formedness check using fast-xml-parser.
 * Also verifies that the root element is <lsaDataset>.
 */
function _structuralCheck(xmlString) {
  let parsed;
  try {
    parsed = _fxpParser.parse(xmlString);
  } catch (e) {
    throw new ValidationError(`XML is not well-formed: ${e.message}`);
  }

  // Verify S3000L root element
  const keys = Object.keys(parsed).filter(k => !k.startsWith('?'));
  if (keys.length === 0) {
    throw new ValidationError('XML has no root element');
  }
  const root = keys[0].replace(/^[^:]+:/, ''); // strip namespace prefix
  if (root !== 'lsaDataset') {
    throw new ValidationError(
      `Expected root element <lsaDataset>, found <${root}>`
    );
  }

  // Verify required header fields exist somewhere in the tree
  const xmlLower = xmlString.toLowerCase();
  for (const required of ['msgid', 'msgdate', 'msgtype']) {
    if (!xmlLower.includes(required)) {
      throw new ValidationError(
        `Missing required header element <${required}> in lsaDataset`
      );
    }
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Validate an XML message against the XSD.
 *
 * @param {string|Buffer} xml      The XML content to validate.
 * @param {string}        xsdPath  Path to the entry XSD file.
 * @param {object}        [opts]
 * @param {boolean}       [opts.throw=true]   If false, return result object
 *                                             instead of throwing.
 * @param {boolean}       [opts.verbose=false] Log validation details.
 *
 * @returns {{ valid: boolean, errors: object[], engine: string }}
 *          Only when opts.throw === false.
 * @throws  {ValidationError}  When validation fails and opts.throw === true.
 */
async function validateXML(xml, xsdPath, opts = {}) {
  const shouldThrow = opts.throw !== false;
  const xmlString   = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const absXsd      = path.resolve(xsdPath);

  if (!fs.existsSync(absXsd)) {
    const err = new ValidationError(`XSD file not found: ${absXsd}`);
    if (shouldThrow) throw err;
    return { valid: false, errors: [{ message: err.message }], engine: 'none' };
  }

  // ── Try libxmljs2 (full XSD 1.0 validation) ──────────────────────────────
  const lib = _tryLoadLibxml();

  if (lib) {
    if (opts.verbose) process.stderr.write('  [xml-validator] using libxmljs2\n');

    let xmlDoc, xsdDoc;
    try {
      xmlDoc = lib.parseXml(xmlString);
    } catch (e) {
      const err = new ValidationError(`XML parse error: ${e.message}`);
      if (shouldThrow) throw err;
      return { valid: false, errors: [{ message: err.message }], engine: 'libxmljs2' };
    }

    try {
      const xsdString = fs.readFileSync(absXsd, 'utf8');
      xsdDoc = lib.parseXml(xsdString);
    } catch (e) {
      const err = new ValidationError(`XSD parse error: ${e.message}`);
      if (shouldThrow) throw err;
      return { valid: false, errors: [{ message: err.message }], engine: 'libxmljs2' };
    }

    const valid  = xmlDoc.validate(xsdDoc);
    const errors = xmlDoc.validationErrors.map(e => ({
      line   : e.line,
      col    : e.column,
      message: e.message.trim(),
      level  : e.level,
    }));

    if (!valid) {
      const summary = `XSD validation failed (${errors.length} error(s)):\n` +
        errors.map(e => `  line ${e.line}: ${e.message}`).join('\n');
      const err = new ValidationError(summary, errors);
      if (shouldThrow) throw err;
    }

    return { valid, errors, engine: 'libxmljs2' };
  }

  // ── Fallback: structural check only ──────────────────────────────────────
  if (opts.verbose) {
    process.stderr.write(
      '  [xml-validator] libxmljs2 not available — using structural check only\n'
    );
  }

  try {
    _structuralCheck(xmlString);
  } catch (err) {
    if (shouldThrow) throw err;
    return { valid: false, errors: [{ message: err.message }], engine: 'structural' };
  }

  return { valid: true, errors: [], engine: 'structural' };
}

// ─── sync convenience wrapper ─────────────────────────────────────────────────

/**
 * Synchronous variant — useful in scripts where async isn't convenient.
 * Same signature as validateXML but returns synchronously.
 */
function validateXMLSync(xml, xsdPath, opts = {}) {
  // validateXML is actually synchronous internally; wrap to avoid Promise
  let result;
  const promise = validateXML(xml, xsdPath, opts);
  // Since the implementation is sync (no real async ops), extract value
  promise.then(r => { result = r; }).catch(e => { throw e; });
  if (result === undefined) {
    // If genuinely async (future extension), throw a clear error
    throw new Error('validateXMLSync: async operation detected — use validateXML instead');
  }
  return result;
}

module.exports = { validateXML, validateXMLSync, ValidationError };
```

---

## `src/xml-deserializer.js`

```javascript
'use strict';

/**
 * xml-deserializer.js
 *
 * Converts a parsed S3000L XML message (JS object from fast-xml-parser)
 * into a set of DB-ready row batches, respecting:
 *
 *   - The envelope hierarchy (lsaDataset → logisticsSupportAnalysisData →
 *     lsaPrimaryData / lsaSupportingData → collections → records)
 *   - The crud attribute per record (I / U / D)
 *   - IR-driven column coercion (XML string → correct JS type for the DB)
 *   - JSONB columns (nested complex types stored as JSON)
 *   - Relations (FK columns populated from nested entity uid attributes)
 *
 * Output shape:
 *   {
 *     msgMeta : { msgId, msgType, msgStatus, msgDate, relatedMsgId }
 *     batches : Map<entityName, { insert: row[], update: row[], delete: uid[] }>
 *   }
 *
 * Usage:
 *   const { XMLDeserializer } = require('./xml-deserializer');
 *   const d = new XMLDeserializer(ir);
 *   const { msgMeta, batches } = d.deserialize(parsedXmlObject);
 */

const { XMLParser } = require('fast-xml-parser');

// ─── S3000L envelope constants ────────────────────────────────────────────────

// Collections that live under lsaPrimaryData
const PRIMARY_COLLECTIONS = new Set([
  'breakdownElements', 'parts', 'productOperationalRoleKits',
  'products', 'taskRequirements', 'tasks',
]);

// Singular name for each collection key  (pluralCollection → singularRecord)
// Built lazily from the IR entity names; overrides for irregular plurals:
const IRREGULAR_SINGULAR = {
  breakdownElements         : 'breakdownElement',
  productOperationalRoleKits: 'productOperationalRoleKit',
  facilities                : 'facility',
  countries                 : 'country',
  trades                    : 'trade',
  skills                    : 'skill',
  contracts                 : 'contract',
  projects                  : 'project',
  documents                 : 'document',
  organizations             : 'organization',
  infrastructures           : 'infrastructure',
  substances                : 'substance',
};

function _singularOf(pluralKey) {
  if (IRREGULAR_SINGULAR[pluralKey]) return IRREGULAR_SINGULAR[pluralKey];
  // Standard rule: strip trailing 's'
  if (pluralKey.endsWith('s')) return pluralKey.slice(0, -1);
  return pluralKey;
}

// ─── type coercion ────────────────────────────────────────────────────────────

/**
 * Coerce an XML string value into the correct JS type for a DB column.
 */
function _coerce(value, sqlType) {
  if (value === undefined || value === null || value === '') return null;

  const v   = String(value).trim();
  const sql = (sqlType || '').toUpperCase();

  if (sql === 'BOOLEAN')  return v === 'true' || v === '1';
  if (sql === 'INTEGER' || sql === 'BIGINT' || sql === 'SMALLINT' ||
      sql === 'BIGSERIAL') return parseInt(v, 10);
  if (sql === 'DECIMAL' || sql === 'FLOAT' || sql.startsWith('DOUBLE')) return parseFloat(v);
  if (sql === 'JSONB')    return typeof value === 'object' ? value : _tryParseJson(v);
  if (sql === 'BYTEA')    return Buffer.from(v, 'base64');
  // TEXT, VARCHAR, CHAR, DATE, TIMESTAMP, etc. → keep as string
  return v;
}

function _tryParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// ─── XML attribute / element reader ──────────────────────────────────────────

/**
 * Read a value from a parsed XML node.
 * fast-xml-parser puts XML attributes under "@_name" and child elements
 * under their plain name.  We check both.
 */
function _readField(node, fieldName) {
  if (node === null || typeof node !== 'object') return undefined;
  // Try as XML attribute first
  const attrVal = node[`@_${fieldName}`];
  if (attrVal !== undefined) return attrVal;
  // Then as child element
  const elemVal = node[fieldName];
  if (elemVal !== undefined) return elemVal;
  return undefined;
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

class XMLDeserializer {
  /**
   * @param {object} ir  The IR returned by IRBuilder.build()
   */
  constructor(ir) {
    this.ir = ir;
    // Build a quick lookup: collectionKey → entityName
    this._collectionMap = this._buildCollectionMap();
  }

  // ── collection → entity name map ─────────────────────────────────────────

  _buildCollectionMap() {
    const map = new Map();
    for (const [entityName] of this.ir.entities) {
      // Pluralise simply for lookup
      map.set(entityName + 's', entityName);
      // Also index by exact name (for single-record collections)
      map.set(entityName, entityName);
    }
    // Add irregular forms
    for (const [plural, singular] of Object.entries(IRREGULAR_SINGULAR)) {
      if (this.ir.entities.has(singular)) map.set(plural, singular);
    }
    return map;
  }

  _resolveEntity(collectionKey) {
    if (this._collectionMap.has(collectionKey)) {
      return this._collectionMap.get(collectionKey);
    }
    // Try singular
    const singular = _singularOf(collectionKey);
    if (this.ir.entities.has(singular)) return singular;
    // Try as-is
    if (this.ir.entities.has(collectionKey)) return collectionKey;
    return null;
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * Deserialize a parsed XML object (output of fast-xml-parser) into batches.
   *
   * @param {object} parsed  Result of XMLParser.parse()
   * @returns {{ msgMeta, batches }}
   */
  deserialize(parsed) {
    // Strip namespace prefix on root key if present
    const rootKey = Object.keys(parsed).find(k => {
      const bare = k.includes(':') ? k.split(':').pop() : k;
      return bare === 'lsaDataset';
    });

    if (!rootKey) throw new Error('No <lsaDataset> root found in parsed XML');

    const root = parsed[rootKey];

    // ── 1. Extract message metadata ────────────────────────────────────────
    const msgMeta = this._extractMsgMeta(root);

    // ── 2. Navigate to data containers ────────────────────────────────────
    const lsaData = root.logisticsSupportAnalysisData ?? {};
    const primary  = lsaData.lsaPrimaryData    ?? {};
    const support  = lsaData.lsaSupportingData ?? {};

    // ── 3. Process all collections ─────────────────────────────────────────
    const batches = new Map();

    for (const [collKey, collValue] of Object.entries(primary)) {
      this._processCollection(collKey, collValue, batches);
    }
    for (const [collKey, collValue] of Object.entries(support)) {
      this._processCollection(collKey, collValue, batches);
    }

    return { msgMeta, batches };
  }

  // ── msg metadata ──────────────────────────────────────────────────────────

  _extractMsgMeta(root) {
    const get = (key) => {
      const v = root[key];
      if (!v) return null;
      // S3000L wraps values in <code> child elements: { code: 'B' }
      if (typeof v === 'object' && v.code !== undefined) return String(v.code);
      return String(v);
    };

    const related = root.relatedMsg;
    const relatedMsgId = Array.isArray(related)
      ? related.map(r => r.msgRef).filter(Boolean)
      : related?.msgRef ?? null;

    return {
      msgId       : get('msgId'),
      msgType     : get('msgType'),     // 'B' or 'U'
      msgStatus   : get('msgStatus'),   // 'D','P','F'
      msgDate     : get('msgDate'),
      relatedMsgId,
    };
  }

  // ── collection processing ─────────────────────────────────────────────────

  _processCollection(collKey, collValue, batches) {
    if (!collValue || typeof collValue !== 'object') return;

    const entityName = this._resolveEntity(collKey);
    if (!entityName) return; // unknown collection, skip silently

    const entity = this.ir.entities.get(entityName);
    if (!entity) return;

    // Collection value can be:
    //   - an object with a single child key (the record element name)
    //   - directly an array of records
    //   - a single record object

    let records = this._extractRecords(collValue, entityName);
    if (records.length === 0) return;

    if (!batches.has(entityName)) {
      batches.set(entityName, { insert: [], update: [], delete: [] });
    }
    const batch = batches.get(entityName);

    for (const xmlRecord of records) {
      const crud = (xmlRecord['@_crud'] ?? 'I').toUpperCase();
      const uid  = xmlRecord['@_uid'] ?? xmlRecord['@_id'] ?? null;

      if (crud === 'D') {
        if (uid) batch.delete.push(uid);
        continue;
      }

      const row = this._xmlRecordToRow(entity, xmlRecord);

      if (crud === 'U') {
        row._xmlUid = uid; // preserve for UPDATE WHERE uid = ?
        batch.update.push(row);
      } else {
        // 'I' or any other value → insert
        batch.insert.push(row);
      }
    }
  }

  _extractRecords(collValue, entityName) {
    // If it's already an array, we're done
    if (Array.isArray(collValue)) return collValue;

    // If it's an object, look for the singular child key
    if (typeof collValue === 'object') {
      const singular = _singularOf(entityName);
      // Try entityName and singular as child keys
      for (const key of [entityName, singular, ...Object.keys(collValue)]) {
        const child = collValue[key];
        if (child === undefined) continue;
        if (Array.isArray(child))          return child;
        if (typeof child === 'object')     return [child];
      }
    }
    return [];
  }

  // ── record → DB row ───────────────────────────────────────────────────────

  _xmlRecordToRow(entity, xmlRecord) {
    const row = {};

    for (const col of entity.columns) {
      // Never map surrogate PK or technical tracking cols from XML
      if (col.columnName === 'id')           continue;
      if (col.columnName.startsWith('_'))    continue;

      const raw = _readField(xmlRecord, col.name)
               ?? _readField(xmlRecord, col.columnName);

      if (raw === undefined) {
        row[col.columnName] = null;
        continue;
      }

      if (col.sqlType === 'LONGTEXT' && typeof raw === 'object') {
        // Store the nested XML subtree as JSON string (LONGTEXT column)
        row[col.columnName] = JSON.stringify(raw);
      } else {
        row[col.columnName] = _coerce(raw, col.sqlType);
      }
    }

    return row;
  }
}

// ─── standalone parse helper ──────────────────────────────────────────────────

const _xmlParser = new XMLParser({
  ignoreAttributes   : false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues         : true,
  isArray: (tag) => {
    // Collections and their records should always be arrays
    const bare = tag.includes(':') ? tag.split(':').pop() : tag;
    return PRIMARY_COLLECTIONS.has(bare);
  },
});

/**
 * Parse an XML string and deserialize it in one call.
 *
 * @param {string} xmlString
 * @param {object} ir          IR from IRBuilder.build()
 * @returns {{ msgMeta, batches }}
 */
function deserializeXML(xmlString, ir) {
  const parsed = _xmlParser.parse(xmlString);
  return new XMLDeserializer(ir).deserialize(parsed);
}

module.exports = { XMLDeserializer, deserializeXML, PRIMARY_COLLECTIONS };
```

---

## `src/db-adapter.js`

```javascript
'use strict';

/**
 * db-adapter.js
 *
 * Thin, IR-aware database layer built on top of knex.
 *
 * Responsibilities:
 *   - Insert / update / soft-delete individual rows
 *   - Persist a full deserialized message (batches) in a single transaction
 *   - Query rows for XML serialization (with optional delta filter)
 *   - Bump _msg_seq after a successful export
 *
 * The adapter is DB-agnostic: any knex-supported dialect works
 * (PostgreSQL recommended for production, SQLite for dev/test).
 *
 * Usage:
 *   const knex   = require('knex')({ client: 'pg', connection: { ... } });
 *   const db     = new DBAdapter(knex, ir);
 *
 *   // Persist a full deserialized message
 *   await db.persistMessage(batches, msgMeta);
 *
 *   // Query all rows for a given entity (for XML export)
 *   const rows = await db.queryEntity('task');
 *
 *   // Query only rows changed since msg seq 42 (delta / net-change)
 *   const rows = await db.queryEntity('task', { since: 42 });
 *
 *   // After export: mark rows as exported at this seq number
 *   await db.markExported(['task', 'breakdown'], currentSeq);
 */

// ─── constants ────────────────────────────────────────────────────────────────

const TECH_COLS = new Set([
  'id', '_created_at', '_updated_at', '_deleted_at', '_msg_seq',
]);

// ─── DBAdapter ────────────────────────────────────────────────────────────────

class DBAdapter {
  /**
   * @param {import('knex').Knex} knex  A configured knex instance.
   * @param {object}              ir    The IR returned by IRBuilder.build().
   */
  constructor(knex, ir) {
    this.knex = knex;
    this.ir   = ir;
  }

  // ── schema bootstrap ──────────────────────────────────────────────────────

  /**
   * Run the generated SQL DDL to create all tables.
   * Wraps each statement in a try/catch so it can be called on an existing DB
   * (tables that already exist are silently skipped).
   *
   * @param {string} ddlSQL  Full DDL from generateSQL(ir).
   */
  async applyDDL(ddlSQL) {
    const statements = ddlSQL
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await this.knex.raw(stmt + ';');
      } catch (err) {
        // Skip "already exists" errors — useful for idempotent migration
        if (!err.message.includes('already exists')) throw err;
      }
    }
  }

  // ── single-row operations ─────────────────────────────────────────────────

  /**
   * Insert a row into an entity table.
   *
   * @param {string} entityName  IR entity name (camelCase, e.g. 'task')
   * @param {object} row         Column → value map (no tech cols needed)
   * @param {object} [opts]
   * @param {object} [opts.trx]  Knex transaction object
   * @returns {object}  The inserted row (with generated id)
   */
  async insert(entityName, row, opts = {}) {
    const entity = this._entity(entityName);
    const clean  = this._stripTechCols(row);
    const now    = new Date();

    const payload = {
      ...clean,
      _created_at: now,
      _updated_at: now,
      _msg_seq   : 0,
    };

    const qb = (opts.trx ?? this.knex)(entity.tableName);
    const [inserted] = await qb.insert(payload).returning('*');
    return inserted;
  }

  /**
   * Update a row identified by its S3000L uid.
   *
   * @param {string} entityName
   * @param {string} uid          The S3000L uid attribute value
   * @param {object} row          Columns to update
   * @param {object} [opts]
   * @param {object} [opts.trx]
   * @returns {number}  Number of rows affected
   */
  async update(entityName, uid, row, opts = {}) {
    const entity = this._entity(entityName);
    const clean  = this._stripTechCols(row);

    const payload = {
      ...clean,
      _updated_at: new Date(),
    };

    const qb = (opts.trx ?? this.knex)(entity.tableName);
    return qb.where('uid', uid).whereNull('_deleted_at').update(payload);
  }

  /**
   * Soft-delete a row (sets _deleted_at, never hard deletes).
   *
   * @param {string} entityName
   * @param {string} uid
   * @param {object} [opts]
   * @param {object} [opts.trx]
   * @returns {number}  Number of rows affected
   */
  async softDelete(entityName, uid, opts = {}) {
    const entity = this._entity(entityName);
    const qb     = (opts.trx ?? this.knex)(entity.tableName);
    return qb.where('uid', uid).whereNull('_deleted_at').update({
      _deleted_at: new Date(),
      _updated_at: new Date(),
    });
  }

  // ── batch / message persistence ───────────────────────────────────────────

  /**
   * Persist a full deserialized message in a single DB transaction.
   *
   * @param {Map}    batches   Output of XMLDeserializer.deserialize().batches
   * @param {object} msgMeta   Output of XMLDeserializer.deserialize().msgMeta
   * @returns {{ inserted: number, updated: number, deleted: number }}
   */
  async persistMessage(batches, msgMeta) {
    let inserted = 0, updated = 0, deleted = 0;

    await this.knex.transaction(async (trx) => {
      // Optionally log the message header itself
      // (you could persist msgMeta to a messages_log table here)

      for (const [entityName, batch] of batches) {
        // INSERT
        for (const row of batch.insert) {
          await this.insert(entityName, row, { trx });
          inserted++;
        }

        // UPDATE
        for (const row of batch.update) {
          const uid = row._xmlUid;
          if (!uid) continue;
          const { _xmlUid, ...clean } = row; // eslint-disable-line no-unused-vars
          await this.update(entityName, uid, clean, { trx });
          updated++;
        }

        // SOFT DELETE
        for (const uid of batch.delete) {
          await this.softDelete(entityName, uid, { trx });
          deleted++;
        }
      }
    });

    return { inserted, updated, deleted };
  }

  // ── query for export ──────────────────────────────────────────────────────

  /**
   * Query all active rows for an entity, optionally filtered for delta export.
   *
   * @param {string} entityName
   * @param {object} [opts]
   * @param {number} [opts.since]       _msg_seq threshold for net-change export
   * @param {string} [opts.msgStatus]   Filter by status column if present
   * @returns {object[]}  Array of DB rows
   */
  async queryEntity(entityName, opts = {}) {
    const entity = this._entity(entityName);

    let qb = this.knex(entity.tableName).whereNull('_deleted_at');

    // Net-change: rows whose _msg_seq is less than or equal to the
    // *current* export sequence are "already exported".
    // We want rows modified AFTER the last export → _msg_seq > since
    if (opts.since !== undefined && opts.since !== null) {
      qb = qb.where('_msg_seq', '>', opts.since);
    }

    // Optionally filter by a status column (not all entities have one)
    if (opts.msgStatus) {
      const hasStatus = entity.columns.some(c => c.columnName === 'status');
      if (hasStatus) qb = qb.where('status', opts.msgStatus);
    }

    return qb.select('*');
  }

  /**
   * Query rows that were soft-deleted since a given _msg_seq.
   * These must be included in net-change exports with crud="D".
   *
   * @param {string} entityName
   * @param {number} since   _msg_seq baseline
   * @returns {object[]}
   */
  async queryDeleted(entityName, since) {
    const entity = this._entity(entityName);
    return this.knex(entity.tableName)
      .whereNotNull('_deleted_at')
      .where('_msg_seq', '>', since)
      .select('id', 'uid', '_deleted_at');
  }

  // ── post-export bookkeeping ───────────────────────────────────────────────

  /**
   * After a successful XML export, stamp all exported rows with the new
   * _msg_seq so they won't appear in the next net-change export.
   *
   * Call this ONLY after the XML file has been confirmed written/sent.
   *
   * @param {string[]} entityNames  Which entities were exported
   * @param {number}   newSeq       The sequence number of the just-written message
   */
  async markExported(entityNames, newSeq) {
    await this.knex.transaction(async (trx) => {
      for (const entityName of entityNames) {
        const entity = this._entity(entityName);
        await trx(entity.tableName)
          .where('_msg_seq', '<', newSeq)
          .whereNull('_deleted_at')
          .update({ _msg_seq: newSeq });
      }
    });
  }

  /**
   * Get the current maximum _msg_seq across all entities.
   * Use this to assign the sequence number of the next export.
   *
   * @returns {number}
   */
  async currentMaxSeq() {
    let max = 0;
    for (const [entityName] of this.ir.entities) {
      const entity = this.ir.entities.get(entityName);
      const hasSeq = entity.columns.some(c => c.columnName === '_msg_seq');
      if (!hasSeq) continue;
      const [row] = await this.knex(entity.tableName).max('_msg_seq as m');
      const v = Number(row?.m ?? 0);
      if (v > max) max = v;
    }
    return max;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _entity(name) {
    const e = this.ir.entities.get(name);
    if (!e) throw new Error(`Unknown entity in IR: "${name}"`);
    return e;
  }

  _stripTechCols(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (!TECH_COLS.has(k) && k !== '_xmlUid') out[k] = v;
    }
    return out;
  }
}

module.exports = { DBAdapter };
```

---

## `src/xml-serializer.js`

```javascript
'use strict';

/**
 * xml-serializer.js
 *
 * Reconstructs a valid S3000L lsaDataset XML message from DB rows.
 *
 * The serializer is the exact reverse of xml-deserializer.js:
 *
 *   DB rows  →  JS object tree  →  XML string
 *
 * It uses the IR to know:
 *   - Which columns map to XML attributes vs child elements
 *   - Which columns are JSONB (re-expanded as nested XML nodes)
 *   - Which entities belong in lsaPrimaryData vs lsaSupportingData
 *
 * The envelope nodes (lsaDataset, logisticsSupportAnalysisData,
 * lsaPrimaryData, lsaSupportingData) are never stored in the DB —
 * they are always reconstructed here.
 *
 * Output modes:
 *   B (Baseline)  — all active rows, crud="I" on every record
 *   U (NetChange) — only rows changed since last export seq,
 *                   with per-row crud="I"|"U"|"D"
 *
 * Usage:
 *   const { XMLSerializer } = require('./xml-serializer');
 *   const s = new XMLSerializer(ir, db);
 *
 *   const xml = await s.serialize({
 *     msgType  : 'B',        // 'B' | 'U'
 *     msgStatus: 'F',        // 'D' | 'P' | 'F'
 *     since    : null,       // for 'U': last _msg_seq value
 *     collections: null,     // null = all; or ['tasks', 'breakdowns']
 *     msgId    : 'MSG-001',
 *   });
 */

const { XMLBuilder } = require('fast-xml-parser');
const { PRIMARY_COLLECTIONS } = require('./xml-deserializer');

// ─── XML builder config ───────────────────────────────────────────────────────

function _makeBuilder() {
  return new XMLBuilder({
    ignoreAttributes  : false,
    attributeNamePrefix: '@_',
    format            : true,
    indentBy          : '  ',
    suppressEmptyNode : true,
  });
}

// ─── naming helpers ───────────────────────────────────────────────────────────

// snake_case → camelCase
const _toCamel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// camelCase entity name → plural collection key
// We just append 's'; caller can override with COLLECTION_OVERRIDES below.
const COLLECTION_OVERRIDES = {
  breakdownElement         : 'breakdownElements',
  productOperationalRoleKit: 'productOperationalRoleKits',
  facility                 : 'facilities',
  country                  : 'countries',
  trade                    : 'trades',
  skill                    : 'skills',
  contract                 : 'contracts',
  project                  : 'projects',
  document                 : 'documents',
  organization             : 'organizations',
  infrastructure           : 'infrastructures',
  substanceDefinition      : 'substanceDefinitions',
};

function _collectionKey(entityName) {
  return COLLECTION_OVERRIDES[entityName] ?? (entityName + 's');
}

// ─── row → XML node ───────────────────────────────────────────────────────────

/**
 * Convert a DB row back to an XML-ready JS object using the IR entity.
 *
 * S3000L convention:
 *   - uid and crud are XML *attributes* (@_ prefix)
 *   - All other columns become child elements
 *   - JSONB columns are re-expanded as nested object/array children
 *
 * @param {object} entity  IR entity
 * @param {object} row     DB row
 * @param {string} crud    'I' | 'U' | 'D'
 */
// Columns that are XML *attributes* in S3000L (not child elements)
const XML_ATTRIBUTE_COLS = new Set(['uid', 'uri', 'crud']);

function _rowToXmlNode(entity, row, crud) {
  const node = {
    '@_crud': crud,
  };

  // Write uid as XML attribute if present
  if (row.uid) node['@_uid'] = row.uid;
  if (row.uri) node['@_uri'] = row.uri;

  for (const col of entity.columns) {
    // Skip internal tech cols
    if (col.columnName === 'id')          continue;
    if (col.columnName.startsWith('_'))   continue;
    // Skip cols already written as attributes
    if (XML_ATTRIBUTE_COLS.has(col.columnName)) continue;

    const val = row[col.columnName];
    if (val === null || val === undefined) continue;

    const xmlKey = _toCamel(col.columnName);

    if (col.sqlType === 'LONGTEXT') {
      // Re-expand JSON string back into nested XML object
      try {
        node[xmlKey] = typeof val === 'string' ? JSON.parse(val) : val;
      } catch {
        node[xmlKey] = val; // fallback: leave as string
      }
    } else if (col.sqlType === 'TINYINT(1)') {
      node[xmlKey] = val ? 'true' : 'false';
    } else if (col.sqlType === 'LONGBLOB') {
      // Base64-encode binary back to XML
      node[xmlKey] = Buffer.isBuffer(val)
        ? val.toString('base64')
        : String(val);
    } else {
      node[xmlKey] = String(val);
    }
  }

  return node;
}

// ─── XMLSerializer ────────────────────────────────────────────────────────────

class XMLSerializer {
  /**
   * @param {object}    ir    IR from IRBuilder.build()
   * @param {DBAdapter} db    DBAdapter instance
   */
  constructor(ir, db) {
    this.ir      = ir;
    this.db      = db;
    this.builder = _makeBuilder();
  }

  // ── main entry point ──────────────────────────────────────────────────────

  /**
   * Serialize DB contents to a valid S3000L XML string.
   *
   * @param {object}   opts
   * @param {string}   opts.msgType       'B' | 'U'
   * @param {string}   opts.msgStatus     'D' | 'P' | 'F'
   * @param {number|null} opts.since      For 'U': last exported _msg_seq
   * @param {string[]|null} opts.collections  Null = all; or subset list
   * @param {string}   [opts.msgId]       Message identifier
   * @param {string}   [opts.relatedMsgId] For net-change: ref to baseline
   * @param {string}   [opts.sendingSystem]
   * @param {string}   [opts.receivingSystem]
   *
   * @returns {string}  Well-formed XML string
   */
  async serialize(opts = {}) {
    const {
      msgType        = 'B',
      msgStatus      = 'F',
      since          = null,
      collections    = null,
      msgId          = `MSG-${Date.now()}`,
      relatedMsgId   = null,
      sendingSystem  = null,
      receivingSystem= null,
    } = opts;

    // ── 1. Build lsaPrimaryData ───────────────────────────────────────────
    const primaryData   = await this._buildSection(
      PRIMARY_COLLECTIONS, msgType, since, collections
    );

    // ── 2. Build lsaSupportingData ────────────────────────────────────────
    const allEntityNames = new Set(this.ir.entities.keys());
    const supportingKeys = new Set(
      [...allEntityNames].filter(n => !PRIMARY_COLLECTIONS.has(n))
    );
    const supportingData = await this._buildSection(
      supportingKeys, msgType, since, collections
    );

    // ── 3. Build the envelope tree ────────────────────────────────────────
    const now     = new Date().toISOString();
    const msgDate = now.split('T')[0];

    const envelope = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      lsaDataset: {
        msgId    : msgId,
        msgDate  : msgDate,
        msgType  : { code: msgType },
        msgStatus: { code: msgStatus },

        // Optional header fields
        ...(sendingSystem   ? { msgPty: [
          { partyType: { code: 'SE' }, partyName: sendingSystem   },
          { partyType: { code: 'RE' }, partyName: receivingSystem ?? '' },
        ]} : {}),

        // Link to baseline for net-change messages
        ...(relatedMsgId ? {
          relatedMsg: {
            relType: { code: 'RM' },
            msgRef : relatedMsgId,
          },
        } : {}),

        logisticsSupportAnalysisData: {
          ...(Object.keys(primaryData).length > 0
            ? { lsaPrimaryData: primaryData }
            : {}),
          ...(Object.keys(supportingData).length > 0
            ? { lsaSupportingData: supportingData }
            : {}),
        },
      },
    };

    return this.builder.build(envelope);
  }

  // ── section builder ───────────────────────────────────────────────────────

  /**
   * Build a data section (primary or supporting) by querying each entity.
   *
   * @param {Set<string>}      entitySet
   * @param {string}           msgType    'B' | 'U'
   * @param {number|null}      since
   * @param {string[]|null}    filter     Allowed collection keys (null = all)
   * @returns {object}  Object whose keys are collection names
   */
  async _buildSection(entitySet, msgType, since, filter) {
    const section = {};

    for (const entityName of entitySet) {
      const collKey = _collectionKey(entityName);

      // Apply optional collection filter
      if (filter !== null && !filter.includes(collKey) && !filter.includes(entityName)) {
        continue;
      }

      if (!this.ir.entities.has(entityName)) continue;
      const entity = this.ir.entities.get(entityName);

      // ── Active rows ──────────────────────────────────────────────────────
      const queryOpts = msgType === 'U' && since !== null ? { since } : {};
      const rows = await this.db.queryEntity(entityName, queryOpts);

      // ── Deleted rows (net-change only) ────────────────────────────────
      let deletedRows = [];
      if (msgType === 'U' && since !== null) {
        deletedRows = await this.db.queryDeleted(entityName, since);
      }

      if (rows.length === 0 && deletedRows.length === 0) continue;

      // ── Map rows → XML nodes ─────────────────────────────────────────
      const xmlNodes = [
        ...rows.map(row => {
          // For baseline: always 'I'
          // For net-change: rows that existed before this export but changed
          // are 'U'; new rows are 'I'.  We use _created_at vs _updated_at
          // to distinguish new vs updated.
          let crud = 'I';
          if (msgType === 'U' && since !== null) {
            const created = row._created_at ? new Date(row._created_at) : null;
            const updated = row._updated_at ? new Date(row._updated_at) : null;
            if (created && updated && updated > created) crud = 'U';
          }
          return _rowToXmlNode(entity, row, crud);
        }),
        ...deletedRows.map(row => ({
          '@_crud': 'D',
          '@_uid' : row.uid,
        })),
      ];

      if (xmlNodes.length > 0) {
        // Nest nodes under the singular entity name inside the collection
        section[collKey] = { [entityName]: xmlNodes };
      }
    }

    return section;
  }
}

// ─── standalone serialize helper ─────────────────────────────────────────────

/**
 * One-shot convenience: serialize without constructing XMLSerializer manually.
 *
 * @param {object}    ir
 * @param {DBAdapter} db
 * @param {object}    opts  Same as XMLSerializer.serialize opts
 * @returns {Promise<string>}
 */
async function serializeToXML(ir, db, opts = {}) {
  return new XMLSerializer(ir, db).serialize(opts);
}

module.exports = { XMLSerializer, serializeToXML };
```

---
