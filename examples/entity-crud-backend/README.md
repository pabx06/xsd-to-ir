# Recovered entity CRUD backend

This baseline contains the 22 TypeScript source and test files extracted from the
supplied `entity-crud2-code-reconstitue.md` on 8 November 2026. The code blocks are
preserved without repairs. `RECOVERY.json` records the source document hash,
original reconstruction status, and each extracted file's SHA-256 hash.

The supplied document was reconstructed from photographs. It does not guarantee
exact fidelity to the developer's source. This is a baseline of that document,
not a verified copy of the separate backend repository.

The baseline is not a standalone application. Its imports refer to the separate
project's schema registry, database pool, project repository, session setup,
logging, and application entry point. Its package manifest, migrations, and
import/export integration were not supplied. Reconstructed tests also contain
known inconsistencies.

The next implementation commit will make the CRUD example independently
verifiable and document the integrations that the host backend must supply.
The review and required behaviour are in the
[Organizations backend contract](../issue-1.1-organizations-ui/BACKEND-CONTRACT.md).
