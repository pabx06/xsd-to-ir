# Organizations editor: backend contract

**Updated 8 November 2026.** The recovered backend and its fixes are now in
[the backend example](../entity-crud-backend/README.md). Commit **`bf4e789`** is the
unchanged recovered baseline. The later implementation replaces the incomplete
write paths and provides migrations, integration functions, and runnable tests.
The earlier review is preserved in Git history at `757b4c0`.

The supplied document was reconstructed from photographs. Compare it with the
actual backend before copying code. No application files in the separate backend
project have been changed or deployed by this work.

## What is implemented, and what your developer must connect

| Area              | Implemented in the example                                                                        | Host work that remains                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| CRUD              | Clean responses, POST preparation, complete PUT, protected PATCH, soft deletion, no-op detection. | Copy the modules and mount the router.                                         |
| Validation        | Prepared values are checked against the generated UI schema.                                      | Supply additional project/XSD rules where needed.                              |
| Identity          | Recursive allocation, UID ownership, nested CRUD, nil identities, explicit legacy backfill.       | Migrate existing databases and classify existing identities from real history. |
| References        | UID and natural-identifier resolution, incoming JSON and SQL relation protection.                 | Connect any external/custom reference resolver.                                |
| Queries           | Search/status before pagination, scalar sorts with a stable final key.                            | Check performance with actual project data.                                    |
| Summary           | Correct singleton/array counts and pending deletions.                                             | Verify existing rows obey the pending convention.                              |
| Authorization     | Required actor and permission callbacks; unknown actors are denied.                               | Connect authenticated sessions and the real IAM policy.                        |
| Exchange tracking | History, deletion snapshots, import registration, export acknowledgement.                         | Connect the actual importer/exporter and message allocator.                    |
| UI compatibility  | CRUD `N` is accepted and displayed as **Unchanged**.                                              | Deploy matching frontend and backend versions.                                 |

Follow the backend example's [integration steps](../entity-crud-backend/README.md#integrate-into-the-host-backend).
They identify the filenames, methods, dependency changes, migration order, and
host callbacks. The separate backend is ready for live testing only after that
integration. Tests in this repository verify this implementation, not the
deployed host's authentication, migrations, or exchange engine.

## Connection and routes

Use the same-origin session API base path, usually `/api`. Select the database
and schema issue from the authenticated project context. This frontend supports
**Issue 1.1** and one active editing session per project. It does not send a
revision, ETag, message sequence, or schema selector in a write request.

All paths below follow `/projects/{projectId}/entities`:

| Method | Path                                                                     | Permission             |
| ------ | ------------------------------------------------------------------------ | ---------------------- |
| GET    | `/organization`                                                          | `list`                 |
| GET    | `/organization/summary`                                                  | `list`                 |
| GET    | `/organization/{id}`                                                     | `read`                 |
| POST   | `/organization`                                                          | `create`               |
| PUT    | `/organization/{id}`                                                     | `update`               |
| DELETE | `/organization/{id}`                                                     | `delete`               |
| GET    | `/externalDocument`, `/externalDocumentIssue`, `/applicabilityStatement` | `list` for each entity |

Register `/summary` before `/:id`. Preserve session authentication, CSRF checks,
project-ready checks, and per-operation permissions. The reference catalogs also
require permission. Entity names are case-sensitive IR names. Reference values
use XML UIDs, while route IDs are database IDs encoded as strings.

The example also keeps `PATCH /:entity/:id` for backend callers. It merges the
submitted business fields with the current business value and runs the same
preparation, validation, reference, and persistence pipeline as PUT. The editor
uses PUT and does not fall back to PATCH.

Use `_msg_seq` consistently in SQL. `_msgSeq` is its IR logical name.
`xsd-runtime.ts` centralizes package imports; align them with the package actually
installed in the host. The recovered code imported `UIAdapterValidationError`,
but this repository does not export that class. The example catches write-codec
errors in `EntityCrudService.encode()` and returns a form-level validation issue.

## Read responses

Single-record and create/update responses use `{ data: record }`:

```json
{
  "data": {
    "id": "42",
    "uid": "org42",
    "crud": "U",
    "pendingExport": true,
    "_createdAt": "2026-10-28T10:52:47.546Z",
    "_updatedAt": "2026-11-08T09:00:00.000Z",
    "_deletedAt": null,
    "value": {
      "orgId": [{ "id": "001234" }],
      "name": { "descr": "Example Engineering" }
    }
  }
}
```

An ID can be a string or a safe JavaScript integer. Configure large database IDs
as strings. Timestamps are ISO UTC strings. The frontend maps them to its
`createdAt`, `updatedAt`, and `deletedAt` properties.

`value` contains the clean `UIAdapter.decodeRow()` business value. Root `uid` and
`crud` belong in the envelope. Existing nested identities remain inside nested
values and are read-only in the editor. Do not send SQL JSON strings, technical
columns, or adapter state inside `value`.

CRUD values `I`, `U`, `R`, `D`, and `N` are preserved. `N` means **Unchanged** in
the UI; it must not be remapped to another marker. Lists and normal record reads
exclude soft-deleted rows on the server. `pendingExport` is true when the stored
`_msg_seq` is zero, including for a deletion in the summary.

List responses preserve the existing envelope:

```json
{
  "data": [],
  "metadata": { "page": 1, "pageSize": 20, "total": 0, "pageCount": 0 }
}
```

## Writes and validation

POST and PUT send the complete business value directly:

```json
{
  "orgId": [{ "id": "001234" }],
  "name": { "descr": "Example Engineering" },
  "docs": {
    "doc": [{ "docRef": { "uidRef": "doc123" } }]
  }
}
```

There is no `value` wrapper, root `uid`/`crud`, technical field, revision, or patch
operation in this body. Existing nested records retain their returned UID and
CRUD. New nested records omit both. POST returns 201, PUT/PATCH return 200, and
DELETE returns 204.

For PUT, omission removes an optional field. Explicit `null` retains its XML nil
meaning. An empty string is a third value and remains subject to schema rules.
The service decodes the old row and encodes through the **same adapter instance
and retained state**. This preserves XML metadata on untouched values. SQL NULL
represents an absent optional JSON field; encoded `xsi:nil` represents explicit
nil. Do not implement PUT as a shallow SQL update of only supplied columns.

`EntityCrudService.create()` and `change()` perform these steps in one transaction:

1. Acquire the project write lock and check history readiness.
2. Read the current row where applicable. Preserve the server-owned root identity.
3. Prepare nested identities and tracking from IR metadata. Reject forged,
   duplicated, foreign, or incompatible identities.
4. Skip a no-op save without changing timestamps, pending state, or history.
5. Validate the complete prepared value against the generated UI JSON Schema and
   any additional host rules.
6. Encode with retained state, reconcile stored identities, and validate outgoing
   and incoming references.
7. Write the row, ownership changes, deletion snapshots, and change log. Return
   the newly decoded row.

The generated schema checks identifiers, scalar types, enumerations, choices,
cardinality, supported assertions, and prohibited fields. For example,
Organization identifiers prohibit `setBy`; Organization names prohibit
`providedBy`. A document assignment requires the permitted `docRef` or
`docIssRef` branch. Decoding through the adapter alone is not full validation.

The schema reports unsupported rules through `entity.validationWarnings()`.
The host can use `validateAdditional` for project rules and XSD constraints not
fully represented by JSON Schema. Do not claim full XSD validation from Ajv alone.

## Identity, change tracking, and references

UID prefixes come from schema constraints, not table names. The allocator checks
project-wide ownership, including imported and deleted identities. Preparation
walks actual nested fields, including documents, remarks, organization assignments,
and recursive applicability. It does not use a fixed `docs.doc[]` path list.

New records use `I`. An effective change to an established root or nested value
uses `U`; an unestablished record retains `I`. Unchanged nested values retain their
tracking. Establishment comes from persisted import/export history. Current CRUD
or `_msg_seq` cannot reliably supply that history.

`stored-identities.ts` also reads XML attributes hidden by a clean UI `null`.
Those UIDs remain reserved. A retained nil identity is not recorded as deleted.
Removed identities are retained outside the active form value. The host exporter
must consume the deletion and change logs and acknowledge successful exports.
The example does not allocate message sequences or generate delta XML.

Imported nested values without optional UIDs can survive unrelated edits
unchanged. Editing or removing them returns `legacy_identity_required`. Use
`EntityCrudService.backfillIdentities()` through an authorized administrative
operation, then reload the record before editing. This operation is explicit;
ordinary reads and unchanged saves never allocate identities.

Reference checks resolve to active values of the permitted type. The default
resolver supports UID and natural-identifier forms and follows parent scope for
document issues. Tests include external documents, applicability, Organizations,
and DMC/PMC documents and issues. Missing, ambiguous, or wrong-type targets fail.
Supply a host resolver for external/custom forms that the default resolver cannot
evaluate. Deleting a referenced record or changing its referenced natural key
fails with a conflict. A SQL foreign key does not protect references inside JSON.

## Query and summary behavior

The Organization UI sends `page`, `pageSize`, `sortBy`, `sortDirection`,
`filter.search`, and `filter.status`. Page numbers start at 1; page sizes are 1–100.
The normal page size is 6. Reference catalogs request pages of up to 100 until
all pages are loaded. Do not silently truncate them.

- `filter.search` matches Organization names and all identifiers, case-insensitively.
  Leading zeroes remain significant. `%` and `_` are literal characters.
- `filter.status` accepts empty/all, `pending`, `I`, `U`, `R`, and `N`. Pending
  filtering uses `_msg_seq = 0`. Active lists exclude deletions.
- Sorts use scalar columns. The UI exposes `crud` and `_updatedAt`;
  `uid` is used for reference catalogs. `id` is also supported.
  Map `_updatedAt` to `_updated_at`. Append the primary key ascending as the final
  sort key when sorting by another column.
- Filtering and sorting happen before pagination and total-count calculation.
  Unknown filters, invalid status values, and unsupported sorts return 400.

There is no UI requirement to sort names, identifiers, or counts inside JSON.
Logical search still needs to read their content. The example currently decodes
eligible rows before paging for search, supporting both stored singleton and
array JSON. Measure large-project performance before choosing an indexed version.

`GET /organization/summary` returns:

```json
{
  "data": {
    "schemaIssue": "1.1",
    "total": 8,
    "pending": 3,
    "documents": 5,
    "deleted": 1
  }
}
```

| Field       | Definition                                                          |
| ----------- | ------------------------------------------------------------------- |
| `total`     | Organizations with `_deleted_at IS NULL`.                           |
| `pending`   | All Organizations with `_msg_seq = 0`, including soft-deleted rows. |
| `documents` | Direct `docs.doc` assignments on active Organizations only.         |
| `deleted`   | Organizations with `_deleted_at IS NOT NULL`.                       |

An array contributes its length; one object contributes **one** assignment.
An absent, nil, or empty assignment contributes zero. Do not count documents under
names, remarks, or applicability. The fixed `getOrganizationSummary()` uses
`JSON_TYPE()` before `JSON_LENGTH()`: MariaDB object length counts members, not
assignments. Summary values are non-negative safe integers. The UI requires
`schemaIssue === "1.1"` before enabling edits. Counts describe the whole project,
not the current page or search result.

## Errors and handoff checks

Preserve the existing `error`, `message`, `details`, `status`, and `constraint`
envelope. Field issues use JSON pointers relative to the editable business value:

```json
{
  "error": "invalid_request",
  "message": "The submitted value is invalid.",
  "details": {
    "issues": [{ "path": "/orgId/0/id", "message": "must NOT have fewer than 1 characters" }]
  }
}
```

Use an empty path for a form-level issue. The frontend also handles Zod
`details.fieldErrors` and message-only errors. Preserve project status and named
database constraints. An invalid input returns 400, unauthenticated access 401,
denied access 403, a missing active record 404, and reference/state conflicts 409.
Unexpected failures return a generic 500 response and are logged by the host.
Failed saves leave the database unchanged and the frontend draft open.

Before enabling the real project:

1. Compare the recovered files with the real backend and integrate the complete
   module set. Align package paths in `xsd-runtime.ts`.
2. Run migrations and initialize ownership using real establishment history.
   Connect importer, exporter, message allocation, and the shared project lock.
3. Connect session/IAM and additional project rules. Confirm unauthorized requests
   fail for main rows, summary, and reference catalogs.
4. Run the backend unit and real MariaDB integration suites. Run the Angular unit,
   build, and browser checks using the documented commands.
5. Configure a dedicated Issue 1.1 project and run live create, replace, no-op,
   delete, search, summary, reference, and failure checks. Verify imported
   singleton JSON and nil values, established/new CRUD behavior, root `N`, and
   export acknowledgement against actual history.

Repository integration tests use the implemented service and real generated DDL
on an isolated MariaDB database. Browser tests use explicit HTTP fixtures. Neither
test set establishes that the separate backend has been integrated or deployed.
