# Review Ledger

Last updated: 2026-08-07
Reviewed baseline: `2949ad3` plus the REV-019/REV-020 working-tree changes

This file is the repository source of truth for review findings. Update it whenever a finding is opened,
changed, accepted, or resolved. Keep resolved findings for history instead of deleting them.

## Status and severity

- Status: `Open`, `In progress`, `Resolved`, `Accepted`, or `Invalid`.
- `P1`: blocks commit or causes a runtime/data-integrity failure.
- `P2`: correctness or output-contract issue that should be fixed before commit.
- `P3`: lower-risk maintainability, clarity, or coverage issue.

## Open findings

### REV-002 — Relation collision fallback can duplicate logical property names

- Status: `Open`
- Severity: `P2`
- Location: [`src/ir-relation-helpers.js`](src/ir-relation-helpers.js#L153)
- Downstream consumer: [`src/json-schema-generator.js`](src/json-schema-generator.js#L89)

`uniqueColumnName` makes the database `columnName` unique, but `oneToOneRelationColumn` derives the logical
`name` only from `fieldName`. When `foo_id` and `foo_relation_id` already exist, the next generated column is:

```json
{
  "name": "fooRelationId",
  "columnName": "foo_relation_2_id"
}
```

The logical name duplicates the existing `fooRelationId`. JSON Schema generation assigns properties through
`properties[col.name]`, so the later column can silently overwrite the earlier property.

Required resolution:

1. Make both `columnName` and `name` unique, preferably deriving the logical name from the final candidate or
   applying a separate logical-name allocator.
2. Add tests for the preferred-name collision, an existing `_relation_id`, numbered fallback, and
   case-insensitive collisions.

### REV-005 — S3000L Issue 1 section normalization loses the information required for serialization

- Status: `Open`
- Severity: `P1`
- Locations:
  [`src/s3000l-ir-metadata.js`](src/s3000l-ir-metadata.js#L6),
  [`src/xml-serializer.js`](src/xml-serializer.js#L257)

REV-017 now preserves the source dialect as `s3000lDialect`, but the collection metadata still converts
Issue 1 section names to Issue 2 names and the serializer does not consume the dialect. It always emits the
Issue 2 `lsaDataset` / `logisticsSupportAnalysisData` envelope, so an IR built from Issue 1 cannot be
serialized back as a schema-valid Issue 1 document.

Required resolution:

1. Extend the preserved S3000L dialect metadata with the actual section/envelope names needed for export.
2. Make serialization dialect-aware and validate generated Issue 1 XML against its schema.

### REV-006 — S3000L Issue 1 compatibility paths lack complete regression coverage

- Status: `In progress`
- Severity: `P2`
- Locations:
  [`test/rev-004-regressions.test.js`](test/rev-004-regressions.test.js),
  [`test/s3000l-ir-metadata.test.js`](test/s3000l-ir-metadata.test.js#L11)

The focused REV-004 suite now exercises Issue 1 real-IR construction, schema-valid product import,
`messageContentItems`/`supportingContentItems`, structural validation, metadata extraction, and the public
`version` result. Issue 1 export and a complete round trip remain uncovered and depend on REV-005's
dialect-preserving serializer work.

Required resolution:

1. Add Issue 1 XML export and round-trip coverage after REV-005 is resolved.
2. Keep the Issue 1 fixtures in the automated XSD 1.1 validation matrix.

### REV-007 — Configured dependency-audit gates currently fail

- Status: `Open`
- Severity: `P1`
- Location: [`package.json`](package.json#L11)

Both audit commands included in `npm run ci` currently exit with status 1. `npm audit --omit=optional`
reports high-severity `brace-expansion` and `js-yaml` advisories through the ESLint development toolchain.
The full `npm audit` additionally reports high-severity `ip-address` and critical `tar` advisories through
the optional `libxmljs2 -> node-gyp` installation toolchain. The required runtime dependency set is not
reported as vulnerable: `npm audit --omit=dev --omit=optional` passes with zero vulnerabilities.

Required resolution:

1. Refresh the affected development and optional dependency chains without changing runtime behavior.
2. Rerun both audit commands and the complete `npm run ci` gate.

### REV-009 — Structural validation accepts XML for the wrong selected schema version

- Status: `Open`
- Severity: `P1`
- Location: [`src/xml-validator.js`](src/xml-validator.js#L111)

Structural validation chooses its rules only from the XML root and never compares that dialect with
the supplied `xsdPath`. Consequently, Issue 1 XML validated against the Issue 2 XSD and Issue 2 XML
validated against the Issue 1 XSD both return `{ valid: true }` in structural mode. The same weakness
applies when normal validation falls back to the structural engine.

Required resolution:

1. Bind the expected root and envelope to the selected XSD or an explicit validated dialect option.
2. Add both cross-version rejection cases for explicit structural mode and fallback mode.

### REV-010 — Issue 1 structural checks reject schema-valid optional envelopes

- Status: `Open`
- Severity: `P2`
- Locations:
  [`src/xml-validator.js`](src/xml-validator.js#L129),
  [`s3000l/1_1/s3000l_1-1_lsa_dataset.xsd`](s3000l/1_1/s3000l_1-1_lsa_dataset.xsd#L39)

The structural validator requires both `msgId` and `msgContent` for Issue 1, while the bundled schema
declares both with `minOccurs="0"`. Xerces accepts a namespace-qualified empty `<lsaDataSet/>`, but the
structural engine rejects it as missing `msgId`.

Required resolution:

1. Match the Issue 1 schema's optionality, or explicitly define and document a stricter application-level
   validation policy separate from XSD validation.
2. Add schema-valid empty and partial-envelope tests.

### REV-014 — Semantic fingerprint manifest is stale

- Status: `Open`
- Severity: `P2`
- Location: [`manifest.json`](manifest.json#L31)

Fingerprint generation now succeeds, but its JSON output differs from `manifest.json`. The stored repository
semantic hash is `c7ed6cd8...`, while the REV-019/REV-020 source produces `72304cee...`; comparisons against the
checked-in manifest therefore report a change set that does not match the actual working tree.

Required resolution:

1. Regenerate `manifest.json` after the functional findings are resolved and the final source is stable.
2. Verify a fresh `semantic-fingerprint.js --json` run matches it byte-for-byte.

### REV-015 — XSD namespace stripping corrupts URI-valued attributes

- Status: `Open`
- Severity: `P2`
- Locations:
  [`src/xsd-parser.js`](src/xsd-parser.js#L57),
  [`s3000l/1_1/s3000l_1-1_lsa_dataset.xsd`](s3000l/1_1/s3000l_1-1_lsa_dataset.xsd#L7)

`deepStripNs` applies QName prefix stripping to every string value, including URI-valued attributes. Parsing
the Issue 1 schema changes its `targetNamespace` from
`http://www.asd-europe.org/s-series/s3000l` to `//www.asd-europe.org/s-series/s3000l` and corrupts the import
namespace identically. The latest `xsd-parser.js` diff is cosmetic, so this is a pre-existing defect exposed
by the new multi-version work.

Required resolution:

1. Strip prefixes only from attributes whose values are QNames; preserve namespace URIs and documentation.
2. Add tests proving `targetNamespace` and import namespaces remain exact while QName references still resolve.

### REV-016 — Invalid-root diagnostics omit the accepted Issue 1 root

- Status: `Open`
- Severity: `P3`
- Location: [`src/xml-validator.js`](src/xml-validator.js#L111)

The validator accepts both `lsaDataset` and `lsaDataSet`, but its invalid-root error still says only
`Expected root element <lsaDataset>`. The structural-check comment also describes only the Issue 2 root.

Required resolution:

1. Report both accepted roots, ideally with their dialects, and update the helper documentation.
2. Assert the diagnostic in a focused invalid-root test.

## Resolved and invalid findings

### REV-001 — One-to-one relation construction omitted `entity`

- Status: `Resolved`
- Severity: `P1`
- Location: [`src/ir-relation-helpers.js`](src/ir-relation-helpers.js#L92)
- Resolution: `addRelationToEntity` now passes `entity` to `oneToOneRelationColumn`.
- Evidence: `node --test test/ir-relation-helpers.test.js` passes all four focused tests.

### REV-003 — Foreign-key documentation contract and test disagreed

- Status: `Resolved`
- Severity: `P2`
- Locations:
  [`src/ir-relation-helpers.js`](src/ir-relation-helpers.js#L166),
  [`test/ir-relation-helpers.test.js`](test/ir-relation-helpers.test.js#L132)
- Resolution: the implementation and exact-shape test now consistently use the ASCII `FK -> target` form.
- Note: this intentionally changes generated IR, SQL comments, and JSON Schema descriptions from the former
  Unicode-arrow form.

### REV-004 — S3000L Issue 1 deserialization remains incomplete

- Status: `Resolved`
- Severity: `P1`
- Locations:
  [`src/s3000l-ir-metadata.js`](src/s3000l-ir-metadata.js#L1),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L243)
- Resolution: The Issue 1 fixture shapes covered by this finding import through their `msgContent`
  containers, metadata extraction follows the Issue 1 wrappers, and the deserializer enforces the
  dialect-specific envelope contract. A later schema-valid anonymous-wrapper gap, not exercised by those
  fixtures, is tracked and resolved separately by REV-018. REV-011 was invalidated by XSD validation;
  REV-012 and REV-013 are resolved.
- Evidence: `npm run test:rev-004` passes all 27 focused cases after validating all six fixtures against their
  actual XSD 1.1 schemas.

### REV-008 — XML deserializer contained invalid JavaScript and blocked CI

- Status: `Resolved`
- Severity: `P1`
- Location: [`src/xml-deserializer.js`](src/xml-deserializer.js#L163)
- Resolution: the bare `...` argument was removed and the full edit was brought back into lint compliance.
- Evidence: `npm run lint`, `npm run check`, and the full 57-test runnable suite now pass.

### REV-011 — Namespace-prefixed child elements are not normalized

- Status: `Invalid`
- Original severity: `P1`
- Locations reviewed:
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L82),
  [`src/xml-validator.js`](src/xml-validator.js#L109)
- Resolution: both bundled XSDs omit `elementFormDefault`, whose default is `unqualified`. Their global root
  must be namespace-qualified, while locally declared children such as `msgId` and `msgContent` must remain
  unqualified. Xerces rejects the former reproduction's fully prefixed children, so it was not a legal
  S3000L document and did not establish a deserializer data-loss defect.
- Evidence: the schema-valid prefixed-root fixtures for both dialects pass Xerces XSD 1.1 validation and the
  green REV-011 validation/import baselines in
  [`test/rev-004-regressions.test.js`](test/rev-004-regressions.test.js).

### REV-012 — Message metadata extraction does not match the schema wrapper shapes

- Status: `Resolved`
- Severity: `P2`
- Location: [`src/xml-deserializer.js`](src/xml-deserializer.js#L69)
- Resolution: metadata extraction is dialect-aware. Issue 1 reads `dateTime` and `code`; Issue 2 reads
  `date`, optional `time`, and `state`. Both retain scalar/`#text` compatibility, preserve nil values as
  null, and flatten schema-shaped related-message references to their ID, UID, or URI value.
- Evidence: all seven REV-012 cases pass against six Xerces-valid fixtures via
  `node --test --test-name-pattern='REV-012' test/rev-004-regressions.test.js`.

### REV-013 — Deserializer does not reject contradictory or invalid dialect envelopes

- Status: `Resolved`
- Severity: `P1`
- Location: [`src/xml-deserializer.js`](src/xml-deserializer.js#L560)
- Resolution: the exact root name now selects the dialect. The deserializer rejects foreign, missing, nil,
  or repeated content containers as required by that dialect. Issue 1 still accepts absent or explicitly nil
  `msgContent`, but requires both immediate content wrappers when a non-nil container is present.
- Evidence: all 18 focused REV-013 cases pass, covering both hybrid directions, both-container hybrids,
  missing/nil/repeated/text content, valid empty content, XSI aliases and lexical forms, foreign namespace
  rejection, false nil, and partial Issue 1 content.

### REV-017 — XML dialect is not checked against the IR schema dialect

- Status: `Resolved`
- Severity: `P1`
- Locations:
  [`src/s3000l-ir-metadata.js`](src/s3000l-ir-metadata.js#L29),
  [`src/ir-builder.js`](src/ir-builder.js#L155),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L255),
  [`index.js`](index.js#L65)
- Pre-fix evidence: both mismatch directions imported instead of failing. Issue 1 XML with an Issue 2 IR
  inserted `prod1` while filling Issue 2-only fields with nulls; Issue 2 XML with an Issue 1 IR likewise
  inserted `prod2` into the wrong model.
- Resolution: S3000L IRs now record `s3000lDialect` as `1.1` or `2.0`, derived from the schema's exact global
  root, and generated `ir.json` preserves that field. Deserialization compares it with the XML root dialect
  before metadata or collection processing and rejects mismatches. Generic and legacy/manual IR objects with
  absent or null dialect metadata remain intentionally unbound for compatibility.
- Evidence: `npm run test:rev-017` passes all seven focused cases after strict validation of both fixtures.
  Both same-dialect imports succeed, both mismatch directions fail before `_processCollection`, generic and
  legacy IR behavior remains compatible, and the CLI persistence check covers both generated dialects.
- Scope note: schema-selection checks in structural validation remain open under REV-009, and dialect-aware
  Issue 1 serialization remains open under REV-005.

### REV-018 — Anonymous S3000L wrappers become dangling UID-backed relations

- Status: `Resolved`
- Severity: `P1`
- Locations:
  [`src/ir-builder.js`](src/ir-builder.js#L520),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L392)
- Pre-fix evidence: Xerces XSD 1.1 accepted `tmp.xml`, but its import failed with
  `Cannot persist nested product.bkdns: child record has no uid`. The Issue 1 IR contained 500 relations
  to absent synthetic entities and Issue 2 contained four, including
  `product.bkdns -> ProductBkdns` and `productVariant.bkdns -> ProductVariantBkdns`; the anonymous wrappers
  have no UID even though their nested `bkdn` records do.
- Resolution: in S3000L mode, anonymous complex elements are emitted as inline `LONGTEXT` JSON element
  columns instead of relations to synthetic entities excluded by real-entity detection. Generic-XSD
  anonymous relations are unchanged, and genuine persisted relations retain their UID requirements.
  This intentionally replaces 504 dangling generated relations without changing a public API.
- Evidence: `npm run test:rev-018` passes all four focused cases after strict Xerces XSD 1.1 validation.
  Both bundled dialect IRs have zero absent relation targets; product and product-variant `bkdns` payloads
  retain their nested `bkdn` UIDs and genuine parentage. The existing genuine-relation missing-child-UID
  regression also passes.
- Scope note: Issue 1 serialization remains open under REV-005, the stale manifest under REV-014, and
  dependency audits under REV-007. The separate empty/nil phantom-record and genuine UID-less entity cases
  are tracked and resolved under REV-019 and REV-020.

### REV-019 — Empty mapped collections and explicitly nil relations create phantom records

- Status: `Resolved`
- Severity: `P1`
- Locations:
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L343),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L371),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L574)
- Pre-fix evidence: schema-valid empty mapped collections such as `<taskRequirements/>` fell through from
  collection metadata to plural-name lookup, so the parser's empty array sentinel became a synthetic
  `taskRequirement` insert with null `uid` and `tr_id`. An explicitly nil nested `maintLevel` similarly
  created an empty `allocatedMaintenanceLevel` record even though no record value was present.
- Resolution: mapped collection metadata is now authoritative even when it finds no records, and batches are
  created lazily only after a valid record survives validation. Nil detection resolves the XSI prefix through
  the full namespace ancestry for direct, nested, and flattened relations: a pure nil value is absence, a
  UID-bearing nil delete remains a delete operation, and nil-with-element-content is rejected rather than
  silently discarded.
- Evidence: the initial red run reported seven failures and two passes. A second expanded red audit caught
  eight failures and eight passes before the namespace, nil-delete, and nil-content hardening was complete.
  A final red audit caught two additional delete-routing regressions while 15 cases passed.
  `npm run test:rev-020` now passes all 17 focused cases after all four fixtures pass strict Xerces XSD 1.1
  validation, including a flattened UID-bearing nil delete with no phantom relation helper.

### REV-020 — Schema-valid UID-less S3000L records cannot satisfy the persistence contract

- Status: `Resolved`
- Severity: `P1`
- Locations:
  [`s3000l/1_1/s3000l_1-1_lsa_dataset.xsd`](s3000l/1_1/s3000l_1-1_lsa_dataset.xsd#L328),
  [`src/ir-builder.js`](src/ir-builder.js#L671),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L371),
  [`src/db-adapter.js`](src/db-adapter.js#L109),
  [`src/db-adapter.js`](src/db-adapter.js#L419)
- Pre-fix evidence: all 169 detected Issue 1 entities and all 187 detected Issue 2 entities declare their XSD
  `uid` attribute optional, while the generated database profile requires `uid NOT NULL`. A content-bearing,
  Xerces-valid Issue 1 `allocatedMaintenanceLevel` without `uid` was batched as a genuine child record and
  reached MariaDB, where the generated non-null constraint rejected it.
- Resolution: the project now makes its stricter persistence profile explicit. The deserializer rejects
  UID-less insert, update, and delete records required by the generated model before creating a batch, and
  the database adapter defensively enforces the same rule for direct insert, update, and delete calls.
  Message persistence preflights every required UID before opening a transaction. UID-bearing routing and
  generic or legacy entities whose IR does not require UID remain unchanged.
- Evidence: the initial combined red run reported seven failures and two passes. The second expanded red
  audit reported eight failures and eight passes before direct-operation and pre-transaction safeguards were
  complete. The final delete-routing red audit reported two failures and 15 passes before generic UID-less
  deletes returned to no-op behavior and flattened child deletes stopped creating relation helpers.
  `npm run test:rev-020` now passes all 17 focused cases after strict Xerces XSD 1.1 validation of all four
  fixtures.

## Verification snapshot

Current verification on 2026-08-07 supersedes the prior snapshot.

Passed:

- `npm run lint`
- `npm run check`
- `npm run test:generate`
- `npm run test:generate1_1`
- `npm run test:xsd11`
- `npm run test:xsd11:invalid`
- `npm run test:xsd11:assert-invalid`
- Semantic fingerprint generation completes successfully.
- Issue 1 schema parsing and metadata extraction: 169 direct entities, 37 collections, and the expected
  `product -> products.prod` mapping.
- Xerces XSD 1.1 compilation and validation of a namespace-qualified empty Issue 1 `<lsaDataSet/>`.
- Xerces XSD 1.1 validation of all six schema-valid REV-004 fixtures.
- Xerces XSD 1.1 validation of both schema-valid REV-017 cross-dialect fixtures.
- Xerces XSD 1.1 validation of the schema-valid REV-018 anonymous-wrapper fixture.
- Xerces XSD 1.1 validation of all four schema-valid REV-019/REV-020 fixtures.
- All seven focused REV-012 metadata tests pass, including date-only, date-time, status, related-message,
  complete-header, and nil-wrapper coverage.
- All 18 focused REV-013 envelope tests pass, including hybrid, required/nillable, multiplicity, and partial
  Issue 1 content cases.
- `npm run test:rev-004`: all 27 focused cases pass.
- `npm run test:rev-017`: all seven focused cases pass.
- `npm run test:rev-018`: all four focused cases pass.
- `npm run test:rev-020`: all 17 focused REV-019/REV-020 cases pass.
- Both S3000L dialects are preserved in memory and in generated `ir.json`; mismatched XML/IR dialects are
  rejected before collection processing while matching dialects still import.
- Both bundled S3000L IRs contain zero relations whose target entity is absent.
- The real `tmp.xml` passes strict Xerces validation, imports both `bkdns` subtrees, preserves the
  `productVariant` parent relation, and produces no phantom `taskRequirement` batch.
- Empty mapped collections and pure nil relations produce no phantom records. Namespace declarations are
  resolved through the full ancestry, UID-bearing nil deletes remain operations, and nil-with-content is
  rejected.
- Content-bearing UID-less records required by the generated database profile fail before batching. Direct
  insert/update/delete calls reject missing required UIDs before querying, and message persistence rejects
  them before opening a transaction.
- `npm test`: 112 passes, zero failures, and 4 expected MariaDB skips.
- `git diff --check`
- Every file relocated from `s3000l/` to `s3000l/2_0/` has the same Git blob hash as its baseline
  counterpart; no old-path references or files directly under `s3000l/` remain.
- `npm audit --omit=dev --omit=optional`: zero required-runtime vulnerabilities.

Failed:

- Fresh fingerprint JSON does not match `manifest.json`: semantic hash `72304cee...` versus
  `c7ed6cd8...`, and 186 stored functions versus 211 current functions.
- Both configured audit gates remain non-zero as recorded in REV-007.
- Cross-version structural-validation reproduction: both wrong-XSD combinations returned `valid: true`.
- Empty schema-valid Issue 1 envelope reproduction: falsely rejected as missing `msgId`.
- XSD parser reproduction: both the target namespace and imported namespace lost their `http:` scheme.

The targeted numbered-collision reproduction for REV-002 remains unresolved. REV-017 through REV-020 are
verified for their scoped focused checks. Unrelated validation/data-integrity findings, REV-014's stale
manifest, and REV-007's audit failures remain open; `npm run ci` remains non-zero at the configured audit
gates.

## Maintenance rules

1. Record new findings with a stable `REV-NNN` identifier, severity, evidence, and exact location.
2. Keep open findings above resolved findings and order each section by identifier.
3. When code changes, rerun the smallest reproducer plus proportionate repository checks.
4. Move fixed findings to `Resolved` only after verification; record the command or artifact used as evidence.
5. Record deliberate risk acceptance as `Accepted` with the reason and decision owner.
