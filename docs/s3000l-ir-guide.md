# S3000L Intermediate Representation Developer Guide

This guide explains how this repository builds and uses the S3000L
Intermediate Representation (IR). It targets a developer who has not worked
with this code before.

The worked example uses S3000L Issue 1.1. It reads persisted entities from
MariaDB and produces a hierarchical product breakdown. The executable example
is in
[`examples/issue-1.1-product-breakdown.js`](../examples/issue-1.1-product-breakdown.js).

Read Sections 1 through 5 first if XML and XSD are new to you. Those sections
define the terms used by the rest of the guide and trace one product record
through every representation.

## 1. Start with the five representations

This project handles the same S3000L information in five different forms. Each
form has a separate purpose and separate names.

```text
XSD schema
   |
   | parseXSD() + IRBuilder.build()
   v
IR metadata ---------------------> JSON Schema
   |
   | generateSQL()
   v
MariaDB schema and rows

XML input ---- deserializeXML(xml, ir) ----> database batches ----> MariaDB
MariaDB  ---- serializeToXML(ir, db, options) --------------------> XML output
```

The IR is required on both XML paths. It tells the deserializer and serializer
which XML name, entity, table, column, and relation represent the same value.

Keep these facts separate:

- XSD is a schema language. It describes XML. It is not the database schema.
- XML is the exchange document. It contains actual S3000L message data.
- The IR is JavaScript metadata generated from XSD. It contains no project
  records.
- MariaDB contains project records in generated tables.
- JSON Schema is another generated description. It does not replace the source
  XSD or validate the complete S3000L message envelope.

The word **entity** is an application and database term in this repository.
XML itself contains elements and attributes. The builder decides which XSD
types become IR entities and database tables.

### Essential terms

| Term | Meaning in this project |
| --- | --- |
| XML | A text format that stores an ordered tree of elements, attributes, and values. |
| XML instance | One actual XML document, such as an imported S3000L message. |
| XSD | XML Schema Definition. It specifies valid XML names, types, order, repetition, and rules. |
| Schema type | A reusable XSD definition, such as the type named `product`. |
| XML element | A named node in an XML document, such as `<prod>` or `<prodId>`. |
| XML attribute | A value written in an opening tag, such as `uid="prod1"`. |
| Envelope | Message-level XML structure that carries headers and collections but is not persisted as a record table. |
| Collection | An XML container for records, such as `<products>`. |
| IR | Intermediate Representation. The generated JavaScript model shared by database, JSON, XML, and UI code. |
| IR entity | A persistable record or generated helper described in `ir.entities`. |
| Database row | One stored occurrence of an IR entity. |
| Relation | IR metadata that connects two entity types. |
| Dialect | The supported S3000L issue: `1.1` or `2.0`. |
| Normalization | A deliberate name or structure conversion, such as `productVariant` to `product_variant`. |

## 2. XML basics needed for this project

XML uses opening and closing tags. A tag pair creates an element:

```xml
<prodId>
  <id>PRODUCT-1</id>
</prodId>
```

`prodId` is an element. It contains another element named `id`. The text value
of `id` is `PRODUCT-1`.

Attributes are written inside an opening tag:

```xml
<prod uid="prod1" crud="I">
  <prodId>
    <id>PRODUCT-1</id>
  </prodId>
</prod>
```

In this fragment:

- `prod` is an element;
- `uid` and `crud` are attributes of `prod`;
- `prodId` is a child element of `prod`;
- `id` is a child element of `prodId`;
- `PRODUCT-1` is text content.

An empty element can use a self-closing tag. These two forms have the same
basic meaning:

```xml
<products></products>
<products/>
```

### XML is an ordered tree

Each element has one parent, except the document root. An element can have
children. The order can matter because XSD `sequence` rules can require a
specific order.

This Issue 1.1 fragment contains one product and one nested product variant:

```xml
<products>
  <prod uid="prod1" crud="I">
    <prodId>
      <id>PRODUCT-1</id>
    </prodId>
    <name>
      <descr>Training Aircraft</descr>
    </name>
    <prodVar uid="prodv1" crud="I">
      <prodVarId>
        <id>VARIANT-A</id>
      </prodVarId>
      <name>
        <descr>Trainer Variant</descr>
      </name>
    </prodVar>
  </prod>
</products>
```

The structural path to the variant is:

```text
products -> prod -> prodVar
```

The XML names do not match all XSD type names or database table names:

```text
XML <prod>       uses XSD type product        -> table product
XML <prodVar>    uses XSD type productVariant -> table product_variant
```

Do not treat an XML tag name as a database table name.

### Repeated elements

XML repeats a tag to represent multiple values:

```xml
<products>
  <prod uid="prod1" crud="I">
    <prodId><id>PRODUCT-1</id></prodId>
  </prod>
  <prod uid="prod2" crud="I">
    <prodId><id>PRODUCT-2</id></prodId>
  </prod>
</products>
```

`fast-xml-parser` represents repeated values as JavaScript arrays. A location
with one occurrence can still be represented as one object. Code that reads a
repeating XSD location must accept both forms:

```javascript
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
```

### XML names are case-sensitive

`<prodName>` and `<prodname>` are different XML elements. The Issue 2.0 schema
also contains names such as `<InfrStrCompls>` with an uppercase first letter.
Never lowercase XML names and never recreate them from database names. Read
the exact name from `column.xmlName`, `relation.fieldName`, or collection
metadata.

### Namespaces and prefixes

An XML namespace identifies which vocabulary owns a name. A prefix is a short
alias for a namespace URI.

The Issue 1.1 root can appear as:

```xml
<s:lsaDataSet xmlns:s="http://www.asd-europe.org/s-series/s3000l">
  ...
</s:lsaDataSet>
```

The ellipsis in this namespace example marks omitted child elements. It is not
literal XML content.

Here:

- `s` is the prefix;
- `xmlns:s` declares what `s` means;
- `lsaDataSet` is the local root name;
- the complete root name includes the namespace URI.

The bundled XSDs do not set `elementFormDefault="qualified"`. Their global
root is namespace-qualified, while locally declared children such as `msgId`,
`msgContent`, and `products` are unqualified. Do not add the root prefix to
every child unless a different schema explicitly requires it.

### XML parser object form

The XML parser uses a JavaScript object representation. For a record, it uses
`@_` to distinguish an attribute from a child element:

```javascript
{
  '@_uid': 'prod1',
  '@_crud': 'I',
  prodId: { id: 'PRODUCT-1' },
  name: { descr: 'Training Aircraft' },
  prodVar: {
    '@_uid': 'prodv1',
    '@_crud': 'I',
    prodVarId: { id: 'VARIANT-A' },
  },
}
```

The IR does not use the `@_` prefix in `column.xmlName`. Instead, it records
`xmlName: 'uid'` and `xmlKind: 'attribute'`. Import and export code adds or
removes `@_` when it converts between XML parser objects and rows.

## 3. XSD basics needed for this project

XSD is XML that describes other XML. An XSD file defines allowed element
names, attributes, types, order, repetition, and constraints.

The prefixes `xs:` and `xsd:` normally refer to the same W3C XML Schema
namespace. A schema author chooses the prefix. This repository contains both
styles. For example, `xs:element` and `xsd:element` mean the same XSD
construct when their namespace declarations point to that namespace.

This shortened Issue 1.1 definition describes a product:

```xml
<xsd:complexType name="product">
  <xsd:sequence>
    <xsd:element name="prodId"
                 type="productIdentifier"
                 maxOccurs="unbounded"/>
    <xsd:element name="name"
                 type="productName"
                 minOccurs="0"
                 maxOccurs="unbounded"/>
    <xsd:element name="prodVar"
                 type="productVariant"
                 minOccurs="0"
                 maxOccurs="unbounded"/>
  </xsd:sequence>
  <xsd:attribute name="uid" use="optional"/>
  <xsd:attribute name="crud" type="crudCodeValues" default="I"/>
</xsd:complexType>
```

Read the `prodVar` declaration from left to right:

- XML element name: `prodVar`;
- reusable XSD type: `productVariant`;
- minimum occurrences: `0`, so it is optional;
- maximum occurrences: `unbounded`, so it can repeat.

The builder converts this declaration into a one-to-many IR relation from
entity `product` to entity `productVariant`.

### XSD type names and XML element names are separate

The XSD connects the XML record `<prod>` to the reusable type `product` in a
different declaration:

```xml
<xsd:element name="products">
  <xsd:complexType>
    <xsd:sequence>
      <xsd:element name="prod"
                   type="product"
                   minOccurs="0"
                   maxOccurs="unbounded"/>
    </xsd:sequence>
  </xsd:complexType>
</xsd:element>
```

These names serve different purposes:

```text
products = XML collection element
prod     = XML record element
product  = XSD type, IR entity key, and IR entity name
```

There is no safe singularization rule that converts `products` to every record
name. Other mappings use abbreviations, such as `breakdownElements -> beAggr`
and `facilities -> maintFclty`. Use `ir.s3000lCollections`.

### Type prefixes inside an XSD

The `type` attribute can point to different namespaces:

| XSD value | Meaning |
| --- | --- |
| `type="productVariant"` | A type declared in the schema's current namespace. |
| `type="xsd:date"` | The built-in XSD `date` type. |
| `type="value:languageCodeValues"` | A type from an imported namespace assigned the prefix `value`. |

The prefix is an alias, not part of the type's local name. Read its `xmlns`
declaration to identify the namespace. Do not remove prefixes in general XML
or XSD code. This repository's parser performs its own QName normalization
while it merges the bundled schemas.

### XSD constructs used by the builder

| XSD construct | Basic meaning | Main IR result |
| --- | --- | --- |
| `xs:element` | Declares an XML child or record name. | A column, inline JSON value, or relation. |
| `xs:attribute` | Declares a value in an opening tag. | A column with `xmlKind: 'attribute'`. |
| `xs:complexType` | Defines a value with child elements or attributes. | An entity, relation target, or JSON-backed value. |
| `xs:simpleType` | Defines a scalar restriction or allowed values. | A simple type or enum entry. |
| `xs:sequence` | Requires children in a defined order. | The builder walks each declared child. |
| `xs:choice` | Allows one branch from alternatives. | Nullable fields or relations and sometimes `choice_type`. |
| `xs:group` | Reuses a group of declarations. | Flattened fields or a synthetic helper entity when repeated. |
| `xs:extension` | Extends another type. | `parentType` and a database relation when materialized. |
| `xs:assert` | Adds an XSD 1.1 XPath rule. | Assertion metadata and limited runtime enforcement. |

### Occurrence values

If `minOccurs` is omitted, its XSD default is `1`. If `maxOccurs` is omitted,
its default is also `1`.

| Declaration | Meaning |
| --- | --- |
| `minOccurs="1" maxOccurs="1"` | Exactly one. |
| `minOccurs="0" maxOccurs="1"` | Optional, at most one. |
| `minOccurs="1" maxOccurs="unbounded"` | One or more. |
| `minOccurs="0" maxOccurs="unbounded"` | Zero or more. |

The IR stores numeric limits as numbers and stores an unlimited maximum as the
string `'unbounded'`.

Other declarations affect whether and how a value appears:

| Declaration | Meaning |
| --- | --- |
| `nillable="true"` | The element can be present with `xsi:nil="true"`; this differs from omitting it. |
| `default="I"` | Use `I` when the XML does not supply a value and the applicable XSD rules allow the default. |
| `use="optional"` | An attribute can be omitted from the XML instance. |
| `base="xsd:ID"` | Restrict the built-in XML ID type. |
| `pattern value="..."` | Require the lexical value to match a regular-expression constraint. |

The database model can be stricter than the transport declaration. For
example, Issue 1.1 declares a product `uid` attribute as optional, but this
repository requires `uid` on a persisted direct record so update, delete, and
reference operations have a stable record identity.

### Why not every complex type becomes a table

S3000L XSDs contain message envelopes, reusable values, references, anonymous
wrappers, and real records. Creating one table for every `complexType` would
create tables for transport-only structures and split small values into many
unnecessary rows.

In S3000L mode, the builder treats a named complex type with both `uid` and
`crud` attributes as a direct record entity. It usually stores other nested
complex values as JSON in a `LONGTEXT` column. Repeating groups and primitives
can create synthetic helper entities when a table is required to preserve
multiplicity.

## 4. Follow one Issue 1.1 product through every layer

This section uses the XML product shown earlier.

### Step 1: the XSD defines the XML location

The Issue 1.1 envelope declares this path:

```text
lsaDataSet
└─ msgContent
   └─ messageContentItems
      └─ products
         └─ prod, type product, repeated
```

`products` is a container. `prod` is the XML record element. `product` is the
XSD type used by that record.

### Step 2: the builder selects a record entity

The `product` type has both `uid` and `crud` attributes. The builder creates:

```javascript
ir.entities.get('product');
// {
//   name: 'product',
//   tableName: 'product',
//   columns: [...],
//   relations: [...],
// }
```

The IR entity key and `entity.name` preserve the XSD type name. The database
table name uses database normalization.

### Step 3: the builder classifies each child

| XSD member | Classification | IR/database result |
| --- | --- | --- |
| `prodId: productIdentifier` | Structured value type without record `uid` and `crud` | `prod_id LONGTEXT`, containing JSON. |
| `name: productName` | Structured value type without record `uid` and `crud` | `name LONGTEXT`, containing JSON. |
| `prodVar: productVariant` | Repeating direct record type | One-to-many relation to entity `productVariant`. |
| `bkdns` from group `breakdownItem` | Anonymous structured wrapper | `bkdns LONGTEXT`, containing JSON. |
| `uid` | XML record attribute | Required database column `uid`. |
| `crud` | XML record attribute | Required database column `crud`, default `I`. |

The product relation is:

```javascript
{
  kind: 'one-to-many',
  fieldName: 'prodVar',
  targetEntity: 'productVariant',
  parentColumn: 'product_prod_var_parent_id',
  nullable: true,
  minOccurs: 0,
  maxOccurs: 'unbounded',
}
```

`fieldName` is the XML child name. `targetEntity` is the IR/XSD type name.
`parentColumn` is the normalized database column added to the child table.

### Step 4: the SQL generator creates tables

The generated DDL contains more columns and constraints than this shortened
view:

```sql
CREATE TABLE `product` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `prod_id` LONGTEXT NOT NULL,
  `name` LONGTEXT DEFAULT NULL,
  `bkdns` LONGTEXT DEFAULT NULL,
  `uid` VARCHAR(255) NOT NULL,
  `crud` VARCHAR(64) NOT NULL DEFAULT 'I'
);

CREATE TABLE `product_variant` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `prod_var_id` LONGTEXT NOT NULL,
  `name` LONGTEXT DEFAULT NULL,
  `bkdns` LONGTEXT DEFAULT NULL,
  `uid` VARCHAR(255) NOT NULL,
  `crud` VARCHAR(64) NOT NULL DEFAULT 'I',
  `product_prod_var_parent_id` BIGINT DEFAULT NULL
);
```

The actual DDL also adds lifecycle columns, JSON validity checks, indexes, and
the foreign key from `product_variant.product_prod_var_parent_id` to
`product.id`.

### Step 5: import creates rows

The earlier XML can produce rows with these values:

`product`:

| id | uid | crud | prod_id | name |
| ---: | --- | --- | --- | --- |
| `42` | `prod1` | `I` | `{"id":"PRODUCT-1"}` | `{"descr":"Training Aircraft"}` |

`product_variant`:

| id | uid | crud | prod_var_id | name | product_prod_var_parent_id |
| ---: | --- | --- | --- | --- | ---: |
| `88` | `prodv1` | `I` | `{"id":"VARIANT-A"}` | `{"descr":"Trainer Variant"}` | `42` |

The numbers `42` and `88` are illustrative surrogate database IDs. The S3000L
identities are `prod1` and `prodv1`.

### Step 6: a read reconstructs the hierarchy

Application code loads the parent row, reads the IR relation, and queries the
child table with the relation's `parentColumn`:

```javascript
const productEntity = ir.entities.get('product');
const prodVarRelation = productEntity.relations
  .find((relation) => relation.fieldName === 'prodVar');

const products = await db.queryEntity('product');
const variants = await db.queryRelated(
  prodVarRelation.targetEntity,
  prodVarRelation.parentColumn,
  products[0].id,
);
```

The result is a database-backed hierarchy:

```text
Training Aircraft (product row id 42, uid prod1)
└─ Trainer Variant (product_variant row id 88, uid prodv1)
```

The detailed product-breakdown example later in this guide also reads the
`bkdns` JSON and resolves breakdown-element references against other database
entities.

## 5. Name mapping and normalization rules

This section defines the naming contract. Use it whenever code crosses between
XSD, XML, IR, an API, and MariaDB.

### The same record can have different names

| Business record | XSD type name | XML collection | XML record or nested element | IR entity key/name | MariaDB table |
| --- | --- | --- | --- | --- | --- |
| Product | `product` | `products` | `prod` | `product` | `product` |
| Product variant | `productVariant` | None; nested under product | `prodVar` | `productVariant` | `product_variant` |
| Aggregated breakdown element | `aggregatedElement` | `breakdownElements` | `beAggr` | `aggregatedElement` | `aggregated_element` |
| Maintenance facility, Issue 2.0 | `maintenanceFacility` | `facilities` | `maintFclty` | `maintenanceFacility` | `maintenance_facility` |

XML has no element named `<productVariant>` at the product-to-variant location.
MariaDB has no table named `prodVar`. The relation metadata connects these
names.

### Rule 1: direct IR entity names preserve named XSD type names

For a named direct record type:

```text
XSD complex type name productVariant
                      |
                      v
IR map key            productVariant
IR entity.name        productVariant
```

Case is significant. Use `ir.entities.has(name)` to validate an entity name.

Synthetic helpers are different. The builder creates their logical names from
the parent and repeated group or field. A synthetic helper name may be long and
may not exist anywhere as one XML tag.

### Rule 2: database names use lower snake case

The builder converts table and column identifiers to lower snake case:

```text
productVariant  -> product_variant
prodVarId       -> prod_var_id
InfrStrCompls   -> infr_str_compls
some-name       -> some_name
```

The conversion inserts underscores at lower-to-upper and acronym boundaries,
replaces hyphens with underscores, and lowercases the result.

Table names start from the IR entity name. Normal field columns start from the
logical field name. Generated foreign-key columns first combine structural
names, then apply database normalization:

```text
IR entity productVariant              -> table product_variant
logical field prodVarId               -> column prod_var_id
source product + field prodVar + role -> column product_prod_var_parent_id
```

The database conversion does not pluralize or singularize names. It does not
use the XML collection or record name.

MariaDB limits identifiers to 64 characters. When a generated name is too
long, the builder keeps a prefix and appends an underscore plus the first ten
hexadecimal characters of a SHA-1 hash. This current Issue 1.1 example has
exactly 64 characters:

```text
aggregated_element_revision_maintenance_man_hours_per_dc617b5e52
```

Do not reproduce this conversion in application code. Read
`entity.tableName`, `column.columnName`, and `relation.parentColumn` from the
IR. A small schema change can change a generated long-name hash.

### Rule 3: XML names are preserved, not database-normalized

For a normal column, the IR records all relevant names:

```javascript
{
  name: 'prodId',
  columnName: 'prod_id',
  xmlName: 'prodId',
  xmlKind: 'element',
}
```

For a case-sensitive Issue 2.0 field:

```javascript
{
  name: 'InfrStrCompls',
  columnName: 'infr_str_compls',
  xmlName: 'InfrStrCompls',
  xmlKind: 'element',
}
```

The logical `name` is not guaranteed to begin with lowercase. The builder's
camel conversion preserves an existing leading uppercase letter. Do not call
`toLowerCase()` on a logical or XML name.

The two supported issues can also use different XML and logical field names
for the same business concept:

| Business concept | Issue | Logical name | XML name | MariaDB column |
| --- | --- | --- | --- | --- |
| Product display name | 1.1 | `name` | `name` | `name` |
| Product display name | 2.0 | `prodName` | `prodName` | `prod_name` |
| Infrastructure complements | 2.0 | `InfrStrCompls` | `InfrStrCompls` | `infr_str_compls` |

Do not create one shared hard-coded field name across issues. Load the IR for
the selected issue and resolve the field from that IR.

Attributes use their unprefixed XML name plus `xmlKind`:

```javascript
{
  name: 'uid',
  columnName: 'uid',
  xmlName: 'uid',
  xmlKind: 'attribute',
}
```

The XML parser object key is `@_uid`, but the IR `xmlName` remains `uid`.

### Rule 4: top-level XML names come from collection metadata

For a direct top-level record, use:

```javascript
const mapping = ir.s3000lCollections.get('aggregatedElement');
// {
//   entityName: 'aggregatedElement',
//   section: 'lsaPrimaryData',
//   collectionName: 'breakdownElements',
//   recordName: 'beAggr',
// }
```

Do not calculate `collectionName` by appending `s`. Do not calculate
`recordName` by removing an `s`. S3000L uses abbreviations and collections that
contain several record types.

### Rule 5: nested XML record names come from relations

`productVariant` has no top-level collection mapping because it is nested in a
product. The parent entity relation provides its XML name:

```javascript
const relation = ir.entities.get('product').relations
  .find((item) => item.targetEntity === 'productVariant');

console.log(relation.fieldName);    // prodVar
console.log(relation.parentColumn); // product_prod_var_parent_id
```

Use `fieldName` when reading or writing the nested XML element. Use
`parentColumn` when querying the child table.

An XML element name belongs to a location in the XML tree, not only to its XSD
type. Two parent declarations can use the same target type under different
element names. For that reason, the IR stores a nested XML name on each
relation instead of assigning one universal XML record name to the target
entity.

### Rule 6: normalized section names hide envelope differences

The IR uses two normalized section values:

```text
lsaPrimaryData
lsaSupportingData
```

They map to different XML containers by dialect:

| Normalized IR section | Issue 1.1 XML container | Issue 2.0 XML container |
| --- | --- | --- |
| `lsaPrimaryData` | `messageContentItems` | `lsaPrimaryData` |
| `lsaSupportingData` | `supportingContentItems` | `lsaSupportingData` |

The normalized value groups equivalent business sections. It is not always the
literal XML tag. Export code must also use `ir.s3000lDialect` to choose the
correct envelope. The current serializer does not yet implement the Issue 1.1
choice; this limitation is detailed later.

### Rule 7: API names should use IR entity names

Use the IR entity name as the server-side API discriminator:

```json
{
  "entity": "productVariant",
  "uid": "prodv1"
}
```

Resolve it on the server:

```javascript
const entity = ir.entities.get(requestedEntityName);
if (!entity) throw new Error('Unknown entity');

const tableName = entity.tableName;
```

Do not accept a client-supplied table name, column name, or raw SQL identifier.

### Entity name, UID, business identifier, and database ID are different

These values are often confused:

| Value | Example | Purpose |
| --- | --- | --- |
| IR entity name | `product` | Identifies a record type. |
| XML record name | `prod` | Identifies an element at one XML location. |
| S3000L record UID | `prod1` | Identifies one S3000L record for CRUD and references. |
| Product business identifier | `PRODUCT-1` inside `prodId` | Domain identifier stored as structured JSON. |
| Database surrogate ID | `42` | Internal primary key used for local foreign keys. |

Use the S3000L `uid` at API boundaries. Never expose the surrogate `id` as a
portable identity. Never assume that a business identifier equals `uid`.

### Name lookup checklist

When code needs a name, use this source:

| Needed name | Read from |
| --- | --- |
| IR entity key | `entity.name` or the key in `ir.entities` |
| MariaDB table | `entity.tableName` |
| Logical field | `column.name` |
| MariaDB column | `column.columnName` |
| XML field or attribute | `column.xmlName` plus `column.xmlKind` |
| Top-level XML collection | `s3000lCollections.get(entityName).collectionName` |
| Top-level XML record | `s3000lCollections.get(entityName).recordName` |
| Nested XML record | `relation.fieldName` |
| Child foreign key | `relation.parentColumn` |
| Equivalent primary/support section | `mapping.section` |
| Exact envelope tags | `ir.s3000lDialect` and dialect-specific code |

Use this inspection helper before implementing a new entity screen or query:

```javascript
function inspectEntityNames(ir, entityName) {
  const entity = ir.entities.get(entityName);
  if (!entity) throw new Error(`Unknown IR entity: ${entityName}`);

  const collection = ir.s3000lCollections.get(entityName) ?? null;
  return {
    xsdTypeAndIrEntity: entity.name,
    databaseTable: entity.tableName,
    topLevelXml: collection && {
      section: collection.section,
      collection: collection.collectionName,
      record: collection.recordName,
    },
    fields: entity.columns.map((column) => ({
      logical: column.name,
      xml: column.xmlKind === 'internal'
        ? null
        : { name: column.xmlName, kind: column.xmlKind },
      database: column.columnName,
    })),
    nestedRecords: entity.relations.map((relation) => ({
      xmlElement: relation.fieldName,
      targetIrEntity: relation.targetEntity,
      childDatabaseForeignKey: relation.parentColumn,
    })),
  };
}

console.dir(inspectEntityNames(ir, 'product'), { depth: null });
```

Pass the IR entity name, such as `product`. Do not pass the XML record name
`prod` or the database table name `product_variant` to IR lookup methods.

## 6. What the IR is

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

## 7. Build an IR

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

## 8. Top-level IR contract

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

## 9. How XSD constructs become IR metadata

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

## 10. Entity and column contracts

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

## 11. Relation contract

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

## 12. Collections and envelope versions

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

## 13. Generate and use the database

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

## 14. Schema visualization versus record visualization

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

## 15. Issue 1.1 database-backed product breakdown

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

## 16. Build a generic metadata-driven UI

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

## 17. Common mistakes

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

## 18. Completion checklist for an IR consumer

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

## 19. Relevant source files

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
