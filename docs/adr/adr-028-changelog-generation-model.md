# ADR-028: CHANGELOG Generation Model — Task-Anchored Changesets DSL

**Status**: Accepted (revised 2026-05-20)
**Date**: 2026-03-06 (original) · 2026-05-20 (comprehensive revision)
**Task**: T5577 (original) · T9783 (revision under Saga T9782)
**Epic**: T5576 (original) · T9782 (revision)
**Related ADRs**: ADR-026, ADR-027, ADR-051, ADR-053, ADR-068, ADR-073, ADR-076

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

### 1.1 Original problem (2026-03-06)

CHANGELOG generation in CLEO had two competing implementations:

1. **Legacy path** (`src/core/release/index.ts` — deleted per ADR-026): prepended a bare `# VERSION` header to `CHANGELOG.md` with no section structure. No task-sourced content. No deduplication with existing sections.

2. **Manifest path** (`src/core/release/release-manifest.ts`): stored `## VERSION (date)` as part of the `changelog_text` field in `releases.json` (now `release_manifests` per ADR-027) but never wrote it to `CHANGELOG.md`.

Neither path performed section-aware merging. Running `release ship` twice on the same version could produce duplicate headers. There was no mechanism for contributors to inject custom prose into generated sections.

Additionally, auto-generated content was sourced from `releases.json` (a flat JSON file), while task metadata was stored in `tasks.db`. Sourcing from the database directly enables richer queries (by epic, by status, by type).

### 1.2 What the 2026-05 audit found (T9783 under Saga T9782)

By v2026.5.83 the change-tracking surface had drifted into **five** competing
subsystems instead of two:

| # | Subsystem | Location | Classification |
|---|-----------|----------|----------------|
| 1 | `[custom-log]` block injection | `packages/core/src/release/changelog-writer.ts` | Legacy (ADR-028 §2.2 original) |
| 2 | Label-grouping renderer | `packages/studio/src/lib/release/ui/changelog.ts` | Legacy (UI-only) |
| 3 | Git-log scraping CLI | `packages/cleo/src/cli/commands/release/changelog.ts` | Legacy (drift from DB-sourced canon) |
| 4 | Standalone renderer CLI | `packages/cleo/src/cli/commands/generate-changelog.ts` | Legacy (bypasses release plan) |
| 5 | Task-anchored changesets DSL | `packages/core/src/changesets/` + `packages/core/src/release/changesets-aggregator.ts` | **Canonical** |

The five subsystems wrote overlapping bytes through unrelated code paths. The
audit (`.cleo/agent-outputs/T9783-*.md`) confirmed no shared invariants, no
shared schema, and no shared deduplication. The canonical task-anchored DSL
(introduced T9753, dual-write hardened in T9793, canon-routed in T9796) is the
only path that anchors entries to a task ID by construction and survives the
ADR-076 canonical-docs lockdown.

### 1.3 Resolution (user directive 2026-05-20)

> **"Should NOT supersede ADR-028 — we must fully revamp and fix it comprehensively updated."**

Single canonical path, no deprecation phase. PRs **T9784-A** and **T9784-B**
delete the 4 legacy subsystems. This ADR is rewritten in place to describe the
remaining canonical pipeline. ADR-028 remains `Accepted` (now `Accepted
(revised 2026-05-20)`) — it is **not** superseded by a sibling ADR; it **is**
the definitive spec for change-tracking in CLEO.

---

## 2. Decision

The canonical change-tracking + CHANGELOG generation pipeline is a four-stage
flow: **Author → Validate → Aggregate → Render**. Every stage has exactly one
implementation, one schema, and one storage chokepoint.

### 2.1 Stage 1 — Author (`cleo changeset add`)

Contributors MUST create change entries via the `cleo changeset add` CLI verb,
implemented at `packages/cleo/src/cli/commands/changeset.ts`. The verb is the
ADR-076 canonical writer for `kind: 'changeset'` per `.cleo/canon.yml`.

The verb MUST dual-write:

1. `.changeset/<slug>.md` — the git-tracked, human-reviewable mirror (the
   `publishMirror` for the `changeset` kind, `rawMdAllowed: true` because
   the directory is part of the contract).
2. The docs SSoT blob store, via `packages/core/src/changesets/writer.ts`,
   storing the deduplicated/searchable copy keyed by content hash.

The slug pattern is `/^t\d+-[a-z0-9-]+$/`, anchoring every changeset to a
task ID **by construction**. Entries lacking a `T####` prefix MUST be rejected
at the CLI layer with a clear actionable error.

The frontmatter + body schema is defined in `packages/contracts/src/changesets.ts`
(SSoT). `kind: 'changeset'` is a first-class doc kind registered in
`packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`).

Schema fields the body MUST support (Zod-validated):

- `kind: 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'chore'`
- `tasks: string[]` — one or more `T####` IDs (the slug task is the primary)
- `breaking?: string` — migration instructions; presence promotes the entry
  to the BREAKING section regardless of `kind`
- `notes: string` — markdown body rendered verbatim under the auto-generated,
  `kind`-grouped header

### 2.2 Stage 2 — Validate (`scripts/lint-changesets.mjs`)

CI MUST run `node scripts/lint-changesets.mjs` on every PR. The linter:

1. Enumerates every `*.md` under `.changeset/` (excluding `README.md`).
2. Parses each file against the contract in
   `packages/contracts/src/changesets.ts`.
3. Reports **all** failures in one pass — one bad entry MUST NOT mask the
   rest (T9780 hardening). Failure mode for legacy "first-error-exits"
   behaviour is explicitly prohibited.
4. Exits non-zero if any entry fails validation, blocking the PR.

### 2.3 Stage 3 — Aggregate (`cleo release plan`)

`cleo release plan v<version> --epic T####` is the sole aggregator. It MUST:

1. **Read** every `.changeset/*.md` via `parseChangesetDir(...)` from
   `packages/core/src/changesets/parser.ts`. The parser MUST NOT read git
   history, GitHub labels, or `releases.json` — those sources are legacy and
   are deleted by PR #T9784-A/B.
2. **Aggregate** via the pure function `aggregateChangesetsForRelease(...)`
   in `packages/core/src/release/changesets-aggregator.ts`. The function:
   - Groups entries by `kind` in stable canonical order:
     `breaking → feat → fix → perf → refactor → docs → test → chore`.
   - Renders BREAKING entries as their own top-of-section block. Each
     BREAKING entry's `breaking:` field is rendered as a `**Migration:**`
     call-out at the top of its bullet.
   - Renders the `notes` body verbatim under each entry's bullet.
   - Is **pure**: same inputs MUST produce identical outputs (idempotent,
     no clock reads, no env lookups).
3. **Persist** every aggregated entry into the `release_changesets` table
   (T9753 schema) keyed by `(release_version, changeset_slug)` for audit
   and provenance backfill (ADR-053 pipeline).
4. **Embed** the rendered markdown into the Release Plan envelope's
   `meta.releaseNotes` field, making it the stable machine-readable
   contract for downstream consumers.

### 2.4 Stage 4 — Render (`CHANGELOG.md` + downstream sites)

`cleo release plan` MUST also write the rendered markdown directly into
`CHANGELOG.md` (T9838-A scope), under a section header conforming to §2.5.
The write MUST be **atomic** (temp file → fsync → rename) and **idempotent**:
running `cleo release plan` twice on the same version MUST produce identical
`CHANGELOG.md` bytes.

Downstream documentation sites (Mintlify, Docusaurus, plain HTML) MUST consume
`meta.releaseNotes` from the Release Plan envelope rather than re-parsing
`CHANGELOG.md` or invoking a separate renderer CLI. The deleted
`cleo generate-changelog` CLI (PR #T9784-A) is replaced by this stable JSON
API on the plan envelope.

### 2.5 Canonical section header format

All CHANGELOG sections MUST use the format:

```
## [VERSION] (YYYY-MM-DD)
```

Examples:

- `## [2026.5.83] (2026-05-19)`
- `## [2026.6.0] (2026-05-20)`

The `#` (H1) header level is **reserved** for the document title `# Changelog`
only. Version sections MUST be H2. This invariant is unchanged from the
original ADR-028 §2.1 and remains enforced by the CI gate in §2.7.

### 2.6 Custom prose injection

The original `[custom-log]...[/custom-log]` block syntax is **deleted** with
`packages/core/src/release/changelog-writer.ts` (PR #T9784-B). The replacement
mechanism is the changeset entry's `notes` field (the markdown body after the
YAML frontmatter), which is rendered verbatim under the auto-generated
`kind`-grouped entry.

Contributors inject prose by editing the changeset entry directly — no
separate block syntax, no out-of-band injection, no parser ambiguity. Each
prose block is anchored to a specific task ID via the slug, restoring
traceability that `[custom-log]` lacked.

For breaking changes, the `breaking:` frontmatter field is rendered as a
`**Migration:**` call-out at the top of the BREAKING section's bullet for
that entry. See §2.3 step 2.

### 2.7 CI gate assertion

The release-publish workflow MUST assert that a `## [VERSION] (YYYY-MM-DD)`
section exists in `CHANGELOG.md` before proceeding to `npm publish`. The
gate check MUST:

1. Extract the version from the git tag (strip leading `v`).
2. Run: `grep -qE "^## \[${VERSION}\] \([0-9]{4}-[0-9]{2}-[0-9]{2}\)" CHANGELOG.md`.
3. Fail the job with a clear error message if the section is absent or the
   date format is non-conforming.

This prevents publishing a release without a documented changelog entry. The
gate runs after `cleo release plan` and before the `npm publish` step.

---

## 3. Storage canon

`.changeset/<slug>.md` is `ssot-first` per ADR-076 — git-tracked,
human-reviewable, and canonical-via-cleo-verb. The companion blob in the
docs SSoT (kind `'changeset'`, stored in `manifest.db`'s blob store per
ADR-068's DB charter) is the deduplicated and content-addressed copy.

`release_changesets` (T9753) is the relational projection used by
`cleo release plan` evidence checks (ADR-051) and provenance backfill
(ADR-053). It is NOT a source of truth — it is rebuilt from the dual-write
on demand.

### 3.1 Open question — `.changeset/` location (T9839)

Whether `.changeset/` SHOULD remain at the repository root OR migrate to a
pure SSoT-only kind under `cleo docs publish` is **not decided** in this
ADR. The question is captured as follow-up task **T9839** and MUST NOT
block adoption of the §2 pipeline. Both layouts are compatible with the
canon — only the `publishMirror` value changes.

---

## 4. Consequences

### Positive

- **One pipeline, one schema, one writer**: change-tracking is no longer a
  cross-package archipelago. Five subsystems collapsed to one.
- **Task-anchored by construction**: the `T####-` slug prefix is mandatory.
  Every CHANGELOG bullet traces back to a task in `tasks.db`.
- **Idempotent generation**: `cleo release plan` produces byte-identical
  output for identical inputs. Re-running on the same version MUST NOT
  introduce drift.
- **No parser ambiguity**: `[custom-log]` block deletion removes a class
  of edge cases (nested tags, unclosed tags, tags in code fences).
- **Single CI gate path**: §2.2 lint plus §2.7 publish assertion are the
  only two gates. Both run from `scripts/` and have no runtime deps.
- **Downstream stability**: `meta.releaseNotes` on the plan envelope is a
  versioned JSON contract — sites and tools can consume it without text
  scraping.

### Negative

- **Migration cost**: the four legacy subsystems are deleted in a single
  release cycle (no deprecation phase). Any external tools that invoked
  `cleo generate-changelog` directly will fail until they migrate to
  consuming `meta.releaseNotes`.
- **`.changeset/` directory clutter**: contributors see one file per
  in-flight change. Mitigated by the T9839 follow-up to optionally move
  the directory to SSoT-only.
- **Schema rigidity**: the strict Zod contract in
  `packages/contracts/src/changesets.ts` rejects malformed entries at lint
  time. Contributors learning the format will see one early failure.

### Neutral

- The CI gate runtime cost is negligible (a single `grep` plus a
  `node scripts/lint-changesets.mjs` pass).
- Tasks without a linked changeset are silently excluded from
  CHANGELOG generation. This is the intended behaviour — auto-extracting
  bullets from `tasks.db` without explicit contributor authorship was the
  source of the original drift.

---

## 5. Storage chokepoint summary

| Concern | Single chokepoint |
|---------|-------------------|
| Author entry | `cleo changeset add` (`packages/cleo/src/cli/commands/changeset.ts`) |
| Schema SSoT | `packages/contracts/src/changesets.ts` |
| Doc-kind registration | `packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`) |
| Canon routing | `.cleo/canon.yml` (`kinds.changeset`) |
| Parse | `packages/core/src/changesets/parser.ts` (`parseChangesetDir`) |
| Aggregate | `packages/core/src/release/changesets-aggregator.ts` (`aggregateChangesetsForRelease`) |
| Persist relational | `release_changesets` table |
| Persist canonical bytes | `manifest.db` blob store (kind `'changeset'`) |
| Write CHANGELOG | `cleo release plan` |
| Lint gate | `scripts/lint-changesets.mjs` |
| Publish gate | `release-publish` workflow (`grep -qE "^## \[VERSION\] \(YYYY-MM-DD\)"`) |

If a new code path duplicates any of these chokepoints, it MUST be
deleted or merged. The CI canon-check (`cleo check canon docs`) will flag
new `.md` additions outside the allowlisted `rawMdPaths`.

---

## 6. Related ADRs

- **ADR-026** — Release System Consolidation. Context for the original
  legacy-path deletion that ADR-028 v1 absorbed.
- **ADR-027** — Manifest SQLite Migration. The `release_manifests` table
  is superseded by `releases` (T9686-B2 unification); this ADR's
  `release_changesets` table is the changeset-scoped projection.
- **ADR-051** — Programmatic Gate Integrity. Evidence atoms underpin
  `cleo release plan` evidence checks against the `release_changesets`
  rows.
- **ADR-053** — Project-agnostic Release Pipeline. The pipeline frame
  inside which §2.3's aggregator runs.
- **ADR-068** — DB Charter. Changeset bytes live in `manifest.db`'s blob
  store per the charter's storage allocation.
- **ADR-073** — Above-Epic Naming. The task-hierarchy charter to which
  every changeset is anchored via the `T####-` slug prefix.
- **ADR-076** — Canonical Docs SSoT. Defines the `cleo changeset add`
  routing and the `ssot-first` taxonomy used in §2.1 / §3.

---

## 7. Migration path

1. **Land** PR #T9784-A: delete `cleo generate-changelog` and the
   git-log-scraping `cleo release changelog` CLIs.
2. **Land** PR #T9784-B: delete `packages/core/src/release/changelog-writer.ts`
   (`[custom-log]` injection) and `packages/studio/src/lib/release/ui/changelog.ts`
   (label-grouping renderer).
3. **Verify** `cleo release plan` writes CHANGELOG.md directly (T9838-A).
4. **Update** any contributor-facing docs that referenced the deleted
   verbs to point to `cleo changeset add` (auto-update via canon-doc
   regeneration).
5. **Open** T9839 to decide `.changeset/` directory location.

No data migration is required: existing CHANGELOG history is preserved
verbatim; only new entries flow through the new pipeline.

---

## 8. Revision history

| Date | Author | Summary |
|------|--------|---------|
| 2026-03-06 | T5577 | Original ADR — 2-way competition (legacy bare-header vs manifest path); introduced `## [VERSION] (YYYY-MM-DD)` and `[custom-log]` blocks. |
| 2026-05-20 | T9783 (Saga T9782) | Comprehensive revision — collapses the 5-way drift to a single canonical task-anchored changesets DSL; deletes `[custom-log]`; embeds `meta.releaseNotes` on the plan envelope; aligns with ADR-073 / ADR-076. Status → `Accepted (revised 2026-05-20)`. |

---

## 9. References

- ADR-026: Release System Consolidation (deletion of legacy `writeChangelogFile()`)
- ADR-027: Manifest SQLite Migration (`release_manifests` table, `pipeline_id` linkage)
- ADR-051: Programmatic Gate Integrity (evidence atoms)
- ADR-053: Project-agnostic Release Pipeline
- ADR-068: DB Charter (blob store allocation)
- ADR-073: Above-Epic Naming (task-hierarchy charter)
- ADR-076: Canonical Docs SSoT (`cleo changeset add` routing)
- ADR-016 §8.3: Release workflow architecture
- T5576: LOOM Release Pipeline Remediation (original epic)
- T5577: Release System Consolidation documentation (original task)
- T9753: `release_changesets` table introduction
- T9782: Change-tracking remediation saga (revision parent)
- T9783: ADR-028 revamp task (this revision)
- T9784-A / T9784-B: Legacy subsystem deletion PRs
- T9793: `cleo changeset add` dual-write hardening
- T9796: Canon-lockdown (`.cleo/canon.yml`)
- T9838-A: `cleo release plan` writes CHANGELOG.md directly
- T9839: `.changeset/` location follow-up (open question)
- `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`

---

**END OF ADR-028 (revised 2026-05-20)**
