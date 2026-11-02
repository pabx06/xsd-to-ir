# Organizations editor: backend contract

This document is the handoff for the **separate backend project**. The frontend in
this directory implements this contract. The supplied `entity-crud.service.ts`,
`entity-crud.routes.ts`, `entity-crud.registry.ts`, and `entity-crud.types.ts` were
reviewed as reference files. They have not been changed here.

**The supplied backend does not yet meet this contract.** In particular, it has no
PUT or summary route, no Organization identity hooks, and no Organization search
or status-filter implementation. Its existing scalar-column sorting is sufficient
for this screen, with the stable primary-key tie-breaker described below. Passing
this example's HTTP fixture tests does not verify that backend. Complete the
checklist below before connecting a real project.

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

- [ ] Fix `_msq_seq` to **`_msg_seq`** everywhere in the service, including pending
      detection, create, update, and delete. `_msgSeq` is the IR logical name;
      `_msg_seq` is the SQL column. Do not introduce a second column.
- [ ] Align the `@slivawex/xsd-to-ir`, `@slivave/xsd-to-ir`, and
      `@sliwave/xsd-to-ir` imports with the package actually installed by the
      backend. The backend package.json was not supplied. The adapter and its
      error class must come from the same installed package instance.
- [ ] Register `GET /:entity/summary` **before** `GET /:entity/:id`, with the same
      context resolution and `list` authorization. Restrict this summary to
      Organization unless another entity has its own summary implementation.
- [ ] Add `PUT /:entity/:id` with `update` authorization. This frontend never
      substitutes PATCH if PUT fails.

## 2. Response envelopes

A list returns `{ data, metadata }`. Find, create, and replace return `{ data }`.
Creation can return 201; replacement returns 200. Delete returns 204 with no body.
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

The current backend envelope permits root CRUD values `I`, `U`, `R`, `D`.
This is separate from the XSD's wider enumeration, which also permits `N`.
If imports expose root `N`, agree on that API extension and its display/filter
semantics before using this editor; do not silently classify it as an update.
Nested values retain the generated XSD enumeration.

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

Do not merge the submitted business value with the old business value. The
existing `{ ...decoded.value, ...data }` update implementation cannot remove
omitted fields and must not be reused for PUT.

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

## 4. Identity, tracking and reference services

The supplied registry declares optional `beforeCreate`/`beforeUpdate` hooks but
**does not attach them to generated definitions**. Its managed-column list also
does not exclude root `uid`. Passing these payloads directly to the supplied
create/update service is therefore insufficient.

- [ ] Exclude root `uid`, `crud`, database ID, timestamps, sequence and other
      technical columns from editable schemas. Accept only known business keys.
- [ ] Register identity preparation explicitly. A reusable service should walk
      the selected IR/UI contract and operate on the submitted value plus its
      previous value. Use UID constraints from that issue's metadata. Do not
      infer a prefix from a table name or use frontend counters.
- [ ] Give preparation access to the transaction and persisted import/export
      history. The current update hook signature only receives the proposed
      value and context; extend it or introduce a dedicated preparation service
      so it can compare against the previous entity and collect deletions.
- [ ] Preserve root and existing nested identities. New roots and nested records
      receive server-generated, project-unique, schema-valid identities.
- [ ] Keep `I` for records that are not yet established in import/export history.
      Use `U` for changed established records. Apply the corresponding policy to
      nested identities. Do not infer establishment from the current CRUD marker
      alone, or set every save to `U`.
- [ ] Keep removed nested values/identities outside active editable values, in
      backend change history sufficient for later export. A root DELETE sets
      `D`, `_deleted_at`, pending state and timestamps according to project policy.
- [ ] Check incoming Organization references before deletion and before changes
      to natural identifiers. SQL foreign keys alone cannot protect references
      inside JSON cells. Reject missing or ambiguous outgoing references too.
- [ ] Validate document versus document-issue and applicability reference forms.
      Catalog choices are suggestions, not proof that a reference still exists.
- [ ] Set `pendingExport` from backend history and the corrected `_msg_seq`
      convention. The UI never allocates a message sequence or marks a record
      exported. Keep export/message allocation in the backend workflow.

Keep identity allocation and change preparation separate from route handling and
HTTP serialization. Then other work areas can reuse them through the same CRUD
service with issue-specific IR metadata. This frontend has no allocator.

## 5. Organization queries and reference catalogs

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

Before deployment, add backend tests for:

- [ ] Full replacement removes omitted optional fields; explicit nil survives
      `decodeRow -> encodeRow -> database -> decodeRow`, with both JSON driver forms.
- [ ] Root and nested identity allocation, unchanged identity preservation,
      forgery/duplicate rejection, and nested deletion history.
- [ ] Established/new tracking rules and no-op behavior, including unchanged
      timestamps, message state, and pending flag.
- [ ] Reference validation, deletion and identifier-change protection, atomic
      rollback on validation or persistence failure.
- [ ] Logical queries across more than one page, stable ties, direct-document
      counts, and summaries that include pending deletions.
- [ ] Summary route ordering, all permissions, ready-state checks, structured
      errors, cookies, and the installation's CSRF policy.

Then point the UI at a dedicated Issue 1.1 test project. Verify a real list,
create, edit, omission, explicit null, nested document/remark edit, reference
selection, failed save, and delete. Reload between operations and inspect stored
values and tracking. Check the normal XML validation/export path separately.

**Live verification is outstanding.** No backend URL, credentials, or test project
were supplied. The automated frontend tests intercept HTTP requests with explicit
fixtures; those fixtures exercise the UI contract, not transaction behavior,
production reference resolution, UID uniqueness, or actual import/export history.
