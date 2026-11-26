#!/usr/bin/env node

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
 *   --ui-schema-id <url>   $id for the UI JSON Schema document
 *   --no-sql               Skip SQL DDL generation
 *   --no-json              Skip JSON Schema generation
 *   --no-ir                Skip IR JSON dump
 *   --no-typescript        Skip TypeScript declarations
 *   --pretty               Pretty-print all JSON output (default: true)
 *
 * Outputs (in <out>/):
 *   ir.json                The Intermediate Representation
 *   schema.sql             MariaDB CREATE TABLE DDL
 *   json-schema.json       JSON Schema draft-07 validator
 *   ui-json-schema.json    JSON Schema for clean UI values
 *   types.ts               Clean UI TypeScript types for this schema / issue
 *   xml-types.ts           XML-shaped TypeScript types for this schema / issue
 */

const fs = require('fs');
const path = require('path');

const { parseXSD } = require('./src/xsd-parser');
const { IRBuilder } = require('./src/ir-builder');
const { generateSQL } = require('./src/sql-generator');
const { generateJSONSchema } = require('./src/json-schema-generator');
const { generateUIJSONSchema } = require('./src/ui-json-schema');
const { generateTypeScript } = require('./src/typescript-generator');

// ─── arg parsing (no external dep) ───────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    xsdFile: null,
    out: './output',
    root: null,
    schemaId: 'https://example.com/generated-schema.json',
    uiSchemaId: 'https://example.com/generated-ui-schema.json',
    sql: true,
    json: true,
    ir: true,
    typescript: true,
    pretty: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') { opts.out = args[++i]; } else if (a === '--root') { opts.root = args[++i]; } else if (a === '--schema-id') { opts.schemaId = args[++i]; } else if (a === '--ui-schema-id') { opts.uiSchemaId = args[++i]; } else if (a === '--no-sql') { opts.sql = false; } else if (a === '--no-json') { opts.json = false; } else if (a === '--no-ir') { opts.ir = false; } else if (a === '--no-typescript') { opts.typescript = false; } else if (a === '--no-pretty') { opts.pretty = false; } else if (a === '--verbose') { opts.verbose = true; } else if (!a.startsWith('--')) { opts.xsdFile = a; }
  }
  return opts;
}

// ─── IR serialiser (Maps → plain objects) ────────────────────────────────────

function irToJSON(ir) {
  return {
    entities: Object.fromEntries(ir.entities),
    joinTables: Object.fromEntries(ir.joinTables),
    enums: Object.fromEntries(ir.enums),
    simpleTypes: Object.fromEntries(ir.simpleTypes),
    valueTypes: Object.fromEntries(ir.valueTypes || []),
    assertions: Object.fromEntries(ir.assertions),
    assertionPaths: Object.fromEntries(ir.assertionPaths),
    s3000lMode: !!ir.s3000lMode,
    s3000lDialect: ir.s3000lDialect ?? null,
    s3000lCollections: ir.s3000lCollections instanceof Map
      ? Object.fromEntries(ir.s3000lCollections)
      : (ir.s3000lCollections || {}),
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
  console.log(`✅  Parsed OK (${(schema.complexType || []).length} complexTypes merged)`);

  // ── build IR ───────────────────────────────────────────────────────────────
  console.log('\n🔨  Building Intermediate Representation…');
  const ir = new IRBuilder(schema).build();

  if (ir.s3000lMode) {
    console.log('   ✦  S3000L mode: filtering to uid+crud entities only');
  }

  const stats = {
    entities: ir.entities.size,
    joinTables: ir.joinTables.size,
    enums: ir.enums.size,
    simpleTypes: ir.simpleTypes.size,
    assertions: ir.assertions.size,
    assertionPaths: ir.assertionPaths.size,
    columns: [...ir.entities.values()].reduce((n, e) => n + e.columns.length, 0),
    relations: [...ir.entities.values()].reduce((n, e) => n + e.relations.length, 0),
  };

  console.log(`   Entities   : ${stats.entities}`);
  console.log(`   Columns    : ${stats.columns}`);
  console.log(`   Relations  : ${stats.relations}`);
  console.log(`   Join tables: ${stats.joinTables}`);
  console.log(`   Enums      : ${stats.enums}`);
  console.log(`   SimpleTypes: ${stats.simpleTypes}`);
  console.log(`   Assertions : ${stats.assertions}`);
  console.log(`   AssertPaths: ${stats.assertionPaths}`);

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
    const sql = generateSQL(ir);
    const sqlPath = path.join(outDir, 'schema.sql');
    fs.writeFileSync(sqlPath, sql, 'utf8');
    console.log(`✅  SQL DDL written     → ${sqlPath}`);
  }

  // ── write JSON Schema ──────────────────────────────────────────────────────
  if (opts.json) {
    const jsonSchema = generateJSONSchema(ir, { rootEntity: opts.root, schemaId: opts.schemaId });
    const jsonSchemaPath = path.join(outDir, 'json-schema.json');
    fs.writeFileSync(jsonSchemaPath, JSON.stringify(jsonSchema, null, indent), 'utf8');
    console.log(`✅  JSON Schema written → ${jsonSchemaPath}`);
    const uiJSONSchema = generateUIJSONSchema(ir, { rootEntity: opts.root, schemaId: opts.uiSchemaId });
    const uiJSONSchemaPath = path.join(outDir, 'ui-json-schema.json');
    fs.writeFileSync(uiJSONSchemaPath, JSON.stringify(uiJSONSchema, null, indent), 'utf8');
    console.log(`✅  UI JSON Schema written → ${uiJSONSchemaPath}`);
  }

  if (opts.typescript) {
    const typesPath = path.join(outDir, 'types.ts');
    fs.writeFileSync(typesPath, generateTypeScript(ir), 'utf8');
    console.log(`✅  TypeScript written  → ${typesPath}`);
    const xmlTypesPath = path.join(outDir, 'xml-types.ts');
    fs.writeFileSync(xmlTypesPath, generateTypeScript(ir, { representation: 'xml' }), 'utf8');
    console.log(`✅  XML TypeScript written → ${xmlTypesPath}`);
  }

  console.log('\n🎉  Done.\n');
}

main();
