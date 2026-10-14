# xsd-to-ir Developer Guide

This guide is the starting point for developers using or integrating this
project. `handover.md` is project state and history; this file is the practical
usage guide.

For the complete IR data contract, construction rules, relation semantics, and
the tested Issue 1.1 database-backed product breakdown example, read the
[S3000L Intermediate Representation Developer Guide](s3000l-ir-guide.md).

## What This Tool Does

`xsd-to-ir` reads an XSD schema, builds an Intermediate Representation (IR),
and uses that IR to generate:

- MariaDB DDL in `schema.sql`
- JSON Schema in `json-schema.json`
- an IR dump in `ir.json`
- XML import/export behavior for S3000L messages

For the bundled S3000L Issue 2.0 schema, the tool treats only named
`complexType` definitions with both `uid` and `crud` attributes as direct
S3000L record entities. The current IR also includes synthetic helper entities
for repeating `xs:group` structures.

## Setup And Common Commands

Install dependencies:

```bash
npm ci
```

Generate IR, MariaDB DDL, and JSON Schema from the bundled S3000L schema:

```bash
node index.js s3000l/2_0/s3000l_2-0_lsaDataset.xsd --out output --verbose
```

Run the full local quality gate:

```bash
npm run ci
```

Run real XSD 1.1 validation against the bundled smoke XML fixture:

```bash
npm run test:xsd11
```

Run the negative XSD 1.1 acceptance check against a deliberately invalid
S3000L fixture:

```bash
npm run test:xsd11:invalid
```

Run the negative XSD 1.1 assertion check against a real S3000L `xs:assert`
fixture:

```bash
npm run test:xsd11:assert-invalid
```

Explore the generated IR for the bundled S3000L Issue 1.1 schema in a local
browser:

```bash
node scripts/visualize.js s3000l/1_1/s3000l_1-1_lsa_dataset.xsd --open
```

The viewer defaults to `127.0.0.1:4173` (use `--port 0` for an available
ephemeral port). It provides the S3000L primary/supporting-data hierarchy, a
searchable entity list, a focused one- or two-hop relationship graph, and
field-level XML/SQL/JSON metadata. JSON-backed columns expose their retained
complex-type structure through lazy expanders, including choices, occurrence,
nillability, constraints, documentation, and nested type references. It
displays schema metadata, not persisted project rows. The `visualize:1_1` npm
script launches the same bundled viewer.

Validate a custom XML instance against the S3000L XSD:

```bash
node scripts/validate-xsd11.js --xsd s3000l/2_0/s3000l_2-0_lsaDataset.xsd --xml path/to/file.xml
```

Run the Docker-backed MariaDB integration suite:

```bash
npm run test:mariadb:docker
```

Remove the local MariaDB test container:

```bash
npm run mariadb:stop
```

## Validation Model

In this project, "XSD validation" means validating an XML instance document
against an XSD schema. It does not mean validating that the XSD file itself is
well designed.

| Level | Command or module | What it checks | What it does not check |
|---|---|---|---|
| XML well-formedness | `fast-xml-parser` through `src/xml-validator.js` | XML syntax, one root element, closed tags | XSD types, order, occurrence rules, enums, `xs:assert` |
| Runtime lightweight validation | `validateXML()` / `validateXMLSync()` in `src/xml-validator.js` | Well-formedness, root `<lsaDataset>`, required envelope elements, optional `libxmljs2` XSD 1.0-style validation when available | Full S3000L XSD 1.1; `xs:assert` is not guaranteed here |
| App-level assertion subset | `src/assertion-validator.js` during import/export | Extracted S3000L exactly-one reference assertions for persisted inline values, direct nested asserted paths, and bounded two-step recursive asserted paths | Arbitrary XPath, unbounded recursion, full XSD 1.1 schema semantics |
| Real XSD 1.1 acceptance validation | `npm run test:xsd11`, `npm run test:xsd11:invalid`, `npm run test:xsd11:assert-invalid`, or `node scripts/validate-xsd11.js --xsd ... --xml ...` | XML against the real S3000L XSD using Java Xerces XSD 1.1, including order, occurrence, datatypes, enums, and `xs:assert` | It is an acceptance/CI gate by default, not automatically called by every runtime import |

Current policy: Java-backed XSD 1.1 validation is the source of truth for
acceptance and CI. Runtime import/export code remains lightweight unless a
caller explicitly runs `scripts/validate-xsd11.js`.

`scripts/validate-xsd11.js` downloads pinned Xerces XSD 1.1 runtime jars into
`.cache/xsd11`, verifies SHA-256 checksums, compiles
`scripts/Xsd11Validator.java`, runs an intentional `xs:assert` self-test, and
then validates the requested XML instance.

`scripts/expect-xsd11-failure.js` is the companion negative acceptance wrapper.
It passes only when the requested XML is rejected with a schema validation
error, so infrastructure failures such as a missing JDK do not masquerade as a
successful negative test.

The bundled negative fixtures cover two different acceptance boundaries:
`s3000l-minimal-invalid-missing-msg-id.xml` proves real-schema occurrence and
content rejection, while `s3000l-assert-invalid-organization-ref.xml` proves a
real S3000L `xs:assert` rejection.

## API Usage

Build an IR from an XSD:

```javascript
const { parseXSD } = require('./src/xsd-parser');
const { IRBuilder } = require('./src/ir-builder');

const schema = parseXSD('s3000l/2_0/s3000l_2-0_lsaDataset.xsd');
const ir = new IRBuilder(schema).build();
```

Complex values stored in JSON columns retain their XSD shape in
`ir.valueTypes`. Resolve a column through its exact `valueTypeRef`; anonymous
definitions use stable path keys, so `column.xsdType` is not a reliable lookup
key. Nested `TypeUse.valueTypeRef` values use the same registry. This metadata
does not add tables or change the generated MariaDB layout.

Generate MariaDB DDL and JSON Schema:

```javascript
const { generateSQL } = require('./src/sql-generator');
const { generateJSONSchema } = require('./src/json-schema-generator');

const ddl = generateSQL(ir);
const jsonSchema = generateJSONSchema(ir, {
  rootEntity: 'product',
  schemaId: 'https://example.com/s3000l-generated-schema.json',
});
```

The draft-07 output keeps entity schemas in the existing `$defs` namespace and
adds JSON-backed complex values under `definitions`. Value-type `$ref` values
use `#/definitions/<key>` with JSON Pointer escaping (`~` becomes `~0`, `/`
becomes `~1`). The generated shapes preserve representable choices and
assertions and annotate unsupported XSD semantics; use real XSD 1.1 validation
for complete instance acceptance.

Run lightweight runtime XML validation:

```javascript
const { validateXML } = require('./src/xml-validator');

await validateXML(xmlString, 's3000l/2_0/s3000l_2-0_lsaDataset.xsd');
```

Deserialize XML into DB batches:

```javascript
const { deserializeXML } = require('./src/xml-deserializer');

const { msgMeta, batches } = deserializeXML(xmlString, ir);
```

Persist batches with MariaDB/knex:

```javascript
const knex = require('knex')({
  client: 'mysql2',
  connection: process.env.MARIADB_URL,
});
const { DBAdapter } = require('./src/db-adapter');

const db = new DBAdapter(knex, ir);
await db.persistMessage(batches, msgMeta);
```

Serialize a baseline XML message:

```javascript
const { serializeToXML } = require('./src/xml-serializer');

const baselineXml = await serializeToXML(ir, db, {
  msgId: 'MSG-BASELINE-001',
  msgType: 'B',
  msgStatus: 'F',
});
```

The current serializer emits the Issue 2.0 envelope. Do not use it to deliver
Issue 1.1 XML. Issue 1.1 import and the database-backed read example are
supported; dialect-aware Issue 1.1 serialization remains open as `REV-005` in
`Review.md`.

Serialize a net-change XML message and mark rows exported after delivery is
confirmed:

```javascript
const deltaXml = await serializeToXML(ir, db, {
  msgId: 'MSG-DELTA-001',
  msgType: 'U',
  msgStatus: 'P',
  relatedMsgId: 'MSG-BASELINE-001',
  since: 5,
});

const nextSeq = (await db.currentMaxSeq()) + 1;
await db.markExported([...ir.entities.keys()], nextSeq);
```

## Generated Outputs

The CLI writes these files to the selected `--out` directory:

- `ir.json`: serialized IR for introspection and downstream tooling
- `schema.sql`: MariaDB DDL
- `json-schema.json`: JSON Schema draft-07 output

`output/` is ignored by git. Regenerate it when the XSD or generator behavior
changes.

JSON stored in an object-valued `LONGTEXT` column follows the XML parser form:
attributes are `@_<name>`, element text is `#text`, and repeatable elements
accept either a singleton value or an array. Older imports can contain coerced
numeric and boolean element text even for XSD string types. Value schemas accept
those stored scalars as well as strings; string enums retain their parsed equivalents.
String facets whose original spelling cannot be recovered are annotated with
`x-xsd-unsupported`. Attribute text stays a string. Particle nesting in
`ir.valueTypes` preserves choice-dependent requiredness: a required member of
one choice branch is required only when that branch is selected.

## JSON Representation Baseline

[`test/json-representation-baseline.test.js`](../test/json-representation-baseline.test.js)
tracks the importer, generated JSON Schema, and XML serializer against the
original assessment in commit `7df4826`. String preservation, schema support
for exact numeric strings, and typed XML child ordering are implemented.
Array/numeric normalization and TypeScript generation remain separate steps.

Run the baseline:

```bash
npm run test:json-baseline
```

The original strict command remains available and now runs the same passing assertions:

```bash
npm run test:json-baseline:strict
```

The original assessment had 51 tests: 29 passing checks and 22 failing
desired-behavior assertions across seven defect groups. **All 51 now pass with
no TODOs**: `JSON-001` through `JSON-007` are ordinary passing tests, included
in `npm test`. The original failures can still be reproduced at commit `7df4826`.

| Defect | Desired behavior tested | Current result |
| --- | --- | --- |
| `JSON-001` | Keep `prodId.id` strings `001234`, `1234.00`, `1234`, `true`, and `false` in both issues. | Fixed: new imports retain strings. |
| `JSON-002` | Preserve identifier spelling through XML import and record export in both issues. | Fixed: the original spelling survives. |
| `JSON-003` | Preserve boundary whitespace for `xs:string`. | Fixed: whitespace follows the XSD type and inherited `whiteSpace` facet. |
| `JSON-004` | Keep the string enum member `01` in JSON and exported XML. | Fixed: `01` remains a string and exports unchanged. |
| `JSON-005` | Preserve string simple content, including `#text`, alongside attributes. | Fixed: text remains a string with or without attributes. |
| `JSON-006` | Accept exact numeric values actually produced by import in generated JSON Schema. | Fixed: large integer and precise decimal strings pass the generated value schemas without conversion. |
| `JSON-007` | Export children in XSD sequence order independently of JSON property insertion order. | Fixed: typed JSON children follow the IR's particle order recursively, including `<id>` before `<class>` in both issues. |

The serializer follows `column.valueTypeRef` and nested type references to order
known children. XSD parsing preserves declaration order across interleaved
elements, choices, and groups in the value-type particles. Extension content
follows its base; restrictions use their own content. Choice branches are
selected from the present children and required members. This changes exported
child order without changing stored JSON, scalar
values, array item order, attributes, or explicit nil values. It works with both
JSON text columns and already decoded objects.

[`test/xml-value-order.test.js`](../test/xml-value-order.test.js) additionally
covers inheritance, named groups, overlapping choice branches, optional fields,
recursive types, and immutable inputs. Unknown keys retain their input slots.
Values without type metadata retain their property order. Mixed content retains
its direct child order; typed nested values can still be ordered. Repeated
compositors with multiple child names present also retain their direct order:
grouped object properties cannot recover interleaving such as `a, b, a, b` from
separate `a` and `b` arrays. Absent groups or groups with one present child name
still allow surrounding siblings to be ordered. Types that reuse the same
element name at distinct sequence positions retain their direct order for the
same reason. Full XSD
validation remains necessary; ordering does not validate scalar facets, wildcard
placement, or occurrence counts. Regenerate older IR artifacts to obtain the
corrected particle order.

The representation comparisons establish which choices need coordinated importer,
JSON Schema, and serializer changes:

| Comparison | XML effect | Reimport / validation effect |
| --- | --- | --- |
| Repeatable singleton object vs one-item array | Same XML for `prodId`, nested `bkdn`, and fixture primitive/complex repeats. | Single occurrences reimport as singletons; JSON array shape is not retained. |
| Multiple repeated values | Same values in the supplied order. | Reimport retains an array and its order. |
| Empty required array | No XML occurrence. | JSON Schema rejects it; serialization alone does not enforce minimum occurrences. |
| Empty optional array vs omission | Same XML absence. | The tested nested field's schema currently requires omission instead of `[]`; reimport omits the field. |
| Array on a non-repeatable field | Serializer still emits one or multiple occurrences. | JSON Schema rejects the array. Array normalization must respect multiplicity. |
| SQL `NULL` / missing column vs JSON text `"null"` / `{}` | SQL absence omits the element; parsed JSON null and empty object emit an empty element. | Neither spelling is a substitute for explicit `xsi:nil`. |
| Nested JSON null vs explicit nil object | Null emits an empty element; the nil object emits `xsi:nil` and preserves attributes. | The tested nested null fails JSON Schema; the explicit nil object passes and survives reimport. |
| Missing vs empty string | An absent child differs from a present empty child. | Empty string remains present when the type allows it. |
| Boolean `true`/`false` vs numeric `1`/`0` | Different XML spelling with equivalent XSD boolean meaning. | Both forms pass the current schema; canonical booleans would be a deliberate representation change. |
| Simple-content scalar vs `#text` object | Same XML text without attributes. | Attributes require the object form; tested text and attributes survive reimport. |
| Plain property vs `@_` property | Child element vs XML attribute. | Removing the prefix changes the XML meaning. Numeric/boolean-looking attribute text is already preserved as strings. |
| Encoded JSON column vs already decoded object | Same XML. | This is an existing serializer capability, not an automatic API decoding contract. |

Both bundled issue IRs are used for product identifiers, nested breakdowns,
multiplicity, nil, and element-order tests. A small
[`json-representation-baseline.xsd`](../test/fixtures/json-representation-baseline.xsd)
isolates whitespace, enums, simple content, numeric precision, booleans, and
empty values. Safe numbers and escaped/Unicode text provide positive controls.

The output oracle disables numeric/boolean parsing and whitespace trimming, so it
cannot hide a string loss by coercing both sides of a comparison. It ignores only
pretty-print indentation in containers with child elements. Leaf text and simple
content remain exact. Array checks distinguish XML equivalence from JSON shape
equality; they do not promise byte-identical original XML.

These tests use the public importer and serializer with in-memory database rows;
they do not assess MariaDB driver conversions. Issue 1.1 tests inspect exported
record fragments and explicitly put them back into the matching input fixture
envelope for reimport. **They do not certify Issue 1.1 whole-document export**:
the serializer still emits the Issue 2.0 envelope (`REV-005`). The Issue 2.0
whole-envelope test proves current importer/serializer compatibility, not full
XSD acceptance. Existing Java/Xerces acceptance checks remain necessary.

The importer reads XML text without automatic number/boolean conversion or
trimming. It then uses `ir.valueTypes` and scalar column constraints to normalize
known types: `xs:string` preserves whitespace, `xs:normalizedString` replaces XML
tabs/newlines with spaces, and `xs:token` collapses XML whitespace. Named
restrictions inherit or override these rules. NBSP is not XML whitespace. These
rules follow the [XSD whitespace definitions](https://www.w3.org/TR/xmlschema11-2/#rf-whiteSpace).

[`test/xml-string-preservation.test.js`](../test/xml-string-preservation.test.js)
also covers direct columns, recursive and inherited inline fields, simple-content
restrictions, attributes, and scalar simple-content export. Unknown types and
union values remain lexical because the importer cannot safely select a union
member without validating its facets. Numeric and boolean inline elements keep
the existing number/exact-string and boolean/numeric-spelling behavior; attributes
remain strings. Element-only indentation is discarded, while mixed text remains
present; preserving mixed-content order is not part of this fix.

Real-schema regressions also cover anonymous `xs:ID` restrictions on record UIDs:
stored IDs, update/delete keys, and relation references use the same normalized
value. Envelope dates, times, message IDs, and related-message references retain
their required whitespace normalization.

Generated JSON Schema still accepts legacy numeric/boolean values in string
locations, and singleton/array and nil representations are unchanged. This fix
applies to new imports and does not migrate existing rows. Already-lost identifier
spelling cannot be reconstructed from a number; repair requires original source
data. Decide the public JSON contract and migration strategy before tightening
schemas or normalizing arrays and numbers.

Numeric fields inside JSON columns accept JSON numbers and XML numeric strings.
`TypeUse.numericKind` distinguishes integer, decimal, float, and double, including
named restrictions. Integer strings reject decimal points and exponents; decimal
strings reject exponent notation and floating-point specials; float/double
strings allow scientific notation and XSD `INF`/`NaN` forms. Boundary XML
whitespace is accepted for lexical values retained by union types; malformed
values such as `1 2`, `0x10`, or an empty string are rejected.

Integer/decimal enums and fixed values compare exact values: leading `+`/zeros or
trailing decimal zeros can spell the same value, while rounded neighbors fail.
Unrepresentable constants and defaults remain strings. Raw declarations are
available as `x-xsd-enumeration` and `x-xsd-fixed`.

The number branch retains representable numeric bounds. Numeric keywords such as
`minimum` do not validate strings in [JSON Schema draft-07](https://json-schema.org/draft-07/draft-handrews-json-schema-validation-01#rfc.section.6.2).
String branches retain exact bounds and digit facets in `x-xsd-facets`, with an
`x-xsd-unsupported` warning on the owning definition; **these facets still require
XSD validation**, so lexical acceptance alone does not prove a value is in range.
Bounds that would round when serialized by this JavaScript generator are also
annotated and left to XSD validation. Alternate floating-point enum/fixed
spellings beyond those represented by the schema carry the same warning.
[`test/numeric-value-schema.test.js`](../test/numeric-value-schema.test.js) tests
these rules using standard Ajv without coercion after serializing the schema.
Import, database storage, and XML serialization are unchanged by this schema fix.

## Assertion Baseline

[`test/assertion-baseline.test.js`](../test/assertion-baseline.test.js) compares
generated JSON Schema and runtime assertion checks with independently specified
XSD 1.1 expectations. This assessment starts from `f17eee8` (the JSON-007 fix).
It adds tests and documentation; it does not change production assertion logic,
the IR shape, storage representation, or generated types.

```bash
npm run test:assertion-baseline
npm run test:assertion-baseline:xsd11
npm run test:assertion-baseline:strict
```

The normal baseline has **191 tests: 145 pass and 46 expected failures are
marked TODO**, across six gap groups. TODO tests execute their desired-behavior
assertions; they are not skipped. Strict mode removes those markers and exits
nonzero with the 46 failures. New failures outside the explicit TODO cases fail
the normal suite. When fixing a gap, remove its TODO markers and retain the tests.
The normal tests run in `npm test`; `npm run ci` also runs the required Java/Xerces
oracle. Strict mode is a diagnostic command until the gaps are fixed.

The oracle validates **64 cases: 35 against actual Issue 1.1/2.0 types and 29
against a small synthetic schema**. It uses the existing pinned, checksum-verified
Xerces runner, with its assertion self-test enabled on the first call. Missing
Java, schema compilation failures, wrong rejection reasons, and unrelated errors
in assertion-only negative cases fail the oracle command. Acceptance expectations
are written in the fixtures, not inferred from the current JSON Schema or runtime.

| Inventory | Issue 1.1 | Issue 2.0 |
| --- | ---: | ---: |
| Extracted assertion rules | 36 | 200 |
| Classified `exactlyOne` | 33 | 200 |
| Retained as `rawXPath` | 3 | 0 |
| Rule IDs referenced by emitted value definitions | 36 | 79 |
| Rule IDs outside those value definitions | 0 | 121 |

Classification counts are not enforcement coverage. The 121 Issue 2.0 rules
outside the emitted value definitions remain in `ir.assertions`; this inventory
does not establish that they should all be emitted, or that they are all missing
from runtime paths. The tests check that retained value-type assertion references
resolve and appear in JSON Schema annotations.

| Gap | Desired behavior | Observed result |
| --- | --- | --- |
| `ASSERT-001` | Enforce Issue 1.1 grouped presence alternatives in `conditionTypeValueReference`, `documentIssueReference`, and `documentReference`. | Runtime skips these three raw rules; JSON Schema annotates them but accepts the tested assertion violations. |
| `ASSERT-002` | Test XML node presence independently of its text value. | Runtime and JSON Schema reject valid empty elements/attributes and accept a tested invalid UID-plus-empty-element combination. An empty `organizationRef.uriRef` in Issue 2.0 is a real-schema example. |
| `ASSERT-003` | Validate each occurrence of a repeatable asserted value. | Direct arrays are checked as one reference object. Valid one-item arrays fail export; valid multi-item arrays fail import/export. Nested array controls work. |
| `ASSERT-004` | Enforce anonymous assertions using retained value-type metadata, including nested anonymous types. | Metadata and JSON Schema retain/enforce the tested rules, but runtime import/export miss them. A direct column's synthetic `xsdType` differs from its assertion-bearing `valueTypeRef`. |
| `ASSERT-005` | Apply inherited base assertions to derived values. | JSON Schema rejects the invalid derived reference; runtime import/export accept it. |
| `ASSERT-006` | Reach asserted values beyond two child steps and through recursive values. | Runtime misses the tested third-level and recursive-child violations; generated JSON Schema rejects them. Two-level controls work. |

The real-schema catalog distinguishes assertion validity from complete XSD
validity. For example, `(docId or dmc or pmc)` tests whether the group has a
member; the surrounding XSD choice enforces mutual exclusion. Likewise, an empty
code element exists for XPath but may violate its datatype. These cases must not
be mistaken for assertion failures. Positive controls include UID and identifier
alternatives, nil values, empty URI attributes, zero, false, singleton/array
forms, and valid inherited/recursive values.

A synthetic `lower le upper` comparison records the general XPath boundary:
Xerces rejects reversed bounds, while runtime reports the rule in `skipped` and
JSON Schema carries a `requires XSD validation` annotation. Runtime `valid: true`
with skipped rules proves only that the checked subset passed. Import/export do
not currently surface those skipped-rule notices. Arbitrary XPath translation is
not promised by the six reference-assertion fixes.

Real cases use wrapper schemas importing the bundled issue schema and apply
`xsi:type` to a probe. An ID anchor resolves UIDREFs so unrelated identity errors
cannot disguise an assertion failure. Synthetic cases exercise public
import/export with in-memory rows. The oracle checks the independently authored
input fragments; it does not certify complete S3000L messages, every assertion
path, MariaDB conversions, or Issue 1.1 whole-document export (`REV-005`).

Next, fix these gaps in small steps with the XSD oracle retained, decide which
unsupported rules remain explicitly XSD-only, then define the versioned public
JSON contract before implementing the TypeScript generator.

## MariaDB Notes

Generated DDL targets MariaDB and uses `mysql2` through knex. The Docker-backed
integration test uses MariaDB 10.11 by default. To point tests at an existing
database:

```bash
MARIADB_TEST_URL=mysql://xsd:xsdpass@127.0.0.1:3306/xsd_to_ir_test npm run test:mariadb
```

The DB adapter uses soft delete and export sequence markers:

- `_deleted_at` marks deleted rows.
- `_msg_seq = 0` means dirty or unexported.
- `markExported()` stamps exported rows with a confirmed message sequence.

## Source Of Truth

Use these files as source of truth:

- live code under `src/`
- package scripts in `package.json`
- this developer guide
- current refactor backlog in `docs/maintainability-review.md`
- project state and history in `handover.md`

Do not use `xsd-to-ir-complete.md` as a source of truth. It is an archived
snapshot and may be stale.
