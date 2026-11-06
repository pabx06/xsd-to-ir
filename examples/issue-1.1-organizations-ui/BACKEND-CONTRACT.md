# Organizations editor: backend contract

This document is the handoff for the **separate backend project**. The frontend in
this directory implements the API contract below. Backend implementation and
deployment belong to that other project.

**Review updated on 6 November 2026**, using
`entity-crud2-code-reconstitue.md`. That file contains code reconstructed from
photographs and warns that its fidelity is not guaranteed. Confirm each finding
against the actual source. Filenames, method names, and code fragments below
identify the relevant code without depending on document line numbers.

**PUT and summary routes now exist. Complete Organization CRUD is still
unfinished.** The following table distinguishes code present in the reviewed
version from work that remains. “Present” does not mean verified against the
deployed backend.

| Area                      | Current state                                                                                                                                         | Remaining work                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| PUT replacement           | Separate route and `EntityCrudService.replace()` are present. They retain adapter state, use a transaction and row lock, and detect unchanged values. | Complete nested preparation, validation, and reference checks.                                                               |
| POST creation             | The old `create()` path remains.                                                                                                                      | Call `prepareCreate()` and validate the prepared value. The registry currently attaches no creation hook.                    |
| Read responses            | Clean envelopes, timestamps, active-row filtering, and `_msg_seq` pending detection are present.                                                      | Resolve the root CRUD `N` mismatch with the UI.                                                                              |
| Queries                   | Scalar sorting and pagination up to 100 are present.                                                                                                  | Implement `filter.search`, `filter.status`, and the primary-key sort tie-breaker.                                            |
| Summary                   | Route ordering, registration, and the response envelope are present.                                                                                  | Correct the SQL branch for singleton document assignments.                                                                   |
| Identity and history      | Preparation, allocator, and history classes are present.                                                                                              | Cover all nested types, handle existing values without UIDs, and confirm migrations, history population, and UID uniqueness. |
| Validation and references | Column-level Zod checks and database-error mapping are present.                                                                                       | Use the generated UI schema and validate references inside JSON.                                                             |
| Authorization             | Routes call `iamAllowed()`.                                                                                                                           | Replace its unconditional `return true` with effective project permissions.                                                  |

Recommended implementation order:

1. Confirm the actual source, installed package, and history-table migrations.
2. Complete creation, recursive identity preparation, and prepared-value validation.
3. Add reference protection and make all enabled write routes use the same rules.
4. Finish queries and summary calculations; resolve authorization and CRUD `N`.
5. Run backend integration tests, then connect the UI to a dedicated test project.

The sections below contain the required behaviour, the code to locate, and
specific acceptance tests. The final section defines the live handoff checks.

## 1. Connection, authorization and naming

All routes are relative to the configured same-origin API base path, usually
`/api`. The example supports Issue **1.1** only and one active editing session per
project. It does not send a revision, ETag, or message sequence. A second editing
session can overwrite changes; this contract does not solve concurrent editing.

Keep the existing session authentication, project context, project-ready checks,
and per-operation authorization. Use the project to select the database and IR;
never trust a client-supplied schema issue to choose the dialect. Serve the API and
UI on one origin, or use the development proxy described in the README. The UI
sends cookies. Existing login and CSRF requirements still apply.

| Method | Path after `/projects/{projectId}/entities`                              | Authorization                       |
| ------ | ------------------------------------------------------------------------ | ----------------------------------- |
| GET    | `/organization`                                                          | `list`                              |
| GET    | `/organization/summary`                                                  | `list`                              |
| GET    | `/organization/{id}`                                                     | `read`                              |
| POST   | `/organization`                                                          | `create`                            |
| PUT    | `/organization/{id}`                                                     | `update`                            |
| DELETE | `/organization/{id}`                                                     | `delete`                            |
| GET    | `/externalDocument`, `/externalDocumentIssue`, `/applicabilityStatement` | `list` for the corresponding entity |

The entity names are IR names and are case-sensitive. The document tables use
**`externalDocument`** and **`externalDocumentIssue`**. They are not named
`document` and `documentIssue`. IDs in routes are database record IDs, encoded as
strings. Reference values use **XML UIDs**, not these database IDs.

Keep these changes already present in the reviewed code:

- Use **`_msg_seq`** for SQL reads and writes. `_msgSeq` is the IR logical name.
  The previous `_msq_seq` spelling has been corrected.
- `UIAdapter` and `UIAdapterValidationError` now use `@sliwave/xsd-to-ir`.
  Confirm that this is the package actually installed in the backend's
  package.json and lockfile. Its package files were not supplied for review.
  The adapter and error class must come from the same installed package instance.
- Keep `GET /:entity/summary` **before** `GET /:entity/:id`, with `list`
  authorization. The registry currently supplies a summary for Organization.
- Keep `PUT /:entity/:id` with `update` authorization. The UI never substitutes
  PATCH if PUT fails.

### Fix authorization before live use

Locate `entity-crud.authorization.ts`, method `iamAllowed()`:

```ts
export async function iamAllowed(_request: CrudAuthorizationRequest): Promise<boolean> {
  return true;
}
```

This function does not enforce any permissions. Connect it to the backend's
actual project/entity permissions. Retain session authentication and CSRF
protection in the surrounding application; their implementation is outside the
supplied files. Do not authorize the fallback actor `"unknown"` as a real user.

Acceptance tests must exercise effective authorization, not only a mocked
`iamAllowed()` result: an unauthenticated request fails authentication, a user
without project access is denied, and each CRUD operation checks its permission.
Summary and reference-catalog requests require their corresponding list permission.

## 2. Response envelopes

A list returns `{ data, metadata }`. Find, create, and replace return `{ data }`.
Creation returns 201; replacement returns 200. Delete returns 204 with no body.
Lists and lookups exclude soft-deleted records on the **server** before counting
and pagination. The frontend does not send an `_deleted_at` filter.

```json
{
  "data": [
    {
      "id": "17",
      "uid": "org817",
      "crud": "U",
      "pendingExport": true,
      "_createdAt": "2026-10-01T08:00:00.000Z",
      "_updatedAt": "2026-11-02T09:30:00.000Z",
      "_deletedAt": null,
      "value": {
        "orgId": [{ "id": "001234", "class": "CAGE" }],
        "name": { "descr": "Example supplier", "lang": "en" },
        "docs": {
          "doc": [{ "docRef": { "uidRef": "doc23" }, "uid": "docasg91", "crud": "R" }]
        }
      }
    }
  ],
  "metadata": { "page": 1, "pageSize": 6, "total": 1, "pageCount": 1 }
}
```

Keep `id` as a string or a safe integer. Send large database IDs as strings to
avoid JavaScript precision loss. Timestamp properties have the spelling shown
above and contain ISO date-time strings. `_deletedAt` is null for active rows.
The frontend maps them to `createdAt`, `updatedAt`, and `deletedAt` internally.

`value` is the clean result from `UIAdapter.decodeRow()`, with root `uid` and
`crud` moved to the envelope. Do not expose SQL JSON strings, technical columns,
adapter state, or a root revision inside `value`. Keep existing nested UID/CRUD
attributes in nested values. The form displays these as read-only.

### Resolve the root CRUD `N` mismatch

The current **frontend** accepts root CRUD values `I`, `U`, `R`, `D`.
The reviewed backend's `entity-crud.service.ts`, `CrudMarker` and
`toEntityRecord()`, now also accept and return `N`, which the XSD permits.

In the frontend, `src/app/entity-crud-http.service.ts`, `mapRecord()`, contains:

```ts
!['I', 'U', 'R', 'D'].includes(raw.crud);
```

A record with root `N` therefore makes the current UI reject that response. This
also affects reference catalogs. Agree on its API/display/filter behaviour, then
update the frontend `CrudMarker`, `mapRecord()`, relevant display/filter controls,
and tests together with the backend. Do not silently map `N` to `U` or `R`, or
hide those records. Until this is resolved, projects containing root `N` are not
compatible with this editor. Nested values retain the generated XSD enumeration.

## 3. Full business replacement

POST and PUT bodies contain the **business value itself**, without a `value`
wrapper, database identity, root UID/CRUD, revision, or patch operations:

```http
PUT /api/projects/project-42/entities/organization/17
Content-Type: application/json

{
  "orgId": [{ "id": "001234", "class": "CAGE" }],
  "docs": null
}
```

This replaces the example above. It removes `name`, sets `docs` to explicit nil,
and removes the document assignment from active data. The backend retains any
required deletion information for export. These distinctions must survive:

| Input in a complete value      | Meaning                                              |
| ------------------------------ | ---------------------------------------------------- |
| Optional property omitted      | Remove that property                                 |
| `"docs": null`                 | Keep an explicit nil value, where the XSD permits it |
| `"name": { "descr": "" }`      | Empty text; reject if schema constraints prohibit it |
| Identifier `"001234"`          | Keep the string, including its leading zeroes        |
| Repeatable field with one item | Keep a one-item array in the clean API value         |

Do not merge the submitted business value with the old business value.
`EntityCrudService.replace()` now uses the submitted replacement correctly.
Keep it separate from the old `update()` method, which contains
`{ ...decoded.value, ...data }` and cannot remove omitted fields.

A safe replacement sequence in `EntityCrudService` is:

1. Resolve and authorize the project/entity. Start a database transaction and
   load the active row. Use the same adapter instance for decode and encode.
2. Decode the existing row. Retain `decoded.state` only inside the backend for
   this operation. Separate the existing root identity from its business value.
3. Reject unknown fields and root technical/identity fields in the request.
   Compare existing nested identities to the submitted complete value. Reject
   forged, duplicate, moved-to-an-incompatible-type, or foreign nested UIDs and
   changed client-supplied nested CRUD values. A new nested record omits both.
4. Compare complete business values before applying tracking changes. If there
   is no effective change, return the current record without writing anything.
   Keep timestamps, pending state, and nested tracking unchanged. Do not use
   JSON property order as an indication of a change.
5. Prepare root and nested identities and tracking, and record removed nested
   identities for export. Reattach the **retained** root UID for PUT; allocate it
   for POST. New records must receive schema-valid UID prefixes and values.
6. Validate the complete prepared clean entity against the generated UI schema
   and applicable runtime/project rules. Do not coerce numeric-looking strings
   or replace omitted fields with defaults. Validate references in the same
   project, including references inside JSON cells and natural identifiers.
7. Encode the complete prepared value with
   `adapter.encodeRow(entity.name, preparedValue, decoded.state)` for PUT.
   Use no prior state for POST. Persist returned SQL columns, deletion records,
   timestamps and pending/export tracking in the **same transaction**.
8. Read the stored result and return the clean envelope. Return success only
   after the transaction commits. Propagate validation and database errors.

The retained adapter state matters: it preserves XML metadata for untouched
nested values and allows removed optional columns to be cleared. In this adapter,
SQL NULL for a nullable column means **absence**. An explicit clean `null` must go
through the adapter's nil encoding; do not replace all clean nulls with SQL NULL.
SQL JSON columns can be returned by the driver as parsed objects or serialized
JSON text. Decode both with the adapter rather than parsing every column blindly.

Organization has inline JSON content. `encodeRow()` writes columns, not arbitrary
relations. Reusing this design for other entities requires separate relation
persistence in the same transaction.

### Connect POST to the preparation service

Locate `entity-crud.service.ts`, `EntityCrudService.create()`:

```ts
const preparedData = entity.beforeCreate
  ? await entity.beforeCreate(data, { ...context, knex: trx })
  : data;
const rawValues = await entity.createSchema.parseAsync(preparedData);
```

The registry attaches no `beforeCreate` hook. `prepareCreate()` exists in
`entity-change-preparation.service.ts`, but this method never calls it.
`preparedCreateSchema` is also defined but unused here. The UI submits no root
UID, the adapter does not allocate one, and the generated Organization table has
`uid NOT NULL` with no default. Creation is therefore incomplete.

In `entity-crud.registry.ts`, `buildEntityDefinition()` currently builds
`createSchema` and `updateSchema` from `writableColumns`. The corresponding
`isWritableColumn()` excludes technical columns but still includes root `uid`
and `crud`. Use known **business columns** for editable input schemas, as the
replacement schema already does. Reject managed and unknown root keys rather
than silently stripping them. Existing nested identities remain allowed on PUT
and must be checked against the previous value.

Change the create flow inside its transaction. The following fragment shows the
required connection to the existing preparation service; it is not a complete
method. `policy` is the resolved entity identity policy, and the prepared schema
must perform the complete validation described below.

```ts
const submittedValue = await entity.createSchema.parseAsync(data);
const prepared = await this.changePreparation.prepareCreate({
  trx,
  context: { ...context, knex: trx },
  entity,
  submittedValue,
  policy,
});
const validatedValue = await entity.preparedCreateSchema.parseAsync(prepared.value);
// Validate outgoing references in this transaction before inserting.
const values = {
  ...adapter.encodeRow(entity.name, validatedValue),
  _msg_seq: 0,
};
```

Preparation supplies root and nested UID/CRUD values. Persist identity ownership
and tracking history in the same transaction as the entity. Reload the stored
record and return the clean envelope after commit. Do not make the frontend
generate a UID to work around this missing connection.

Acceptance test: POST the following body through the real router, registry, and
service. It must return 201 with a server-assigned root UID and `crud: "I"`.
Repeat with new documents, remarks, and applicability values and verify their
identity handling. Reject client-supplied managed fields for new records.

```json
{
  "orgId": [{ "id": "001234" }],
  "name": { "descr": "Example supplier", "lang": "en" }
}
```

### Validate the complete prepared value

Locate `entity-crud.registry.ts`, `buildCompleteEntitySchema()`,
`buildNonNullableColumnSchema()`, and `buildObjectColumnSchema()`. These fragments
show why the current schema does not validate nested business rules:

```ts
case "array": return z.array(z.unknown());
// Object columns can use:
z.record(z.unknown());
```

Keep strict root input checks, but connect `preparedCreateSchema` and
`preparedReplaceSchema` to validation of the **generated UI JSON Schema** for
the selected entity and project issue. This can be a Zod refinement around a
compiled JSON Schema validator or a separate validation service used by both
write paths. Merely adding `uid` and `crud` to the shallow schema is insufficient.

Generate the schema with `generateUIJSONSchema(ir, { rootEntity: entity.name })`
from the installed xsd-to-ir package. Cache compiled validators by entity and IR
version. Include all referenced definitions. Disable coercion, default insertion,
and automatic removal of unknown properties. Use the required format validators.
Apply the supported assertion rules and retain explicit handling/documentation
for `x-xsd-unsupported` rules that need runtime or XML validation.

For example, this prepared value must fail validation:

```json
{
  "orgId": [{ "id": "001234" }],
  "uid": "org817",
  "crud": "U",
  "docs": { "doc": [{ "uid": "docasg91", "crud": "I" }] }
}
```

The assignment has neither `docRef` nor `docIssRef`. The generated schema rejects
it, but `UIAdapter.encodeRow()` can encode it. Encoding is not complete schema
validation. An assignment requires exactly one reference choice; the assignment's
own UID does not replace that choice. The whole optional `docs` field can be absent.

Acceptance tests must reject missing required identifiers, invalid nested choices,
invalid enumeration values, and prohibited fields. Test Organization identifier
`setBy` and Organization name `providedBy` as prohibited examples. Keep leading
zeroes, optional absence, explicit nil, and empty text distinct. Return validation
issues using the field paths in section 7, and roll back any identity/history work
when validation fails.

### Apply the same protections to any enabled PATCH route

The UI uses PUT, but `entity-crud.routes.ts` still exposes PATCH through
`EntityCrudService.update()`. That method does not use the new preparation flow
and always writes `crud: "U"`.

Either route Organization PATCH through the same identity, validation, reference,
and tracking services, or explicitly disable it for Organization until it is
supported. If retained, merge only submitted business fields with the previous
business value, then process that complete candidate. PATCH omission still means
“keep”; PUT omission means “remove”. Keeping both routes must not provide a way
to bypass the protections on PUT.

## 4. Identity, tracking and reference services

`EntityChangePreparationService.prepareReplacement()` now receives the previous
value and transaction. Keep this separation from route handling and HTTP
serialization. The remaining work is to complete its coverage and connect its
history to the import/export lifecycle. This frontend has no allocator.

### Cover every nested identity-bearing value

Locate `organization-identity.policy.ts`, `organizationIdentityPolicyV11`:

```ts
nested: [
  {
    identityType: 'organizationDocumentAssignment',
    path: ['docs', 'doc'],
    // UID rules follow here.
  },
];
```

This only covers document assignments directly attached to the Organization.
`prepareReplacement()` only visits the paths in that policy. It does not prepare
or protect remarks, applicability expressions, or assignments deeper inside them.
For example, changing the UID/CRUD on `rmks.rmk[]` currently passes through
preparation. New remarks also receive no identity from that method.

Build the traversal from the selected IR/UI value-type metadata. Walk the actual
submitted and previous values, following objects, arrays, and active choices.
Recursive types must not cause an infinite expansion: visit the values that
exist, rather than eagerly expanding every possible schema path.

- Identify actual UID/CRUD attributes on each value type. `uidRef` points to
  another record; it is not an identity to allocate.
- Preserve existing root and nested UIDs. Match existing nested records by UID
  and compatible type, not only by array position.
- Reject duplicate, foreign, forged, and incompatible moved identities, plus
  changed client-supplied tracking values, at every nesting level.
- New identity-bearing records omit UID/CRUD in the request. Allocate their
  project-unique, schema-valid identities on the server and set their action to I.
- Use issue-specific UID constraints from metadata. If additional policy is
  needed, make it explicit and test it against the XSD. A guessed prefix or a
  permissive regular expression is not a replacement for those constraints.
- Preserve unchanged nested tracking. Changed established records use U; changed
  records that have never been established remain I.
- Retain removed nested values in export history outside the active business
  value. Handle removals caused by omission, explicit nil, and choice changes.

Acceptance tests must include root documents, `rmks.rmk[]`, documents inside a
remark, and recursive applicability. Test adding, editing, reordering, and removing
them. Attempt to forge UID/CRUD in each location. A fixed list containing only
`docs.doc` must not be sufficient for these tests to pass.

### Handle existing nested values without a UID

Locate `entity-change-preparation.service.ts`, `prepareNestedPath()` and
`readRequiredUid()`:

```ts
const uid = this.readRequiredUid(previousItem);
```

`readRequiredUid()` throws a generic error if the stored item has no UID. However,
Issue 1.1 `documentAssignment` permits its UID to be absent. For example, this
fragment is valid when the referenced document exists:

```json
{
  "docs": {
    "doc": [{ "docRef": { "uidRef": "doc23" } }]
  }
}
```

An unrelated name edit currently fails when this fragment is in the previous
value. Do not treat optional XML identity as corrupt data.

Preserve unchanged values without UIDs during unrelated edits. For edits and
removals that need individual tracking, implement an explicit legacy policy:
retain sufficient previous-value history, or assign identities through a
controlled server-side backfill. Do not classify imported data as newly created
merely because it received an identity. Do not guess matches solely from array
positions when users reorder values. Keep adapter state and untouched metadata.

Acceptance tests: import a valid assignment without a UID, change only the
Organization name, and save successfully. Also test editing, reordering, and
removing those legacy assignments under the chosen tracking policy. An unchanged
save must not allocate UIDs or change timestamps/pending state as a side effect.

### Install and populate history storage

The supplied classes refer to three new tables. Their migrations and lifecycle
writers were not included in the reviewed document. Confirm them in the backend
project; add them if absent. They are not supplied by this example's generated
entity DDL.

| Table                      | Code that uses it                                                | Required integration                                                                                 |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `_entity_identity_history` | `MariaDbEntityIdentityHistory.isEstablished()` and `findOwner()` | Record identity ownership on creation/import/backfill and establishment on import/successful export. |
| `_entity_uid_sequence`     | `MariaDbEntityUidAllocator.allocate()`                           | Create and lock allocation state, and prevent collisions with existing imported or allocated UIDs.   |
| `_entity_nested_deletion`  | `MariaDbEntityIdentityHistory.recordNestedDeletion()`            | Store removed values transactionally and retain them until the export workflow has processed them.   |

Apply migrations to existing project databases as well as new ones. The reviewed
implementation uses one database per project. Preserve that scope for all three
tables. If they are moved to shared storage, project identity must also be part
of their keys and queries.

The history reader currently contains:

```ts
if (!row) return false;
```

Without history population, an established imported Organization can become I
when edited. Backfill establishment from authoritative import/export records;
do not infer it solely from current CRUD or `_msg_seq`, which becomes zero again
after an edit. Treat missing history for existing data as a condition to resolve,
not proof that the record is new. Keep import/export writers and new-record
ownership updates consistent with the preparation service's identity-type keys.

The allocator initializes each sequence with `next_value: 1`. Locking that
sequence prevents simultaneous allocations from using the same number, but does
not prevent a collision with an imported `org1` or `docasg1`. Reserve/check UIDs
against project-wide identity ownership, including nested identities and retained
history, and retry or advance the sequence within the transaction. Reusing the
same XML UID prefix through different policies must not create separate,
conflicting allocation spaces.

Acceptance tests must use a migrated database with imported identities and an
initially absent sequence. Verify no collisions, imported edits becoming U, new
records retaining I across edits, and establishment after successful export.
Check rollback of entity changes, allocations, and deletion history together.
An unchanged save must leave timestamps, tracking, and history unchanged.

### Validate outgoing and incoming references

Locate `entity-crud.service.ts`, `create()`, `replace()`, and `delete()`.
The reviewed code has no reference-resolution step. `delete()` currently only
updates `_deleted_at`, `_updated_at`, `crud`, and `_msg_seq`.

Add a reusable reference service that uses the selected issue's metadata and the
same project transaction. Before saving, resolve UID and permitted natural-key
references to active records of the correct type. Reject missing, ambiguous, or
wrong-type targets. Cover Organization, document, document-issue, and applicability
references, including those nested inside JSON. Schema validation checks the
reference's structure; it does not prove that its target exists.

Before deleting an Organization or changing its natural identifiers, check
incoming references across the project, including JSON values. Reject an action
that would break them. SQL foreign-key error translation alone cannot do this;
soft deletion is an UPDATE and JSON references are not SQL foreign keys.

Persist an allowed root deletion with D, a soft-delete timestamp, and pending
state in the same transaction as the checks and required history. The UI never
allocates a message sequence or marks a record exported.

Acceptance tests: a stale catalog choice fails without writing; a missing or
ambiguous natural identifier fails; a reference of the wrong type fails; and an
incoming JSON reference blocks deletion or an identifier change that would break
it. Removing the dependency must allow a subsequent valid operation. Return the
existing conflict/validation envelopes described in section 7.

## 5. Organization queries and reference catalogs

### Implement logical filters before column-filter resolution

Locate `entity-crud.service.ts`, `list()`, `resolveAndValidateFilters()`, and
`resolveColumn()`. The current list path sends every filter through:

```ts
const column = this.resolveColumn(entity, field);
```

`search` and `status` are UI query features, not Organization columns. Non-empty
`filter.search` or `filter.status` therefore produces an invalid-query error.
The route already extracts `filter.*` parameters; the missing part is their
Organization-specific interpretation in the service.

For Organization, separate the logical filters before resolving remaining column
filters. This fragment only illustrates that separation:

```ts
const { search, status, ...columnFilters } = input.filters;
const resolvedFilters = this.resolveAndValidateFilters(entity, columnFilters);
```

Validate `search` as text and `status` against the supported values below.
Implement pending status using `_msg_seq = 0`; implement R/I/U status using the
`crud` column. Keep the active-row condition in every case. Apply these rules to
both the result set and its count. Other entities can retain their existing
column-filter contract.

Example list request:

```http
GET /api/projects/project-42/entities/organization?page=1&pageSize=6&sortBy=_updatedAt&sortDirection=desc&filter.search=001234&filter.status=pending
```

- `page` starts at 1. `pageSize` supports 6, 12, 24 and **100**; reject invalid
  bounds. `metadata.total` is the number after filtering and before pagination.
  `pageCount = ceil(total / pageSize)`; an empty result has pageCount 0.
- `filter.search`: case-insensitive substring search over Organization name and
  **all** Organization identifiers. Preserve leading zeroes. Empty means no
  search. Treat user text as literal text, not a SQL pattern or expression.
- `filter.status`: omitted/empty for all active records; `pending` for active
  pending records; `R`, `I`, or `U` for the corresponding CRUD marker. Deletions
  belong in summary/history, not the active table.
- The screen uses `sortBy=crud` for **Change status** or `sortBy=_updatedAt` for
  **Last update**, with `sortDirection=asc` or `desc`. It initially requests
  `_updatedAt` descending, so recently updated records appear first. The backend
  can retain its existing primary-key default when `sortBy` is omitted.
- Reuse the existing `sortBy`/`sortDirection` route parameters, column resolver,
  and sortable-column allow-list. `crud` maps to SQL `crud`; `_updatedAt` maps to
  SQL `_updated_at`. The request uses the existing IR field name `_updatedAt`,
  even though the frontend record mapper exposes `updatedAt` for display.
- Name, identifier, and document-count columns have no sort controls. This screen
  requires no sorting within inline JSON and no calculated sort fields.
- Add the primary key ascending as the final tie-breaker after the selected
  column. This keeps pagination stable when several records have the same status
  or timestamp.

In `list()`, keep the selected scalar order and add the tie-breaker before
pagination. Avoid adding the primary key twice when it is already selected:

```ts
dataQuery.orderBy(sortColumn, sortDirection);
if (sortColumn !== entity.primaryKey) {
  dataQuery.orderBy(entity.primaryKey, 'asc');
}
```

Apply logical search, filtering, sorting, and active-row rules **before** SQL
pagination and count. The supplied service already sorts scalar SQL columns
before pagination. Search and status filters still need implementation. In
particular, name/identifier search must inspect business values inside JSON.
An initial implementation may decode eligible rows before filtering, then apply
the selected scalar sort and pagination; measure it and add database projections
or indexes as needed. Do not page SQL rows and then search only that page. Handle
both parsed JSON and serialized JSON representations, and legacy singleton
repeating values through adapter normalization. Direct document counts are still
required for the summary endpoint, but are not used for sorting.

Acceptance tests must use more than one page. Search for an identifier on a later
page and verify both the returned row and filtered total. Include multiple
identifiers, `"001234"`, case differences, and literal `%` and `_` in the search
text. Test pending and each CRUD filter, combinations with search, and invalid
status values. Equal timestamps/statuses must have a stable primary-key order.

### Keep reference catalogs complete

All four reference endpoints support `page`, `pageSize=100`, `sortBy=uid`, and
`sortDirection=asc`, and return the same record/list envelopes. Do not silently
cap pageSize below 100 or truncate a page. Require list permissions for each
catalog. Failed or inconsistent pages must cause a visible error, not partial
choices. The frontend requests every page, checks counts/UID uniqueness, caches
complete catalogs per project, and invalidates them after Organization writes.
Refresh connection also reloads catalogs. Future concurrent external writes need
a cache-expiration policy; this example assumes one active editor.

The choices use the record's XML UID. Labels use name/identifier for Organizations,
docId/docTitle for documents, docIssId for issues, and applicId/applicDescr for
applicability; they fall back to UID. Manual natural-identifier forms remain
available. Document issue labels cannot invent a parent document relation absent
from the response; the backend may provide distinct issue identifiers or a later
agreed display-label extension if needed.

Acceptance test: serve more than 100 records from a catalog, verify the last page
and total, and confirm that all choices reach the UI. Include authorization
failure and root CRUD `N` compatibility in catalog tests, not only the main list.

## 6. Organization summary

```http
GET /api/projects/project-42/entities/organization/summary
```

```json
{
  "data": { "schemaIssue": "1.1", "total": 8, "pending": 2, "documents": 3, "deleted": 1 }
}
```

All counts are non-negative integers, scoped to the project:

- `total`: active Organizations only.
- `pending`: all pending Organizations, **including soft-deleted records**.
- `documents`: the sum of direct `docs.doc` assignments on active Organizations.
  Count assignments, not unique documents. Exclude documents nested in names,
  remarks, or applicability, and exclude deleted Organizations.
- `deleted`: soft-deleted Organizations, whether pending or already exported.

Return the **actual project schema issue**, not a hardcoded UI preference. The
frontend waits for `schemaIssue === "1.1"` before loading the editor's records and
enabling changes. A missing endpoint, authorization failure, or issue mismatch
leaves editing disabled. Summary counts are independent of current table filters.

### Correct the singleton-document branch

Locate `organization-summary.ts`, `getOrganizationSummary()`. The current
`documents` expression contains:

```sql
CASE WHEN JSON_TYPE(JSON_EXTRACT(??, '$.doc')) = 'ARRAY'
     THEN JSON_LENGTH(??, '$.doc')
     WHEN 'OBJECT' THEN 1
     ELSE 0
END
```

This mixes the two SQL CASE forms. `WHEN 'OBJECT'` is a condition by itself; it
does not compare the JSON type. Also, using `JSON_LENGTH` alone on an object would
count its members, not one assignment. See the
[MariaDB CASE documentation](https://mariadb.com/docs/server/reference/sql-functions/control-flow-functions/case-operator)
and [JSON_LENGTH documentation](https://mariadb.com/docs/server/reference/sql-functions/special-functions/json-functions/json_length).

Replace the `documents` expression with:

```ts
documents: knex.raw(
  `COALESCE(SUM(
    CASE WHEN ?? IS NOT NULL THEN 0
      ELSE CASE JSON_TYPE(JSON_EXTRACT(??, '$.doc'))
        WHEN 'ARRAY' THEN JSON_LENGTH(??, '$.doc')
        WHEN 'OBJECT' THEN 1
        ELSE 0
      END
    END
  ), 0)`,
  ["_deleted_at", "docs", "docs"],
),
```

The other count definitions match the contract, provided `_msg_seq = 0` means
pending in the backend's tracking workflow. In `toNonNegativeInteger()`, use
`Number.isSafeInteger(numericValue)` and reject negative values. The UI requires
safe integer counts too; `Number.isInteger()` alone is not enough.

Test the SQL against MariaDB. A mock that returns `{ documents: "3" }` only tests
result conversion and cannot detect this SQL error. Use, for example:

| Organization | State        | `_msg_seq` | Direct `docs.doc`                  | Document contribution |
| ------------ | ------------ | ---------- | ---------------------------------- | --------------------- |
| A            | Active       | 7          | One object with several properties | 1                     |
| B            | Active       | 0          | Array with two assignments         | 2                     |
| C            | Active       | 7          | No documents                       | 0                     |
| D            | Soft-deleted | 0          | Array with two assignments         | 0                     |

Expected summary: `{ schemaIssue: "1.1", total: 3, pending: 2, documents: 3, deleted: 1 }`.
Also test an empty table, explicit nil/missing `doc`, an empty array, documents
inside remarks that must not be counted, and the actual project issue value.

## 7. Error envelopes

Keep existing error codes and fields. Structured validation issues use JSON
Pointers **relative to the editable value**, without a `/value` prefix:

```json
{
  "error": "invalid_request",
  "message": "Check the marked fields.",
  "details": {
    "issues": [
      { "path": "/orgId/0/id", "message": "An identifier is required." },
      { "path": "/docs/doc/0/docRef", "message": "The document reference does not resolve." }
    ]
  }
}
```

Use `path: ""` for form-level rules. Encode `~` as `~0` and `/` as `~1` in path
segments. The editor links known paths to fields; unknown paths remain visible in
the validation summary. Do not invent a field path for a plain adapter error.

The existing Zod envelope also works:

```json
{
  "error": "invalid_request",
  "message": "The request is invalid.",
  "details": { "fieldErrors": { "orgId": ["An identifier is required."] }, "formErrors": [] }
}
```

Zod flattened keys are top-level field names. Structured `issues` are preferred
for deep field errors. A message-only `UIAdapterValidationError` is displayed as a
form-level message. Preserve 401/403 permission errors, 409 `status` for project
state, and `constraint` for database conflicts. For example:

```json
{
  "error": "project_not_ready",
  "message": "The project import is still running.",
  "status": "importing"
}
```

The UI keeps the draft after failure, prevents overlapping writes, and does not
silently retry PUT as PATCH. After a network failure, the client cannot know
whether a transaction committed. Refresh/read the record before retrying a create
whose result is unknown; this contract does not add idempotency keys.

## 8. Backend verification and live handoff

### Repair the supplied tests before using them as evidence

Locate `entity-crud.e2e.spec.ts`, test `"POST (create) organization for project 1"`.
It currently expects 200, while `entity-crud.routes.ts` returns 201. It sends an
identifier/name and then asserts different values copied from another test.
Expect 201 and verify the values actually submitted, together with server-assigned
identity and tracking. Use an isolated test project instead of depending on a
fixed existing Organization ID.

The existing end-to-end update test uses PATCH. Add PUT tests that exercise the
actual registry, preparation, validation, database, and response mapper together.
Mocked preparation and prebuilt database results cannot establish that the complete
flow works. In the replacement tests, assert the encoded absence/nil difference
and the value read back; checking that `update()` was called is insufficient.

The reviewed document contains reconstructed tests, not verified test results.
Run the backend's own type/build checks, migrations, unit tests, and integration
tests on its actual source. Its optional end-to-end suite is gated by
`END2END=true`; ensure it really executes in the integration test run.

### Backend acceptance checklist

Before live handoff, verify:

- [ ] POST through the real router allocates root and nested identities, rejects
      client-managed fields, returns 201, and preserves `"001234"`.
- [ ] Full replacement removes omitted optional fields; explicit nil survives
      `decodeRow -> encodeRow -> database -> decodeRow`, with both JSON driver forms.
- [ ] Root and nested identity allocation, unchanged identity preservation,
      forgery/duplicate rejection, and nested deletion history work throughout
      remarks, documents, and recursive applicability.
- [ ] Existing optional nested UIDs may be absent. Unrelated edits succeed;
      editing/removal/reordering follows the documented legacy tracking policy.
- [ ] Generated-schema validation rejects missing required identifiers, invalid
      choices, prohibited fields, and applicable assertion violations.
- [ ] Established/new tracking rules and no-op behavior, including unchanged
      timestamps, message state, and pending flag, use real persisted history.
- [ ] History tables exist in new and existing project databases. Import/export
      writers maintain them, and allocation does not collide with imported UIDs.
- [ ] Reference validation, deletion and identifier-change protection, atomic
      rollback on validation or persistence failure.
- [ ] Any enabled PATCH path enforces the same protections while retaining PATCH
      semantics; it cannot bypass the PUT/create rules.
- [ ] Search/status queries across more than one page, stable scalar-sort ties,
      and complete catalogs beyond 100 records.
- [ ] Summary SQL correctly counts singleton/array assignments and pending
      deletions, independently of the table filters.
- [ ] Root CRUD `N` behaviour is agreed and compatible with both list and catalog
      consumers; it is not silently rewritten or dropped.
- [ ] Summary route ordering, effective permissions, ready-state checks,
      structured errors, cookies, and the installation's CSRF policy.

### Connect and verify the UI

Then point the UI at a dedicated Issue 1.1 test project. Verify a real list,
create, edit, omission, explicit null, nested document/remark edit, reference
selection, failed save, and delete. Reload between operations and inspect stored
values and tracking. Check the normal XML validation/export path separately.

Set `apiBasePath`, `projectId`, `projectLabel`, and `schemaIssue` in
`public/organizations.config.json`. Use the same-origin session or development
proxy described in [README.md](README.md). The UI first calls the summary endpoint
and requires `schemaIssue === "1.1"`; then it loads records and reference catalogs.
Use the browser's network panel to check the requested method, parameters, body,
and response when a step fails. Keep failed drafts available for correction.

**Live verification is outstanding.** No backend URL, credentials, or test project
were supplied. The automated frontend tests intercept HTTP requests with explicit
fixtures; those fixtures exercise the UI contract, not transaction behavior,
production reference resolution, UID uniqueness, or actual import/export history.
