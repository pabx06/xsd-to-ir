# Entity CRUD backend example

This example implements the backend contract for the Issue 1.1 Organizations
editor. It contains an Express router, reusable CRUD services, MariaDB migrations,
and tests. The code is ready to integrate into the separate backend project.
It does not include that project's application server, login, database pool,
project repository, or XML import/export engine.

The first commit, **`bf4e789`**, preserves the 22 TypeScript code blocks from
`entity-crud2-code-reconstitue.md`, supplied on 8 November 2026. Those blocks were
reconstructed from photographs. They are not a verified copy of the developer's
repository. `RECOVERY.json` records their original hashes and provenance; its
hashes apply to that baseline commit, not to the repaired files.

To compare the recovered version with this implementation:

```sh
git diff bf4e789 HEAD -- examples/entity-crud-backend
```

The [Organizations backend contract](../issue-1.1-organizations-ui/BACKEND-CONTRACT.md)
defines the HTTP interface and the remaining host integration work. The earlier
review remains available in Git history at commit `757b4c0`.

## Install and verify

Use Node 24 LTS. From the repository root:

```sh
npm ci
npm ci --prefix examples/entity-crud-backend
npm run check --prefix examples/entity-crud-backend
npm test --prefix examples/entity-crud-backend
npm run build --prefix examples/entity-crud-backend
npm run format:check --prefix examples/entity-crud-backend
```

The package has its own dependencies and lockfile. `xsd-to-ir` points to this
repository through `file:../..`. The build emits the reusable module at
`dist/index.js`; it does not start an HTTP server. Tests load the repository's
Issue 1.1 XSD and use its real IR, generated JSON Schema, and DDL.

The example uses Express 4 with the corresponding TypeScript types. Every async
route forwards rejected promises to `next(error)`. Without this forwarding,
Express 4 leaves requests pending and Vitest reports unhandled
rejections when authentication, authorization, validation, or a service fails.
Keep the error middleware's four parameters so Express recognizes it.

To run just the route tests from this directory:

```sh
npm test -- src/entity-crud.routes.spec.ts
```

The integration suite requires a **dedicated MariaDB test server**. It creates a
random database, builds the generated DDL, runs HTTP and database tests, then drops
that database. The test account needs CREATE/DROP DATABASE permission. Use one of:

```sh
ENTITY_CRUD_TEST_URL='mysql://test_user:test_password@127.0.0.1:3306' \
  npm run test:integration --prefix examples/entity-crud-backend

# Local Unix socket, with a passwordless local root account:
ENTITY_CRUD_TEST_SOCKET=/path/to/test-server.sock \
  npm run test:integration --prefix examples/entity-crud-backend
```

The suite refuses to run without an explicit connection. It does not use a
project database from the host. MariaDB 11.4 is the verified database version;
other database engines have not been verified.

## Integrate into the host backend

### 1. Copy the implementation and align dependencies

Copy the non-test files in `src/`, including the new helper modules. Keep their
relative imports. Merge the required dependencies from this package into the
backend's package manifest. Keep the host's application and session middleware.

All xsd-to-ir imports are in **`xsd-runtime.ts`**. If your installed package is
named `@sliwave/xsd-to-ir`, change each package path there to that name. Use one
package instance with the same adapter, UIModel, schema generator and IR behavior
as this repository. `UIModel` currently uses a package subpath; it is an explicit
version dependency. This example does not import the nonexistent
`UIAdapterValidationError` export from this repository.

`EntityCrudRegistry` now takes a schema provider in its constructor. Replace the
old singleton call with one shared registry:

```ts
const registry = new EntityCrudRegistry({
  getIRRAW: (issue) => schemaRegistry.getIRRAW(issue),
});
const service = new EntityCrudService(registry);
```

The provider must return the project's real IR. Do not select an issue from
request-body data. Issue 1.1 is covered by the tests. Other issues need their own
integration tests before use.

### 2. Migrate each project database and initialize history

Call **`migrateEntityCrud(knex)`** through the host migration runner, once for each
project database, before enabling writes. It adds these tables:

| Table                      | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `_entity_crud_state`       | Project write lock and history readiness flag.             |
| `_entity_identity_history` | Global XML UID ownership, establishment, and active state. |
| `_entity_uid_sequence`     | Next numeric suffix per XSD UID prefix.                    |
| `_entity_nested_deletion`  | Removed identity snapshots awaiting export.                |
| `_entity_change_log`       | Before/after SQL row snapshots for effective changes.      |

This is an idempotent creation helper for these new tables. It does not upgrade
an existing, different history-table layout. Compare any tables already present
in the actual project and write a migration for that layout before using it.
Run migrations with a single migration runner.

Then call **`initializeProjectHistory()`**. The callback must answer from your
authoritative import/export history whether each identity is established:

```ts
await migrateEntityCrud(projectDb);
await initializeProjectHistory(
  projectDb,
  registry,
  project.schemaIssue,
  async ({ entity, row, type, uid, path }) => {
    return importExportHistory.isEstablished({
      projectId: project.id,
      entity: entity.name,
      recordId: row[entity.primaryKey],
      type,
      uid,
      path,
    });
  },
);
```

`importExportHistory` is a host integration, not a service included here. Do not
replace it with a guess based on `crud` or `_msg_seq`. A record can have CRUD `I`
after it was imported, and an edited established record has `_msg_seq = 0`.
For a new empty project there are no existing identities to classify. For an
existing project with unavailable history, obtain an explicit migration decision
before enabling writes. The initializer includes soft-deleted rows and UIDs on
nil XML values. Duplicate ownership makes initialization fail.

Until initialization succeeds, writes fail with `identity_history_not_ready`.
Missing ownership during a later edit fails with `identity_history_missing`.
Neither case is silently treated as a new record.

### 3. Mount the router with real host services

`createEntityCrudRouter()` requires authenticated actor resolution and an
authorization callback. Missing callbacks prevent mounting. Missing or unknown
actors and denied permissions fail before database access.

```ts
app.use(
  "/api/projects/:projectId/entities",
  createEntityCrudRouter({
    registry,
    service,
    projectRepository: {
      findById: async (id) => {
        const project = await projects.findById(id);
        return (
          project && {
            id: project.id,
            databaseName: project.databaseName,
            dialect: project.schemaIssue,
            status: project.status,
          }
        );
      },
    },
    getProjectDatabase: (name) => databasePool.get(name),
    getActor: (request) => sessions.authenticatedActor(request),
    authorize: (scope) => permissions.isAllowed(scope),
    onError: (error) => logger.error(error),
  }),
);
```

The names `projects`, `databasePool`, `sessions`, `permissions`, and `logger`
represent existing host services. Map them to the actual application. The router
expects project status `ready`; adapt the project mapping if the host uses another
status enum. Its authorization scope includes actor, project, database, entity,
operation, and optional record ID. Keep the host's session and CSRF checks, JSON
body-size limit, and same-origin deployment. The test-only actor header in
`test-support/mariadb.ts` must never be used for authentication in the host.

Configure mysql2 with `supportBigNumbers: true`, `bigNumberStrings: true`, and
`timezone: 'Z'`. IDs may be strings or safe JavaScript integers. SQL timestamps are
returned as ISO UTC strings. Keep `multipleStatements` disabled for requests; the
test setup uses it only to execute trusted generated DDL.

### 4. Connect import, export, and project-specific rules

All editor writes take the `_entity_crud_state` row lock inside one transaction.
Import and export operations must take the same lock with
**`MariaDbEntityIdentityHistory.lock(trx)`**. Otherwise they can bypass UID and
reference checks while an editor write is in progress.

After storing an imported row, call **`recordImportedRow(trx, entity, row,
establishmentResolver)`** in that transaction. Synchronize removed identities and
history with the importer's own deletion rules. This helper registers identities
in the supplied row; it does not implement XML import or infer deletions from an
earlier import snapshot.

`DBAdapter.persistMessage(batches, msgMeta, hooks)` provides two optional hooks
for this integration. Both run inside its transaction and are awaited:

- `beforeImport({ trx, msgMeta })` runs before import writes. Acquire the project
  lock here.
- `afterImport({ trx, msgMeta, changes })` runs after all row writes and pending
  relation resolution, **before commit**. Register imported identities here.

Each `changes` entry is `{ entityName, id, previousRow }`. It identifies a database
row, including helper-table rows. `previousRow` is the full SQL row before its
first update/delete, or `null` if this import inserted it. Repeated writes to the
same row produce one entry and preserve that original snapshot. Missing update
or delete targets and unsupported helper-table soft deletes produce no entry.
Read the final row through `trx`; include soft-deleted rows so their identities
can be marked inactive. Existing calls without hooks keep their behavior and
`{ inserted, updated, deleted }` result; these operation counts are not a count of
unique `changes` entries.

For example, wire the generic adapter to this backend in the host importer:

```ts
const history = new MariaDbEntityIdentityHistory();

const statistics = await dbAdapter.persistMessage(batches, msgMeta, {
  beforeImport: async ({ trx }) => {
    await history.lock(trx);
  },

  afterImport: async ({ trx, changes }) => {
    for (const change of changes) {
      // Internal helper tables are not CRUD entity records.
      if (!registry.hasEntity(project.schemaIssue, change.entityName)) continue;

      const entity = registry.getEntityDefinition(
        project.schemaIssue,
        change.entityName,
      );
      const row = await trx(entity.tableName)
        .where(entity.primaryKey, change.id)
        .first();

      if (!row) throw new Error("Imported row is missing.");

      // Host implementation: apply this import's deletion rules.
      await reconcileImportedRemovals({
        trx,
        entity,
        before: change.previousRow,
        after: row,
        history,
      });

      await recordImportedRow(
        trx,
        entity,
        row,
        resolveImportedEstablished,
        history,
      );
    }
  },
});
```

`dbAdapter` uses the same project database and schema issue as the registry;
`batches` and `msgMeta` come from the accepted XML import. One `recordImportedRow`
call handles the row's root UID and all retained nested UIDs in its JSON columns.
`reconcileImportedRemovals` and `resolveImportedEstablished` are host functions
you must implement, not helpers supplied by this package. The former compares
the previous and final rows and applies your rules for removed nested identities
and root deletions. The latter answers whether each imported identity is
established under your accepted import policy; the `() => false` callback used
for an empty project's initialization is not a general import policy.

If either hook throws or rejects, the transaction rolls back both the imported
rows and history writes made through `trx`. Await all hook work and use the
provided transaction for database access; do not start a separate transaction or
defer identity registration until after `persistMessage()` returns.

After successful export of a stable snapshot, call **`acknowledgeExport()`** with
the exact exported root records and the sequence allocated by the host:

```ts
await acknowledgeExport(
  trx,
  registry,
  "1.1",
  [{ entityName: "organization", id: organizationId }],
  allocatedSequenceAsString,
);
```

The host must ensure the rows still match that successful export snapshot. Hold
the project lock for the relevant operation, or provide equivalent export
coordination. The helper marks identities established, acknowledges pending logs
and deletions, and sets `_msg_seq` without changing `_updated_at`. It does not
create XML, allocate message sequences, or prove that an export succeeded.

`_entity_nested_deletion.previous_value` holds the removed value in **stored XML
JSON form**, including attributes. `path` is a JSON pointer using clean UI field
names. `_entity_change_log` preserves complete before/after SQL rows. The host
exporter must consume these records and apply the project's exchange rules.

For additional XSD or project rules, supply `validateAdditional` to the service.
Throw `CrudValidationError` with field paths for a correctable input error.
`entity.validationWarnings()` exposes limitations of the generated schema, such
as whitespace rules and repeated compositor ordering. The generated UI schema is
not a complete XSD validator.

UID and natural-identifier references resolve to active records using IR type
families and parent scopes. The tests cover Organization, external document and
issue, applicability, and DMC/PMC forms. For external URI/custom resolution,
provide the `references` callback in `CrudServiceOptions`. Return `undefined` to
use the default resolver; return matching typed targets to override it. Unsupported
forms fail explicitly when resolution is needed. The host must define their
semantics before accepting them.

## Implementation map

| File / method                                                      | Responsibility                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `entity-crud.registry.ts` / `EntityCrudRegistry`                   | IR definitions, business-input whitelist, compiled generated UI schema.        |
| `entity-crud.service.ts` / `create`, `replace`, `update`, `delete` | Transactional writes, retained adapter state, validation, references, logging. |
| `entity-change-preparation.service.ts`                             | Root and nested UID/CRUD preparation from actual typed values.                 |
| `entity-metadata.ts`                                               | Recursive typed traversal and schema UID patterns.                             |
| `stored-identities.ts`                                             | Identities hidden by clean `null`, post-encoding deletion reconciliation.      |
| `mariadb-entity-uid-allocator.ts`                                  | Prefix counters and global ownership collision checks.                         |
| `identity-lifecycle.ts`                                            | History initialization and import/export integration functions.                |
| `entity-references.ts`                                             | Outgoing reference resolution and incoming reference protection.               |
| `organization-summary.ts`                                          | Direct assignment counts, including singleton JSON.                            |
| `entity-crud.routes.ts`                                            | Route order, request parsing, project context, errors.                         |

Existing UID-less nested values remain unchanged during unrelated edits. An
attempt to edit or remove them returns `legacy_identity_required`. The explicit
**`service.backfillIdentities(context, id)`** operation allocates their identities
before such edits. Expose it only through a host-authorized administrative flow.
It is not a public HTTP route here, and GET/no-op saves never trigger it.

## Verification scope and limits

Unit tests and real MariaDB HTTP tests cover full replacement, schema validation,
leading zeroes, omission/nil, recursive identities, legacy backfill, import
collisions, establishment after export, references, SQL rollback, queries, and
summary counts. The Angular example also accepts and displays CRUD `N` as
**Unchanged**, including in reference catalogs.

Logical search currently decodes all eligible Organization rows before paging.
Reference checks read active entities in the project's complete generated schema.
These choices provide correct results for the example. Large projects need
measured, indexed search/reference implementations that preserve the same tests.
The service edits a root row and its inline values; it does not implement a
general aggregate editor for child tables, bulk edits, or project migrations.

There is no revision protocol. One active editing session is still assumed.
Transactions protect individual writes; they do not prevent an old form from
overwriting a later form submission. The host's authentication, IAM policy,
existing data migration, and XML exchange integration have not been tested here.
No deployment to the separate backend or live UI-to-host verification is claimed.
