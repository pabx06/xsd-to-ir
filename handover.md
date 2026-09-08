# Project Handover Context Document
## XSD-to-IR Pipeline — S3000L LSA Tooling

> **Updated:** 2026-06-14  
> **Status:** Active development — hardened prototype, not production-ready yet  
> **Solo developer:** 1 person

Developer-facing docs:

- [Developer guide](docs/developer-guide.md) is the primary usage and integration guide.
- [S3000L IR guide](docs/s3000l-ir-guide.md) defines the IR contract and includes a tested database-backed product breakdown example.
- [Maintainability review](docs/maintainability-review.md) tracks quick-win simplification and refactor candidates.

This handover is current-state context and history. It is not the primary developer manual.

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
| R1 | The database schema must be **auto-generated from the XSD** — not hand-coded | The current Issue 2.0 XSD load has 915 merged `complexType` definitions; hand-coding is not feasible for one developer |
| R2 | The UI must be **generic by introspection** — like phpMyAdmin, not hand-coded screens | Same scale problem as R1 |
| R3 | XML export must be **structurally valid** against the S3000L XSD | Interoperability with client tools requires it |
| R4 | Support **two export modes**: Baseline (`B`) and Net Change (`U`) | S3000L protocol requirement |
| R5 | Target database: **MariaDB** | Project infrastructure constraint |
| R6 | Runtime: **Node.js** | Developer preference and tooling |
| R7 | **No hand-coded CRUD interfaces** for the ~187 uid+crud entities | One developer cannot maintain hundreds of forms |
| R8 | The 4–5 **business-critical views** (PBS tree, MTA composite, FMEA matrix, Dashboard) may be coded manually | These cannot be adequately represented as flat grids |

### What S3000L Is (Critical Context)

S3000L is **not a database schema**. It is an **XML message protocol** for exchanging LSA data between tools. Key insight that drove the entire architecture:

- The XSD root is `<lsaDataset>` — a **message envelope**, never persisted to DB
- `<logisticsSupportAnalysisData>`, `<lsaPrimaryData>`, `<lsaSupportingData>` are also **envelopes** — never persisted
- Only the **187 current `complexType` nodes that carry both `uid` and `crud` attributes** are direct S3000L record entities
- The IR currently contains **193 database entities**: those 187 direct record entities plus 6 synthetic helper entities generated to preserve repeating `xs:group` structures
- The remaining 728 `complexType` nodes are envelopes, value types, nested inline structures, or transport structures
- Every message has `msgType` (`B`=Baseline or `U`=NetChange) and per-record `crud` (`I`/`U`/`D`)
- Note: the complete XSD is available under [s3000l/2_0/s3000l_2-0_lsaDataset.xsd](s3000l/2_0/s3000l_2-0_lsaDataset.xsd)
---

## 2. Tech Stack

### Core Runtime

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js | ≥18 |
| Database | MariaDB | ≥10.4 |
| Package manager | npm | — |
| Linting | ESLint + Airbnb Base | ESLint 8 / `eslint-config-airbnb-base` |

### Dependencies

| Package | Role | Required? |
|---|---|---|
| `fast-xml-parser` | XSD/XML parse and XML build | **Hard** |
| `knex` | DB query builder (DB-agnostic) | **Hard** |
| `mysql2` | MariaDB driver for knex | Optional (needed at runtime) |
| `better-sqlite3` | SQLite driver — local dev/test only | Optional |
| `libxmljs2` | Full XSD 1.0 structural validation via native libxml2 | Optional (graceful fallback if absent; requires node-gyp / C++ toolchain) |
| `eslint`, `eslint-config-airbnb-base`, `eslint-plugin-import` | Airbnb-based JavaScript linting | Dev only |

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

- The XSD imports several sibling files (`valid_values.xsd`, etc.). The v1 parser only read the entry file, so only **1 enum** was detected instead of the current 192.
- All 915 current `complexType` nodes would be naively turned into tables, including envelope/wrapper types that should never be persisted.
- No distinction between XML attributes (`uid`, `crud`) and child elements — everything was treated as a column, causing structural errors.
- SQL output used PostgreSQL syntax (`BIGSERIAL`, `JSONB`, `DOUBLE PRECISION`, `BYTEA`) — incompatible with MariaDB.
- No separation of concerns: parse, model, and output were all in one function.

---

### Version 2 — IR + Multi-file Parser + PostgreSQL Target

**What it was:**  
A refactored pipeline with a proper Intermediate Representation (IR) separating parse → model → output. Added `xsd-parser.js`, `ir-builder.js`, `type-resolver.js`, `sql-generator.js`, `json-schema-generator.js`.

**Key architectural decisions made in v2:**

1. **IR as the single source of truth.** The IR is a `Map<entityName, { columns, relations, documentation }>` structure that all generators consume. Adding a new output format (JSON Schema, XML serializer) only requires a new consumer of the existing IR — not a re-parse.

2. **S3000L entity detection.** The IR builder scans all `complexType` nodes for the presence of both `uid` AND `crud` attributes. The current Issue 2.0 load has 187 such direct record entities. The final IR has 193 database entities because 6 additional synthetic helper entities are generated for repeating `xs:group` structures. Non-record complex types are otherwise skipped as envelopes, inlined as columns, or stored as JSON in `LONGTEXT`.

3. **xs:include / xs:import resolution.** The parser now recursively follows local `schemaLocation` references using a visited-set guard, merging all sibling XSD files into one schema object. This brings the current enum count from 1 to 192.

4. **choice_type deduplication.** When a `complexType` contained multiple `xs:choice` blocks, the discriminator column was being added multiple times. A guard was added.

**Why it still needed changes:**

- Target database was still PostgreSQL — incompatible with the MariaDB infrastructure requirement.
- No XML ingestion or export — the pipeline was one-directional (XSD → DDL only).
- `JSONB` / `BIGSERIAL` / `BYTEA` / `DOUBLE PRECISION` types were hard-coded throughout multiple files (ir-builder, type-resolver, sql-generator).

---

### Version 3 — MariaDB + Full Round-Trip XML↔DB (Current)

**What it is:**  
A bidirectional prototype with parser, IR, MariaDB DDL generation, structural XML validation, Java-backed XSD 1.1 acceptance validation, XML deserialization, DB persistence helpers, and XML serialization. The core paths now have automated tests, GitLab CI wiring, an opt-in Docker-backed MariaDB integration suite, and a relationship-heavy XML → MariaDB → XML fixture round-trip. Full production readiness still requires the first observed GitLab runner execution, broader negative import tests, a broader real-world S3000L XML acceptance corpus, and migration/delta cleanup.

**Key changes from v2 → v3:**

1. **MariaDB migration.** Generated DDL now targets MariaDB:

   | PostgreSQL | MariaDB |
   |---|---|
   | `BIGSERIAL` | `BIGINT AUTO_INCREMENT` |
   | `DOUBLE PRECISION` | `DOUBLE` |
   | `BYTEA` | `LONGBLOB` |
   | `JSONB` | `LONGTEXT` |
   | `DEFAULT NOW()` | `DEFAULT CURRENT_TIMESTAMP` |
   | `TIMESTAMP` | `DATETIME(3)` |

   DDL also gained `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, backtick identifiers, deterministic shortening for MariaDB's 64-character identifier limit, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `INSERT IGNORE`, and `SET FOREIGN_KEY_CHECKS`.

2. **XML ingestion (xml-deserializer.js).** Navigates the envelope hierarchy, extracts records from collections, reads per-record `crud` attribute, maps XML fields to DB columns via XSD-derived `xmlName` / `xmlKind` metadata, stores nested non-entity complex types as `LONGTEXT` (JSON string).

3. **DB adapter (db-adapter.js).** Thin knex layer providing `insert`, `update`, `softDelete`, `persistMessage` (transactional), `queryEntity` (with dirty-row filter), `queryDeleted`, `markExported`, `currentMaxSeq`.

4. **XML serialization (xml-serializer.js).** Reverse of deserializer for top-level S3000L collection records. It uses XSD-derived metadata such as `lsaPrimaryData.products.prod -> product` and per-column `xmlName` / `xmlKind`, maps rows back to XML nodes (with `@_crud`, `@_uid` as XML attributes), re-expands `LONGTEXT` JSON back into nested XML child nodes, and reconstructs envelope nodes from scratch.

5. **Validation.** `xml-validator.js` remains the lightweight in-process path: it uses `libxmljs2` for XSD 1.0 validation when available and usable, and falls back to `fast-xml-parser` well-formedness validation plus required-envelope checks when native validation is unavailable or the S3000L XSD 1.1 grammar is rejected by libxml. Full XSD 1.1 acceptance validation is now handled by `scripts/validate-xsd11.js`, which provisions pinned Xerces XSD 1.1 Java artifacts, verifies SHA-256 checksums, compiles `scripts/Xsd11Validator.java`, runs an `xs:assert` self-test, and validates the real S3000L Issue 2.0 schema through positive, schema-negative, and assertion-negative fixtures.

6. **XSD assertion inventory and inline enforcement.** The IR extracts the 200 `xsd:assert` rules in the Issue 2.0 schema. All current rules classify as an enforceable `exactlyOne` reference pattern, such as exactly one of `@uidRef`, a natural-key child element, or `@uriRef`. `assertion-validator.js` evaluates those rules, and import/export now apply them to direct asserted `LONGTEXT` inline objects, directly nested asserted child references, and bounded two-step recursive asserted paths under persisted inline value types.

7. **Delta / Net-Change support.** Each entity table carries a `_msg_seq BIGINT` column. `_msg_seq = 0` means dirty/unexported. `insert`, `update`, and `softDelete` mark rows dirty; `markExported()` stamps exported rows with the confirmed message sequence. Soft-deleted dirty rows are included in net-change exports with `crud="D"`.

8. **Database contract hardening.** Generated MariaDB DDL now enforces core S3000L persistence rules: `uid VARCHAR(255) NOT NULL`, one unique `uid` index per record table, `crud VARCHAR(64) NOT NULL DEFAULT 'I'` with valid-code `CHECK`, and `JSON_VALID(...)` checks for persisted `LONGTEXT` inline JSON columns.

9. **Nested relationship round-trip support.** Repeating real-entity relationships such as `product.prodVar`, `operationalTask.taskRev`, `taskRevision.taskJust`, and `maintenanceFacility.fcltyRel` now get generated parent FK columns. Import flattens nested XML records into child batches with parent markers, persistence resolves those markers to parent surrogate IDs inside one transaction, and export recursively reconstructs child XML under the correct parent element. Repeating `xs:group` choice helpers are handled as flattened branches; the current fixture covers `taskRevision.subtaskNonAbstractClasses -> subtByDef`.

10. **GitLab CI, linting, and validation gates.** `.gitlab-ci.yml` defines a `quality` job for Airbnb ESLint, syntax checks, unit tests, real S3000L generation, enforced Java-backed XSD 1.1 validation, and audits, plus a `mariadb` job using a `mariadb:10.11` service and `scripts/wait-for-mariadb.js` before running `npm run test:mariadb`.

---

## 4. Current Architecture (Version 3)

### Data Flow

```
                        ┌─────────────────────────┐
                        │   S3000L XSD (Issue 2.0) │
                        │  s3000l_2-0_lsaDataset   │
                        │  + valid_values.xsd + …  │
                        └────────────┬────────────┘
                                     │ xsd-parser.js
                                     │ (multi-file merge,
                                     │  namespace strip)
                                     ▼
                        ┌─────────────────────────┐
                        │   Raw Schema Object      │
                        │  915 complexTypes        │
                        │  192 enums merged        │
                        └────────────┬────────────┘
                                     │ ir-builder.js
                                     │ (S3000L mode:
                                     │  select uid+crud records,
                                     │  synthesize helper tables)
                                     ▼
                        ┌─────────────────────────┐
                        │   Intermediate Rep (IR)  │
                        │  187 uid+crud entities   │
                        │  193 total (+ synthetics)│
                        │  3,327 columns           │
                        │  192 enums               │
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
              │  385 tables  │   (knex)          │
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

### Entity Classification Criteria

The project uses two related but different meanings of “entity”:

1. **Direct S3000L record entity.** A named `complexType` is treated as a direct S3000L record entity only when it has both `uid` and `crud` attributes. These are the records that appear under S3000L collections and carry XML-level create/update/delete semantics. Current Issue 2.0 count: **187**.

2. **IR/database entity.** The IR includes every direct S3000L record entity plus any extra helper entity required to preserve relational cardinality. Current Issue 2.0 count: **193**.

The 6 current non-direct helper entities are synthetic tables created from repeating `xs:group` references:

| Synthetic helper entity | Why it exists |
|---|---|
| `DecisionTreeTemplateRevisionDecisionTreeTemplateActionDefinitionNonAbstractClasses` | Repeating decision-tree action-definition choice group under `decisionTreeTemplateRevision` |
| `InServiceOptimizationAnalysisRevisionInServiceOptimizationAnalysisStepNonAbstractClasses` | Repeating ISO analysis-step choice group under `inServiceOptimizationAnalysisRevision` |
| `LogicalANDEvaluationCriteriaNonAbstractClasses` | Repeating evaluation-criteria choice group under `logicalAND` |
| `LogicalOREvaluationCriteriaNonAbstractClasses` | Repeating evaluation-criteria choice group under `logicalOR` |
| `LogicalXOREvaluationCriteriaNonAbstractClasses` | Repeating evaluation-criteria choice group under `logicalXOR` |
| `TaskRevisionSubtaskNonAbstractClasses` | Repeating subtask choice group under `taskRevision` |

These synthetic entities are persistable database tables, but they are **not** top-level S3000L collection records and should not be counted as direct `uid`/`crud` record entities.

### The IR Entity Structure

Every entity in the IR has:

```javascript
{
  name       : 'organization',          // camelCase type name
  tableName  : 'organization',          // snake_case table name
  documentation: '...',                 // from XSD annotation
  columns    : [
    { name, columnName, xmlName, xmlKind, sqlType, jsonType, nullable,
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
    { fieldName, targetEntity, kind, parentColumn, nullable, minOccurs, maxOccurs }
  ],
}
```

**Rule:** Columns prefixed `_` are never written to or read from XML. They are purely technical.

Repeating nested S3000L record relationships use generated parent FK columns on the child table. Example: `product.prodVar` creates `product_variant.product_prod_var_parent_id -> product.id`; `operationalTask.taskRev` creates `task_revision.operational_task_task_rev_parent_id -> operational_task.id`.

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
| Which rows | All active (non-deleted) | Dirty active/deleted rows where `_msg_seq = 0` |
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
| `_msg_seq` | `BIGINT DEFAULT 0` | Dirty/export marker. `0` means unexported change; non-zero is the confirmed export sequence |

### DB Data Contract

| Rule | Enforcement |
|---|---|
| Direct S3000L records require `uid` | `uid VARCHAR(255) NOT NULL` |
| One row per `uid` per entity table | `CREATE UNIQUE INDEX ... ON table(uid)` |
| Missing `crud` becomes insert | `crud VARCHAR(64) NOT NULL DEFAULT 'I'` |
| Invalid `crud` is rejected | `CHECK (crud IN ('I', 'D', 'U', 'R', 'N'))` |
| Inline complex values stored in `LONGTEXT` must be JSON | `CHECK (JSON_VALID(column))`, nullable columns allow `NULL` |

---

## 5. Known Issues & Pending Tasks

### Known Issues

| # | Severity | Description |
|---|---|---|
| I1 | Low | **GitLab CI has been added but not yet observed on a real GitLab runner.** `.gitlab-ci.yml` defines mandatory quality and MariaDB service jobs. Local equivalent checks pass, including Docker-backed MariaDB, but the first remote GitLab pipeline may still expose runner-specific service startup or cache behavior. |
| I2 | Low | **`_updated_at` vs `_created_at` heuristic for net-change.** The serializer currently infers `crud="U"` vs `crud="I"` by comparing `_created_at` and `_updated_at`. This is fragile — a dedicated `_first_exported_at` column or explicit state tracking would be cleaner. |
| I3 | Low | **Circular FK handling is not generalized for arbitrary schemas.** The current S3000L Issue 2.0 generated DDL applies on MariaDB, but non-S3000L schemas with FK cycles may still require manual cycle breaking or deferred constraint strategy. |
| I4 | Medium | **Runtime XML validation and acceptance XML validation are separate.** `npm run test:xsd11` now performs real Java-backed XSD 1.1 validation against the S3000L schema and proves `xs:assert` enforcement with a negative fixture. The in-process `xml-validator.js` path is still intentionally lightweight: XSD 1.0 via `libxmljs2` when possible, otherwise well-formedness plus required-envelope checks. Decide later whether production imports should call the Java XSD 1.1 gate synchronously, asynchronously, or only in acceptance/CI. |

### Pending Tasks (Planned Next)

| Priority | Task |
|---|---|
| 🟡 Medium | **Observe first GitLab pipeline** — push the `.gitlab-ci.yml`, confirm the `quality` and `mariadb` jobs pass on the actual runner, then adjust service startup/cache settings if needed |
| 🟡 Medium | **Expand XSD 1.1 acceptance corpus** — add a representative generated net-change XML fixture after the exporter delta shape is stable |
| 🟡 Medium | **Broader negative import coverage** — add unresolved relationship-reference cases that require DB persistence, beyond the current deserializer-level parent/branch UID and shape checks |
| 🟢 Low | **Compact recursive type graph** — current assertion-path discovery is bounded to two-step recursive paths; revisit only if production data requires deeper local app-level assertion enforcement |
| 🟡 Medium | **knex migration file** — convert `schema.sql` output to version-controlled schema evolution |
| 🟢 Low | **Delta tracking improvement** — add `_first_exported_seq` to replace the `_created_at` vs `_updated_at` heuristic |

---

## 6. File Structure

```
xsd-to-ir/
│
├── docs/
│   ├── developer-guide.md       # Primary usage and integration guide
│   └── maintainability-review.md
│                                 # Quick-win maintainability/refactor backlog
│
├── .gitlab-ci.yml               # GitLab CI: quality job + MariaDB service integration job
│
├── .eslintrc.cjs                # ESLint config extending airbnb-base
│
├── package.json                  # deps: fast-xml-parser, knex
│                                 # optionalDeps: mysql2, better-sqlite3, libxmljs2
│                                 # devDeps: ESLint + Airbnb Base
│
├── index.js                      # CLI entry point
│                                 # node index.js <xsd> --out <dir> [--verbose]
│                                 # Outputs: ir.json, schema.sql, json-schema.json
│
├── scripts/
│   ├── start-mariadb-test.sh     # Local Docker MariaDB helper
│   ├── wait-for-mariadb.js       # CI/local readiness probe using mysql2
│   ├── validate-xsd11.js         # Provisions and runs Java-backed XSD 1.1 validation
│   └── Xsd11Validator.java       # JAXP validator using Xerces XMLSchema11Factory
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
│   │                             # Selects uid+crud record entities
│   │                             # Synthesizes helper entities for repeating groups
│   │                             # Inlines non-record complex values as LONGTEXT
│   │                             # Extracts S3000L collection metadata
│   │                             # Stores xsdType/xmlName/xmlKind on columns
│   │                             # Adds parent FK columns for nested one-to-many records
│   │                             # Adds _created_at, _updated_at, _deleted_at, _msg_seq
│   │                             # Resolves xs:group, xs:extension, xs:restriction
│   │                             # Deduplicates xs:choice discriminator columns
│   │
│   ├── sql-generator.js          # IR → MariaDB DDL
│   │                             # Topological sort for FK ordering
│   │                             # ENGINE=InnoDB, utf8mb4, backtick identifiers
│   │                             # Identifier shortening, IF NOT EXISTS, INSERT IGNORE
│   │                             # Index on _msg_seq per entity table
│   │                             # Unique uid indexes, crud checks, JSON_VALID checks
│   │
│   ├── json-schema-generator.js  # IR → JSON Schema draft-07
│   │                             # Skips _tech columns and surrogate PK
│   │
│   ├── assertion-validator.js    # Evaluates classified XSD assert rules
│   │                             # Supports S3000L exactly-one reference pattern
│   │                             # Walks direct asserted child paths under persisted inline types
│   │
│   ├── xml-validator.js          # XML string → validation result
│   │                             # libxmljs2 if available and usable (XSD 1.0)
│   │                             # Well-formedness + structural fallback for XSD 1.1 gaps
│   │                             # Returns { valid, errors[], engine, warnings? }
│   │
│   ├── xml-deserializer.js       # Parsed XML object → DB row batches
│   │                             # Navigates S3000L envelope hierarchy
│   │                             # Reads per-record crud attribute (I/U/D)
│   │                             # Maps XML fields → DB columns via IR
│   │                             # Flattens nested relationship records with parent markers
│   │                             # Flattens repeating xs:group branch records
│   │                             # LONGTEXT cols: stores nested XML as JSON string
│   │                             # Validates asserted inline values before storage
│   │                             # Returns { msgMeta, batches: Map<entity, {insert,update,delete}> }
│   │
│   ├── db-adapter.js             # DB layer (knex)
│   │                             # insert / update / softDelete (single row)
│   │                             # persistMessage (full batch, single transaction)
│   │                             # Deferred FK resolution for nested branch refs
│   │                             # queryEntity (with optional delta since filter)
│   │                             # queryRelated (nested child rows by generated parent FK)
│   │                             # queryById (one-to-one branch relation reconstruction)
│   │                             # queryDeleted (for net-change crud=D records)
│   │                             # markExported (stamp _msg_seq after export)
│   │                             # currentMaxSeq (next export sequence number)
│   │
│   └── xml-serializer.js         # DB rows → S3000L XML string
│                                 # Reconstructs all envelope nodes from scratch
│                                 # uid, crud → XML attributes (@_uid, @_crud)
│                                 # LONGTEXT cols → re-expanded as nested XML objects
│                                 # Recursively reconstructs nested relationship records
│                                 # Re-flattens synthetic xs:group helper rows to branch elements
│                                 # Validates asserted inline values before export
│                                 # Supports Baseline (B) and Net-Change (U) modes
│                                 # Selective export by collection name
│
└── test/
    ├── assertions.test.js        # XSD assert extraction and local evaluation
    ├── db-adapter.test.js        # Dirty/export marker behavior
    ├── mariadb-integration.test.js
    │                             # Opt-in MariaDB DDL replay, DB contract checks,
    │                             # DBAdapter lifecycle, and relationship-heavy XML round-trip
    ├── fixtures/
    │   ├── s3000l-minimal-valid.xml
    │   ├── xsd11-assert-smoke.xsd
    │   ├── xsd11-assert-valid.xml
    │   └── xsd11-assert-invalid.xml
    ├── s3000l-roundtrip.test.js  # Real Issue 2.0 collection, relation, and XML mapping
    └── xml-validator.test.js     # Sync/fallback validation behavior
```

---

## Appendix — Key Numbers

| Metric | Value |
|---|---|
| XSD complexType nodes (total) | 915 |
| XSD simpleType nodes (total) | 201 |
| Direct S3000L record entities (`uid`+`crud`) | 187 |
| Synthetic helper entities | 6 |
| Total IR/database entities | 193 |
| Non-record complexType nodes | 728 |
| Top-level S3000L collection record mappings | 42 |
| XSD 1.1 assert rules extracted | 200 |
| Assert rules classified as exactly-one references | 200 |
| Inline column types with assertion paths | 381 |
| Direct nested assert paths | 308 |
| Bounded recursive nested assert paths | 463 |
| Enums from valid_values.xsd | 192 |
| IR columns (all entities) | 3,327 |
| IR relations | 166 |
| MariaDB tables generated/applied | 385 |
| MariaDB DB contract checks | uid uniqueness, crud default/check, JSON_VALID |
| MariaDB XML fixture round-trip | product + prodVar, opTask + taskRev + taskJust + subtByDef, maintFclty + fcltyRel passing |
| Primary data collections | 5 |
| Supporting data collections | 26 |

Local Docker-backed MariaDB integration command:

```bash
npm run test:mariadb:docker
```

Current local CI-equivalent command:

```bash
npm run ci
```

ESLint-only commands:

```bash
npm run lint
npm run lint:fix
```

Real XSD 1.1 validation command:

```bash
npm run test:xsd11
```

`npm run test:xsd11` downloads pinned Xerces XSD 1.1 runtime jars into `.cache/xsd11`, verifies SHA-256 checksums, compiles the Java validator helper, rejects an intentional `xs:assert` violation fixture, and validates `test/fixtures/s3000l-minimal-valid.xml` against `s3000l/2_0/s3000l_2-0_lsaDataset.xsd`.

The local Docker-backed run used MariaDB 10.11 on `127.0.0.1:3307` and passed generated S3000L DDL apply/replay, DB contract rejection checks, `DBAdapter` insert/update/soft-delete/export lifecycle checks, and a relationship-heavy fixture covering product variants, task revisions with task justifications, a flattened `taskRevision.subtaskNonAbstractClasses -> subtByDef` helper branch, and maintenance-facility relationships. `npm run mariadb:stop` removes the local test container.

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

const ir = new IRBuilder(parseXSD('./s3000l/2_0/s3000l_2-0_lsaDataset.xsd')).build();
const db = new DBAdapter(knex, ir);
```

## Appendix — Full Round-Trip Example

```javascript
const { validateXML }    = require('./src/xml-validator');
const { deserializeXML } = require('./src/xml-deserializer');
const { serializeToXML } = require('./src/xml-serializer');

// 1. Validate incoming XML
await validateXML(xmlString, './s3000l/2_0/s3000l_2-0_lsaDataset.xsd');

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

// 4. Export Net-Change dirty rows after baseline sequence 5
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
