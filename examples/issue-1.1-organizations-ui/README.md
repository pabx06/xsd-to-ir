# Issue 1.1 Organizations — offline Angular example

A working Organizations editor for the fictional **Aurora demonstrator** project.
It uses Angular 22.2.3, standalone components, Reactive Forms, signals, and
Optimus UI 2 with the Aura theme. Icons are bundled locally. Other work areas
remain visible and disabled.

## Run

Use Node **24.15 or later in the 24.x series**, or another Node version supported
by Angular 22. Dependencies and the lockfile are separate from the root package.
From the repository root:

```sh
npm ci
npm ci --prefix examples/issue-1.1-organizations-ui
npm run example:organizations:1_1
```

Open **http://127.0.0.1:4211**. The first load creates eight fictional records.
The app needs a local web server to serve its files. It makes no API or CDN
requests. After installation, development and build commands do not need a network
connection. This is not an installable PWA or a service-worker cache.

To run from this directory:

```sh
npm start
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Development, build, and both test commands generate their inputs first. `npm test`
checks TypeScript and runs the form and storage tests. Browser tests use a local
static server on port **4212** and the production build. They cover Chromium on
desktop and a mobile viewport. If the downloaded Chromium cannot run on your OS,
use an installed Chromium executable:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:browser
```

Generated files, build artifacts, browser reports, and dependencies are ignored by
Git. Run `npm run generate` to inspect the generated files in `src/generated/`.

## Use the screen

Search by name or identifier. Select a column heading to change the sort order.
Open a record by its name or edit button. The editor has four sections:

- **Details:** optional name, language, date, and name applicability.
- **Identifiers:** one or more identifiers, class, and identifier applicability.
- **Documents:** document or document-issue references, roles, portions, remarks,
  and applicability.
- **Remarks:** text, language, date, source Organization, type, supporting
  documents, Organization assignments, and applicability.

Expand nested fields as needed. Optional fields offer **Not supplied**, **Value**,
and **Explicit null** when the schema permits it. Empty text remains empty text;
it is not converted to absence or null. The schema rejects empty text for fields
such as identifiers and descriptions. Repeated values have add, remove, and
reorder controls. A nullable repeated element uses null on an individual item,
not on the whole array.

Choice controls select the permitted branch. Reference controls offer seeded
documents and applicability statements, plus the current Organizations. These
lookups are conveniences. You can also enter the permitted UID or natural
identifier form. Document and applicability lookup records are read-only.
Organization references must resolve to one active Organization in this project.

Enumeration controls show the meaning and code when the XSD supplies a supported
semantic annotation, for example **Drawing reference (DRW)** for a document role.
These labels are generated from the annotated identifier, not inferred from the
code. Values without a recognized annotation keep their code as the label.
Storage and validation always use the original code. A label is a short name;
it does not replace a full business definition or instructions for using it.

Record information shows IDs, CRUD action, revision, and timestamps. Nested XML
UIDs and CRUD actions are read-only. The service assigns them when you save.
Closing a changed editor requires confirmation. The page also registers the
browser's standard unsaved-change prompt for navigation or reload.

## Generated contracts and reusable parts

`scripts/generate.cjs` reads the bundled Issue 1.1 XSD through the repository's
existing parser, IR builder, TypeScript generator, and UI JSON Schema generator.
It emits:

- `types.ts`: generated entity and value types. The application imports these as
  types only.
- `organization.schema.json`: the Organization schema and all definitions reached
  by its references. Assertions and unsupported-rule annotations are retained.
- `form-metadata.json`: the Organization shape, 68 nested value types, effective
  inherited fields, cardinalities, choices, references, scalar constraints, and
  enumeration labels derived from the IR's per-code annotations.

The browser imports only these generated artifacts. It does **not** import
`lib.js`, `UIAdapter`, `DBAdapter`, the XML parser, or the IR builder.
`npm run build` checks the bundle input graph for those dependencies.

`FieldNode` and `FieldEditor` provide recursive controls. They materialize controls
when a branch is opened, and preserve untouched nested values. Fields prohibited
by the XSD are excluded, including `orgId.setBy` and `name.providedBy`.

`ENTITY_CRUD` is the injection token for the CRUD interface. A future HTTP service
can replace its provider. The project and entity parameters, Observable results,
list query, and `{ data, metadata }` envelope remain available. The demo's
`reset`, `summary`, and reference-catalog functions are separate convenience APIs
on `OfflineOrganizationService`.

Each record separates business values from storage and tracking information:

```typescript
{
  id: 1,
  revision: 1,
  uid: 'org1',
  crud: 'R',
  baseline: true,
  pendingExport: false,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-10-08T09:00:00.000Z',
  deletedAt: null,
  deletedNested: [],
  value: { orgId: [{ id: '001234' }], name: { descr: 'Aurora Aerospace' } }
}
```

`value` is `Omit<Entities['organization'], 'uid' | 'crud'>`. Nested UID/CRUD fields
remain in the generated nested types for record identity, but controls cannot
edit them. The service rejects forged system fields in incoming payloads.

An update contains the record revision, changed **top-level** business fields, and
an explicit list of fields to remove:

```typescript
{ revision: 1, changes: { docs: null }, remove: ['name'] }
```

This sets documents to explicit null and removes the name. Nested edits send the
complete changed top-level field; unchanged nested values remain intact.
`makePatch` computes this update from the original and edited values.

## Storage and change tracking

The service stores one snapshot under:

```text
xsd-to-ir:organizations-ui:v1:aurora-demo:issue-1.1
```

It seeds only when this key is absent. Deleting all records does not cause
reseeding on reload. Each operation reads current storage, validates the candidate
snapshot, and writes once. A failed `setItem` never produces a successful save.
Unreadable or incompatible stored data stays in place until the user explicitly
confirms **Reset demo data**. Reset affects only this key.

Seeds use `R` as the established demonstration baseline. Editing a baseline
record sets `U`; new records retain `I` after further edits. Deletion sets `D` and
`deletedAt`, and removes the record from active lists. Changed records have
`pendingExport: true`. Nested records receive the same treatment according to
their own baseline state. Nested deletions are kept in `deletedNested`, outside
the active editable value.

An effective change increments the project-local revision and assigns that
revision to the changed record. A no-op save does not increment it. Updates and
deletes require the current record revision. Incoming UID and natural-identifier
Organization references block deletion. Identifier edits that would break those
references also fail.

The revision is **not an S3000L message sequence**. This example does not allocate
message sequences, export XML, mark changes as exported, or resolve production
references. It has no cross-tab locking or multi-user synchronization. Use a
backend transaction and a project change policy for those operations.

## Validation limits

The service validates complete values against the generated UI JSON Schema before
storage. It adds the managed root UID and CRUD action for this check. Validation
errors retain JSON Pointer paths, which the editor uses to select the section and
focus the field.

The generated Organization schema reports these remaining XSD limits:

- XSD `whiteSpace` normalization requires XSD validation. The demo preserves input
  text and leading zeroes; it does not implement all token normalization rules.
- Repeating group count correlations and XML order require XSD validation.
- Repeating choice totals and branch order require XSD validation.

The schema is not a complete XSD 1.1 validator. The UI does not claim that a saved
record is ready for valid XML export. The reference catalog is fictional, and
non-Organization reference resolution is outside this demo. Run the production
XSD and project-level checks when you add import/export or a real backend.

## Sources

- [Optimus UI installation and Angular compatibility](https://optimus.openng.org/installation)
- [Angular version compatibility](https://angular.dev/reference/versions)
