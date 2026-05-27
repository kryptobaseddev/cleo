# CLEO Memory Architecture — Master Specification

> **Spec ID**: MEMORY-ARCH-V1
> **Status**: AUTHORITATIVE — supersedes council reports T726-council-transcripts.md,
>   T726-council-tiers.md, T726-council-extraction.md
> **Date**: 2026-04-15
> **Author**: T726 Council Synthesis Lead
> **Parent task**: T726 (EPIC: Memory Architecture Reality Check + Long-Term Tier Wire-Up + Transcript Lifecycle)
> **Synthesized from**:
>   - Lead A: Transcript Lifecycle Council (`T726-council-transcripts.md`)
>   - Lead B: Tier Architecture Council (`T726-council-tiers.md`)
>   - Lead C: Extraction Pipeline Council (`T726-council-extraction.md`)
>   - Prior spec: `docs/specs/stdp-wire-up-spec.md` (STDP cross-reference)
>   - Prior decisions: D008 (7-technique memory architecture), D009 (no LadybugDB replacement)
> **Related specs**: `docs/specs/stdp-wire-up-spec.md` (plasticity layer)

---

## §1 Purpose and Current State

### §1.1 Purpose

This specification is the single authoritative source of truth for CLEO's complete memory
architecture. It governs:

1. Transcript lifecycle — storage, extraction triggers, and garbage collection
2. Three-layer architecture — the end-to-end pipeline from raw session transcripts to
   long-term semantic memory
3. Schema — all brain.db tables involved in memory storage and retrieval
4. Extraction pipeline — the 7-technique D008 system with all gaps identified and remediated
5. Tier promotion — short/medium/long memory lifecycle with promotion rules and decay
6. CLI surface — all commands required for owner visibility and control
7. Studio surface — observability for the `/brain` page
8. Migration sequence — how to get from broken current state to fully-wired target state

Workers implementing T726 subtasks MUST treat this document as the canonical source of truth.
The three council reports are superseded (reference only).

### §1.2 Current State (as of 2026-04-15)

**Memory tier distribution** (live brain.db):

| Table | short | medium | long | Total active |
|-------|-------|--------|------|-------------|
| `brain_observations` | 849 | 148 | 0 | 997 |
| `brain_decisions` | 0 | 16 | 0 | 16 |
| `brain_learnings` | 0 | 7 | 0 | 7 |
| `brain_patterns` | 0 | 2 | 0 | 2 |
| **TOTAL** | **849** | **173** | **0** | **1022** |

**Long tier empty**: By design — the 7-day age gate + citation≥5 threshold has not elapsed
for any entry. The oldest eligible entry crosses the threshold ~2026-04-18. No bug.

**Transcript state**:
- `~/.claude/projects/` contains 750MB (cleocode) / 3.5GB (all projects) with zero GC
- 86 root session JSONLs + 964 subagent JSONLs for cleocode alone
- `getTranscript()` P0 bug: reads UUID subdirs for *.jsonl — always returns null

**Pipeline gaps** (confirmed P0 — never running in production):
1. LLM extraction has never received a transcript (P0: `getTranscript` wrong path)
2. `runSleepConsolidation()` is orphaned — exported but never called
3. LLM extraction bypasses `verifyAndStore` gate — zero dedup on extracted memories
4. `hashDedupCheck` covers `brain_observations` only — decisions/patterns/learnings can dupe

**What IS working**:
- `runTierPromotion()` — fully functional, correct logic
- `runConsolidation()` Steps 1–9e — all wired except Step 10
- Write-time tier routing for decisions/patterns/learnings — correct
- `observer-reflector.ts` Observer+Reflector — functional with two gaps (T740/T742)
- `cleo memory consolidate` CLI — manual trigger works
- `brain-similarity.ts` sqlite-vec integration — wired

---

## §2 Three-Layer Architecture

### §2.1 Overview

The memory system operates in three conceptual layers:

```
LAYER 1: RAW TRANSCRIPTS
  ~/.claude/projects/<project>/<session>.jsonl
  ~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl
  Lifecycle: HOT (0-24h) → WARM (1-7d) → deleted (COLD = brain.db only)
  Owner: T729 (bug fix), T730 (extractor), T731 (GC), T732 (hook), T733 (migration)

LAYER 2: WRITE-TIME GATE + BRAIN.DB STORAGE
  Input: LLM-extracted memories from transcripts + direct observe/decide/learn calls
  Gate: verifyAndStore() → hashDedupCheck (all 4 tables) → embeddingDedupCheck → confidence
  Tables: brain_observations, brain_decisions, brain_patterns, brain_learnings
  Default tiers: observations=short, decisions=medium, patterns=medium, learnings=short|medium
  Owner: T736 (gate bypass fix), T737 (hashDedup all tables), T746 (schema default fix)

LAYER 3: CONSOLIDATION + TIER PROMOTION + LONG-TERM SEMANTIC MEMORY
  Input: brain.db entries from Layer 2
  Processing: runConsolidation() Steps 1-10 at every session end
    Step 1: deduplicateByEmbedding
    Step 2: recomputeQualityScores
    Step 3: runTierPromotion (short→medium→long)
    Step 4: detectContradictions
    Step 5: softEvictLowQualityMedium
    Step 6: strengthenCoRetrievedEdges (Hebbian)
    Step 7: consolidateMemories (cluster-based)
    Step 8: autoLinkMemories (brain↔nexus graph bridge)
    Step 9a: backfillRewardSignals (R-STDP)
    Step 9b: applyStdpPlasticity (STDP timing-dependent)
    Step 9c: applyHomeostaticDecay
    Step 9d: weight_history retention sweep
    Step 9e: logConsolidationEvent
    Step 10: runSleepConsolidation [T734 — currently orphaned]
  Observer+Reflector: compress+synthesize session observations (priority 4/3 hooks)
  Long tier: permanent; first entries expected 2026-04-18
  Owner: T734 (Step 10 wire), T741/T743 (schema+logic), T747 (tests)
```

### §2.2 Data Flow (Target State)

```
 Session work  ──────────────────────────────────────────────────────────────────────►
                                                                                       │
 ~/.claude/projects/<project>/<session>.jsonl  ◄──── Claude Code writes live ─────────┤
                                                                                       │
 session.end fires:                                                                    │
   Priority 100: getTranscript() ─► condensed turns ─► llm-extraction.ts              │
                 [T729 fixes path]   [T730 condenses]   [extracts 7 types]             │
                 └─► ExtractedMemory[] ─► verifyAndStore() [T736]                     │
                                          ├── hashDedupCheck (all 4 tables) [T737]    │
                                          ├── embeddingDedupCheck (sqlite-vec)         │
                                          └── write to brain.db at short/medium tier  │
   Priority 10:  VACUUM INTO backup                                                    │
   Priority 5:   runConsolidation() Steps 1-10                                         │
                   Step 3: runTierPromotion                                             │
                     short→medium: 24h + (cite≥3 OR quality≥0.7 OR verified=1)        │
                     medium→long:   7d + (cite≥5 OR verified=1)                        │
                   Step 10: runSleepConsolidation [T734]                               │
                     merge-dups → prune-stale → strengthen-patterns → insights         │
   Priority 4:   runObserver() [T740 — unconditional at session end]                   │
                   compress ≥1 observations → observer-compressed entries              │
   Priority 3:   runReflector()                                                        │
                   synthesize patterns+learnings → addGraphEdge() [T742]               │
   Priority 2:   write transcript_pending_extraction record [T732]                     │
                                                                                       │
 nightly (02:00): cleo-transcript-gc.timer [T731 — requires Q5 owner decision]        │
   ├── Sessions >7d: extract (if ANTHROPIC_API_KEY or local model per Q4)              │
   └── After extraction: delete JSONL, write tombstone                                 │
                                                                                       │
 brain.db long-tier: cite≥5 OR verified=1 entries after 7d = permanent semantic KB ◄─┘
```

---

## §3 Schema

### §3.1 Brain Tables — Memory Tier Column

All four primary brain tables have `memory_tier` as an ALTER-added column.

**Enum** (from `packages/core/src/store/brain-schema.ts:27`):
```typescript
export const BRAIN_MEMORY_TIERS = ['short', 'medium', 'long'] as const;
export type BrainMemoryTier = (typeof BRAIN_MEMORY_TIERS)[number];
```

**Default tiers at write time** (current state and target):

| Table | Schema DEFAULT | Write-Time Default | Correct? |
|-------|---------------|-------------------|---------|
| `brain_observations` | `'short'` | `'short'` | YES |
| `brain_decisions` | `'short'` (schema bug) | `'medium'` (correct) | NO — fix via T746 |
| `brain_patterns` | `'short'` (schema bug) | `'medium'` (correct) | NO — fix via T746 |
| `brain_learnings` | `'short'` | `'short'` (auto) or `'medium'` (manual) | YES |

### §3.2 Missing Schema Columns (Target — add via T741)

The following columns MUST be added to all four brain tables via migration:

| Column | Type | Purpose |
|--------|------|---------|
| `tier_promoted_at` | TEXT (ISO 8601) | Timestamp of last tier promotion; null = never promoted |
| `tier_promotion_reason` | TEXT | Why entry was promoted: 'citation', 'quality', 'verified', 'manual' |

Migration file: `packages/core/migrations/drizzle-brain/20260416000005_t726-tier-audit-columns/migration.sql`

```sql
-- T726-M5: Tier audit columns — all four brain tables
-- Idempotent: SQLite ADD COLUMN skips if column already exists

ALTER TABLE `brain_observations` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `tier_promotion_reason` text;
```

**`ensureColumns` safety net** (add to `brain-sqlite.ts:runBrainMigrations`):
```typescript
// T726: tier audit columns — all four brain tables
for (const table of ['brain_observations', 'brain_decisions', 'brain_patterns', 'brain_learnings']) {
  ensureColumns(nativeDb, table, [
    { name: 'tier_promoted_at', ddl: 'text' },
    { name: 'tier_promotion_reason', ddl: 'text' },
  ], 'brain');
}
```

### §3.3 brain_observations Transcript Tombstone Fields

The transcript tombstone record uses `brain_observations` with these field values:

| Field | Value |
|-------|-------|
| `source_type` | `'transcript-extracted'` |
| `content` | `"Session <id>: extracted <N> memories"` |
| `memory_tier` | `'short'` |
| `tags` | JSON array including `"transcript"`, `"tombstone"` |
| `source_session_id` | The original session UUID |

This record is idempotent: upsert on `source_session_id + source_type = 'transcript-extracted'`.

### §3.4 STDP Schema (Cross-Reference)

The following tables are defined in `docs/specs/stdp-wire-up-spec.md` and MUST NOT be
modified by T726 workers. They are referenced here for completeness:

- `brain_retrieval_log` — retrieval events (STDP input)
- `brain_plasticity_events` — LTP/LTD events written by STDP
- `brain_page_edges` — memory graph with plasticity columns
- `brain_weight_history` — immutable audit log of edge weight changes
- `brain_modulators` — R-STDP reward modulator events
- `brain_consolidation_events` — one row per `runConsolidation` execution

T726 ADDS `step_results_json` content in `brain_consolidation_events` by extending the
`ConsolidationResult` type with extraction metrics (Lead C GAP-11). This is additive.

---

## §4 Extraction Pipeline

### §4.1 D008 Seven-Technique Status

D008 (2026-04-13) mandated seven extraction techniques. Current status after gap remediation:

| # | Technique | Status | Gap | Fix |
|---|-----------|--------|-----|-----|
| 1 | LLM extraction gate at session end | SHIPPED + WIRED but broken input | T729 (getTranscript wrong path) | T729 |
| 2 | Write-time dedup with embedding similarity | PARTIAL | LLM extraction bypasses gate (T736), hash dedup only covers observations (T737) | T736, T737 |
| 3 | Observer/Reflector 3-6x compression | SHIPPED + WIRED | Observer only fires on task-complete, not session-end (T740); Reflector missing supersedes edges (T742) | T740, T742 |
| 4 | Temporal supersession with pointers | SHIPPED | Never auto-fires (T738); embedding branch stubbed (T739) | T738, T739 |
| 5 | Graph memory bridge BRAIN↔NEXUS | SHIPPED + WIRED | Regex-only entity extraction (T726-H deferred P2) | T726-H (future) |
| 6 | Sleep-time consolidation | SHIPPED but ORPHANED | runSleepConsolidation() never called (T734) | T734 |
| 7 | Reciprocal Rank Fusion retrieval | PARTIAL | Hybrid search exists; full RRF needs verification | Future task |

### §4.2 Write-Time Gate Architecture (Target State)

ALL memory write paths MUST route through `verifyAndStore()`. Direct calls to
`storeLearning`/`storePattern`/`storeDecision`/`observeBrain` from extraction pipelines
are prohibited after T736 ships.

```
[Input: MemoryCandidate]
        │
        ▼
verifyAndStore(candidate)
  ├── [A] hashDedupCheck(all 4 tables)          ← T737 extends from observations-only
  │         match found → increment citationCount, return existing ID
  │         no match → continue
  ├── [B] embeddingDedupCheck (sqlite-vec)
  │         similarity > 0.9 → merge (return existing + increment citation)
  │         similarity 0.7-0.9 → store new + create 'related' edge
  │         similarity < 0.7 → no overlap
  ├── [C] confidenceThreshold >= 0.40
  └── [D] detectSupersession (only for sourceConfidence='owner'|'task-outcome') ← T738
              Jaccard + embedding combined score > 0.8
              → mark old invalid_at + create 'supersedes' edge
        │
        ▼
  Write to brain.db table per memory type
  Assign source_type = 'llm-extracted' for LLM extraction path  ← T730
  Assign initial memory_tier per write-time routing rules
        │
        ▼
  Async: enqueue for embedding computation (all-MiniLM-L6-v2)
  Async: entity extraction for graph bridge (regex + LLM NER for zero-match)
```

### §4.3 LLM Extraction Gate (Technique 1)

**Location**: `packages/core/src/memory/llm-extraction.ts`
**Model**: `claude-haiku-4-5-20251001` (configurable via `brain.llmExtraction.model`)
**Input**: condensed transcript (user+assistant turns, tool results summarized)
**Output**: `ExtractedMemory[]` (up to 7 per call, configurable)
**Types extracted**: `decision | pattern | learning | constraint | correction`
**Importance gate**: 0.6 minimum (configurable)
**Transcript clip**: 60,000 chars head+tail

**What to extract from session transcripts** (Lead A §3.2):
1. Decisions — `Agent` tool prompts revealing architectural choices; assistant reasoning blocks
2. File modifications — `Edit` tool calls (filename + change summary, NOT full diff)
3. Task completions — `TaskUpdate` with status transition to `done`
4. Errors+recovery — bash commands with non-zero exit + subsequent assistant recovery
5. Learnings — text containing "I learned", "the issue was", "this means", "we should"
6. Owner directives — user turns containing "never", "always", "must", "do not"

**What NOT to extract**: Raw tool inputs/outputs, system prompt injections,
file-history snapshots, permission events.

**Source confidence**: All LLM-extracted memories MUST set `source_type = 'llm-extracted'`
(not the default `'agent'`) to enable targeted queries (fix in T730).

### §4.4 Observer / Reflector (Technique 3)

**Observer** (`observer-reflector.ts`):
- Fires on task completion when count ≥ threshold (default 10)
- ALSO fires unconditionally at session end (T740 adds session-end hook, priority 4)
- Batch limit: 30 observations
- Output: `source_type='observer-compressed'` entries + `supersedes` graph edges

**Reflector** (`observer-reflector.ts`):
- Fires at session end, priority 3 (after Observer at 4)
- Reads up to 50 session observations (raw + compressed)
- Produces: patterns via `storePattern()`, learnings via `storeLearning()`
- MUST call `addGraphEdge()` from new entry to each superseded observation ID (T742 fix)
- Tagged `reflector-synthesized`

### §4.5 Sleep Consolidation (Technique 6) — T734 Critical Fix

`runSleepConsolidation()` in `packages/core/src/memory/sleep-consolidation.ts` MUST be
wired as Step 10 in `runConsolidation()` (`brain-lifecycle.ts`). Current state: exported
but never called from any production path.

**Four sub-steps**:
1. Merge duplicates — embedding cosine > 0.85, LLM confirmation
2. Prune stale — short-tier entries older than 7d with quality < 0.4
3. Strengthen patterns — synthesize frequently-cited learnings (citation_count ≥ 3) into patterns
4. Generate insights — cluster observations by token overlap, LLM extracts cross-cutting insights

**Step ordering in runConsolidation** (complete with Step 10):
```
Steps 1-5: dedup, quality, tier promotion, contradictions, eviction
Step 6:    strengthenCoRetrievedEdges (Hebbian)
Step 7:    consolidateMemories (cluster)
Step 8:    autoLinkMemories (graph bridge)
Step 9a:   backfillRewardSignals (R-STDP)
Step 9b:   applyStdpPlasticity (STDP)
Step 9c:   applyHomeostaticDecay
Step 9d:   weight_history retention
Step 9e:   logConsolidationEvent
Step 10:   runSleepConsolidation  ← T734 adds this
```

---

## §5 Tier Promotion

### §5.1 Three-Tier Model

| Tier | Biological Analog | Purpose | Write-Time Assignment |
|------|------------------|---------|----------------------|
| **short** | Working memory / hippocampal buffer | Recent session observations; quick-write, may be noisy | Default for `brain_observations`; LLM-extracted items |
| **medium** | Episodic memory | Survived dedup + quality gate; cross-session durable | Default for `brain_decisions`, `brain_patterns`; promoted from short |
| **long** | Semantic memory / neocortical | High-confidence knowledge; repeated citation or owner verification | Promoted from medium; PERMANENT |

### §5.2 Promotion Rules (Current — Keep These Thresholds)

```
short → medium (24h age gate required):
  A. citation_count >= 3    (co-retrieval Hebbian signal)
  B. quality_score >= 0.7   (quality fast-track)
  C. verified = 1           (owner-verified track)

medium → long (7d age gate required):
  A. citation_count >= 5    (repeated co-retrieval across sessions)
  B. verified = 1           (owner-verified at any citation count)

Eviction (short entries after 7d):
  verified = 0 AND quality_score < 0.5 → invalid_at = now

Long-tier entries: NEVER auto-evicted. Cap: 2000 entries total.
When at cap: lowest-quality current long-tier entry demotes to medium.
```

### §5.3 Promotion Persistence (T743 Fix)

`runTierPromotion()` in `brain-lifecycle.ts` currently computes `tier_promoted_at` and
`tier_promotion_reason` in memory but does NOT persist them to the DB row. After T743:

```typescript
// After UPDATE memory_tier, also write:
await db.update(table)
  .set({
    tierPromotedAt: new Date().toISOString(),
    tierPromotionReason: reason,  // 'citation' | 'quality' | 'verified' | 'manual'
  })
  .where(eq(table.id, entry.id));
```

### §5.4 Manual Override

`cleo memory tier promote <id> --to <tier> --reason "<text>"` (T744):
- Bypasses age gate
- Writes `tier_promoted_at` and `tier_promotion_reason` immediately
- For demotion from long: requires `--force` flag

### §5.5 Medium→Short LTD Analog (Deferred)

Medium entries with `citation_count = 0 AND verified = 0 AND quality_score < 0.4` older
than 30 days SHOULD demote to short (not evict). This provides homeostatic medium-tier
scaling. Implementation deferred to ADR approval (T749) then a follow-on task. Current
state (medium never demotes) is conservative but not harmful.

---

## §6 Transcript Lifecycle

### §6.1 Three-Tier Hot/Warm/Cold Model

```
HOT (0–24h)                WARM (1–7d)               COLD (>7d)
────────────────────────   ─────────────────────────  ───────────────────────────
Full JSONL retained         Pending extraction          brain.db entries only
Agents can re-read          Scheduled at session end    Raw JSONL deleted
No modification             LLM extracts → brain.db     tool-results dir deleted
~25MB for 7 sessions        via TranscriptExtractor      Tombstone in brain_obs
                            (T730)                       No JSONL recovery possible
```

### §6.2 Storage Layout

```
~/.claude/projects/
  -mnt-projects-cleocode/           ← project-slug dir
    <session-uuid>.jsonl             ← ROOT-LEVEL: main session transcript (HOT/WARM)
    <session-uuid>/                  ← SESSION DIR (created when subagents spawned)
      subagents/
        agent-<agentId>.jsonl        ← subagent transcript (HOT/WARM)
        agent-<agentId>.meta.json    ← {"agentType":"...", "description":"..."}
      tool-results/
        <toolUseId>.json             ← raw tool result (delete at COLD transition)
        <toolUseId>.txt
```

`~/.temp/claude-1000/` contains symlinks only — GC targets `~/.claude/projects/` exclusively.

### §6.3 getTranscript P0 Bug Fix (T729)

**Current broken implementation** (`packages/adapters/src/providers/claude-code/hooks.ts:364`):
Iterates UUID subdirectories looking for `*.jsonl` inside them. UUID directories contain
only `subagents/` and `tool-results/` — no root JSONL at that depth. Returns null always.

**Fixed implementation** (two-pass read):
1. Read `~/.claude/projects/<slug>/*.jsonl` (root-level files = session transcripts)
2. Sort by mtime descending to find the most-recent session
3. Read `~/.claude/projects/<slug>/<session-uuid>/subagents/agent-*.jsonl` for the matching
   session UUID to include subagent transcripts

### §6.4 Hard Caps and Circuit Breakers

| Condition | Action |
|-----------|--------|
| Per-session directory > 100MB | Trigger immediate warm extraction (skip 7d wait) |
| Total `~/.claude/projects/` > 5GB | Emergency prune: extract all warm sessions now, delete cold immediately |
| `ANTHROPIC_API_KEY` absent (or local model not configured) | Skip extraction; delete only sessions > 30d (raw preservation fallback) |
| Extraction failure rate > 50% of batch | Abort prune; log error; do NOT delete un-extracted files |

### §6.5 Session-End Hook Priority Order

```
Priority 100  handleSessionEnd                  (LLM extraction + memory bridge)
Priority 10   handleSessionEndBackup            (VACUUM INTO all DBs)
Priority 5    handleSessionEndConsolidation     (runConsolidation Steps 1–10)
Priority 4    handleSessionEndObserver          (runObserver unconditional) [T740]
Priority 3    handleSessionEndReflector         (runReflector + supersedes edges) [T742]
Priority 2    handleSessionEndTranscriptSchedule (write transcript_pending_extraction) [T732]
```

---

## §7 LLM Model Choices

> **OWNER OVERRIDE APPLIED 2026-04-15** — Q4 and Q5 are now locked. See §14 for the
> rationale. Workers implementing T730/T731 MUST use the locked choices below.

### §7.1 Transcript Extraction Model (Q4 — LOCKED)

**Owner decision (T726 Wave 1E, 2026-04-15)**: Hybrid with Sonnet for cold path.

| Path | Model | Notes |
|------|-------|-------|
| Warm (local model available) | Ollama + Gemma 4 E4B-it | Auto-installed via `scripts/install-ollama.mjs` |
| Cold (no local model) | `claude-sonnet-4-6` | Owner-specified; best quality for cold extraction |
| Fallback chain | Ollama → `@huggingface/transformers` → `claude-sonnet-4-6` → skip | Graceful degradation |

The `TranscriptExtractor` (T730) MUST implement this fallback chain. Configuration:
```json
{
  "brain": {
    "llmExtraction": {
      "warmModel": "ollama:gemma-4-e4b-it",
      "coldModel": "claude-sonnet-4-6",
      "requireApiKey": false
    }
  }
}
```

> **Key auth note**: `requireApiKey: false` is correct. `tryAnthropic()` calls
> `resolveAnthropicApiKey()` which auto-discovers the Claude Code OAuth token from
> `~/.claude/.credentials.json` — no explicit API key required for users logged in
> to Claude Code. The cold-tier path is zero-config for Claude Code users.

### §7.2 Observer/Reflector Model (Resolved)

| Component | Model | Rationale |
|-----------|-------|-----------|
| Observer | `claude-haiku-4-5` | Compression is mechanical; Haiku is adequate |
| Reflector | `claude-haiku-4-5` (default), override via `brain.reflector.model` | Synthesis benefits from Sonnet; expose config key |

### §7.3 Embedding Model (Resolved — No Change)

Local `all-MiniLM-L6-v2` via `sqlite-vec` + `@huggingface/transformers` (384-dim, ~22MB).
No Anthropic embedding API calls for the background dedup pipeline. The model is already
wired in `packages/core/src/memory/embedding-local.ts`. No change needed.

---

## §8 Transcript GC Automation

### §8.1 Q5 — LOCKED (Owner Override 2026-04-15)

**Owner decision**: Hybrid mode (Option C). Sidecar daemon via `node-cron v4` (not systemd).

| Component | Behavior |
|-----------|----------|
| Extraction (non-destructive) | Automatic nightly at 02:00 via `cleo daemon` cron job |
| File deletion (destructive) | Requires `--confirm` flag; never automatic |
| Daemon management | `cleo daemon start` / `cleo daemon stop` / `cleo daemon status` |
| GC thresholds | 70% → warn, 85% → extract warm sessions, 90% → extract all, 95% → alert |

Implementation: `packages/core/src/memory/transcript-gc.ts` using `node-cron` v4.
The daemon is a long-running sidecar spawned by `cleo daemon start` and managed
as a background process with PID file at `.cleo/daemon.pid`. See ADR-047 for full
daemon architecture.

T731 (systemd timer) is CANCELLED — owner prefers `cleo daemon` over systemd for
portability across Linux, macOS, and Pi OS.

### §8.2 systemd Units (T731)

`cleo-transcript-gc.timer`:
```ini
[Unit]
Description=CLEO Transcript Garbage Collection

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`cleo-transcript-gc.service`:
```ini
[Unit]
Description=CLEO Transcript GC Service
After=network.target

[Service]
Type=oneshot
ExecStartPre=/usr/bin/env sh -c 'du -sb ~/.claude/projects/ | awk "{if(\$1 > 5368709120) exit 0; else exit 1}" && cleo transcript prune --older-than 3d --confirm || true'
ExecStart=cleo transcript prune --older-than 7d --confirm
```

Install script: `packages/caamp/src/platform/linux/install-transcript-gc.sh`

---

## §9 CLI Surface

### §9.1 Transcript Commands (T728)

```
cleo transcript scan                          # counts, sizes, age buckets
cleo transcript scan --pending                # sessions queued for extraction
cleo transcript extract <session-id>          # run extraction on one session now
cleo transcript extract --all-warm            # extract all warm-tier sessions
cleo transcript prune --older-than 7d         # dry-run by default
cleo transcript prune --older-than 7d --confirm  # destructive (requires Q5 decision)
cleo transcript migrate                       # one-time backfill of all existing sessions
cleo transcript migrate --dry-run             # report only
```

### §9.2 Memory Tier Commands (T744)

```
cleo memory tier stats                        # tier distribution + countdown to long
cleo memory tier promote <id> --to <tier> --reason "<text>"  # manual override
cleo memory tier demote <id> --to <tier> --reason "<text>"   # requires --force from long
```

`cleo memory tier stats` output MUST include:
- Count per tier per table
- Top-10 entries by days-until-next-promotion
- First expected long-tier promotion date

### §9.3 Extraction Pipeline Commands (T745)

```
cleo memory reflect                           # manually trigger Observer+Reflector
cleo memory dedup-scan                        # report potential duplicates by table
cleo memory reflect --dry-run                 # report what would be produced
cleo memory dedup-scan --fix                  # merge confirmed duplicates
```

### §9.4 Existing Commands (Verified Working)

```
cleo memory consolidate                       # manual runConsolidation trigger
cleo memory find "<query>"                    # brain.db semantic search
cleo memory fetch <id>                        # full entry details
cleo memory timeline <id>                     # entry history
cleo memory verify <id>                       # set verified=1 on entry (R-STDP +1.0 reward)
cleo memory invalidate <id>                   # set invalid_at on entry (R-STDP -1.0 reward)
```

---

## §10 Studio Surface

### §10.1 `/brain/overview` Tier Distribution Chart (T748)

**New component**: Add to `packages/studio/src/routes/brain/+page.svelte` (or a sub-route):

1. **Tier distribution bar chart**: short/medium/long counts for all four brain tables,
   stacked by table. Updates on page load. No streaming required.

2. **Promotion countdown panel**: Top 5 entries closest to long-tier promotion.
   Shows: entry ID, type, current citation count vs threshold, days remaining, tier_promoted_at.

3. **Transcript stats panel** (new, T728 dependency):
   - Hot/warm/cold session counts
   - Total storage (MB)
   - Sessions pending extraction
   - Last extraction run timestamp

### §10.2 New SvelteKit API Routes Required

| Route | Method | Returns | Depends On |
|-------|--------|---------|------------|
| `/api/brain/tier-stats` | GET | `{ tiers: TierDistribution[], nextPromotions: PromotionCountdown[] }` | T741/T743 |
| `/api/brain/transcript-stats` | GET | `{ hot: N, warm: N, cold: N, totalMB: N, pending: N }` | T728/T732 |

---

## §11 Migration Sequence

### §11.1 Wave 0 (P0 Bug Fixes — run immediately, no owner decisions needed)

| Step | Task | File | Risk |
|------|------|------|------|
| M0a | Fix getTranscript path | `packages/adapters/src/providers/claude-code/hooks.ts:364` | Low — 2-line fix |
| M0b | Wire runSleepConsolidation | `packages/core/src/memory/brain-lifecycle.ts` | Low — Step 10 addition |
| M0c | Route LLM extraction through verifyAndStore | `packages/core/src/memory/llm-extraction.ts` | Medium — behavior change |
| M0d | Extend hashDedupCheck to all 4 tables | `packages/core/src/memory/extraction-gate.ts` | Low — additive |

### §11.2 Wave 1 (Schema Migrations)

**Migration file**: `20260416000005_t726-tier-audit-columns/migration.sql` (T741)

```sql
-- Add tier audit columns to all four brain tables
ALTER TABLE brain_observations  ADD COLUMN tier_promoted_at text;
--> statement-breakpoint
ALTER TABLE brain_observations  ADD COLUMN tier_promotion_reason text;
--> statement-breakpoint
ALTER TABLE brain_decisions     ADD COLUMN tier_promoted_at text;
--> statement-breakpoint
ALTER TABLE brain_decisions     ADD COLUMN tier_promotion_reason text;
--> statement-breakpoint
ALTER TABLE brain_patterns      ADD COLUMN tier_promoted_at text;
--> statement-breakpoint
ALTER TABLE brain_patterns      ADD COLUMN tier_promotion_reason text;
--> statement-breakpoint
ALTER TABLE brain_learnings     ADD COLUMN tier_promoted_at text;
--> statement-breakpoint
ALTER TABLE brain_learnings     ADD COLUMN tier_promotion_reason text;
```

**MUST run `cleo backup add` before applying any schema migration.** See ADR-013 §9.

### §11.3 Rollback Plan

| Migration | Reversible? | Method |
|-----------|-------------|--------|
| M0a-M0d (code changes) | Yes | git revert |
| T726-M5 (ALTER TABLE ADD COLUMN) | No (SQLite limitation) | Accept; new columns nullable, zero data impact |
| T746 (Drizzle DEFAULT change) | Yes (schema only) | git revert + `cleo upgrade` |
| T731 (systemd timer install) | Yes | `systemctl --user disable cleo-transcript-gc.timer` |

---

## §12 Functional Tests

### §12.1 Transcript Lifecycle Tests (T735)

**File**: `packages/adapters/src/providers/claude-code/__tests__/transcript-lifecycle.test.ts`

All tests MUST use a `mkdtemp` project root. No mocking of the file system.

```
TL-F1: getTranscript reads root-level *.jsonl, not UUID subdirs
TL-F2: getTranscript also reads subagent JSONLs for the matching session UUID
TL-F3: TranscriptExtractor processes a real JSONL and writes to brain_observations
TL-F4: Tombstone written after successful extraction; prevents re-extraction
TL-F5: prune --dry-run makes zero filesystem mutations
TL-F6: Budget cap triggers early prune when total size > threshold
TL-F7: API key absent falls back to 30d-only deletion (no extraction attempted)
```

### §12.2 Tier Promotion Tests (T747)

**File**: `packages/core/src/memory/__tests__/brain-tier-promotion.test.ts`

Real brain.db (no mocks). Each test gets own `mkdtemp` dir.

```
TP-F1: short→medium via citation track (cite_count incremented to 3, 24h elapsed)
TP-F2: short→medium via quality track (quality_score ≥ 0.7, 24h elapsed)
TP-F3: short→medium via verified track (verified=1, age irrelevant)
TP-F4: medium→long via citation track (cite_count ≥ 5, 7d elapsed)
TP-F5: medium→long via verified track (verified=1, 7d elapsed)
TP-F6: long-tier entries NEVER evicted by soft-eviction pass
TP-F7: tier_promoted_at and tier_promotion_reason written on promotion (T743)
TP-F8: cleo memory tier promote --to long bypasses age gate (T744)
```

### §12.3 Extraction Gate Tests (T736/T737 workers define these)

```
EG-F1: LLM-extracted decision is deduped (hashDedupCheck on brain_decisions)
EG-F2: LLM-extracted pattern is deduped (hashDedupCheck on brain_patterns)
EG-F3: LLM-extracted observation goes through verifyAndStore (no direct storeLearning call)
EG-F4: Duplicate LLM-extracted memory increments citationCount on existing entry
EG-F5: runSleepConsolidation called as Step 10 and returns results (T734)
```

### §12.4 CI Compliance

All functional tests discoverable by `pnpm run test` via existing `**/*.test.ts` glob.
Zero mocked SQLite modules in functional tests.
`pnpm biome check --write .` MUST pass before any worker marks a task complete.

---

## §13 Acceptance Criteria for the Full Epic

All of the following MUST be true before T726 child tasks are collectively done.
T726 epic itself stays `active` until all children are complete.

| ID | Criterion | Task(s) |
|----|-----------|---------|
| AC-1 | `getTranscript()` returns non-null on a project with at least one session JSONL | T729 |
| AC-2 | LLM extraction runs end-to-end after session end without error (pipeline fully wired) | T729+T730+T732 |
| AC-3 | `brain_observations` receives at least one entry with `source_type='transcript-extracted'` after running `cleo transcript extract <session-id>` | T730 |
| AC-4 | Duplicate LLM-extracted decision is NOT inserted as a second row (hashDedupCheck covers brain_decisions) | T737 |
| AC-5 | `runSleepConsolidation()` is called as Step 10 of `runConsolidation()` and logs results in `brain_consolidation_events.step_results_json` | T734 |
| AC-6 | `brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings` all have `tier_promoted_at` and `tier_promotion_reason` columns | T741 |
| AC-7 | `runTierPromotion()` writes `tier_promoted_at` and `tier_promotion_reason` on every promotion event | T743 |
| AC-8 | `cleo memory tier stats` outputs tier distribution + promotion countdown for top-10 entries | T744 |
| AC-9 | `cleo transcript scan` outputs correct hot/warm/cold counts for an existing `~/.claude/projects/` layout | T728 |
| AC-10 | All functional tests in `brain-tier-promotion.test.ts` pass (real brain.db, no mocks) | T747 |
| AC-11 | All functional tests in `transcript-lifecycle.test.ts` pass | T735 |
| AC-12 | `runObserver()` fires at session end unconditionally (sessions with < 10 observations still get compression) | T740 ✓ |
| AC-13 | `runReflector()` writes `supersedes` graph edges from new entries to each superseded observation ID | T742 ✓ |
| AC-14 | `brain_decisions.memoryTier` Drizzle DEFAULT is `'medium'` (not `'short'`) | T746 |
| AC-15 | Studio `/brain/overview` shows tier distribution chart and promotion countdown | T748 |
| AC-16 | `pnpm biome check --write .` passes; `pnpm run build` passes; `pnpm run test` passes zero new failures | All |
| AC-17 | ADR written for transcript lifecycle policy (T735) and unified extraction pipeline (T749) | T735+T749 ✓ |
| AC-18 | `detectSupersession()` uses sqlite-vec ANN query when embeddings available | T739 ✓ |
| AC-19 | `storePattern()`/`storeLearning()` with `sourceConfidence='agent'` does NOT auto-fire detectSupersession | T738 ✓ |
| AC-20 | `cleo memory reflect` and `cleo memory dedup-scan` commands operational | T745 ✓ |

---

## §14 Owner-Locked Decisions

> **All questions answered as of 2026-04-15 (T726 Wave 1E).** No open questions remain.
> Workers implementing T730/T731/T732 MUST use the locked choices in §7 and §8.

### Q4: LLM Extraction Model — LOCKED

**Context**: T730 (`TranscriptExtractor`) calls `llm-extraction.ts` to process session
transcripts.

**Owner decision (2026-04-15)**: Hybrid with Sonnet for cold path.
- Warm path (local Ollama available): use Ollama + Gemma 4 E4B-it
- Cold path (no local model): use `claude-sonnet-4-6`
- Fallback chain: Ollama → transformers.js → claude-sonnet-4-6 → skip

See §7.1 for full configuration details.

**T730 is UNBLOCKED.** Workers may spawn T730 against this decision.

---

### Q5: Transcript GC Automation Mode — LOCKED

**Context**: GC automation for `~/.claude/projects/` transcripts.

**Owner decision (2026-04-15)**: Hybrid mode (Option C) via `cleo daemon` (NOT systemd).
- Automatic nightly extraction (non-destructive) via `node-cron v4` sidecar
- File deletion requires explicit `--confirm` flag
- `cleo daemon start/stop/status` manages the cron process

T731 (systemd timer) is CANCELLED. See §8.1 for full implementation details.

**T731 replacement task T731-daemon is UNBLOCKED.** Workers may spawn against this decision.

---

*This specification is complete. All questions answered. Workers MUST
implement T726 subtasks against this document as the canonical source of truth. The three
council reports are superseded (reference only) per the SUPERSEDED notices prepended to them.*
