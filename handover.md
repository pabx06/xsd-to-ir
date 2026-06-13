# Project Handover Context Document
## XSD-to-IR Pipeline — S3000L LSA Tooling

> **Generated:** 2026-06-13  
> **Status:** Active development — Version 3 (current)  
> **Solo developer:** 1 person

---

## 1. Project Overview & Core Requirements

### Ultimate Goal

Build a **lightweight, programmatic LSA (Logistic Support Analysis) data management tool** that is fully compliant with the **ASD S3000L Issue 2.0** standard (the international standard for LSA in aerospace and defence programmes). see [S3000L_Software_Compliance_Guidelines.md](./S3000L_Software_Compliance_Guidelines.md)

The tool must allow an engineer to:

1. **Ingest** S3000L XML messages from external tools (EAGLE, Smart-LI, etc.)
2. **Store** the LSA data in a relational database
3. **Edit** that data through a generic, auto-generated UI (no hand-coded CRUD screens) in a different project (angular front-end and nodejs backend) not in scope of the current tool, however it implies some requirement for the current toolling.
4. **Export** the data back as valid S3000L XML messages for delivery to clients or exchange with other tools

### Hard Requirements

| # | Requirement | Rationale |
|---|---|---|
| R1 | The database schema must be **auto-generated from the XSD** — not hand-coded | The XSD has 1,235 `complexType` definitions; hand-coding is not feasible for one developer |
| R2 | The UI must be **generic by introspection** — like phpMyAdmin, not hand-coded screens | Same scale problem as R1 |
| R3 | XML export must be **structurally valid** against the S3000L XSD | Interoperability with client tools requires it |
| R4 | Support **two export modes**: Baseline (`B`) and Net Change (`U`) | S3000L protocol requirement |
| R5 | Target database: **MariaDB** | Project infrastructure constraint |
| R6 | Runtime: **Node.js** | Developer preference and tooling |
| R7 | **No hand-coded CRUD interfaces** for the ~253 real entities | One developer cannot maintain hundreds of forms |
| R8 | The 4–5 **business-critical views** (PBS tree, MTA composite, FMEA matrix, Dashboard) may be coded manually | These cannot be adequately represented as flat grids |

### What S3000L Is (Critical Context)

S3000L is **not a database schema**. It is an **XML message protocol** for exchanging LSA data between tools. Key insight that drove the entire architecture:

- The XSD root is `<lsaDataset>` — a **message envelope**, never persisted to DB
- `<logisticsSupportAnalysisData>`, `<lsaPrimaryData>`, `<lsaSupportingData>` are also **envelopes** — never persisted
- Only the **253 `complexType` nodes that carry both `uid` and `crud` attributes** are real persistable entities
- The remaining 982 `complexType` nodes are envelopes, value types, or transport structures
- Every message has `msgType` (`B`=Baseline or `U`=NetChange) and per-record `crud` (`I`/`U`/`D`)
- Note: the complete XSD is availabe under [s3000l/s3000l_2-0_lsaDataset.xsd](s3000l/s3000l_2-0_lsaDataset.xsd)
---

## 2. Tech Stack

### Core Runtime

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js | ≥18 |
| Database | MariaDB | ≥10.4 |
| Package manager | npm | — |

### Dependencies

| Package | Role | Required? |
|---|---|---|
| `fast-xml-parser` | XSD/XML parse and XML build | **Hard** |
| `knex` | DB query builder (DB-agnostic) | **Hard** |
| `mysql2` | MariaDB driver for knex | Optional (needed at runtime) |
| `better-sqlite3` | SQLite driver — local dev/test only | Optional |
| `libxmljs2` | Full XSD 1.0 structural validation via native libxml2 | Optional (graceful fallback if absent; requires node-gyp / C++ toolchain) |

### Not Yet Integrated (Pending)

- A web UI framework (candidate: plain HTML + HTMX, or a minimal React SPA)
- An ORM or migration runner (knex migrations are sufficient)
- An authentication layer

---

## 3. Version Evolution

### Version 1 — Proof of Concept Parser

**What it was:**  
A single-file XSD parser that read the S3000L XSD into a raw JS object and attempted to generate a flat SQL DDL. No IR, no type resolution, no multi-file support.

**What worked:**  
Confirmed that `fast-xml-parser` could consume the XSD and that the top-level structure was navigable.

**Why it failed / what we changed:**

- The XSD imports several sibling files (`valid_values.xsd`, etc.). The v1 parser only read the entry file, so only **1 enum** was detected instead of 263.
- All 1,235 `complexType` nodes were naively turned into tables, producing ~1,400 entities including envelope/wrapper types that should never be persisted.
- No distinction between XML attributes (`uid`, `crud`) and child elements — everything was treated as a column, causing structural errors.
- SQL output used PostgreSQL syntax (`BIGSERIAL`, `JSONB`, `DOUBLE PRECISION`, `BYTEA`) — incompatible with MariaDB.
- No separation of concerns: parse, model, and output were all in one function.

---

### Version 2 — IR + Multi-file Parser + PostgreSQL Target

**What it was:**  
A refactored pipeline with a proper Intermediate Representation (IR) separating parse → model → output. Added `xsd-parser.js`, `ir-builder.js`, `type-resolver.js`, `sql-generator.js`, `json-schema-generator.js`.

**Key architectural decisions made in v2:**

1. **IR as the single source of truth.** The IR is a `Map<entityName, { columns, relations, documentation }>` structure that all generators consume. Adding a new output format (JSON Schema, XML serializer) only requires a new consumer of the existing IR — not a re-parse.

2. **S3000L entity detection.** The IR builder scans all `complexType` nodes for the presence of both `uid` AND `crud` attributes. Only those 253 types are materialised as DB tables. All others are either skipped or inlined as `JSONB` columns.

3. **xs:include / xs:import resolution.** The parser now recursively follows local `schemaLocation` references using a visited-set guard, merging all sibling XSD files into one schema object. This brought the enum count from 1 to 263.

4. **choice_type deduplication.** When a `complexType` contained multiple `xs:choice` blocks, the discriminator column was being added multiple times. A guard was added.

**Why it still needed changes:**

- Target database was still PostgreSQL — incompatible with the MariaDB infrastructure requirement.
- No XML ingestion or export — the pipeline was one-directional (XSD → DDL only).
- `JSONB` / `BIGSERIAL` / `BYTEA` / `DOUBLE PRECISION` types were hard-coded throughout multiple files (ir-builder, type-resolver, sql-generator).

---

### Version 3 — MariaDB + Full Round-Trip XML↔DB (Current)

**What it is:**  
The complete pipeline, now bidirectional. Added `xml-validator.js`, `xml-deserializer.js`, `db-adapter.js`, `xml-serializer.js`. Migrated all types to MariaDB dialect.

**Key changes from v2 → v3:**

1. **MariaDB migration.** All PostgreSQL-specific types replaced consistently across 5 files:

   | PostgreSQL | MariaDB |
   |---|---|
   | `BIGSERIAL` | `BIGINT AUTO_INCREMENT` |
   | `DOUBLE PRECISION` | `DOUBLE` |
   | `BYTEA` | `LONGBLOB` |
   | `JSONB` | `LONGTEXT` |
   | `DEFAULT NOW()` | `DEFAULT CURRENT_TIMESTAMP` |
   | `TIMESTAMP` | `DATETIME(3)` |

   DDL also gained `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, backtick identifiers, `CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`, `SET FOREIGN_KEY_CHECKS`.

2. **XML ingestion (xml-deserializer.js).** Navigates the envelope hierarchy, extracts records from collections, reads per-record `crud` attribute, maps XML fields to DB columns via the IR, stores nested non-entity complex types as `LONGTEXT` (JSON string).

3. **DB adapter (db-adapter.js).** Thin knex layer providing `insert`, `update`, `softDelete`, `persistMessage` (transactional), `queryEntity` (with delta filter), `queryDeleted`, `markExported`, `currentMaxSeq`.

4. **XML serialization (xml-serializer.js).** Reverse of deserializer. Queries rows from DB, maps them back to XML nodes (with `@_crud`, `@_uid` as XML attributes), re-expands `LONGTEXT` JSON back into nested XML child nodes, reconstructs all envelope nodes from scratch, builds valid XML string.

5. **Validation (xml-validator.js).** Uses `libxmljs2` for full XSD 1.0 validation when available; falls back to structural envelope check (well-formed XML + root `<lsaDataset>` + required header fields) when not.

6. **Delta / Net-Change support.** Each entity table carries a `_msg_seq BIGINT` column. On export: rows with `_msg_seq ≤ lastExport` are skipped. After a confirmed export: `markExported()` stamps all exported rows with the new sequence. Soft-deleted rows (non-null `_deleted_at`) are included in net-change exports with `crud="D"`.

---

## 4. Current Architecture (Version 3)

### Data Flow

```
                        ┌─────────────────────────┐
                        │   S3000L XSD (Issue 2.0) │
                        │  s3000l_3-0_lsaDataset   │
                        │  + valid_values.xsd + …  │
                        └────────────┬────────────┘
                                     │ xsd-parser.js
                                     │ (multi-file merge,
                                     │  namespace strip)
                                     ▼
                        ┌─────────────────────────┐
                        │   Raw Schema Object      │
                        │  1,235 complexTypes      │
                        │  263 enums merged        │
                        └────────────┬────────────┘
                                     │ ir-builder.js
                                     │ (S3000L mode:
                                     │  filter uid+crud only)
                                     ▼
                        ┌─────────────────────────┐
                        │   Intermediate Rep (IR)  │
                        │  253 real entities       │
                        │  261 total (+ synthetics)│
                        │  4,613 columns           │
                        │  263 enums               │
                        └──┬──────────┬────────────┘
                           │          │          │
              sql-generator│  json-   │  xml-    │
                           │  schema- │  serial- │
                           ▼  generator  izer.js │
              ┌──────────────┐  │            │   │
              │  MariaDB DDL │  ▼            │   │
              │  schema.sql  │ JSON          │   │
              └──────┬───────┘ Schema        │   │
                     │                       │   │
                     ▼                       │   │
              ┌──────────────┐               │   │
              │   MariaDB    │◄──────────────┘   │
              │   Database   │   db-adapter.js   │
              │  253 tables  │   (knex)          │
              └──────┬───────┘                   │
                     │                           │
    ┌────────────────┘               ┌───────────┘
    │  xml-deserializer.js           │  xml-serializer.js
    │                                │
    ▼                                ▼
┌──────────────┐            ┌──────────────────┐
│ Incoming XML │            │  Outgoing XML    │
│ S3000L msg   │            │  Baseline (B)    │
│  validated   │            │  Net-Change (U)  │
│  by          │            │  per-collection  │
│  xml-        │            │  selective       │
│  validator   │            └──────────────────┘
└──────────────┘
```

### The IR Entity Structure

Every entity in the IR has:

```javascript
{
  name       : 'organization',          // camelCase type name
  tableName  : 'organization',          // snake_case table name
  documentation: '...',                 // from XSD annotation
  columns    : [
    { name, columnName, sqlType, jsonType, nullable,
      isPrimaryKey, isForeignKey, referencesEntity,
      isEnum, enumRef, constraints, documentation },
    // ...
    // Technical columns added automatically in S3000L mode:
    { columnName: '_created_at', sqlType: 'DATETIME(3)' },
    { columnName: '_updated_at', sqlType: 'DATETIME(3)' },
    { columnName: '_deleted_at', sqlType: 'DATETIME(3)', nullable: true },
    { columnName: '_msg_seq',    sqlType: 'BIGINT' },
  ],
  relations  : [
    { fieldName, referencesEntity, kind: 'one'|'many', nullable }
  ],
}
```

**Rule:** Columns prefixed `_` are never written to or read from XML. They are purely technical.

### The Message Protocol

```
lsaDataset                     ← envelope (never persisted)
  msgId, msgDate
  msgType   { code: 'B'|'U' }  ← Baseline or Net-Change
  msgStatus { code: 'D'|'P'|'F' }
  relatedMsg { msgRef }         ← for Net-Change: ref to prior Baseline
  logisticsSupportAnalysisData  ← envelope (never persisted)
    lsaPrimaryData              ← envelope (never persisted)
      breakdownElements, parts, products,
      productOperationalRoleKits, taskRequirements, tasks
    lsaSupportingData           ← envelope (never persisted)
      organizations, maintenanceLevels, trades, skills,
      facilities, documents, … (33 collections)
```

Each record inside a collection carries `crud="I|U|D"` and `uid="..."` as XML attributes.

### Export Modes

| Parameter | `B` (Baseline) | `U` (Net-Change) |
|---|---|---|
| Which rows | All active (non-deleted) | Only rows where `_msg_seq > since` |
| Per-row `crud` | Always `I` | `I` if new, `U` if modified, `D` if deleted |
| `relatedMsgId` | Not required | Should reference the prior Baseline `msgId` |
| After export | `markExported(entities, newSeq)` | Same |

### DB Technical Columns

| Column | Type | Purpose |
|---|---|---|
| `id` | `BIGINT AUTO_INCREMENT PK` | Surrogate key — internal only, never in XML |
| `_created_at` | `DATETIME(3) DEFAULT CURRENT_TIMESTAMP` | Insert timestamp |
| `_updated_at` | `DATETIME(3) ON UPDATE CURRENT_TIMESTAMP` | Last-modified timestamp |
| `_deleted_at` | `DATETIME(3) NULL` | Soft-delete — `crud="D"` sets this; hard DELETE never used |
| `_msg_seq` | `BIGINT DEFAULT 0` | Sequence of last export — used to compute delta |

---

## 5. Known Issues & Pending Tasks

### Known Issues

| # | Severity | Description |
|---|---|---|
| I1 | Medium | **XML field mapping is best-effort.** The deserializer maps XML child element names to DB column names via the IR `col.name` (camelCase). The XSD uses abbreviated prefixes (e.g., `orgName` not `name`) — fields that don't match are silently stored as `null`. A field-alias map per entity would fix this properly. |
| I2 | Low | **`libxmljs2` is unavailable** in the current environment (no C++ build toolchain). The validator falls back to structural check only. Full XSD validation requires installing `libxmljs2` with `node-gyp`. |
| I3 | Low | **`_updated_at` vs `_created_at` heuristic for net-change.** The serializer currently infers `crud="U"` vs `crud="I"` by comparing `_created_at` and `_updated_at`. This is fragile — a dedicated `_first_exported_at` column or explicit state tracking would be cleaner. |
| I4 | Low | **Circular FK references.** The topological sort in `sql-generator.js` handles cycles by appending remainder entities, but FK constraints on cycle members will fail at DDL execution time. Affected tables need their FKs deferred or the cycle broken manually. |
| I5 | Low | **`task` entity not found by name lookup.** The XSD uses `taskAnalysisItem` not `task` as the primary task entity. Downstream code that looks up `ir.entities.get('task')` will get `undefined`. The correct entity name is `taskAnalysisItem`. |

### Pending Tasks (Planned Next)

| Priority | Task |
|---|---|
| 🔴 High | **Web UI shell** — minimal Express server + generic introspection-driven data grid (read IR from `ir.json` at startup, render table/form per entity) . Ui is in scope of another project|
| 🔴 High | **knex migration file** — convert `schema.sql` output to knex migration format for version-controlled schema evolution |
| 🟡 Medium | **PBS tree view** — custom arborist view for `breakdownElement` hierarchy (recursive self-referencing entity) |
| 🟡 Medium | **MTA composite view** — single-screen view assembling a `taskAnalysisItem` with its related resources, steps, and requirements |
| 🟡 Medium | **FMEA matrix view** — tabular view linking `lsaFailureMode` → effects → criticality → tasks |
| 🟡 Medium | **Field alias map** — per-entity mapping of XML element short-names to IR column names, fixing Issue I1 |
| 🟢 Low | **LSA Dashboard** — completion/coverage metrics across entity collections |
| 🟢 Low | **`libxmljs2` setup** — document the node-gyp setup for full XSD validation |
| 🟢 Low | **Delta tracking improvement** — add `_first_exported_seq` to replace the `_created_at` vs `_updated_at` heuristic |

---

## 6. File Structure

```
xsd-to-ir/
│
├── package.json                  # deps: fast-xml-parser, knex
│                                 # optionalDeps: mysql2, better-sqlite3, libxmljs2
│
├── index.js                      # CLI entry point
│                                 # node index.js <xsd> --out <dir> [--verbose]
│                                 # Outputs: ir.json, schema.sql, json-schema.json
│
├── src/
│   │
│   ├── xsd-parser.js             # XSD file → raw JS object
│   │                             # Handles xs:include / xs:import recursively
│   │                             # Strips all namespace prefixes
│   │                             # Guards against circular includes
│   │
│   ├── type-resolver.js          # XSD primitive type names → { sqlType, jsonType }
│   │                             # MariaDB dialect: DOUBLE, LONGBLOB, DATETIME(3)
│   │
│   ├── ir-builder.js             # Raw schema → IR (the core of the pipeline)
│   │                             # S3000L mode: auto-detected via uid+crud pattern
│   │                             # Filters to 253 real entities, inlines others as LONGTEXT
│   │                             # Adds _created_at, _updated_at, _deleted_at, _msg_seq
│   │                             # Resolves xs:group, xs:extension, xs:restriction
│   │                             # Deduplicates xs:choice discriminator columns
│   │
│   ├── sql-generator.js          # IR → MariaDB DDL
│   │                             # Topological sort for FK ordering
│   │                             # ENGINE=InnoDB, utf8mb4, backtick identifiers
│   │                             # IF NOT EXISTS, INSERT IGNORE
│   │                             # Index on _msg_seq per entity table
│   │
│   ├── json-schema-generator.js  # IR → JSON Schema draft-07
│   │                             # Skips _tech columns and surrogate PK
│   │
│   ├── xml-validator.js          # XML string → validation result
│   │                             # libxmljs2 if available (full XSD 1.0)
│   │                             # Structural fallback otherwise
│   │                             # Returns { valid, errors[], engine }
│   │
│   ├── xml-deserializer.js       # Parsed XML object → DB row batches
│   │                             # Navigates S3000L envelope hierarchy
│   │                             # Reads per-record crud attribute (I/U/D)
│   │                             # Maps XML fields → DB columns via IR
│   │                             # LONGTEXT cols: stores nested XML as JSON string
│   │                             # Returns { msgMeta, batches: Map<entity, {insert,update,delete}> }
│   │
│   ├── db-adapter.js             # DB layer (knex)
│   │                             # insert / update / softDelete (single row)
│   │                             # persistMessage (full batch, single transaction)
│   │                             # queryEntity (with optional delta since filter)
│   │                             # queryDeleted (for net-change crud=D records)
│   │                             # markExported (stamp _msg_seq after export)
│   │                             # currentMaxSeq (next export sequence number)
│   │
│   └── xml-serializer.js         # DB rows → S3000L XML string
│                                 # Reconstructs all envelope nodes from scratch
│                                 # uid, crud → XML attributes (@_uid, @_crud)
│                                 # LONGTEXT cols → re-expanded as nested XML objects
│                                 # Supports Baseline (B) and Net-Change (U) modes
│                                 # Selective export by collection name
│
└── test/
    ├── s3000l-sample.xsd         # Minimal S3000L-like XSD for unit testing
    └── group-test.xsd            # XSD with xs:group patterns for parser testing
```

---

## Appendix — Key Numbers

| Metric | Value |
|---|---|
| XSD complexType nodes (total) | 1,235 |
| Real S3000L entities (uid+crud) | 253 |
| Total IR entities (incl. synthetics) | 261 |
| Enums from valid_values.xsd | 263 |
| IR columns (all entities) | 4,613 |
| IR relations | 237 |
| Primary data collections | 6 |
| Supporting data collections | 33 |
| Total source lines | ~2,943 |

## Appendix — Knex Connection Example (MariaDB)

```javascript
const knex = require('knex')({
  client    : 'mysql2',           // MariaDB uses the mysql2 driver
  connection: {
    host    : 'localhost',
    port    : 3306,
    user    : 'lsa_user',
    password: 'secret',
    database: 'lsa_db',
    charset : 'utf8mb4',
  },
  pool: { min: 2, max: 10 },
});

const { DBAdapter }      = require('./src/db-adapter');
const { IRBuilder }      = require('./src/ir-builder');
const { parseXSD }       = require('./src/xsd-parser');

const ir = new IRBuilder(parseXSD('./s3000l_3-0_lsaDataset.xsd')).build();
const db = new DBAdapter(knex, ir);
```

## Appendix — Full Round-Trip Example

```javascript
const { validateXML }    = require('./src/xml-validator');
const { deserializeXML } = require('./src/xml-deserializer');
const { serializeToXML } = require('./src/xml-serializer');

// 1. Validate incoming XML
await validateXML(xmlString, './s3000l_3-0_lsaDataset.xsd');

// 2. Deserialize and persist
const { msgMeta, batches } = deserializeXML(xmlString, ir);
const stats = await db.persistMessage(batches, msgMeta);
console.log(`Persisted: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.deleted} deleted`);

// 3. Export full Baseline
const baseline = await serializeToXML(ir, db, {
  msgType  : 'B',
  msgStatus: 'F',
  msgId    : 'MSG-BASELINE-001',
});

// 4. Export Net-Change delta since sequence 5
const delta = await serializeToXML(ir, db, {
  msgType      : 'U',
  msgStatus    : 'P',
  since        : 5,
  relatedMsgId : 'MSG-BASELINE-001',
  msgId        : 'MSG-DELTA-002',
});

// 5. Mark rows as exported (call after file is confirmed written)
const newSeq = (await db.currentMaxSeq()) + 1;
await db.markExported([...ir.entities.keys()], newSeq);
```