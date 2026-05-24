# ADR-078: Docs SSoT as DB-Backed Provenance Graph with Supersession + Update-in-Place

- **Status**: Accepted
- **Date**: 2026-05-24
- **Epic**: T10157 (E12-DOCS-PROVENANCE-INTEGRITY)
- **Saga**: T9855 (SG-TEMPLATE-CONFIG-SSOT)
- **Layers on**: T9787 SG-DOCS-CANON-CLOSURE (canon routing — shipped),
  T9625 SG-CLEO-DOCS-CANON (slug + classify — shipped)
- **Cross-refs**: ADR-073 (saga charter), ADR-076 (E10 saga-first-class),
  ADR-077 (E11 human-render-contract)
- **Absorbs scope of**: T10153 (auto-numbering), T10154 (body schema)
- **Authors**: cleo-prime (proposed 2026-05-22; accepted 2026-05-24 via T10169)

## Context

T9787 (SG-DOCS-CANON-CLOSURE) shipped the routing foundation: every doc kind
has a typed `DocKindMetadata` entry in `packages/contracts/src/docs-taxonomy.ts`
with `entityIdPattern`, `publishDir`, and `requiresEntityId`. `.cleo/canon.yml`
mirrors the kinds for CI gating. Attachments are stored as content-addressed
blobs (sha256) joined to owner entities via `attachment_refs`. `cleo docs add`,
`cleo docs publish`, `cleo docs fetch` operate against this SSoT.

Stopping there left five compounding gaps:

1. **Storage gap.** Only ADRs have a denormalized index
   (`.cleo/adrs/adr-index.jsonl`) carrying `status`, `relatedTasks`, `keywords`,
   `topics`, `summary`. The other 9 doc kinds (spec, research, handoff, note,
   llm-readme, changeset, release-note, plan, rcasd) get no equivalent. The
   JSONL has concurrency hazards (no atomic update), is filesystem-coupled, and
   is not queryable from the CLI without grep.
2. **Supersession gap.** `packages/core/src/docs/` has zero supersession or
   conflict-detection logic. Meanwhile `brain_decisions`
   (`packages/core/src/store/memory-schema.ts:204-334`) already implements the
   exact pattern: `supersedes` / `supersededBy` columns + a `status` enum
   `['proposed', 'accepted', 'superseded']` + a `provenance_class` audit field.
3. **Update-in-place gap.** Every `cleo docs add` creates a new blob. `llmtxt`
   ships `squashPatches` / `diffVersions` / `reconstructVersion` but no CLI
   surface exposes them. Minor edits create doc bloat.
4. **Vector + graph surface gap.** `llmtxt` ships `rankBySimilarity` and
   `buildGraph` — both consumed inside `docs-ops.ts` but neither surfaces as a
   CLI verb. Agents cannot ask "what's already been written about X?" or
   "show me everything related to T10113."
5. **Validation gap.** `entityIdPattern` enforces slug format but doesn't
   auto-resolve next-available numbers (T10153). The taxonomy declares no
   body schema (T10154). Both ADR-076 and ADR-077 were created on 2026-05-22
   by hand-picking numbers from `ls .cleo/adrs/` — concrete evidence the
   system trusts authors to be archivists.

## Decision

Treat docs as **first-class provenance-linked entities in the database**,
mirroring the proven `brain_decisions` pattern. Eliminate `adr-index.jsonl`.
Surface `llmtxt`'s vector + graph primitives in the CLI. Enforce
update-in-place vs supersession semantics per the user's anti-bloat policy.

### 1. Extend the `attachments` table (single migration)

Mirror `brain_decisions`. Seven new columns:

| Column | Type | Purpose |
|--------|------|---------|
| `lifecycle_status` | TEXT (enum) | `draft` \| `proposed` \| `accepted` \| `superseded` \| `archived` \| `deprecated`. Defaults to `draft`. |
| `supersedes` | TEXT FK → `attachments.id` | Forward edge: this doc supersedes another. |
| `superseded_by` | TEXT FK → `attachments.id` | Reverse edge: this doc has been superseded. |
| `summary` | TEXT | 1–2 sentence abstract. |
| `keywords` | TEXT (JSON) | Topic keywords. |
| `topics` | TEXT (JSON) | Coarser topic clusters. |
| `related_tasks` | TEXT (JSON) | `T###` IDs linked at attach time. |

All nullable except `lifecycle_status` (default `draft`). Indices on
`lifecycle_status` and `supersedes` for graph traversal.

### 2. Atomic ID-numbering in DB (`packages/core/src/docs/numbering.ts`)

`SELECT MAX(<numeric portion of slug>) FROM attachments WHERE type=? AND slug LIKE '<prefix>-%'`
in a single transaction. `cleo docs add --slug adr-AUTO-foo` resolves `AUTO`
post-query, then `INSERT` runs in the same `BEGIN IMMEDIATE` transaction.

### 3. Body schema validation per kind

`DocKindMetadata` gains `requiredSections: readonly string[]`. `cleo docs add`
scans the body for matching H2 headers; raises `E_DOC_SCHEMA_MISMATCH` on
miss. Examples:

- `adr`: `[Status, Date, Context, Decision, Consequences]`
- `spec`: `[Goal, Non-Goals, Requirements, Out-of-Scope]`
- `research`: `[Question, Findings, Sources]`
- `rcasd`: `[Root-Cause, Action, Schedule, Detection]`

### 4. New CLI verbs

| Verb | Effect |
|------|--------|
| `cleo docs update <slug> [file]` | Replace content; preserve slug; append to version chain via `squashPatches`. NOT supersession. |
| `cleo docs supersede <old> <new>` | Atomic write of all four lineage fields. Mirrors `brain_decisions` write pattern. |
| `cleo docs find --similar <slug>` | Surface `rankBySimilarity` with cosine score. |
| `cleo docs graph --root <slug>\|<taskId>` | Surface `buildGraph`. Returns `TreeResponse<T>` consumable by the E11 renderer. |
| `cleo docs lineage <slug>` | Walk full supersession chain in either direction. |
| `cleo docs diff <slug>` | Diff current version against previous. |
| `cleo docs validate <slug>` | Post-hoc body-schema check. |

### 5. Anti-bloat policy enforced at add time

`cleo docs add` calls `rankBySimilarity` against existing same-kind docs
before storing. If max score > 0.85, prompt: *"Similar to `<slug>` (score
0.92) — did you mean `cleo docs update <slug>`?"* `--allow-similar` override
emits an audit-log entry.

CI gate (`scripts/lint-docs-similarity.mjs`) blocks PRs adding near-duplicates
unless commit trailer `Docs-Similar-Allowed: <reason>` is present.

### 6. Decommission `adr-index.jsonl`

Idempotent backfill migrates every JSONL row into the new attachment columns.
JSONL deleted (or kept as `.deprecated` mirror until N+2 release). New CI lint
blocks writes to it.

## Consequences

### Positive

- **Single queryable surface** for every doc kind. No more grep-only ADR
  discovery.
- **Provenance closed**. Docs ↔ tasks ↔ decisions ↔ sessions ↔ memory form a
  unified graph traversable by `cleo docs graph` and rendered by the E11
  unified tree renderer.
- **Anti-bloat enforced** at both add-time (warn) and CI (block).
- **Battle-tested pattern**: mirrors `brain_decisions` supersession, which
  has been in production since T1260 PSYCHE E3.
- **LLM-agent-friendly**: agents query the docs graph via typed CLI verbs
  instead of grep + JSONL parsing.

### Negative

- **Migration surface**: 1 drizzle migration adds 7 columns; backfill touches
  ~75 existing ADRs. Mitigated by idempotent backfill + nullable columns.
- **`adr-index.jsonl` consumers**: any external script that read the JSONL
  needs to migrate to `cleo docs find --kind adr --json`. Public surface is
  the CLI, so consumer risk is low.

### Neutral

- **Vector index source**: `llmtxt/similarity` builds the embedding store
  per-call from the attachment blob set. Future optimization (cached
  embeddings, incremental update) is a separate follow-up.

## Implementation Tasks (Epic T10157)

| Task | Title |
|------|-------|
| T10158 | C1: migration — 7 provenance columns on attachments |
| T10159 | C2: atomic ID-numbering (absorbs T10153) |
| T10160 | C3: body schema validation (absorbs T10154) |
| T10161 | C4: cleo docs update verb |
| T10162 | C5: cleo docs supersede verb |
| T10163 | C6: cleo docs find --similar |
| T10164 | C7: cleo docs graph |
| T10165 | C8: backfill adr-index.jsonl → DB |
| T10166 | C9: DocProvenanceResponse contract |
| T10167 | C10: auto-warn at add time |
| T10168 | C11: ct-documentor skill update |
| T10169 | C12: publish ADR-078 (this file matures from proposed → accepted) |
| T10170 | C13: CI gate — docs similarity lint |

## References

- `packages/core/src/store/memory-schema.ts:204-334` — `brain_decisions`
  supersession pattern (the precedent).
- `packages/core/src/store/tasks-schema.ts` — attachments table (target).
- `packages/core/src/docs/docs-ops.ts` — current llmtxt wrapper.
- `.cleo/adrs/adr-index.jsonl` — legacy index to decommission.
- ADR-073 (saga charter), ADR-076 (E10), ADR-077 (E11) — sibling
  architecture decisions in the T9855 spine.
