# Review Ledger

Last updated: 2026-08-07
Reviewed baseline: `55e49a9` plus the REV-018 working-tree changes

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

The new metadata mapping converts Issue 1 section names to Issue 2 names and does not retain the
source dialect. The serializer always emits the Issue 2 `lsaDataset` /
`logisticsSupportAnalysisData` envelope, so an IR built from Issue 1 cannot be serialized back as a
schema-valid Issue 1 document.

Required resolution:

1. Preserve the S3000L dialect and actual section/envelope names in IR metadata.
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
semantic hash is `c7ed6cd8...`, while the REV-018 source produces `17ab8486...`; comparisons against the
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

### REV-017 — XML dialect is not checked against the IR schema dialect

- Status: `Open`
- Severity: `P1`
- Locations:
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L92),
  [`src/xml-deserializer.js`](src/xml-deserializer.js#L163)

The detected XML version is returned but never compared with the IR supplied to the deserializer. A V1
document passed to an IR built from the V2 schema currently imports a `product` row and fills V2-only fields
with nulls. This can silently create incomplete cross-version data unless conversion is an explicit feature.

Required resolution:

1. Preserve the source dialect in IR metadata.
2. Reject XML/IR dialect mismatches, or implement an explicit, documented conversion mode with complete field
   mappings and tests.

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
  dependency audits under REV-007. The unrelated empty-container defect also remains:
  `<taskRequirements/>` creates one phantom `taskRequirement` insert with null `uid`/`tr_id`; REV-018 does
  not claim to fix it.

## Verification snapshot

Current verification on 2026-08-07 supersedes the prior snapshot.

Passed:

- `npm run lint`
- `npm run check`
- `npm run test:generate`
- `npm run test:xsd11`
- `npm run test:xsd11:invalid`
- `npm run test:xsd11:assert-invalid`
- Semantic fingerprint generation completes successfully.
- Issue 1 schema parsing and metadata extraction: 169 direct entities, 37 collections, and the expected
  `product -> products.prod` mapping.
- Xerces XSD 1.1 compilation and validation of a namespace-qualified empty Issue 1 `<lsaDataSet/>`.
- Xerces XSD 1.1 validation of all six schema-valid REV-004 fixtures.
- Xerces XSD 1.1 validation of the schema-valid REV-018 anonymous-wrapper fixture.
- All seven focused REV-012 metadata tests pass, including date-only, date-time, status, related-message,
  complete-header, and nil-wrapper coverage.
- All 18 focused REV-013 envelope tests pass, including hybrid, required/nillable, multiplicity, and partial
  Issue 1 content cases.
- `npm run test:rev-004`: all 27 focused cases pass.
- `npm run test:rev-018`: all four focused cases pass.
- Both bundled S3000L IRs contain zero relations whose target entity is absent.
- The real `tmp.xml` imports both `bkdns` subtrees and preserves the `productVariant` parent relation.
- `npm test`: 88 passes, zero failures, and 4 expected MariaDB skips.
- `git diff --check`
- Every file relocated from `s3000l/` to `s3000l/2_0/` has the same Git blob hash as its baseline
  counterpart; no old-path references or files directly under `s3000l/` remain.
- `npm audit --omit=dev --omit=optional`: zero required-runtime vulnerabilities.

Failed:

- Fresh fingerprint JSON does not match `manifest.json`: semantic hash `17ab8486...` versus
  `c7ed6cd8...`, and 186 stored functions versus 201 current functions.
- Both configured audit gates remain non-zero as recorded in REV-007.
- Cross-version structural-validation reproduction: both wrong-XSD combinations returned `valid: true`.
- Empty schema-valid Issue 1 envelope reproduction: falsely rejected as missing `msgId`.
- Cross-dialect reproduction: V1 XML imported into a V2 IR and populated V2-only fields with nulls.
- XSD parser reproduction: both the target namespace and imported namespace lost their `http:` scheme.
- The unrelated empty `<taskRequirements/>` container still creates one phantom `taskRequirement` insert
  with null `uid`/`tr_id`; REV-018 does not address it.

The targeted numbered-collision reproduction for REV-002 remains unresolved. REV-018 is verified for its
scoped change. Unrelated validation/data-integrity findings, REV-014's stale manifest, and REV-007's audit
failures remain open; `npm run ci` remains non-zero at the configured audit gates.

## Maintenance rules

1. Record new findings with a stable `REV-NNN` identifier, severity, evidence, and exact location.
2. Keep open findings above resolved findings and order each section by identifier.
3. When code changes, rerun the smallest reproducer plus proportionate repository checks.
4. Move fixed findings to `Resolved` only after verification; record the command or artifact used as evidence.
5. Record deliberate risk acceptance as `Accepted` with the reason and decision owner.
