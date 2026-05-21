---
id: t9791-docs-migrate-execute
tasks: [T9791]
kind: feature
summary: Execute cleo docs import across all 5 legacy doc sources (2388 files) — closes T9625 validation gate.
---

Shipped on `main` via the T9791 Epic (E-DOCS-MIGRATE-EXECUTE).

`cleo docs import` was implemented in T9628 but never actually run against the
cleocode project. This Epic executes it across the 5 canonical source dirs and
fixes the three latent bugs that surfaced during the dogfood:

- **Source-dir-aware classifier** — when the scan root is inside a canonical
  source dir (e.g. `.cleo/adrs/`), file relPaths no longer carry the source-dir
  prefix and the legacy `classifyByRelPath` defaulted to `note`. The new
  `makeClassifierForScanRoot` closure resolves the type from the scan root
  itself so `.cleo/adrs/` → adr, `.cleo/rcasd/` → research, etc. The
  `SOURCE_DIR_TO_TYPE` map adds `.cleo/rcasd` → research as a first-class entry.

- **AttachmentStore-backed DocsAccessor** — the in-memory `DocsAccessorImpl`
  was incompatible with the SSoT contract (slug→sha lookups query
  `tasks.db.attachments` via `findBySlug`, but writes went to `manifest.db`).
  The new `AttachmentStoreDocsAccessor` persists imports through the
  AttachmentStore with `slug` + `type` extras so `cleo docs fetch <slug>`
  resolves to bytes, `cleo docs list --project --type spec` works, and
  re-running the import is idempotent across processes.

- **Legacy ref re-attach + reserved-slug fallback** — `AttachmentStore.put`
  now checks for an existing `attachment_refs` row before inserting, so
  re-puts of the same (blob, owner) tuple do not trip the composite-PK
  UNIQUE constraint. The orchestrator also chains the parent dir into the
  slug when the basename slugifies to a RESERVED_SLUG (e.g.
  `gsd/workflows/import.md`), so benchmark fixtures import cleanly.

The migration imported 2,388 source files across `.cleo/adrs/` (79),
`.cleo/research/` (6), `.cleo/agent-outputs/` (1,189), `.cleo/rcasd/` (973),
and `docs/` (141). Originals were preserved at their source paths —
deletion is deferred to a future epic.

Audit manifests are committed under `.cleo/audit/imports/<ts>/<source>.json`
so the import event is git-traceable for retroactive evidence-gate
verification.

Closes T9625's original validation gate:
`cleo docs fetch sg-cleo-docs-canon-plan` now returns bytes.
