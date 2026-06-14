# xsd-to-ir Developer Guide

This guide is the starting point for developers using or integrating this
project. `handover.md` is project state and history; this file is the practical
usage guide.

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
node index.js s3000l/s3000l_2-0_lsaDataset.xsd --out output --verbose
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

Validate a custom XML instance against the S3000L XSD:

```bash
node scripts/validate-xsd11.js --xsd s3000l/s3000l_2-0_lsaDataset.xsd --xml path/to/file.xml
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
| App-level assertion subset | `src/assertion-validator.js` during import/export | Extracted S3000L exactly-one reference assertions for persisted inline values and direct nested asserted paths | Arbitrary XPath, full XSD 1.1 schema semantics |
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

const schema = parseXSD('s3000l/s3000l_2-0_lsaDataset.xsd');
const ir = new IRBuilder(schema).build();
```

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

Run lightweight runtime XML validation:

```javascript
const { validateXML } = require('./src/xml-validator');

await validateXML(xmlString, 's3000l/s3000l_2-0_lsaDataset.xsd');
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
