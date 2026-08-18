The key distinction is: `<message>` contains an **exchange envelope** plus an **LSA payload**. Only the payload must normally come from the domain database. The envelope is generated or supplied for a new export, but must be persisted separately if you want an exact XML → DB → XML replay.

## Issue 1.1

The root is `<lsaDataSet type="message">`. Its direct children are declared in [the Issue 1.1 XSD](/home/pbx06/work/xsd-to-ir/s3000l/1_1/s3000l_1-1_lsa_dataset.xsd:31).

| Node | Cardinality | Function |
|---|---:|---|
| `msgId` | `0..1` | Message identifier: required nested `id`, with optional identifier class and issuing organization. |
| `msgDate` | `0..1` | Creation timestamp, represented by nested `dateTime`. |
| `msgLang` | `0..1` | Language used by the message. |
| `msgStatus` | `0..1` | Content maturity: draft `D`, preliminary `P`, or final `F`. |
| `msgSend` | `0..*` | Sending organizations. |
| `msgReceive` | `0..*` | Receiving organizations. |
| `msgContext` | `0..1` | Business scope: contract, product, product variant, or project reference. |
| `msgContent` | `0..1` | The actual LSA data payload. |
| `relatedMsg` | `0..*` | Relations to other messages: observation, update, acknowledgement, or reply. |
| `secs` | `0..1` | Message-level security classifications. |
| `rmks` | `0..1` | Message-level remarks. |

The root also has optional `uid` and `crud` attributes. `crud` defaults to `I`.

When `msgContent` is present and non-nil, it contains two required structural sections ([XSD](/home/pbx06/work/xsd-to-ir/s3000l/1_1/s3000l_1-1_lsa_dataset.xsd:63)):

- `messageContentItems`: products, breakdown elements, parts, task requirements and tasks.
- `supportingContentItems`: contracts, projects, organizations, documents, skills, resources, applicability data and other supporting collections.

The collection records are the domain data that belongs in the main database. The `msgContent` and section wrappers themselves are reconstructed XML structure, not database records.

## Issue 2.0

The root spelling changes to `<lsaDataset type="message">`. Its sequence is declared in [the Issue 2.0 XSD](/home/pbx06/work/xsd-to-ir/s3000l/2_0/s3000l_2-0_lsaDataset.xsd:25).

| Node | Cardinality | Function |
|---|---:|---|
| `msgId` | exactly `1` | Identifies the exchanged message. Unlike Issue 1.1, it is mandatory. |
| `msgDate` | `0..1` | Creation date plus optional time. |
| `msgLang` | `0..1` | Message language, represented by a nested code. |
| `msgStatus` | `0..1` | Draft, preliminary, final, or the permitted special null-like states. The Issue 2 field is `state`. |
| `msgType` | `0..1` | `B` for baseline or `U` for net-change/update. |
| `logisticsSupportAnalysisData` | exactly `1` | The actual LSA payload. |
| `msgContext` | `0..*` | Contract, product, product-variant or project contexts. It became repeatable. |
| `msgPty` | `0..*` | Message parties, replacing Issue 1’s separate sender/receiver nodes. Party roles are sender `S`, receiver `R`, or forwarder `F`. |
| `relatedMsg` | `0..*` | Acknowledgement, observation, reply or update links to other messages. |
| `docs` | `0..1` | Message-level document references. |
| `orgRefs` | `0..1` | Additional message-level organization references and roles. |
| `projAttrs` | `0..1` | Project-specific extension attributes. |
| `rmks` | `0..1` | Message-level remarks. |
| `secs` | `0..1` | Message-level security classifications. |

Issue 2 adds optional root attributes `uid`, `uri`, and `crud`.

`logisticsSupportAnalysisData` is required, but its two internal sections are optional ([XSD](/home/pbx06/work/xsd-to-ir/s3000l/2_0/s3000l_2-0_lsaDataset.xsd:69)):

- `lsaPrimaryData`
- `lsaSupportingData`

Again, these wrappers are constructed around the domain rows; they do not need their own database rows.

## What should come from the DB?

| Node category | At import | At export |
|---|---|---|
| LSA payload collections | Read from XML and insert/update/delete domain tables. | Query domain tables and reconstruct the payload wrappers. |
| `msgId`, `msgDate`, `msgLang`, `msgStatus`, `msgType` | Comes from XML. Store in a message journal if auditing, idempotency or replay matters. | For a new message: generate or take from export options/config. For replay: load from the message journal. |
| Sender/receiver/party and context | Comes from XML. Store the selected associations if they must survive round-trip. Referenced organizations/products may need DB resolution. | Selection should come from export input or a saved message header. The referenced target data may come from domain tables. |
| `relatedMsg` | Comes from XML. Store in message history if message chains matter. | Read from message history or receive it as an export option. |
| Documents, organizations, remarks, security and extensions | Comes from XML. Persist only if exact semantic replay or audit is required. | Supply from the export request or load from the saved message header. |
| Structural wrappers | Parse and reconstruct only. | Construct from schema/version; never query them as standalone rows. |
| Root `uid`, `uri`, `crud` | Comes from XML; preserve if exact replay or external references matter. | Generate/derive for a new message, or load for replay. |

`msgType` deserves special attention: its value is envelope metadata, but it controls the payload query. A baseline export normally selects the full active dataset; a net-change export selects changed and deleted records. On import, however, the individual record `crud` values drive the database operations.

## What the repository currently does

The current importer extracts only:

- `msgId`
- `msgType`
- `msgStatus`
- `msgDate`
- flattened related-message IDs

See [`_extractMsgMeta()`](/home/pbx06/work/xsd-to-ir/src/xml-deserializer.js:326). Language, parties, context, extensions, remarks, security and root attributes are currently ignored.

More importantly, [`persistMessage()`](/home/pbx06/work/xsd-to-ir/src/db-adapter.js:181) receives this metadata but deliberately does not store it. It persists only the entity batches found inside the payload.

On export, database queries are performed only while building the primary and supporting payload sections ([serializer](/home/pbx06/work/xsd-to-ir/src/xml-serializer.js:370)). Header values are currently generated or taken from serializer options ([envelope construction](/home/pbx06/work/xsd-to-ir/src/xml-serializer.js:301)).

Therefore, today:

- Domain payload records can be round-tripped through the DB.
- Message-envelope metadata cannot be round-tripped.
- XML → DB → XML currently produces a **new outbound message around persisted data**, not a replay of the original imported message.
- For a genuine semantic message round-trip, add a `message_header`/`message_journal` model with child associations for repeatable nodes, or retain the original parsed header tree.
- Leaving the hardcoded envelope work aside, the current serializer remains Issue-2-shaped and should not yet be considered schema-faithful for either complete Issue 1 or Issue 2 envelope replay.
