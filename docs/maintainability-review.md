# Maintainability Review: Post-P2 IR Builder Snapshot

Date: 2026-06-14

Scope: maintainability state after the P1 `ir-builder.js` refactor and two P2
IR construction cleanups: element metadata and attribute metadata. Public
behavior remains unchanged: CLI commands, IR shape, serializer/deserializer
APIs, DB adapter API, and validation policy are still the same.

## Resolved In This Pass

| Area | Result |
|---|---|
| Baseline safety | Committed the verified production baseline before this refactor as `chore: harden s3000l production baseline`. |
| S3000L IR metadata | Added `src/s3000l-ir-metadata.js` for uid+crud entity detection and S3000L collection/record-name extraction. `IRBuilder` no longer owns the S3000L envelope discovery logic. |
| Relation/group metadata | Added `src/ir-relation-helpers.js` for choice discriminator columns, one-to-one FK columns, repeating parent FK columns, synthetic group entities, and flattened group relation metadata. Traversal remains in `IRBuilder`. |
| Element construction metadata | Added `src/ir-element-builders.js` for primitive, simple, inline complex, unknown, IDREFS, and repeated primitive element metadata. `_processElement()` now owns dispatch, while pure builders own output shape. |
| Attribute construction metadata | Added `src/ir-attribute-builders.js` for primitive, enum, and fallback attribute column metadata. `_processAttribute()` now owns S3000L/default/type dispatch, while the helper owns output shape. |
| Regression tests | Added focused tests for S3000L metadata detection/extraction, relation helper output, element builder output, and attribute builder output, including exact FK names, `choice_type`, synthetic group entity metadata, IDREFS join table names, inline `LONGTEXT` contracts, S3000L `uid`, `crud`, and enum attributes. |
| Comment policy | New code avoids textbook mechanics comments; existing comments are kept where they explain S3000L compatibility or XSD modelling decisions. |

## Current Hotspots

Measured with `wc -l` on 2026-06-14. Line count is a size signal, not a
quality score.

| File | Lines | Current responsibility |
|---|---:|---|
| `src/ir-builder.js` | 873 | Still the largest module: generic type/entity traversal, type-resolution dispatch, inheritance, and final IR assembly. |
| `src/xml-deserializer.js` | 453 | XML envelope traversal, record extraction, nested relation discovery, coercion, and assertion calls. |
| `src/db-adapter.js` | 418 | Row operations, message persistence orchestration, query/export helpers, and export bookkeeping. |
| `src/xml-serializer.js` | 398 | XML envelope reconstruction, row-to-node conversion, relation traversal, and assertion calls. |
| `src/ir-element-builders.js` | 229 | Pure element column/entity metadata builders extracted from `IRBuilder`. |
| `src/ir-relation-helpers.js` | 215 | Pure relation metadata builders extracted from `IRBuilder`. |
| `src/xsd-assertion-metadata.js` | 193 | XSD assertion extraction and direct persisted assertion-path discovery. |
| `src/s3000l-xml-metadata.js` | 168 | Shared serializer/deserializer XML naming and field metadata. |
| `src/s3000l-ir-metadata.js` | 109 | S3000L uid+crud detection and collection metadata extraction. |
| `src/ir-attribute-builders.js` | 58 | Pure attribute column metadata builder extracted from `IRBuilder`. |

## Remaining Quick Wins

| Priority | Area | Change | Why |
|---|---|---|---|
| P2 | IR builder | Move naming and column metadata helpers into a shared IR helper module if another IR refactor needs them. | Element, attribute, and relation helpers now receive the same injected helper set; centralising it would reduce wiring duplication without changing behavior. |
| P2 | IR builder | Consider extracting extension/inheritance column construction if inheritance behavior expands. | It is one of the remaining inline column-shape builders, but it is currently small and easier to read in place. |
| P2 | XML import/export | Consider small `xml-record-reader` and `xml-record-writer` helpers if serializer/deserializer grow again. | Shared metadata is already extracted; traversal complexity is the next likely duplication point. |
| P2 | DB adapter | Split query/export read helpers from mutation/persistence helpers if DB behavior expands. | The adapter still owns both write orchestration and export queries. |
| P2 | Validator docs/comments | Continue using precise wording: runtime lightweight validation is not full XSD 1.1 validation. | Prevents future developers from treating `xml-validator.js` fallback mode as schema acceptance. |

## Next Test Gaps

| Gap | Suggested test |
|---|---|
| Real invalid S3000L XSD 1.1 acceptance fixture | Add an S3000L-shaped invalid XML fixture that Java Xerces rejects against the real schema, beyond the synthetic `xs:assert` smoke fixture. |
| More relationship-heavy import negatives | Add XML fixtures for missing nested child UID during deserialization and unsupported branch shapes before persistence. |
| Net-change XML acceptance | Validate a generated net-change XML fixture with `npm run test:xsd11` or `scripts/validate-xsd11.js` once a representative delta fixture is stable. |
| Recursive assertion paths | Current app-level assertion enforcement covers direct asserted paths under persisted inline value types. Add tests before expanding to deeper recursive paths. |

## Non-Goals

- Do not redesign the IR schema during quick-win refactors.
- Do not make Java XSD 1.1 validation mandatory for every runtime import unless the production integration policy changes.
- Do not replace knex or MariaDB DDL generation as part of maintainability cleanup.
- Do not regenerate or hand-maintain `xsd-to-ir-complete.md` as canonical documentation.
