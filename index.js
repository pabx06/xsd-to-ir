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