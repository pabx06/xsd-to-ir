# S3000L Intermediate Representation Developer Guide

This guide explains how this repository builds and uses the S3000L
Intermediate Representation (IR). It targets a developer who has not worked
with this code before.

The worked example uses S3000L Issue 1.1. It reads persisted entities from
MariaDB and produces a hierarchical product breakdown. The executable example
is in
[`examples/issue-1.1-product-breakdown.js`](../examples/issue-1.1-product-breakdown.js).

## 1. What the IR is

The IR is schema metadata. It is not an S3000L message and it does not contain
project records.

The repository uses the IR as the shared contract between the XSD parser,
database generator, JSON Schema generator, XML import/export code, and schema
viewer:

```text
S3000L XSD and local imports
            |
            v
       parseXSD()
            |
            v
  merged JavaScript XSD tree
            |
            v
      IRBuilder.build()
            |
            v
   Map-based IR metadata
      |       |       |
      v       v       v
 MariaDB   JSON     XML import/export
   DDL    Schema    and visualization
```

Build the IR once for each supported issue. Cache it for the lifetime of the
application. Do not parse the XSD for each HTTP request.

## 2. Build an IR

Use the exact XSD entry point for the selected issue:

The local-module snippets in this guide assume the calling JavaScript file is
in the repository root. Adjust relative imports when the caller is elsewhere.

```javascript
const { parseXSD } = require('./src/xsd-parser');
const { IRBuilder } = require('./src/ir-builder');

const schema = parseXSD('s3000l/1_1/s3000l_1-1_lsa_dataset.xsd');
const ir = new IRBuilder(schema).build();

if (ir.s3000lDialect !== '1.1') {
  throw new Error(`Expected Issue 1.1, received ${ir.s3000lDialect}`);
}
```

Issue 2.0 uses this entry point:

```text
s3000l/2_0/s3000l_2-0_lsaDataset.xsd
```

`parseXSD()` performs these operations:

1. It reads the entry XSD.
2. It follows local `xs:include` and `xs:import` paths.
3. It prevents circular loading with a visited-path set.
4. It strips XSD namespace prefixes from schema node names and string values.
5. It merges named top-level definitions into one JavaScript object.

The current string-value stripping is broader than QName handling and can
change URI-valued attributes. This parser limitation is tracked as `REV-015`
in [`Review.md`](../Review.md).

`IRBuilder.build()` then resolves types and converts the merged XSD tree into
stable metadata for downstream consumers.

### Current module boundary

`lib.js` exports `parseXSD`, `IRBuilder`, `DBAdapter`, XML import/export, and
runtime validation. It does not currently export the SQL generator, JSON
Schema generator, or visualization model. Code inside this repository can use
the direct `src/` imports shown in this guide. A separately deployed backend
should use a versioned public package API after the package-boundary work in
[`docs/s3000l-crud-application-plan.md`](s3000l-crud-application-plan.md) is
complete.

The current bundled schemas produce these tested snapshots:

| Metric | Issue 1.1 | Issue 2.0 |
| --- | ---: | ---: |
| Direct `uid` + `crud` record entities | 169 | 187 |
| Total IR entities | 286 | 193 |
| Synthetic/helper entities | 117 | 6 |
| Columns | 2,632 | 3,331 |
| Relations | 299 | 162 |
| Top-level collection mappings | 37 | 42 |
| Enums | 149 | 192 |
| Restricted simple types | 24 | 4 |
| XSD assertion sets | 36 | 200 |
| Persisted assertion-path sets | 131 | 381 |

These values describe the current schemas and builder rules. Treat tests as the
contract if either schema or the builder changes.

### Generate inspectable files

Run the CLI when a plain JSON copy of the IR is easier to inspect:

```bash
node index.js s3000l/1_1/s3000l_1-1_lsa_dataset.xsd \
  --out output/issue-1.1 \
  --verbose
```

The command writes:

- `output/issue-1.1/ir.json`
- `output/issue-1.1/schema.sql`
- `output/issue-1.1/json-schema.json`

The live IR uses `Map` instances. `JSON.stringify(ir)` does not serialize their
entries. The CLI explicitly converts each `Map` to an object before writing
`ir.json`.

## 3. Top-level IR contract

`IRBuilder.build()` returns this shape:

```javascript
{
  entities: Map<string, IREntity>,
  joinTables: Map<string, IRJoinTable>,
  enums: Map<string, IREnum>,
  simpleTypes: Map<string, IRSimpleType>,
  assertions: Map<string, IRAssertionSet>,
  assertionPaths: Map<string, IRAssertionPathSet>,
  s3000lMode: true,
  s3000lDialect: '1.1',
  s3000lCollections: Map<string, S3000LCollectionMapping>,
}
```

### `entities`

The key is the XSD complex type name. The value describes one generated table,
its columns, and its outgoing relations.

### `joinTables`

This map describes generated link tables. The generic XSD path can create one
for `xs:IDREFS`. The current bundled S3000L IRs contain no join tables.

### `enums`

This map contains named XSD restrictions with enumeration values. The SQL
generator creates lookup tables for them. Columns also retain the allowed
values in `constraints.enum`.

### `simpleTypes`

This map contains named, non-enum XSD restrictions. Each entry records its SQL
type, JSON type, and supported facets such as length, range, and pattern.

### `assertions` and `assertionPaths`

`assertions` inventories named complex types that contain `xs:assert`.
Recognized exactly-one reference rules are marked as enforceable. Other XPath
rules remain raw metadata.

`assertionPaths` identifies asserted types nested inside persisted JSON
columns. The runtime assertion validator follows direct paths and paths up to
two elements deep. It is not a complete XPath or XSD 1.1 engine.

### `s3000lMode` and `s3000lDialect`

`s3000lMode` is true when the schema contains named record types with both
`uid` and `crud` attributes.

`s3000lDialect` is derived from the exact global root declaration:

| Root element | Dialect |
| --- | --- |
| `lsaDataSet` | `1.1` |
| `lsaDataset` | `2.0` |

The deserializer rejects XML whose root dialect does not match the IR.

### `s3000lCollections`

This map connects a direct record entity to its real S3000L envelope location.
For Issue 1.1, the product mapping is:

```javascript
ir.s3000lCollections.get('product');
// {
//   entityName: 'product',
//   section: 'lsaPrimaryData',
//   collectionName: 'products',
//   recordName: 'prod',
// }
```

`section` uses the normalized names `lsaPrimaryData` and
`lsaSupportingData` for both dialects. `collectionName` and `recordName`
preserve the actual XML names.

Nested entities such as `productVariant` do not need collection mappings. The
parent relation determines their XML and database location.

## 4. How XSD constructs become IR metadata

### Direct S3000L record entities

In S3000L mode, a named `xs:complexType` becomes a direct record entity only
when it defines both `uid` and `crud` attributes. Envelope and value types do
not become direct tables.

Each direct entity receives:

- a surrogate `id` primary key;
- `_created_at`, `_updated_at`, `_deleted_at`, and `_msg_seq` columns;
- XSD-derived columns and relations;
- a required database `uid` column;
- a required `crud` column with default `I`.

The XSD can declare `uid` as optional for transport cases. The generated
database model still requires `uid` for persisted direct records. The importer
rejects insert, update, and delete operations that cannot satisfy this rule.

### Primitive elements and attributes

A non-repeating primitive becomes a column. The type resolver maps XSD types to
SQL and JSON types. Examples include:

| XSD type | IR SQL type | JSON type |
| --- | --- | --- |
| `string` | `TEXT` | `string` |
| `ID` | `VARCHAR` | `string` |
| `integer` | `INTEGER` | `integer` |
| `decimal` | `DECIMAL` | `number` |
| `boolean` | `BOOLEAN` | `boolean` |
| `date` | `DATE` | `string` |
| `dateTime` | `DATETIME(3)` | `string` |
| `base64Binary` | `LONGBLOB` | `string` |

A repeating primitive becomes a synthetic child entity with a `value` column
and a foreign key to its parent. This preserves multiplicity. It does not
guarantee source order because the helper has no explicit position column.

### Named simple types and enums

A named restriction with enumeration values becomes an entry in `ir.enums`.
A named restriction without enumeration values becomes an entry in
`ir.simpleTypes`.

The column keeps the resolved type and supported constraints. UI code can use
this metadata to choose a control and validate input.

### Nested complex types

The S3000L builder applies two different rules:

1. A nested named type with both `uid` and `crud` becomes a relation to another
   entity.
2. A named value type without those attributes, or an anonymous wrapper, stays
   in the parent row as JSON stored in `LONGTEXT`.

The second rule is important. Many business values are structured objects, not
plain strings. For example, an Issue 1.1 product identifier is stored as:

```json
{"id":"PRODUCT-1"}
```

The `product.prod_id` MariaDB column contains that JSON text. XML export expands
the object back into nested XML elements.

### `xs:choice`

Choice branches become nullable columns or relations. When a type has more
than one named branch, the builder adds an internal `choice_type` discriminator
where required. Repeating choice groups can produce synthetic helper entities.

### `xs:group`

A non-repeating group is flattened into its owner. A repeating group becomes a
synthetic child entity and a relation with `flattened: true`. XML serialization
removes the synthetic database wrapper and writes the original branch elements.

### `xs:extension`

The entity records the base type in `parentType`. The builder adds a foreign
key column to the base entity when that base is also materialized. JSON Schema
generation represents the inheritance with `allOf`.

## 5. Entity and column contracts

An entity has this shape:

```javascript
{
  name: 'product',
  tableName: 'product',
  abstract: false,
  parentType: null,
  documentation: null,
  columns: [],
  relations: [],
}
```

Do not derive a table name from the entity name in application code. Read
`entity.tableName`. The builder shortens long database identifiers with a hash
so every generated identifier fits MariaDB's 64-character limit.

### Column names

Every column can have three different names:

| Property | Purpose | Example |
| --- | --- | --- |
| `name` | Logical JavaScript and generated JSON Schema name | `prodId` |
| `columnName` | Exact MariaDB column name | `prod_id` |
| `xmlName` | Exact, case-sensitive XML name | `prodId` |

Always use `columnName` for database rows. Always use `xmlName` and `xmlKind`
for XML. Do not assume that case conversion can reconstruct either name.

### Column shape

```javascript
{
  name: 'prodId',
  columnName: 'prod_id',
  xmlName: 'prodId',
  xmlKind: 'element',
  sqlType: 'LONGTEXT',
  jsonType: 'object',
  nullable: false,
  defaultValue: null,
  isPrimaryKey: false,
  isForeignKey: false,
  referencesEntity: null,
  isEnum: false,
  enumRef: null,
  constraints: {},
  documentation: '...',
  xsdType: 'productIdentifier',
  minOccurs: 1,
  maxOccurs: 'unbounded',
}
```

`xmlKind` has these meanings:

| Value | Meaning |
| --- | --- |
| `element` | Read or write an XML child element. |
| `attribute` | Read or write an XML attribute. |
| `relation` | Store a one-to-one database foreign key. The relation serializer writes the child record. |
| `internal` | Database-only metadata. Never write it to XML. |

### Technical columns

| Column | Purpose |
| --- | --- |
| `id` | Surrogate database primary key. It is never an S3000L identifier. |
| `uid` | S3000L record identity. Use it for record update/delete and XML references. |
| `crud` | Imported transport action. Inserts default to `I`. Export logic calculates the outgoing action. |
| `_created_at` | Insert timestamp. |
| `_updated_at` | Last update timestamp. |
| `_deleted_at` | Soft-delete marker. `DBAdapter` excludes these rows from active queries. |
| `_msg_seq` | Export marker. `0` means dirty or not yet confirmed as exported. |

Never expose `id` as a stable external identifier. It is specific to one
database. Use `uid` at API boundaries.

### JSON-backed columns

When `sqlType === 'LONGTEXT'` and `jsonType === 'object'`, the database value is
JSON text. Parse it before using it:

```javascript
const productId = JSON.parse(productRow.prod_id);
console.log(productId.id);
```

Preserve the XML parser representation:

- attributes use the `@_` prefix, such as `@_uidRef`;
- repeated XML elements use arrays;
- one occurrence can be an object rather than a one-element array;
- element text can use `#text` when attributes are also present.

Use a helper that accepts both one object and an array. The worked example uses
`asArray()` for this reason.

## 6. Relation contract

An entity's `relations` array describes outgoing structural relations. Do not
infer a relation from table names.

### One-to-many

The child table contains the foreign key. `parentColumn` is the exact child
column to query.

Issue 1.1 product example:

```javascript
const product = ir.entities.get('product');
const relation = product.relations.find((item) => item.fieldName === 'prodVar');

// relation is:
// {
//   kind: 'one-to-many',
//   fieldName: 'prodVar',
//   targetEntity: 'productVariant',
//   parentColumn: 'product_prod_var_parent_id',
//   nullable: true,
//   minOccurs: 0,
//   maxOccurs: 'unbounded',
// }

const products = await db.queryEntity('product');
const variants = await db.queryRelated(
  relation.targetEntity,
  relation.parentColumn,
  products[0].id,
);
```

The generated database edge is:

```text
product_variant.product_prod_var_parent_id -> product.id
```

Use `relation.parentColumn`. Do not hard-code the generated foreign-key name in
production application logic.

### One-to-one

A one-to-one relation stores a foreign key on the source row. Its relation has
`parentColumn: null`. Find the corresponding source column whose
`xmlKind === 'relation'` and whose `referencesEntity` matches the target. The
serializer uses that column and `DBAdapter.queryById()` to load the child.

### Flattened repeating groups

A relation with `flattened: true` points to a synthetic helper table. The
helper preserves a repeated XSD group or choice. It is a storage mechanism, not
a top-level business record. Generic UIs should label it as a helper and should
not offer it as an independent top-level collection.

### Incoming relations

The base IR stores outgoing relations only. Find incoming relations by scanning
all entities, or use `buildVisualizationModel()`, which creates
`incomingByEntity` and `outgoingByEntity` indexes.

### Occurrence and nullability

Use all three fields:

- `minOccurs` and `maxOccurs` describe XSD cardinality;
- `nullable` includes optionality introduced by an enclosing `xs:choice`;
- `maxOccurs` can be the string `unbounded`.

Do not use `kind` alone to decide whether a UI field is required.

## 7. Collections and envelope versions

An S3000L message contains transport metadata and data sections. Those envelope
types are not database entities.

| Concern | Issue 1.1 | Issue 2.0 |
| --- | --- | --- |
| Root | `lsaDataSet` | `lsaDataset` |
| Content wrapper | `msgContent` | `logisticsSupportAnalysisData` |
| Primary section | `messageContentItems` | `lsaPrimaryData` |
| Supporting section | `supportingContentItems` | `lsaSupportingData` |

`deserializeXML()` supports both input dialects and checks them against
`ir.s3000lDialect`.

The current serializer emits the Issue 2.0 envelope. It does not yet emit a
schema-valid Issue 1.1 envelope. Do not call `serializeToXML()` with an Issue
1.1 IR for a delivery. This limitation is tracked as `REV-005` in
[`Review.md`](../Review.md).

## 8. Generate and use the database

Generate MariaDB DDL from the IR:

```javascript
const { generateSQL } = require('./src/sql-generator');

const ddl = generateSQL(ir);
```

Apply it with the IR-aware adapter:

```javascript
const knex = require('knex')({
  client: 'mysql2',
  connection: process.env.MARIADB_URL,
});
const { DBAdapter } = require('./src/db-adapter');

const db = new DBAdapter(knex, ir);
await db.applyDDL(ddl);
```

### Import flow

Use this order for an external XML file:

1. Validate the XML against the selected real XSD 1.1 schema.
2. Build or retrieve the cached IR for that same issue.
3. Call `deserializeXML(xml, ir)`.
4. Review the returned message metadata if the application applies additional
   policy.
5. Call `db.persistMessage(batches, msgMeta)`.

```javascript
const fs = require('node:fs');
const { deserializeXML } = require('./src/xml-deserializer');

const xml = fs.readFileSync('/mounted/import/message.xml', 'utf8');
const { msgMeta, batches, version } = deserializeXML(xml, ir);

if (version !== ir.s3000lDialect) throw new Error('Dialect mismatch');
const statistics = await db.persistMessage(batches, msgMeta);
```

`persistMessage()` uses one transaction. It resolves nested parent markers to
surrogate foreign keys after it finds the parent by `uid`.

### Validation boundary

The in-process validator is intentionally lightweight. Use the Java Xerces
validation script as the acceptance gate for a delivered or imported S3000L
file:

```bash
node scripts/validate-xsd11.js \
  --xsd s3000l/1_1/s3000l_1-1_lsa_dataset.xsd \
  --xml /mounted/import/message.xml
```

The generated JSON Schema describes IR entities. It is not a replacement for
validation of the complete S3000L message envelope and all XSD 1.1 assertions.

### Database reads

Use the adapter methods for active data:

| Method | Use |
| --- | --- |
| `queryEntity(entityName)` | Read all active rows for an entity. |
| `queryRelated(entityName, parentColumn, parentId)` | Read active children for a one-to-many relation. |
| `queryById(entityName, id)` | Resolve a stored one-to-one surrogate foreign key. |
| `queryDeleted(entityName, since)` | Read dirty soft-deleted rows for net-change export. |

`queryEntity()` and `queryRelated()` exclude rows whose `_deleted_at` is set.
Do not bypass that behavior in a normal product view.

## 9. Schema visualization versus record visualization

The bundled viewer displays schema metadata:

```bash
npm run visualize:1_1
```

It shows entity definitions, fields, relations, connected components, and XSD
constraints. It does not query MariaDB and it does not display project records.

Use `buildVisualizationModel(ir)` when a browser needs a JSON-safe form of the
schema IR:

```javascript
const { buildVisualizationModel } = require('./src/visualization-model');

const model = buildVisualizationModel(ir, { source: 'Issue 1.1' });
```

Use a separate record API for a product breakdown. The next section shows that
path.

## 10. Issue 1.1 database-backed product breakdown

### Storage topology

The current Issue 1.1 IR uses a hybrid representation:

```text
product database row
├─ product_variant database rows
│  └─ bkdns LONGTEXT JSON
└─ bkdns LONGTEXT JSON
   └─ breakdown
      └─ breakdownRevision
         └─ breakdownElementUsageInBreakdown
            └─ beChildRef -> another usage UID

breakdownElements collection database rows
├─ aggregated_element -> aggregated_element_revision
├─ hardware_element   -> hardware_element_revision
├─ software_element   -> software_element_revision
└─ zone_element       -> zone_element_revision
```

`product.prodVar` is a normalized one-to-many IR relation. In contrast,
`product.bkdns` and `productVariant.bkdns` are anonymous XSD wrappers. The
S3000L builder stores each complete wrapper in one JSON-backed column.

The display code must therefore combine three kinds of edges:

1. Use the IR relation and generated foreign key for product to variant.
2. Traverse breakdown, revision, usage, and child references inside `bkdns`
   JSON.
3. Resolve each usage's `beRef` against normalized breakdown-element and
   revision entity rows so the UI can show the element name and identifier.

Do not query `breakdown` with a fabricated product foreign key. The current IR
does not define that edge.

### Run the executable example

Point `MARIADB_URL` at a database generated from the Issue 1.1 IR and already
populated through the importer:

```bash
MARIADB_URL='mysql://user:password@127.0.0.1:3306/lsa_project_1_1' \
  node examples/issue-1.1-product-breakdown.js
```

Pass a product `uid` to select one product:

```bash
MARIADB_URL='mysql://user:password@127.0.0.1:3306/lsa_project_1_1' \
  node examples/issue-1.1-product-breakdown.js prod1
```

The equivalent npm command is:

```bash
MARIADB_URL='mysql://user:password@127.0.0.1:3306/lsa_project_1_1' \
  npm run example:product-breakdown:1_1 -- prod1
```

Example output:

```text
Aircraft Product (PROD-1)
├─ SY breakdown
│  └─ Revision A
│     └─ Aircraft (SYS-1)
│        └─ Engine (ENG-1) × 2 EA [1]
└─ Trainer Variant (PV-1)
   └─ HY breakdown
```

The quantity follows `×`. The reference designator is in square brackets.

### What the example reads from the IR

The example does not hard-code table names or parent foreign-key names. It uses:

- `ir.s3000lDialect` to reject the wrong database model;
- `ir.entities.get('product')` to find product metadata;
- the `product.prodVar` relation to find the variant entity and child foreign
  key;
- `ir.s3000lCollections` to discover all Issue 1.1 record types in the
  `breakdownElements` collection;
- each breakdown-element entity's `beRev` relation to load its revisions;
- the explicit Issue 1.1 business columns `prod_id`, `prod_var_id`, `name`,
  `bkdns`, `be_id`, and `be_rev_id` after it verifies the IR dialect.

The business concepts `product`, `prodVar`, `beRev`, `beRef`, and `beChildRef`
remain explicit. The IR describes structure and storage. It does not assign a
universal business meaning to every relation.

### Use it in an API

Create one cached IR and one project-scoped `DBAdapter`. Return the render-ready
nodes from a route:

```javascript
const {
  loadIssue11ProductBreakdown,
} = require('./examples/issue-1.1-product-breakdown');

app.get('/api/products/:uid/breakdown', async (request, response, next) => {
  try {
    const nodes = await loadIssue11ProductBreakdown(ir, db, {
      productUid: request.params.uid,
    });
    response.json(nodes);
  } catch (error) {
    next(error);
  }
});
```

Resolve the project to its server-owned database connection before calling the
loader. Never accept a raw database name or table name from the client.

### Display the API result in a browser

The returned nodes all have `label` and `children` properties. This minimal
renderer displays them as a nested list:

```javascript
function renderNode(node) {
  const item = document.createElement('li');
  const label = document.createElement('span');
  const quantity = node.quantity ? ` × ${node.quantity}` : '';
  const rfd = node.referenceDesignator ? ` [${node.referenceDesignator}]` : '';

  label.textContent = `${node.label}${quantity}${rfd}`;
  item.append(label);

  if (node.children.length > 0) {
    const list = document.createElement('ul');
    node.children.forEach((child) => list.append(renderNode(child)));
    item.append(list);
  }
  return item;
}

async function showProductBreakdown(productUid, container) {
  const response = await fetch(`/api/products/${encodeURIComponent(productUid)}/breakdown`);
  if (!response.ok) throw new Error(`Breakdown request failed: ${response.status}`);

  const roots = await response.json();
  const list = document.createElement('ul');
  roots.forEach((root) => list.append(renderNode(root)));
  container.replaceChildren(list);
}
```

Use `textContent`, not `innerHTML`, for database values. S3000L labels are
external data and must not become executable markup.

The same API shape works with an Angular recursive component or tree control.
Keep data loading in the API. Do not send the full IR or database credentials
to the browser.

### Example behavior for incomplete data

The loader handles common data conditions explicitly:

- It accepts an object or array at every repeating XML location.
- It resolves a breakdown element revision by `uidRef` first.
- It can also resolve a natural `beId` plus `beRevId` reference.
- It labels a missing target as unresolved instead of silently dropping it.
- It marks a repeated usage path as a cycle and stops recursion.
- It excludes soft-deleted rows because it reads through `DBAdapter`.
- It sorts product, variant, element, and revision rows for stable output.

### Production optimization

The example favors clear IR use. It calls `queryRelated()` for each element and
product. This can cause many queries on a large project.

For production, retain the same IR-derived entity and column allowlist but load
rows in batches. Build maps keyed by parent surrogate ID and S3000L UID. Add
pagination or depth limits for large product structures. Keep cycle detection
and unresolved-reference reporting.

## 11. Build a generic metadata-driven UI

Use the IR to build generic forms and tables:

1. Select direct record entities from `s3000lCollections` for top-level
   navigation.
2. Add nested record entities when a relation leads to them.
3. Hide columns whose `xmlKind` is `internal` unless an administrator requests
   diagnostics.
4. Use `documentation`, `jsonType`, `nullable`, `constraints`, `minOccurs`, and
   `maxOccurs` to build controls and validation messages.
5. Use `enumRef` and `constraints.enum` for fixed-value choices.
6. Use relations for record selectors and nested editors.
7. Store object-valued fields as valid JSON text in `LONGTEXT` columns.
8. Send entity names only after checking them against `ir.entities` on the
   server.

Do not let a request supply arbitrary SQL identifiers. Resolve an approved IR
entity name to `tableName` and approved logical fields to `columnName` on the
server.

## 12. Common mistakes

| Symptom | Cause | Correction |
| --- | --- | --- |
| `JSON.stringify(ir)` shows empty objects for metadata | The IR uses `Map`. | Convert with `Object.fromEntries()` or use generated `ir.json`. |
| A database query uses `prodVar` as a column | `prodVar` is an XML relation field. | Read `relation.targetEntity` and `relation.parentColumn`. |
| Nested values display as JSON strings | A `LONGTEXT` object column was not parsed. | Parse it and support object-or-array occurrences. |
| A product has no queried `breakdown` children | `bkdns` is an inline JSON wrapper. | Traverse `product.bkdns`; do not invent a product FK on `breakdown`. |
| A breakdown node has only an ID | Its `beRef` was not resolved to a breakdown-element revision row. | Index the `breakdownElements` entities by revision UID and natural key. |
| Deleted records appear | Application code bypassed `DBAdapter`. | Filter `_deleted_at IS NULL` or use adapter reads. |
| Imported fields are all null | XML and IR dialects differ, or code guessed XML names. | Check `s3000lDialect` and use IR `xmlName`. |
| Issue 1.1 export has an Issue 2.0 root | The current serializer is not Issue 1.1-aware. | Do not deliver Issue 1.1 exports until `REV-005` is resolved. |
| The viewer shows entities but no product records | The bundled viewer is a schema viewer. | Add a project database API such as the worked example. |

## 13. Completion checklist for an IR consumer

Before releasing an IR-driven feature, verify each item:

- The project stores an immutable S3000L issue selection.
- The loaded IR dialect matches the project and every imported message.
- The application caches one IR per dialect.
- Every requested entity exists in `ir.entities`.
- Every relation target exists.
- Database code uses `tableName`, `columnName`, and `parentColumn` from the IR.
- XML code uses `xmlName` and `xmlKind` from the IR.
- Code handles `maxOccurs: 'unbounded'` and object-or-array XML shapes.
- Code parses and validates JSON-backed `LONGTEXT` fields.
- Active reads exclude `_deleted_at` rows.
- Public APIs use S3000L `uid`, not the surrogate database `id`.
- Reference resolution reports missing and ambiguous targets.
- Recursive views detect cycles and apply size or depth limits.
- Browser code treats all database values as text.
- Imported and delivered XML passes the real XSD 1.1 validation command.
- Issue 1.1 code does not use the current Issue 2.0-only serializer for a
  delivery.
- Unit tests cover the selected issue, IR relation metadata, JSON reference
  resolution, unresolved references, and the displayed hierarchy.

## 14. Relevant source files

| File | Responsibility |
| --- | --- |
| [`src/xsd-parser.js`](../src/xsd-parser.js) | Parse and merge XSD files. |
| [`src/type-resolver.js`](../src/type-resolver.js) | Resolve XSD types to IR primitive metadata. |
| [`src/ir-builder.js`](../src/ir-builder.js) | Build the core IR. |
| [`src/ir-element-builders.js`](../src/ir-element-builders.js) | Build element columns and repeated-value helpers. |
| [`src/ir-relation-helpers.js`](../src/ir-relation-helpers.js) | Build relation metadata and generated FKs. |
| [`src/s3000l-ir-metadata.js`](../src/s3000l-ir-metadata.js) | Detect dialect, direct records, and collection mappings. |
| [`src/sql-generator.js`](../src/sql-generator.js) | Generate MariaDB DDL. |
| [`src/json-schema-generator.js`](../src/json-schema-generator.js) | Generate entity JSON Schema. |
| [`src/xml-deserializer.js`](../src/xml-deserializer.js) | Convert S3000L XML to database batches. |
| [`src/db-adapter.js`](../src/db-adapter.js) | Persist and query IR entities. |
| [`src/xml-serializer.js`](../src/xml-serializer.js) | Convert database rows to the current Issue 2.0 XML envelope. |
| [`src/visualization-model.js`](../src/visualization-model.js) | Convert Map-based schema IR to a browser-safe model. |
| [`examples/issue-1.1-product-breakdown.js`](../examples/issue-1.1-product-breakdown.js) | Load and display an Issue 1.1 product breakdown from MariaDB entities. |
| [`test/product-breakdown-example.test.js`](../test/product-breakdown-example.test.js) | Verify the worked example and its output. |
