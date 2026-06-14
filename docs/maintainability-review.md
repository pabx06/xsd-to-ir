# Maintainability Review: Post-Refactor Snapshot

Date: 2026-06-14

Scope: quick-win maintainability and simplification review after the safe
refactor pass. Public behavior remains unchanged: CLI commands, IR shape,
serializer/deserializer APIs, DB adapter API, and validation policy are still
the same.

## Resolved In This Pass

| Area | Result |
|---|---|
| Shared XML metadata | Added `src/s3000l-xml-metadata.js` for S3000L collection names, fallback collection naming, XML field kind/name lookup, XML field reads, and relation-column lookup. Serializer and deserializer now share the same metadata source while preserving their intentional import/export differences. |
| Assertion metadata | Added `src/xsd-assertion-metadata.js` for XSD assertion-set extraction, exactly-one classification, and persisted `LONGTEXT` assertion-path discovery. `IRBuilder` still returns the same `assertions` and `assertionPaths` `Map` shapes. |
| DB deferred relation resolution | Added `src/db-relation-resolver.js` and moved nested parent FK and one-to-one relation FK resolution out of `DBAdapter.persistMessage()`. Error messages still include entity/FK/UID context. |
| Test fixtures | Added `test/helpers/s3000l-fixtures.js` for repeated S3000L envelope and relationship-heavy XML fixtures. The tests still keep their assertions local. |
| Test coverage | Added metadata helper tests, assertion-path count regression checks, and DB negative tests for missing/unresolved parent and relation UIDs. |
| Tooling | Updated `npm run check` to syntax-check nested JS/CJS files under `src`, `test`, and `scripts`. |
| Archived snapshot | `xsd-to-ir-complete.md` remains explicitly stale and now points to `docs/developer-guide.md` plus live source files instead of acting as a source of truth. |

## Current Hotspots

Measured with `wc -l` on 2026-06-14. Line count is only a size signal, not a
quality score.

| File | Lines | Current responsibility |
|---|---:|---|
| `src/ir-builder.js` | 1198 | Still the largest hotspot: S3000L entity detection, collection extraction, particle/group traversal, relation construction, naming, and column synthesis. Assertion logic has been removed. |
| `src/xml-deserializer.js` | 453 | XML envelope traversal, record extraction, nested relation discovery, coercion, and assertion calls. Shared metadata has been removed from this file. |
| `src/xml-serializer.js` | 398 | XML envelope reconstruction, row-to-node conversion, relation traversal, and assertion calls. Shared metadata has been removed from this file. |
| `src/db-adapter.js` | 418 | Row operations, message persistence orchestration, query/export helpers, and export bookkeeping. Deferred relation resolution has been removed. |
| `test/s3000l-roundtrip.test.js` | 446 | Broad real-S3000L IR, serializer, deserializer, and relationship behavior coverage. |
| `test/mariadb-integration.test.js` | 369 | MariaDB DDL, lifecycle, and XML round-trip integration coverage. |

## Remaining Quick Wins

| Priority | Area | Change | Why |
|---|---|---|---|
| P1 | IR builder | Split S3000L collection extraction and uid+crud entity detection into a focused `s3000l-ir-metadata` helper. | This is now the cleanest next reduction in `ir-builder.js` without changing IR output. |
| P1 | IR builder | Extract group/choice/relation construction helpers from particle traversal. | Group handling and relation synthesis are intertwined; isolating them would make future relationship fixes less risky. |
| P2 | XML import/export | Consider small `xml-record-reader` and `xml-record-writer` helpers if serializer/deserializer grow again. | Metadata duplication is gone; the next complexity is traversal, not naming. |
| P2 | DB adapter | Split query/export read helpers from mutation/persistence helpers if DB behavior expands. | `DBAdapter` is smaller now, but it still owns both write orchestration and export queries. |
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
