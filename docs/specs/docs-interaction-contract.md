---
id: spec-docs-interaction-contract
slug: spec-docs-interaction-contract
title: "Spec: Docs Update / Versions / Supersede Interaction Contract"
status: Accepted
date: 2026-05-27
task: T11134
epic: T10518
saga: T10516
kind: spec
linkedTasks: [T10161, T10162, T11053, T11054, T11055]
---

# Spec: Docs Update / Versions / Supersede Interaction Contract

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

## Context

Epic T10518 (Docs slug/latest owner-version SSoT repair) consolidated
the docs storage surface across three fixed bugs (T11042 SHA drift,
T11054 publish default, T11055 replacement semantics) and introduced
the `DocsReadModel` (T11049). With the implementation surface now
stable, agents and future maintainers need a single canonical
reference for how the three mutating verb families — `docs update`,
version numbering, and `docs supersede` — interact.

All three families operate on the same `attachments` table (tasks.db).
Without an explicit contract, compound operations such as
supersede-then-update or multi-update version chains can produce
surprising results that break agent workflows.

## Goal

Define the precise interaction contract between `docs update`,
version-number semantics, and `docs supersede` so that:

1. Agents can safely compose mutating docs operations.
2. Compound-operation outcomes are predictable and documented.
3. Edge cases (update after supersede, supersede after update,
   squashed noop version counters) have canonical rulings.

## Non-Goals

- Specifying `docs add`, `docs remove`, `docs list`, `docs publish`,
  or `docs import` behavior (covered by their own contracts).
- Specifying the publication ledger (`docs-publications.json`) or
  publish-mirror mechanics.
- Specifying the blob store (`.cleo/blobs/`) internal layout.
- Specifying `cleo docs fetch` semantics beyond its interaction with
  superseded rows.
- Defining the full docs taxonomy or slug-namespace policy.

## Requirements

### REQ-001: Update preserves slug, rotates bytes

`docs update <slug>` MUST keep the slug as the stable handle while
rotating the underlying content bytes. After a successful update,
`docs fetch <slug>` MUST return the new content, NOT the old.

### REQ-002: Old rows are preserved for history

The row whose slug was cleared during update MUST remain in the
`attachments` table, addressable by `attachments.id` and `sha256`.
It MUST NOT be deleted.

### REQ-003: Attachment refs are migrated

Every `attachment_refs` row pointing at the old attachment row
MUST be re-created pointing at the new row, preserving
`(ownerType, ownerId)` pairs. This migration MUST be idempotent.

### REQ-004: SHA-256 read-back integrity check

Before committing the DB transaction, the blob written to disk
MUST be read back and its SHA-256 digest verified against the
expected hash. If the check fails, the DB transaction MUST NOT
be committed.

### REQ-005: Version numbers are per-slug and monotonic

The `version` field returned by `docs update` MUST be a monotonic,
1-indexed counter for the slug. It MUST count all historical
revisions (including squashed ones) and MUST have a floor of 2
for the first update (initial create = version 1).

### REQ-006: Supersede is atomic and non-mutating

`docs supersede <oldSlug> <newSlug>` MUST execute atomically
(`BEGIN IMMEDIATE`) and MUST set `lifecycle_status = 'superseded'`
+ `superseded_by` on the old row and `supersedes` on the new row.
It MUST NOT clear either slug and MUST NOT write to the audit log
or bump version numbers.

### REQ-007: Both slugs must exist for supersede

If either `oldSlug` or `newSlug` does not resolve to an
`attachments` row, `docs supersede` MUST return `E_NOT_FOUND`.
Self-supersession (`oldSlug === newSlug`) MUST return
`E_INVALID_INPUT`.

### REQ-008: Supersede-then-update ordering matters

After `docs supersede A B`, the old slug A is still assigned to
its row. `docs update A` WILL succeed (clearing slug A from its
row). After `docs update A` clears slug A from its row,
`docs supersede A B` WILL fail with `E_NOT_FOUND`. Agents MUST
supersede BEFORE updating the old slug.

### REQ-009: Audit squash window

Successive `docs update` calls for the same slug within a 5-minute
window MUST be squashed onto a single audit line with multiple
`revisions[]` entries. The `squashed` field on the result MUST be
`true` when this occurs.

### REQ-010: Lifecycle-status default is draft

`docs update` MUST default the new row's `lifecycle_status` to
`'draft'` unless the caller explicitly passes `--status <value>`.

## Out-of-Scope

- Cross-project slug resolution (project-level concern).
- Blob garbage collection for orphaned attachment rows.
- Automatic publication after update or supersede.
- Notification or event hooks triggered by docs mutations.
- Migration of legacy `.cleo/agent-outputs/` content to the docs
  SSoT (see `docs/migration/legacy-to-docs.md`).

## `docs update` contract

### Core semantics

`docs update <slug> --file <path>` or `--content "<text>"` performs
an **in-place blob replacement** that preserves the slug as the stable,
human-addressable handle. The slug stays pinned; the content bytes
rotate underneath.

### Row lifecycle

Within a single `BEGIN IMMEDIATE` transaction:

1. **Old row** — the `slug` column is cleared (set to `NULL`). The row
   itself is NOT deleted; it remains addressable by `attachments.id`
   and `sha256` for version-history queries. Its `lifecycle_status`
   is left unchanged.

2. **New row** — if a row with the same `sha256` already exists
   (deduplication), that row is upserted with the slug, preserved
   `type`, and requested `lifecycle_status`. Otherwise a fresh row
   with a new UUID is inserted.

3. **Ref migration** — every `attachment_refs` row pointing at the old
   row is re-created pointing at the new row, preserving
   `(ownerType, ownerId)` pairs. Idempotent: if a ref already exists
   on the new row it is skipped.

4. **Commit** — the new blob is written to disk AND verified via
   SHA-256 read-back integrity check **before** the DB transaction.
   If the blob write or integrity check fails, the DB is never
   touched.

### Result envelope

| Field | Meaning |
|-------|---------|
| `slug` | Stable slug (unchanged) |
| `attachmentId` | UUID of the new (slug-bearing) row |
| `previousAttachmentId` | UUID of the old row |
| `sha256` | Content hash of the new bytes |
| `previousSha256` | Content hash of the bytes before this update |
| `changed` | `true` when bytes or lifecycle status changed; `false` on noop |
| `lifecycleStatus` | Applied status (default `draft`) |
| `version` | Best-effort 1-indexed version number (see Version-number semantics) |
| `squashed` | `true` when this revision was merged into an existing audit entry |
| `summary` | Human-readable description of what happened |

### Version-number semantics

The `version` field is derived from the audit log at
`.cleo/audit/docs-versioning.jsonl`, NOT from the attachments table.

```
version = 1 (initial create)
        + sum of revisions[] entries across all audit lines for this slug
```

- **Floor**: 2 for the first update (initial create counts as version 1,
  first update makes it 2).
- **Squashed revisions**: when two updates land within the 5-minute
  squash window, both revisions appear in one audit line. The
  version counter counts BOTH revisions — a squashed 2-revision line
  adds 2 to the version.
- **Noop updates**: a noop (identical bytes, same lifecycle status)
  does NOT increment the version.
- **Status-only noop**: an update that doesn't change bytes but changes
  `lifecycle_status` DOES write an audit entry with `changed: false`
  but does NOT increment the version counter (the count stays the same).
- **Dry-run**: returns the prospective `version` without mutating
  anything. The version reflects what it WOULD be if the update were
  committed.

### Audit squash window

Successive updates for the same slug within 300 seconds (5 minutes)
of the previous entry's `lastAt` timestamp are squashed onto the
LAST matching audit line. The revision is appended to that line's
`revisions[]` array, and `lastAt` is updated to the new timestamp.

Outside the squash window, a NEW audit line is written.

### Lifecycle status default

Every `docs update` defaults the new row's `lifecycle_status` to
`'draft'`. This means an `'accepted'` doc gets back-pressured to
`'draft'` on edit UNLESS the caller explicitly passes
`--status accepted`.

Valid lifecycle statuses: `active|archived|draft|superseded|deprecated`.

### No supersession edge

`docs update` does NOT create a supersession edge. If the caller
wants to record that one document formally replaces another, they
MUST use `docs supersede`. The update path preserves the old
row for history but does not link the two rows via the
`supersedes`/`superseded_by` FK columns.

## `docs supersede` contract

### Core semantics

`docs supersede <oldSlug> <newSlug>` atomically marks one document as
the formal successor of another. It is a **status and FK write**,
NOT a content mutation.

### Row lifecycle

Within a single `BEGIN IMMEDIATE` transaction:

1. **Old row** — `lifecycle_status` is set to `'superseded'`, and
   `superseded_by` is set to the new row's `attachments.id`.
   **The old row's slug is NOT cleared.** It remains addressable
   by slug, by attachment ID, and by SHA-256.

2. **New row** — `supersedes` is set to the old row's
   `attachments.id`. The new row is otherwise unchanged — its
   slug, content, and lifecycle status are preserved as-is.

3. **Commit** — ALL three writes (2 UPDATEs) commit or none do.
   `BEGIN IMMEDIATE` prevents concurrent supersessions against the
   same slug from racing past each other.

### Result envelope

| Field | Meaning |
|-------|---------|
| `oldSlug` / `newSlug` | Input slugs echoed back |
| `oldAttachmentId` / `newAttachmentId` | Resolved UUIDs |
| `supersededAt` | ISO-8601 commit timestamp |
| `edgeId` | Deterministic lineage handle (`supersedes:<newId>-><oldId>`) |
| `reason` | Optional human-readable rationale |

### Validation

- **Both slugs MUST exist** — `E_NOT_FOUND` if either does not
  resolve to an `attachments` row.
- **oldSlug ≠ newSlug** — self-supersession is rejected with
  `E_INVALID_INPUT`.
- The `superseded_by` and `supersedes` columns follow a
  **latest-wins** policy: if the old row was already superseded by
  something else, `superseded_by` is overwritten. If the new row
  already superseded something else, `supersedes` is overwritten.

### No version bump

`docs supersede` does NOT write to the audit log and does NOT
affect version numbers. Version numbers are only incremented by
`docs update`.

## Interaction table

The table below defines the expected outcome of compound operations.
Row order represents temporal sequence.

| Sequence | Outcome |
|----------|---------|
| `update` → `update` | Second update creates new row, clears slug from first update's row. Version = 3. Both old rows preserved by ID. |
| `supersede` → `update` (old) | Old row still has its slug. Update succeeds: clears slug from old row, creates new row. The `superseded_by` FK on old row remains (pointing at existing successor) but the old row is now slug-less. |
| `supersede` → `update` (new) | Works normally. New row gets its slug cleared, a fresh row carries the slug forward. The `supersedes` FK on the updated row persists. Version for new slug increments. |
| `update` → `supersede` (old-slug) | FAILS. The old slug was cleared during the update. `docs supersede` resolves slugs, not attachment IDs, so `E_NOT_FOUND` is returned. **Always supersede BEFORE updating the old slug.** |
| `supersede` → `supersede` (same old, different new) | `superseded_by` on old row is overwritten (latest-wins). First successor's `supersedes` is NOT cleared — it still points at old row. |
| `fetch` after supersede | Returns the old row with `lifecycle_status = 'superseded'` and `superseded_by` filled. Content is still present. Callers must check `lifecycle_status` to distinguish active docs from superseded ones. |
| `publish` after supersede | Publishes the latest version for slug+owner. The new slug's content is the canonical published doc. |
| `supersede` → `add` (same slug) | `docs add` fails with slug collision. The slug namespace is global (ADR-076 AMD-001). |

## Version-number lifecycle

```
                    create
                       │
                       ▼
                  version = 1
                       │
                  docs update
                       │
                       ▼
                  version = 2 ────┬── docs update ──► version = 3 ...
                                  │
                                  ├── noop update ──► version = 2 (unchanged)
                                  │
                                  └── status-only ──► version = 2 (unchanged)

                  docs supersede
                       │
                       ▼
                  No version bump.
                  Old slug: status='superseded', slug intact
                  New slug: supersedes=<oldId>, version unchanged
```

**Key invariant**: version numbers are per-slug and monotonic.
Superseding does not transfer or reset the version counter. If
doc-A (v3) is superseded by doc-B (v1), doc-B stays at v1 until
it receives its own `docs update`.

## Error codes (interaction-relevant subset)

| Code | Verb | Trigger |
|------|------|---------|
| `E_NOT_FOUND` | update | Slug does not exist in `attachments` |
| `E_NOT_FOUND` | supersede | Either oldSlug or newSlug does not exist |
| `E_INVALID_INPUT` | supersede | oldSlug === newSlug |
| `E_INVALID_INPUT` | update | Neither `--file` nor `--content` provided, or both provided |
| `E_INVALID_STATUS` | update | `--status` value not in the allowed lifecycle list |
| `E_DOC_SCHEMA_MISMATCH` | update (--strict) | Body validation failed for doc kind |
| `E_FILE_ERROR` | update | Blob write or SHA-256 read-back integrity check failed |
| `E_SLUG_RESERVED` | add (after supersede) | Attempt to re-use an existing slug after old row still has it |

## Agent guidance

### When to use update vs supersede

- Use `docs update` to revise a document in-place. The slug stays,
  the bytes change, and the old version remains reachable by
  attachment ID.
- Use `docs supersede` when one document formally replaces another
  (e.g., ADR-076 supersedes ADR-028). The old doc gets
  `lifecycle_status = 'superseded'` and a FK pointer to the successor.
  Both docs retain their slugs.

### Correct compound-operation ordering

- **To replace doc-A with doc-B**:
  1. `docs supersede A B` — marks A as superseded, B as successor
  2. Optionally `docs update B ...` to revise the successor
  3. Do NOT update A AFTER superseding it — the old row becomes
     slug-less and unreachable by its original slug

- **To retire a doc without a successor**:
  1. `docs update A --status deprecated` — changes lifecycle without
     changing content

- **To create versioned iterations of the same doc**:
  1. `docs update A --content "..."` — rotates content, bumps version
  2. `docs fetch A` — always returns the latest version

### Version-number expectations

- The `version` field on an update result is informational. Do not
  parse it as a semver — it is a monotonic counter with no semantic
  meaning beyond "which revision is this."
- After a dry-run, `wouldChange: true` with `version: N` means the
  real update would produce `version: N` — use this for preflight
  checks.
- The audit log (`.cleo/audit/docs-versioning.jsonl`) is append-only
  and best-effort. The version counter gracefully falls back to 2
  when the audit file is missing or corrupt.

## Implementation references

| Artifact | Path |
|----------|------|
| Update core | `packages/core/src/docs/docs-update.ts` |
| Supersede core | `packages/core/src/docs/supersede.ts` |
| Dispatch handler | `packages/cleo/src/dispatch/domains/docs.ts` (L1414-L1562) |
| Read model (resolveLatest) | `packages/core/src/docs/docs-read-model.ts` |
| Contracts | `packages/contracts/src/operations/docs.ts` |
| Update E2E tests | `packages/cleo/src/cli/commands/__tests__/docs-update.test.ts` |
| Audit log | `.cleo/audit/docs-versioning.jsonl` |
| Slug SSoT ADR | ADR-076 (`docs/adr/ADR-076-canonical-docs-ssot.md`) |
| Migration guide | `docs/migration/legacy-to-docs.md` |

---

**END OF SPEC**

