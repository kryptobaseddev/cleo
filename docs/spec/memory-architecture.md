# CLEO Memory Architecture — Master Specification

> **Spec ID**: MEMORY-ARCH-V1
> **Status**: AUTHORITATIVE
> **Related**: [stdp-wire-up.md](stdp-wire-up.md) (plasticity layer),
> [database-architecture.md](database-architecture.md) (store layout),
> [ADR-048](../adr/adr-048-memory-extraction-pipeline.md) (extraction pipeline contract),
> [ADR-047](../adr/adr-047-autonomous-gc-and-disk-safety.md) (transcript GC),
> [ADR-009](../adr/adr-009-brain-cognitive-architecture.md) (BRAIN cognitive architecture)

---

## §1 Purpose and Scope

### §1.1 Purpose

This specification is the source of truth for CLEO's memory architecture. It
governs:

1. Transcript lifecycle — where provider transcripts live, how they are
   extracted, and how they are pruned
2. The three-layer pipeline from raw transcripts to long-term memory
3. Schema — the `brain_*` tables involved in storage and retrieval
4. Extraction — the write-time gate and the extraction paths
5. Tier promotion — the short/medium/long lifecycle
6. CLI and Studio surfaces

When this document and the code disagree, the code wins and this document is
corrected.

### §1.2 Where memory lives

Memory is the `brain_*` table family. It is the one domain present in both
`cleo.db` scopes, with the same DDL in each
(`packages/core/src/store/schema/cleo-shared/brain.ts`):

- **Project memory**: `<project>/.cleo/cleo.db`.
- **Global memory**: `<cleoHome>/cleo.db`, where `cleoHome` is
  `~/.local/share/cleo` on Linux and `~/Library/Application Support/cleo` on
  macOS (`CLEO_HOME` overrides it).

`getBrainDb()` opens the project store through `openDualScopeDb`
(`packages/core/src/store/memory-sqlite.ts:5-24`). The separate `brain.db`
file is legacy. Where this spec says "the store", it means the `brain_*`
tables in `cleo.db`.

---

## §2 Three-Layer Architecture

### §2.1 Overview

```
LAYER 1: RAW TRANSCRIPTS (provider-owned)
  ~/.claude/projects/<project-slug>/<session>.jsonl
  ~/.claude/projects/<project-slug>/<session>/subagents/agent-*.jsonl
  Lifecycle: HOT (<24h) → WARM (24h–7d) → COLD (>7d: memory rows only)

LAYER 2: WRITE-TIME GATE + STORAGE
  Input: LLM-extracted memories + direct observe/decide/learn calls
  Gate: verifyAndStore() → title blocklist → content-hash dedup → embedding similarity → confidence
  Tables: brain_observations, brain_decisions, brain_patterns, brain_learnings
  Default tiers: observations=short, decisions=medium, patterns=medium, learnings=short

LAYER 3: CONSOLIDATION + TIER PROMOTION
  runConsolidation(): Steps 1–10 (see §4.5)
  Observer + Reflector: compress and synthesize session observations
  Long tier: never auto-evicted
```

### §2.2 Data flow

```
Session work
   │
   ├─ provider writes ~/.claude/projects/<slug>/<session>.jsonl
   │
   └─ SessionEnd hooks (all dispatched concurrently; see §6.5)
        brain-session-end         → if brain.autoCapture: adapter.getTranscript()
                                    → llm-extraction.extractFromTranscript()
                                    → verifyAndStore() / storeDecision()
        consolidation-session-end → runConsolidation() (setImmediate)
        observer-session-end      → runObserver(threshold 1) (setImmediate)
        reflector-session-end     → runReflector() (setImmediate)
        transcript-schedule       → transcript_pending_extraction:<session> observation
        journal-session-end       → .cleo/session-journals/ entry

   endSession() itself takes the session-end SQLite snapshot after the session row is written.

Manual / on demand
   cleo transcript extract | migrate → TranscriptExtractor → typed store functions → tombstone, JSONL deleted
   cleo memory consolidate | dream --apply → runConsolidation()
   cleo memory reflect → runObserver() + runReflector()

GC daemon (cleo daemon start, daily 03:00 UTC)
   runGC(): age + disk-pressure pruning of ~/.claude/projects/ (no extraction)
```

Sources: `packages/core/src/hooks/handlers/session-hooks.ts`,
`packages/core/src/sessions/session-end-snapshot.ts`,
`packages/core/src/gc/gc-subsystem.ts:53`, `packages/core/src/gc/runner.ts`.

---

## §3 Schema

### §3.1 Memory tier column

**Enum** (`packages/core/src/store/schema/memory-schema.ts:54`):

```typescript
export const BRAIN_MEMORY_TIERS = ['short', 'medium', 'long'] as const;
```

**Default tier per table** (`packages/core/src/store/schema/cleo-shared/brain.ts:351`, `:453`, `:514`, `:590`):

| Table | `memory_tier` default |
|---|---|
| `brain_observations` | `'short'` |
| `brain_decisions` | `'medium'` |
| `brain_patterns` | `'medium'` |
| `brain_learnings` | `'short'` |

### §3.2 Tier audit columns

All four tables carry:

| Column | Type | Purpose |
|---|---|---|
| `tier_promoted_at` | TEXT | Timestamp of the last promotion; null if never promoted |
| `tier_promotion_reason` | TEXT | Free-text reason written by the promoter, e.g. `citationCount=4 >= 3, age > 24h` |

The columns were added by `packages/core/migrations/drizzle-brain/20260416000005_t726-dedup-tier-columns/migration.sql`,
which also added `content_hash` to decisions, patterns and learnings, and are
part of the consolidated schema in `cleo-shared/brain.ts`.

`brain_promotion_log` (`cleo-shared/brain.ts:1304`) records observation
promotions decided by the composite scorer (`from_tier`, `to_tier`, `score`,
`decided_by`, `rationale_json`).

### §3.3 Transcript records in `brain_observations`

Two observation records track transcripts. Both are written through
`observeBrain` with `type = 'discovery'`, `sourceType = 'agent'` and
`sourceSessionId` set to the session:

| Record | Title | Writer |
|---|---|---|
| Queued | `transcript_pending_extraction:<sessionId>` | session-end hook (`session-hooks.ts:204`) |
| Extracted (tombstone) | `transcript-extracted:<sessionId>` | `TranscriptExtractor` (`transcript-extractor.ts:560`) |

The extractor skips a session when a row with that `source_session_id` and a
title starting `transcript-extracted:` exists (`transcript-extractor.ts:543`).

### §3.4 STDP schema (cross-reference)

These tables are specified in [stdp-wire-up.md](stdp-wire-up.md); this spec
does not redefine them:

- `brain_retrieval_log` — retrieval events (STDP input)
- `brain_plasticity_events` — LTP/LTD events
- `brain_page_edges` — memory graph with plasticity columns
- `brain_weight_history` — edge weight audit log
- `brain_modulators` — R-STDP reward events
- `brain_consolidation_events` — one row per `runConsolidation` run; `step_results_json` holds the per-step results

---

## §4 Extraction Pipeline

### §4.1 Technique status

| # | Technique | Status in code |
|---|---|---|
| 1 | LLM extraction at session end | Wired. Runs when `brain.autoCapture` is on and the active adapter returns a transcript (`session-hooks.ts:72-90`) |
| 2 | Write-time dedup | Wired. Content-hash dedup covers all four tables; embedding similarity runs when embeddings are available (§4.2) |
| 3 | Observer / Reflector compression | Wired at session end and via `cleo memory reflect` (§4.4) |
| 4 | Temporal supersession | `detectSupersession()` exists (`temporal-supersession.ts:366`) but no production code calls it |
| 5 | BRAIN↔NEXUS graph bridge | Wired as consolidation Step 8, `autoLinkMemories()` (`graph-memory-bridge.ts:619`) |
| 6 | Sleep-time consolidation | Wired as consolidation Step 10 (§4.5) |
| 7 | Reciprocal Rank Fusion retrieval | Implemented in `hybridSearch()` (`brain-search.ts:1202`, `RRF_K = 60`), exposed as `cleo memory search-hybrid` |

### §4.2 Write-time gate

`verifyAndStore(projectRoot, candidate)` (`packages/core/src/memory/extraction-gate.ts:600`)
runs `verifyCandidate()` and stores only on `action: 'stored'`:

```
[MemoryCandidate]
   │
   ├── [A0] title-prefix noise blocklist            → rejected
   ├── [A]  content-hash dedup on the routed table  → merged (citation_count incremented)
   │          semantic → brain_learnings, procedural → brain_patterns, episodic → brain_observations
   ├── [B]  embedding similarity (untrusted sources, when embeddings are available)
   │          cosine distance < 0.15 → stored, flagged potential duplicate
   │          distance < 0.30 with opposite polarity → stored, flagged potential contradiction
   │          distance < 0.30 otherwise → stored as similar-but-distinct
   └── [C]  confidence < 0.40                       → pending
   │
   ▼
 storeVerifiedCandidate()
```

Sources: `extraction-gate.ts:101-108` (thresholds), `:354-470` (checks).
Owner and task-outcome candidates are trusted and skip check B. Similarity
never merges two rows by itself; it only flags candidates.

Decisions do not go through `verifyAndStore`. The LLM extraction path runs
`checkHashDedup(..., 'brain_decisions')` and then calls `storeDecision`
directly (`llm-extraction.ts:186-224`).

New extraction paths MUST use `verifyAndStore()` for patterns, learnings and
observations, and `checkHashDedup()` before `storeDecision()`.

### §4.3 LLM extraction (Technique 1)

**Location**: `packages/core/src/memory/llm-extraction.ts`

| Setting | Value | Source |
|---|---|---|
| Enable flag | `brain.llmExtraction.enabled`, default `true` | `packages/core/src/config.ts` |
| Model | `brain.llmExtraction.model`, else the `extraction` role, else `IMPLICIT_FALLBACK_MODEL` (`claude-haiku-4-5-20251001`) | `llm-extraction.ts:414`, `packages/core/src/llm/fallback-model.ts:24` |
| Types | `decision`, `pattern`, `learning`, `constraint`, `correction` | `llm-extraction.ts` `ExtractionType` |
| Max memories per call | `brain.llmExtraction.maxExtractions`, default 7 | `llm-extraction.ts:398` |
| Importance floor | `brain.llmExtraction.minImportance`, default 0.6 | `llm-extraction.ts:397` |
| Transcript clip | `brain.llmExtraction.maxTranscriptChars`, default 60,000, head + tail | `llm-extraction.ts:399` |

Routing: decisions → `brain_decisions`; patterns and corrections →
`brain_patterns`; learnings and constraints → `brain_learnings`. Candidates
carry `source: 'transcript'` and the session ID.

Extraction never throws; when no credential resolves it returns nothing.

### §4.4 Observer / Reflector (Technique 3)

`packages/core/src/memory/observer-reflector.ts`. Both route through
`executeForRole` with the `consolidation` role; `CLEO_OBSERVER_MODEL`
overrides the resolved model. With no credential they no-op.

**Observer** (`runObserver`, `:541`):
- Runs when uncompressed observations reach `brain.observer.threshold` (default 10).
- The session-end hook passes `thresholdOverride: 1`, so it runs for every session.
- Batch limit: 30 observations.
- Writes `source_type = 'observer-compressed'` observations and a `supersedes`
  edge from each compressed note to its source observations (`:464`).

**Reflector** (`runReflector`, `:671`):
- Reads up to 50 session observations, raw and compressed.
- Stores patterns via `storePattern()` and learnings via `storeLearning()`,
  tagged `reflector-synthesized`.
- Returns the model's proposed superseded IDs as `proposedSupersededIds` but
  writes no supersession: LLM synthesis is not evidence that a source
  observation stopped being true (`:809-819`).

Session-end Observer and Reflector are dispatched concurrently with the other
handlers, so the Reflector is not guaranteed to see the Observer's output
(§6.5).

### §4.5 Consolidation and sleep-time consolidation (Technique 6)

`runConsolidation(projectRoot, sessionId?, trigger)` in
`packages/core/src/memory/brain-lifecycle.ts:958` runs each step best-effort;
a failing step logs and the run continues.

```
Step 1:    deduplicateByEmbedding
Step 2:    recomputeQualityScores
Step 3:    runTierPromotion (§5)
Step 3b:   fulfillPromotionLog — turns promotion-log rows into learnings/patterns
Step 4:    detectContradictions
Step 4b:   dedupePatterns
Step 5:    softEvictLowQualityMedium
Step 6:    strengthenCoRetrievedEdges (Hebbian, brain_page_edges)
Step 6b:   NEXUS co-access strengthening (nexus_relations)
Step 6c:   NEXUS plasticity decay
Step 7:    consolidateMemories (cluster summaries)
Step 8:    autoLinkMemories (BRAIN↔NEXUS bridge)
Step 9a:   backfillRewardSignals (R-STDP)
Step 9a.5: correlateOutcomes (quality feedback)
Step 9b:   applyStdpPlasticity (when shouldRunPlasticity)
Step 9c:   applyHomeostaticDecay
Step 9d:   pruneStaleHistory (plasticity events + weight history retention)
Step 9f:   runPruneSweep (hard delete of prune candidates)
Step 9g:   consolidateAttention
Step 9e:   log the run to brain_consolidation_events (runs after 9f and 9g)
Step 10:   runSleepConsolidation
```

`runSleepConsolidation()` (`packages/core/src/memory/sleep-consolidation.ts:940`)
runs four sub-steps through the `consolidation` LLM role, enabled unless
`brain.sleepConsolidation.enabled` is `false`:

1. Merge near-duplicates — embedding similarity > 0.85
2. Prune stale — short-tier entries older than 7 days with quality < 0.4
3. Strengthen patterns — synthesize learnings cited at least 3 times into patterns
4. Generate insights — cross-cutting insights from clusters of observations

With no credential the LLM steps no-op and the structural steps still run.

**Triggers**: the session-end hook (§6.5); `cleo memory consolidate`;
`cleo memory dream --apply`. The autonomous auto-dream trigger
(`packages/core/src/memory/dream-cycle.ts`) is hosted by the sentient daemon
tick. ADR-098 makes CLEO a harness-agnostic core and freezes the long-running
runtime services, the sentient host among them, for removal, so no part of
this spec depends on that trigger.

---

## §5 Tier Promotion

### §5.1 Three-tier model

| Tier | Purpose | Assignment |
|---|---|---|
| **short** | Recent, possibly noisy | Default for observations and learnings |
| **medium** | Survived the promotion gate; durable across sessions | Default for decisions and patterns; promoted from short |
| **long** | High-confidence knowledge | Promoted from medium; never auto-evicted |

### §5.2 Promotion rules

`runTierPromotion(projectRoot)` (`packages/core/src/memory/brain-lifecycle.ts:407`)
covers `brain_observations`, `brain_learnings`, `brain_patterns` (age from
`extracted_at`) and `brain_decisions`:

```
short → medium (age > 24h AND any of):
  A. citation_count >= 3
  B. quality_score >= 0.7
  C. verified = 1

medium → long (age > 7d AND any of):
  A. citation_count >= 5
  B. verified = 1

Soft eviction of short entries (age > 7d):
  not verified AND (quality_score IS NULL OR quality_score < 0.5) → invalid_at = now

Step 5 soft eviction of medium entries:
  quality_score < 0.30 AND age > 30d → invalid_at = now

Long-tier entries are never auto-evicted.
```

There is no cap on the long tier.

### §5.3 Promotion persistence

Every automatic promotion writes `memory_tier`, `updated_at`,
`tier_promoted_at` and `tier_promotion_reason` in one `UPDATE`
(`brain-lifecycle.ts:490-496`, `:530-535`).

### §5.4 Manual override

```
cleo memory tier promote <id> --to medium|long --reason "<text>"   # bypasses the age gate
cleo memory tier demote  <id> --to short|medium --reason "<text>"  # --force required from long
```

### §5.5 Medium→short demotion (not implemented)

Low-value medium entries are soft-evicted by Step 5 (§5.2); nothing demotes
them to short. A demotion rule would need its own decision before
implementation.

---

## §6 Transcript Lifecycle

### §6.1 Hot / warm / cold

```
HOT (<24h)                 WARM (24h–7d)              COLD (>7d)
────────────────────────   ─────────────────────────  ───────────────────────────
Full JSONL retained         Eligible for extraction     Raw JSONL gone
Agents can re-read          (cleo transcript extract)   Memory rows + tombstone remain
```

Tier boundaries: `packages/core/src/gc/transcript.ts` (`HOT_MAX_MS`,
`WARM_MAX_MS`). `cleo transcript scan` reports the breakdown.

### §6.2 Storage layout

```
~/.claude/projects/
  <project-slug>/
    <session-uuid>.jsonl             ← root-level main session transcript
    <session-uuid>/                  ← present when subagents ran
      subagents/
        agent-<agentId>.jsonl        ← subagent transcript
        agent-<agentId>.meta.json
      tool-results/
        <toolUseId>.json
```

### §6.3 Reading transcripts

The Claude Code adapter's `getTranscript()`
(`packages/adapters/src/providers/claude-code/hooks.ts:422`) reads the
root-level `*.jsonl` files and the `subagents/agent-*.jsonl` files under each
session directory, and returns the user/assistant turn text. It returns `null`
when nothing is found or a read fails. The Codex and Gemini CLI adapters read
the latest transcript under `~/.codex` and `~/.gemini` through the shared
`readLatestTranscript` helper (`packages/adapters/src/providers/shared/transcript-reader.ts`).
The lifecycle in §6.1–§6.2 and the GC in §8 cover only `~/.claude/projects/`.

### §6.4 Circuit breakers

| Condition | Action | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` absent | `cleo transcript prune` deletes only sessions older than 30 days, whatever `--older-than` says | `packages/core/src/gc/transcript.ts:241-265` |
| Disk usage ≥ 70 / 85 / 90 / 95 % | GC daemon shortens retention (see §8) | `packages/core/src/gc/runner.ts:53-63` |

### §6.5 Session-end hooks

Registered in `packages/core/src/hooks/handlers/session-hooks.ts:275-339`:

| Priority | Hook id | Work |
|---|---|---|
| 100 | `brain-session-end` | Session grading; LLM extraction when `brain.autoCapture` is on; memory bridge refresh |
| 5 | `consolidation-session-end` | `runConsolidation()` via `setImmediate` |
| 4.5 | `observer-session-end` | `runObserver(..., { thresholdOverride: 1 })` via `setImmediate` |
| 4 | `reflector-session-end` | `runReflector()` via `setImmediate` |
| 3 | `transcript-schedule-session-end` | Writes the `transcript_pending_extraction:<sessionId>` observation |
| 2 | `journal-session-end` | Appends to `.cleo/session-journals/` (awaited) |

`hooks.dispatch` runs every handler for an event concurrently
(`Promise.allSettled`). Priority orders the handler list, not execution; no
handler may rely on another having finished. The session-end SQLite snapshot
is not a hook: `endSession` calls `snapshotAfterSessionEnd`
(`packages/core/src/sessions/session-end-snapshot.ts:140`) after the session
is persisted.

---

## §7 LLM Model Choices

### §7.1 Transcript extraction (`cleo transcript extract` / `migrate`)

`TranscriptExtractor` (`packages/core/src/memory/transcript-extractor.ts:168`)
resolves a backend with `resolveLlmBackend()`
(`packages/core/src/memory/llm-backend-resolver.ts`):

| Tier | Chain |
|---|---|
| `warm` (default) | `extraction` role profile → Ollama at `localhost:11434` (`gemma4:e4b-it`, then `gemma4:e2b-it`, then `gemma4:e2b`) → `@huggingface/transformers` (`onnx-community/Qwen2.5-0.5B-Instruct`) → `claude-sonnet-4-6` → none |
| `cold` | `extraction` role profile → `claude-sonnet-4-6` → none |

The cold tier MUST use `claude-sonnet-4-6`, not Haiku (owner decision,
`llm-backend-resolver.ts:100`). `scripts/install-ollama.mjs` installs Ollama.
With no backend, extraction is skipped.

The extractor writes decisions, patterns and learnings through
`storeDecision`, `storePattern` and `storeLearning` with
`source = 'transcript-warm-extract:<sessionId>'`, writes the tombstone, then
deletes the source JSONL unless `--dry-run` is passed.

### §7.2 Session-end extraction, Observer, Reflector, sleep consolidation

| Component | Role / model |
|---|---|
| Session-end LLM extraction | `brain.llmExtraction.model`, else the `extraction` role, else `claude-haiku-4-5-20251001` (§4.3) |
| Observer, Reflector | `consolidation` role; `CLEO_OBSERVER_MODEL` overrides |
| Sleep consolidation | `consolidation` role |

Role resolution follows `config.llm.roles.<role>` → `config.llm.default` →
implicit fallback (`sleep-consolidation.ts:11-17`). Reading the Claude Code
OAuth credential from `~/.claude/.credentials.json` requires
`auth.claudeCodeConsentGiven = true`, which defaults to `false`
(`packages/core/src/config.ts`, `packages/core/src/llm/credential-seeders/claude-code-seeder.ts`).

### §7.3 Embedding model

Local `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` (384
dimensions), stored in the `brain_embeddings` vec0 table through sqlite-vec
(`packages/core/src/memory/embedding-local.ts:5-29`,
`packages/core/src/memory/brain-similarity.ts`). The model downloads only when
`brain.embedding.allowModelDownload` is `true`. No embedding API calls are made.

---

## §8 Transcript GC

### §8.1 GC daemon

`cleo daemon start` spawns a detached sidecar (`packages/core/src/gc/daemon.ts`)
that schedules `runGC()` daily at 03:00 UTC with `node-cron`, and on start
runs a missed GC when more than 24 hours have passed
(`packages/core/src/gc/gc-subsystem.ts:53-56`). `cleo daemon stop` and
`cleo daemon status` manage it. Its PID and run state live in
`<cleoDir>/gc-state.json`; its log in `<cleoDir>/logs/gc.log`.

`runGC()` (`packages/core/src/gc/runner.ts:283`) does no extraction. It
measures disk usage, picks a retention window, and deletes transcript paths
under `~/.claude/projects/` older than that window, writing the pending list to
`gc-state.json` before deleting so an interrupted run resumes:

| Disk used | Tier | Retention |
|---|---|---|
| < 70 % | ok | 30 days |
| 70–85 % | watch | 30 days |
| 85–90 % | warn | 7 days, escalation flag set |
| 90–95 % | urgent | 3 days, escalation flag set |
| ≥ 95 % | emergency | 1 day, escalation flag set |

Source: `runner.ts:53-63`, `:139-150`, `:346-350`. Committed
`.cleo/agent-outputs/*.md` files are never pruned.

The daemon deletes without a confirmation flag. Manual deletion through
`cleo transcript prune` is a dry run unless `--confirm` is passed (§9.1).

### §8.2 System service units

No systemd timer or service unit for transcript GC ships in the repo. The GC
daemon runs as the sidecar in §8.1. (`cleo daemon install` registers a
user-level service for the sentient daemon, not for transcript GC.)

---

## §9 CLI Surface

### §9.1 Transcript commands

```
cleo transcript scan [--pending] [--projects-dir <dir>]
cleo transcript extract <session-id> [--tier warm|cold] [--dry-run]
cleo transcript extract --all-warm [--tier warm|cold] [--dry-run]
cleo transcript migrate [--dry-run] [--tier warm|cold] [--older-than-hours N] [--project-filter <slug>] [--limit N]
cleo transcript prune --older-than <7d|24h|30m> [--confirm] [--projects-dir <dir>]
```

`extract` and `migrate` delete each source JSONL after a successful
extraction unless `--dry-run` is given. `prune` dry-runs without `--confirm`.

### §9.2 Memory tier commands

```
cleo memory tier stats
cleo memory tier promote <id> --to medium|long --reason "<text>"
cleo memory tier demote  <id> --to short|medium --reason "<text>" [--force]
```

`tier stats` shows the tier distribution across all four tables and the
top-10 entries closest to long-tier promotion.

### §9.3 Extraction and consolidation commands

```
cleo memory reflect [--session <id>]   # run Observer + Reflector (default: most recent session)
cleo memory dedup-scan [--apply]       # report duplicates; --apply runs consolidation
cleo memory consolidate                # run runConsolidation now
cleo memory dream --apply              # full auto-dream cycle, destructive; --status is read-only
cleo memory llm-status                 # which LLM credential resolved, extraction readiness
```

### §9.4 Retrieval and verification commands

```
cleo memory find "<query>"             # search (filter with --type)
cleo memory timeline <id>              # chronological context around an anchor
cleo memory fetch <id>                 # full entry details
cleo memory search-hybrid "<query>"    # FTS5 + vector + graph, fused with RRF
cleo memory verify <id>                # set verified=true (owner or cleo-prime)
cleo memory pending-verify             # unverified but highly cited entries
```

Run `cleo memory --help` for the full verb list.

---

## §10 Studio Surface

| Surface | Path | Shows |
|---|---|---|
| Page | `/brain/tier-stats` (`packages/studio/src/routes/brain/tier-stats/`) | Tier distribution and upcoming promotions |
| API | `GET /api/memory/tier-stats` (`packages/studio/src/routes/api/memory/tier-stats/+server.ts`) | Per-table short/medium/long counts and the top-5 upcoming long-tier promotions, via `getTierStats()` from `@cleocode/core` |

Studio has no transcript-stats route; transcript counts come from
`cleo transcript scan`.

---

## §11 Schema Change Rules

- Take `cleo backup add` before applying any schema migration
  ([ADR-013](../adr/adr-013-data-integrity-checkpoint-architecture.md)).
- Memory columns are added with nullable `ALTER TABLE … ADD COLUMN`, which
  SQLite cannot drop in place; a rollback leaves the column and ignores it.
- Code-only changes roll back with a revert.

---

## §12 Tests

### §12.1 Transcript lifecycle

`packages/core/src/gc/__tests__/transcript.test.ts`: tier classification,
duration parsing, scanning, and pruning, including:

- TL-F5: `prune` without `--confirm` makes zero filesystem mutations
- TL-F7: with `ANTHROPIC_API_KEY` absent, sessions younger than 30 days are kept

`packages/adapters/src/providers/claude-code/__tests__/hooks-get-transcript.test.ts`
covers `getTranscript()`; `packages/core/src/memory/__tests__/transcript-extractor.test.ts`
covers the extractor.

### §12.2 Tier promotion

`packages/core/src/memory/__tests__/brain-lifecycle-tier-promotion.test.ts`:
each short→medium track (quality, citation, verified), both medium→long
tracks, soft eviction of stale short entries, and coverage of all four
tables. Related: `tier-promotion.test.ts`, `tier-promotion-auto-rows.test.ts`.

### §12.3 Extraction gate and pipeline

`dedup-gates.test.ts`, `brain-dedup.test.ts`, `llm-extraction.test.ts`,
`observer-reflector.test.ts` and `sleep-consolidation.test.ts` under
`packages/core/src/memory/__tests__/`.

### §12.4 Test rules

Tests use a `mkdtemp` project root and a real store; they do not mock SQLite
modules.

---

## §13 Conformance Invariants

An implementation conforms to this spec when all of the following hold:

| ID | Invariant |
|---|---|
| INV-1 | Patterns, learnings and observations from extraction paths pass through `verifyAndStore()`; decisions pass through `checkHashDedup()` before `storeDecision()` (§4.2). |
| INV-2 | Content-hash dedup covers all four memory tables; a hash match increments `citation_count` and creates no row. |
| INV-3 | Embedding similarity alone never merges two rows. |
| INV-4 | Every automatic promotion persists `tier_promoted_at` and `tier_promotion_reason`. |
| INV-5 | Long-tier entries are never auto-evicted. |
| INV-6 | Decision and pattern rows default to `memory_tier = 'medium'`. |
| INV-7 | Session-end memory hooks never block or fail session end. |
| INV-8 | No session-end hook depends on another hook having finished. |
| INV-9 | LLM output never marks an observation superseded by itself. |
| INV-10 | `cleo transcript prune` deletes nothing without `--confirm`. |
| INV-11 | A transcript is extracted at most once per session (tombstone check). |

---

## §14 Owner Decisions

### Q4: Transcript extraction model

Warm extraction prefers local inference (Ollama with Gemma 4, then
transformers.js) and escalates to `claude-sonnet-4-6`; cold extraction uses
`claude-sonnet-4-6`, never Haiku. Implemented in
`packages/core/src/memory/llm-backend-resolver.ts` (§7.1).

### Q5: Transcript GC automation

GC runs as a `node-cron` sidecar started by `cleo daemon start`, not a systemd
timer. Manual pruning needs `--confirm`. The sidecar prunes by age and disk
pressure without confirmation (§8.1).
