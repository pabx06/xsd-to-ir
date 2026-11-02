# Issue 1.1 Organizations — Angular HTTP example

An Organizations editor for a configured S3000L Issue 1.1 project. It uses
Angular 22.2.3, standalone components, Reactive Forms, signals, Optimus UI 2
(Aura), and Tailwind CSS 4 through `@openng/optimus-ui-tailwindcss`. Icons are
bundled locally. Other work areas remain visible and disabled.

The editor uses the backend API. It has no local storage database, runtime seeds,
reset action, revision counter, or frontend UID allocator. The backend handoff is
in [BACKEND-CONTRACT.md](BACKEND-CONTRACT.md). **The supplied backend needs the
changes in that document before live CRUD can work.**

## Install and configure

Use Node 24.15 or later in the 24.x series, or another Node version supported by
the package's engines setting. Dependencies and the lockfile are separate from
the repository's Node package. From the repository root:

```sh
npm ci
npm ci --prefix examples/issue-1.1-organizations-ui
```

Edit `public/organizations.config.json` in this example before starting:

```json
{
  "apiBasePath": "/api",
  "projectId": "your-issue-1.1-project-id",
  "projectLabel": "Your project name",
  "schemaIssue": "1.1"
}
```

The committed template deliberately has an empty project ID and label. The app
loads this file before Angular initialization. Missing settings, unreadable JSON,
a non-local API base path, or an unsupported issue show a configuration error and
cause **no CRUD requests**. Reload after changing configuration. Do not put
credentials or tokens in this public file, or commit deployment-specific edits.

For a production build, the file is copied to
`dist/organizations/browser/organizations.config.json`. Deployment can replace
that file without recompiling the app. Serve it without a stale cache. The
schema issue reported by the backend summary is checked before enabling edits;
changing this configuration cannot convert a project to Issue 1.1.

## Authentication and development proxy

Use an existing same-origin backend session. The HTTP service sends cookies; it
does not implement login or store a token. Angular's default XSRF support remains
enabled. If the backend uses different CSRF cookie/header names or a custom token
flow, configure `provideHttpClient` in `src/main.ts` to match that flow.
Do not disable the backend's CSRF checks to make the example connect.

For local development, set the backend origin and run the root convenience command:

```sh
ORGANIZATIONS_API_TARGET=http://127.0.0.1:3000 npm run example:organizations:1_1
```

Port 3000 is an example: use the real backend origin. Open
**http://127.0.0.1:4211**. `proxy.conf.cjs` forwards `/api/**` to that origin.
It preserves the API path, verifies TLS, and removes a backend-only cookie domain
for local development. If `apiBasePath` differs from `/api`, also set
`ORGANIZATIONS_API_PATH` to the same path. Proxy environment changes require a
server restart. Without a target, the dev server does not proxy API requests.

Establish the session through the proxied authentication route on the UI origin,
or through your application's existing same-origin login. If authentication is
outside the proxied API path, extend the proxy for that route. Secure cookies
require an appropriate HTTPS development setup. A 401 or 403 is shown to the user;
the example does not bypass session or permission checks.

Production must serve both the UI and API under one origin, typically using a
reverse proxy. A cross-origin URL is intentionally rejected by runtime config.
The static test server is not a production API proxy.

## Build and verify

From this example directory:

```sh
npm start
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run format:check
```

Development, build, and test commands generate inputs first. `npm test` checks
TypeScript and runs form, schema, configuration, and HTTP contract tests.
`npm run build` compiles the Angular templates and checks the browser bundle.
Browser tests serve the production build on port **4212**, intercept configuration
and API requests with explicit fixtures, and run desktop/mobile Chromium layouts.
They require no backend credentials and make no requests to a live project.

If Playwright's downloaded Chromium cannot run on your OS, use a working local
Chromium executable:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:browser
```

Tests cover complete CRUD bodies, leading zeroes, optional removal versus null,
server-assigned identities, returned tracking, reference pagination/cache refresh,
search/sorting/pagination, summaries, obsolete reads, failed writes, unsaved-change
protection, keyboard navigation and responsive layouts. Network tests allow only
local assets, runtime configuration and the configured API. Bundle checks exclude
Node adapters, test fixtures, offline services, and external CDN assets.

**No live backend has been verified.** The HTTP fixtures test this frontend's
contract. They do not validate production transactions, reference resolution,
identity allocation, or import/export history. The separate backend document has
a live verification checklist. A real Issue 1.1 test project, API URL and session
are needed for that step.

Generated files, build artifacts, browser reports, and dependencies are ignored by
Git. Run `npm run generate` to inspect `src/generated/`.

## Styling

`.postcssrc.json` enables `@tailwindcss/postcss` in the Angular build. `src/styles.css`
imports Tailwind CSS 4, the Optimus Tailwind integration, local icons, and the
example's custom styles from `src/app.css`. Dependencies stay in this example's
package and lockfile; styles are compiled locally with no CDN requests.

Tailwind's theme and utilities are imported separately. Preflight is omitted to
preserve the existing browser defaults and spacing. The example's global styles
remain in the `base` layer in `src/styles.css`.

The CSS layer order is `theme, base, optimus, components, utilities`, declared in
both `src/styles.css` and the Optimus provider in `src/main.ts`. Optimus uses the
`optimus` layer, and custom application styles use `components`. Tailwind utilities
can therefore override both without `!important`.

Layout, spacing, typography, and responsive rules live in the templates as Tailwind
utilities. `src/app.css` keeps shared controls, Optimus component overrides, and
the reduced-motion rule. Shared styles use `@apply` to reuse the same utilities
without repeating long class lists for every button or form control.

The spacing unit is **4px**, independent of the example's **14px** base font, so
`gap-3` and `p-3` mean 12px. The `ink`, `muted`, and `line` colors reuse the existing
CSS variables. The Optimus integration provides `bg-primary-50`, `text-primary`,
and `text-muted-color` from the active Aura theme. The example keeps its light
theme; exact colors and dimensions use arbitrary values where needed to preserve
the existing design.

Three custom responsive variants retain the original layout boundaries:

| Variant    | Viewport width                          |
| ---------- | --------------------------------------- |
| `compact:` | Up to and including 760px               |
| `tablet:`  | Above 760px, up to and including 1150px |
| `wide:`    | At least 1500px                         |

These ranges do not overlap. For example, `flex compact:block` changes the main
layout on a small screen. Ordinary Tailwind variants remain available.

Tailwind scans `src/app` for complete class names in templates and TypeScript.
Generated types and schemas are excluded from this scan. Use complete class names
in Angular bindings so Tailwind can detect them at build time.

## Use the screen

Search by name or identifier. Records initially show the latest update first.
Select **Change status** or **Last update** to change the sort order. Names,
identifiers, and document counts do not have sort controls; the API only needs
its existing scalar-column sorting (`crud` and `_updatedAt`).
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

Choice controls select the permitted branch. Reference controls offer documents, document issues, applicability statements, and Organizations from the configured backend. These
lookups are conveniences. You can also enter the permitted UID or natural
identifier form. Document and applicability lookup records are read-only.
Organization references must resolve to one active Organization in this project.

Enumeration controls show the meaning and code when the XSD supplies a supported
semantic annotation, for example **Drawing reference (DRW)** for a document role.
These labels are generated from the annotated identifier, not inferred from the
code. Values without a recognized annotation keep their code as the label.
Storage and validation always use the original code. A label is a short name;
it does not replace a full business definition or instructions for using it.

Record information shows IDs, CRUD action, pending export, and timestamps. Nested XML
UIDs and CRUD actions are read-only. The backend assigns them when you save.
Closing a changed editor requires confirmation. The page also registers the
browser's standard unsaved-change prompt for navigation or reload.

Search, filtering, sorting, pagination and summary counts run on the backend.
The table does not filter only the loaded page. Reference catalogs load all pages
of up to 100 records. A failed or inconsistent catalog shows an error instead of
silently dropping choices. **Refresh connection** reloads totals and catalogs.
The application preserves the draft when a save fails and blocks overlapping
writes. It cancels obsolete reads so earlier results cannot replace newer results.

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

## Data flow and reusable services

`EntityCrudHttpService` is a generic HTTP transport. It keeps project/entity
arguments, Observable results, and the existing list/record envelopes.
`OrganizationService` provides Organization operations, validates the summary
issue, and manages reference catalogs. `ENTITY_CRUD` binds the screen to that
service. The runtime config is injected through `RUNTIME_CONFIG`.

The wire record contains `id` (string or number), `uid`, `crud`,
`pendingExport`, `_createdAt`, `_updatedAt`, `_deletedAt`, and `value`.
Only the timestamp names change at the HTTP boundary. The editable `value` is
`Omit<Entities['organization'], 'uid' | 'crud'>`. Root identity and tracking
stay in the surrounding record. Nested UID/CRUD fields remain read-only. New
nested values have no generated identities until the backend saves them.

Creation sends POST. Saving an existing record sends a **complete business value**
with PUT. For example:

```json
{ "orgId": [{ "id": "001234" }], "docs": null }
```

This removes an existing name and makes documents explicit nil. Omitting `docs`
instead removes that property. There is no `makePatch`, revision, `changes`, or
`remove` wrapper, and no PATCH fallback. The original value is retained only for
dirty detection; unchanged saves do not send a write. Unopened nested fields are
preserved when constructing the complete value.

The backend owns validation, reference integrity, UID allocation, timestamps,
root/nested CRUD and deletion history. The editor displays returned pending state;
it does not allocate message sequences or export XML. Pending records include
pending deletions in the summary, while lists contain active Organizations only.
This example assumes one active editing session per project and has no revision
protocol or multi-user synchronization.

## Validation limits

The form validates the complete draft against the generated UI JSON Schema before
sending it. Root validation placeholders are used only for this check and are
never submitted. The backend must validate again after identity preparation.
Structured backend issues are mapped to editable field paths. Zod top-level
`fieldErrors` and message-only adapter errors are also displayed. Error codes,
permission status, project status and constraint names remain available.

The generated Organization schema reports these remaining XSD limits:

- XSD `whiteSpace` normalization requires XSD validation. The demo preserves input
  text and leading zeroes; it does not implement all token normalization rules.
- Repeating group count correlations and XML order require XSD validation.
- Repeating choice totals and branch order require XSD validation.

The schema is not a complete XSD 1.1 validator. The UI does not claim that a saved
record is ready for valid XML export. The backend must resolve references and enforce project rules. Run the production
XSD and project-level checks through the backend import/export workflow.
