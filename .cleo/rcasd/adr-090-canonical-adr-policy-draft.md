# ADR-090: Canonical ADR Policy — Slug-Primary, DB-Authoritative

- **Status:** Proposed (drafted from already-ratified decisions; pending owner post-review)
- **Date:** 2026-06-05
- **Owner task:** T11193 (Write ADR-090: Canonical ADR Policy — supersedes T1824)
- **Saga:** T11778 (docs-SSoT / vault reconciliation)
- **Grounded in:** the ratified `docs-ssot-vault-reconciliation` note (owner-ratified 2026-06-04, council wf_972cc40b-121)
- **Resolves:** the dangling `ADR-072 → ADR-090` supersession reference introduced by PR #969 (ADR-090 was cited but never written).

## Context

CLEO accumulated two parallel ADR stores — `.cleo/adrs/*.md` (legacy authoritative) and
`docs/adr/*.md` (publish mirror) — plus a third, the cleo.db `docs_*` SSoT. Over time the
numeric ADR identifiers drifted: the same number maps to **different decisions** in
different stores (051×3, 052/053/054/068/070/072/078/086/088 ×2, plus lowercase
`adr-079-r1/r2` rename tombstones), with permanent historical gaps at 040 and 060. Number
identity became unsafe as a canonical handle. Re-publishing from any single store would
clobber distinct decisions that happen to share a number.

This ADR codifies the policy that makes ADR identity safe and the cleo.db `docs_*` domain
the single source of truth. It records decisions already ratified by the owner in the
`docs-ssot-vault-reconciliation` record; this document is the canonical ADR form of that
policy.

## Decision

### 1. cleo.db `docs_*` is the SOLE authority

The cleo.db `docs_*` domain (content-addressed attachment blobs + slug/version metadata)
is the **single source of truth** for all project documentation, including ADRs.
`.cleo/adrs/*.md`, `docs/adr/*.md`, `docs/generated/`, and the Obsidian vault are
**derived, non-authoritative projections** — render targets, never merge-back sources.
On any drift between a projection and the DB, the DB wins.

### 2. The Obsidian vault is a live plugin VIEW, not a copy

The vault becomes a live plugin view that reads and renders cleo docs (including base64
blobs and the backlink graph) through a `docs.read` core-SDK API — not a static file
export, not a hand-authored copy. Vault-authored canon must be ingested DB-first so the
DB remains authoritative.

### 3. ADR-076 is AMENDED (AMD-002), not superseded

ADR-076 (canonical docs routing) stays in force and is amended by AMD-002:
`docs/adr` is a generated read-only artifact; the vault is view-only; the raw-markdown
canon CI gate is forward-only (legacy T9791 imports grandfathered); DB-master authority;
PROJECT scope now with GLOBAL reserved for a post-exodus saga.

### 4. Slug-primary — numbers are display aliases only

The globally-unique kebab **slug** is the canonical, durable handle for an ADR. The ADR
**number is a non-authoritative display alias**. Specifically:

- **Never renumber a slug** to resolve a collision. Slugs are stable handles.
- New display aliases come from the **next-free** number, allocated sequentially with **no
  reuse**. No `v#`, `-vN`, or `-rN` suffixes in slugs (versioning lives in the DB
  `owner_version` + `doc_version` columns, not the slug string).
- Permanent historical numbering gaps (e.g. 040, 060) are documented and **left as gaps**
  (T11192); numbers are not back-filled to close them.
- **Number collisions are resolved by content-review + supersession**, NOT by renumbering.
  When the same number labels genuinely distinct decisions, all decisions are kept; each
  keeps its slug; aliases are reconciled. Only true duplicate content or tombstone
  forwarding stubs are superseded/deleted.

### 5. Minimal `docs_wikilinks` backlink graph

A minimal `docs_wikilinks(from_slug, to_slug, relation)` edge table is backfilled from the
existing `supersedes`, `relatedTasks`, and `topics` data, and `cleo docs graph` is extended
to bidirectional edges. Parsing markdown-body `[[wikilinks]]` is deferred and gated on a
write→export→re-import zero-loss round-trip test.

### 6. PROJECT scope now

ADR canon is PROJECT-scoped for now. GLOBAL-scope canon is reserved for a dedicated
post-exodus saga, to avoid churning DB scope mid-migration.

## Consequences

- ADR identity is safe: the slug is the handle, numbers are cosmetic. Cross-store collisions
  no longer threaten data loss.
- Republishing/exporting from the DB is safe once `cleo docs publish` is idempotent and a
  `cleo check canon publish` content-hash mirror gate exists (held under T11820).
- A future regenerate of the on-disk projections should correct any body header that
  mislabels its own number (e.g. the `adr-088-release-pipeline-coherence` body that titles
  itself "ADR-087").
- This ADR supersedes the earlier ADR-numbering intent tracked in T1824.

## References

- Ratified policy: `docs-ssot-vault-reconciliation` (cleo docs note, owner-ratified 2026-06-04).
- ADR-076 (canonical docs routing) + amendment AMD-002 (T11820).
- Cross-store identity map: `adr-cross-store-identity-map` (T11191).
- Reconciliation execution: T11676 (ingest/dedup/supersede), T11192 (document gaps),
  T11674 (079-r1/r2 rename tombstones).
