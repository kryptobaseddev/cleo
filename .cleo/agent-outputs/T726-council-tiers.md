> SUPERSEDED — see `.cleo/agent-outputs/T726-council-synthesis.md` and `docs/specs/memory-architecture-spec.md`

# T726 — Memory Architecture Tier Audit (Lead B: Tier Architecture Councilor)

**Date**: 2026-04-15
**Task**: T726 (EPIC: Memory Architecture Reality Check + Long-Term Tier Wire-Up)
**Author**: cleo-subagent / Memory Council Lead B
**Status**: complete

---

## Executive Summary

**Long-term tier is empty by design, not by bug.** The promotion pipeline is implemented and working. The project is 10 days old. The 7-day age gate for medium→long promotion means the first long-tier entries will appear on approximately 2026-04-18 (~2 days from now), when 16 decisions (all with citation_count ≥ 5 or verified=1) cross the threshold. The "confusing mess" diagnosis is about *observability* — the owner has no visibility into tier states, promotion timelines, or decay without running `cleo memory consolidate` manually.

The real problems are:
1. **Missing observability** — no `cleo memory tier stats` command shows the countdown
2. **Missing schema fields** — `tier_promoted_at` and `tier_promotion_reason` do not exist in the live DB (columns not yet migrated)
3. **Missing manual override** — no `cleo memory tier promote <id> --to long` command
4. **`brain_learnings` default tier is wrong** — schema default is `short` but all 7 entries are `medium`; the write path routes them correctly but the schema default misleads readers
5. **`brain_decisions` and `brain_patterns` start at `medium`** — this is correct but undocumented

---

## Part 1: Schema State Audit

### 1.1 The `memory_tier` Column

All four primary brain tables have `memory_tier` as an ALTER-added column (post-initial-schema). The Drizzle enum is:

```typescript
// packages/core/src/store/brain-schema.ts:27
export const BRAIN_MEMORY_TIERS = ['short', 'medium', 'long'] as const;
export type BrainMemoryTier = (typeof BRAIN_MEMORY_TIERS)[number];
```

`'long'` IS a valid enum value. The type exists. There is no bug in the enum definition.

### 1.2 Default Tiers at Write Time

| Table | Schema Default | Actual Write-Time Default | Correct? |
|-------|---------------|--------------------------|---------|
| `brain_observations` | `'short'` | `'short'` (always) | YES |
| `brain_decisions` | `'short'` (schema) | `'medium'` (write path) | MISLEADING — decisions skip short-tier by design, see `packages/core/src/memory/decisions.ts:159` |
| `brain_patterns` | `'short'` (schema) | `'medium'` (write path) | MISLEADING — same pattern |
| `brain_learnings` | `'short'` (schema) | `'medium'` if manual, `'short'` if auto | PARTIALLY misleading |

The schema `DEFAULT 'short'` is stale for decisions and patterns. The write paths override it correctly, but the schema doesn't document this intent.

### 1.3 Missing Schema Columns

The following columns are in the **design spec** but NOT present in the live SQLite schema:

| Column | Status | Impact |
|--------|--------|--------|
| `tier_promoted_at` | ABSENT from live DB | Cannot audit when promotion happened |
| `tier_promotion_reason` | ABSENT from live DB | Cannot audit why entry was promoted |
| `last_retrieved_at` | ABSENT (retrieval tracked in `brain_retrieval_log` only) | Decay calculation relies on JOIN to retrieval_log, not a column |

The code in `runTierPromotion()` does NOT write these columns — it only updates `memory_tier` and `updated_at`. The promotion reason is computed in-memory and returned in `PromotionResult` but never persisted to the DB row.

### 1.4 Live DB Tier Distribution (2026-04-15)

| Table | short | medium | long | Total active |
|-------|-------|--------|------|-------------|
| `brain_observations` | 849 | 148 | 0 | 997 |
| `brain_decisions` | 0 | 16 | 0 | 16 |
| `brain_learnings` | 0 | 7 | 0 | 7 |
| `brain_patterns` | 0 | 2 | 0 | 2 |
| **TOTAL** | **849** | **173** | **0** | **1022** |

---

## Part 2: Why Long-Tier Is Empty (Root Cause Analysis)

### 2.1 The 7-Day Age Gate

The medium→long promotion in `runTierPromotion()` requires:

```sql
WHERE memory_tier = 'medium'
  AND invalid_at IS NULL
  AND created_at < ?          -- ? = (now - 7 days)
  AND (citation_count >= 5 OR verified = 1)
```

The project's `brain.db` was first populated on **2026-04-05**. Today is **2026-04-15** (10 days old). However:

- Virtually all medium-tier entries were created between **2026-04-11 and 2026-04-15** (after a major brain.db rebuild during T523/T549 epics)
- The oldest medium entry (`O-mnlunyif-0`) is 10.3 days old but has `citation_count=3` and `verified=0` — it does NOT meet the `citation_count >= 5 OR verified = 1` threshold
- All 16 decisions (the highest-quality entries) were created between 2026-04-11 and 2026-04-15

**The 7-day gate has simply not elapsed for any entry that qualifies on citation/verified criteria.**

### 2.2 Consolidation Run Frequency

`runConsolidation` has been called **twice total** (both manual). The session-end hook (`handleSessionEndConsolidation` in `session-hooks.ts:136`) fires via `setImmediate` but consolidation only ran once via the hook. The `dream-cycle.ts` auto-scheduler requires `startDreamScheduler()` to be called — it is NOT auto-started; it must be explicitly enabled.

**Sessions ending are not reliably triggering consolidation** — the `setImmediate` path fires but the T628 auto-dream volume/idle tiers require the daemon to be running. This is the T628 partial-build problem cited in the council handoff notes.

### 2.3 Timeline to First Long-Tier Entries

Based on current DB state:

| Entry | Type | Age (days) | Days to 7d gate | Track |
|-------|------|-----------|----------------|-------|
| `D-mntpeeer` | decision | 4.8 | ~2.2 | citation (count=5) |
| `D-mnwg2sz2` | decision | 2.9 | ~4.1 | citation (count=14) |
| `D001` | decision | 2.9 | ~4.1 | citation (count=14) |
| `D008` | decision | 2.0 | ~5.0 | citation (count=10) |
| `O-mnxnlc5s-0` | observation | 2.0 | ~5.0 | citation (count=26) + verified |

**Expected first long-tier promotion: ~2026-04-18 for `D-mntpeeer`**, subject to consolidation running on that date.

### 2.4 Why Owner Sees "No Long Tier"

The owner sees the tier distribution via `cleo memory stats` or the Studio `/brain` page. The absence of long-tier entries is real and visible. Without the countdown context above, this looks like a bug. It is NOT a bug — it is a young database that hasn't had entries age past 7 days while meeting quality thresholds.

---

## Part 3: Prior Owner Decisions Reconciled

### D008 — 7-Technique Memory Architecture (2026-04-13)

D008 mandated:
1. LLM extraction gate at session end → **IMPLEMENTED** (reflector in `session-hooks.ts`)
2. Write-time dedup with embedding similarity → **IMPLEMENTED** (Step 1 in `runConsolidation`)
3. Observer/reflector pattern for 3-6x compression → **IMPLEMENTED** (`observer-reflector.ts`)
4. Temporal supersession with pointers → **PARTIALLY IMPLEMENTED** (`valid_at`/`invalid_at` exist, no pointer chain)
5. Graph memory bridge connecting brain to nexus → **IMPLEMENTED** (Step 8, `graph-memory-bridge.ts`)
6. Sleep-time consolidation → **IMPLEMENTED** but only fires on `session end` reliably; auto-dream requires daemon start
7. Quality feedback loop → **IMPLEMENTED** (`brain-retrieval-log` + quality recompute in Step 2)

D008 does NOT define the promotion thresholds specifically. The current thresholds (short→medium: 24h + cite≥3 OR quality≥0.7 OR verified; medium→long: 7d + cite≥5 OR verified) were set during T549 wave work.

### D009 — No LadybugDB Replacement (2026-04-13)

D009 is not directly relevant to tier architecture — it confirms brain.db stays as-is. The tier system is built ON TOP of brain.db. Confirmed compatible.

### Memory Architecture v2 Initiative — 14 Owner Directives

The 14 directives call for tiered memory explicitly. The current implementation satisfies the tier structure. The gaps are in observability, schema auditability, and the manual override CLI.

---

## Part 4: Biological Model vs. Current Implementation

### 4.1 Intended 3-Tier Model

| Tier | Biological Analog | Purpose | Implementation Status |
|------|------------------|---------|----------------------|
| **Short** | Working memory / hippocampal buffer | Recent session observations; quick to write; may be noisy | IMPLEMENTED — default for all observations |
| **Medium** | Episodic memory / hippocampal consolidation | Survived dedup + quality gate; cross-session durable | IMPLEMENTED — 24h + quality/citation/verified gate |
| **Long** | Semantic memory / neocortical consolidation | High-confidence knowledge from repeated citation or owner verification; permanent | SCHEMA EXISTS, pipeline exists, 7d gate not yet elapsed |

### 4.2 Promotion Criteria (Current Implementation)

```
short → medium (after 24h):
  A. citation_count >= 3  (co-retrieval Hebbian signal)
  B. quality_score >= 0.7  (quality fast-track)
  C. verified = 1          (owner-verified track)

medium → long (after 7d):
  A. citation_count >= 5   (repeated co-retrieval)
  B. verified = 1          (owner-verified at any citation count)

Eviction (short, after 7d):
  - verified = 0 AND quality_score < 0.5 → invalid_at = now
  - Long-tier entries are NEVER evicted
```

### 4.3 What Is Missing

The implementation has the shape of the 3-tier model but is missing:

**Schema gaps:**
- No `tier_promoted_at` — cannot audit promotion history
- No `tier_promotion_reason` — promotion reasoning is ephemeral (computed, returned, not stored)
- No `promotion_count` — no tracking of how many times an entry has been promoted

**Pipeline gaps:**
- Medium→long demotion is NOT implemented (D008 #4 temporal supersession implies entries can be superseded, but the code only does `invalid_at`, not tier demotion)
- No Hebbian co-retrieval signal directly on the entry row — citation_count is updated externally, but the retrieval→citation pipeline needs audit (Lead C scope)
- LTD (long-term depression) analog for medium→short demotion is absent — only short→evict exists, not medium→short

**Observability gaps:**
- No `cleo memory tier stats` command
- No promotion countdown visible to owner
- No `cleo memory tier promote <id> --to long --reason "..."` manual override
- Studio `/brain/overview` shows total counts but no tier distribution chart

---

## Part 5: Decision Matrix for Owner

### Q1: Promotion Thresholds

**Current:** short→medium at 24h + cite≥3 OR quality≥0.7 OR verified=1. Medium→long at 7d + cite≥5 OR verified=1.

**Proposed:** Keep these thresholds. They are calibrated correctly for a system that has been running for ~10 days. The 7d gate ensures entries have survived at least one full work week before becoming "long-term". The cite≥5 threshold ensures semantic reinforcement across multiple sessions.

**Owner decision needed:** Accept current thresholds OR adjust the 7d gate. Reducing to 3d would mean D-mntpeeer promotes today.

### Q2: Should Long-Tier Entries Ever Decay Back to Medium?

**Proposed: NO.** Long-tier represents owner-confirmed or heavily-cited semantic knowledge. Once promoted, it is ground truth until explicitly invalidated via `invalid_at`. There is no biological or practical justification for automatic demotion of long-tier entries.

**Owner decision needed:** Confirm long tier is permanent (no decay back).

### Q3: Cap on Long-Tier Count?

**Proposed: Cap at 2000 entries across all tables, enforced at promotion time.** When at cap, the lowest-quality current long-tier entry can be demoted to medium to make room. This mirrors the neocortical capacity constraint and prevents unbounded growth.

**Owner decision needed:** Accept cap of 2000 OR set a different limit OR no cap.

### Q4: Manual Override — `cleo memory tier promote <id> --to long --reason "..."`

**Proposed: YES, implement this.** Owner needs the ability to manually promote important entries without waiting for the 7d gate. This is the "owner-verified track" extended to an explicit CLI gesture.

**Owner decision needed:** Confirm this command should be built and whether it should bypass the age gate.

### Q5: How Does This Interact with LLM Extraction Gate (D008 #1)?

D008 requires LLM extraction at session end. The extraction produces:
- Observations → written to `brain_observations` with `memory_tier='short'`
- Decisions → written to `brain_decisions` with `memory_tier='medium'`
- Patterns → written to `brain_patterns` with `memory_tier='medium'`
- Learnings → written to `brain_learnings` with `memory_tier='medium'` (if manual) or `'short'` (if auto)

**The tier promotion pipeline is the SECOND stage.** Extraction is stage 1 (LLM produces structured artifacts). Promotion is stage 2 (consolidation advances tier based on age + quality). This is correct and D008-compatible.

**No conflict.** Extracted artifacts start at their write-time tier and are subject to normal promotion.

---

## Part 6: Proposed Subtasks Under T726

The following atomic worker tasks should be spawned from this epic:

### T726-A — Schema Migration: Add Tier Audit Columns
**Scope:** Add `tier_promoted_at TEXT` and `tier_promotion_reason TEXT` to all four brain tables. Add schema migration in `packages/core/src/upgrade.ts`. No Drizzle schema change needed for the column (use raw SQL migration). Also update Drizzle schema to reflect the correct default tier per-table (decisions/patterns should show `'medium'` as default in Drizzle, not `'short'`).

### T726-B — Implement Tier Promotion Persistence in `runTierPromotion()`
**Scope:** After promoting an entry, write `tier_promoted_at = now` and `tier_promotion_reason = reason` to the row. Currently these are computed and returned but never persisted. This makes promotion auditable. ~20 lines of change in `brain-lifecycle.ts`.

### T726-C — CLI: `cleo memory tier <stats|promote|demote>`
**Scope:**
- `cleo memory tier stats` — shows tier distribution + countdown to next long-tier promotions (list top 10 entries with days remaining)
- `cleo memory tier promote <id> --to <tier> --reason "<text>"` — manual override bypasses age gate; writes `tier_promoted_at` and `tier_promotion_reason` immediately; requires `--reason` flag
- `cleo memory tier demote <id> --to <tier> --reason "<text>"` — manual demotion; never demotes from long without explicit `--force`

### T726-D — Implement Medium→Short Demotion (LTD Analog)
**Scope:** Add a decay pass in `runTierPromotion()` for medium-tier entries: entries older than 30 days with `citation_count = 0` AND `verified = 0` AND `quality_score < 0.4` demote to short (not evict — give them another chance via short→evict path). This implements homeostatic scaling at the tier level.

### T726-E — Studio `/brain/overview` Tier Distribution Chart
**Scope:** Add a tier breakdown visualization to the `/brain` page showing count per tier across all four tables. Include a "next long-tier promotions" section showing countdown for the top 5 entries. This is the owner-visible "is this working?" signal.

### T726-F — Backfill: Fix `brain_decisions` and `brain_patterns` Schema Default
**Scope:** Update Drizzle schema to set `DEFAULT 'medium'` for `brain_decisions.memory_tier` and `brain_patterns.memory_tier`. This aligns schema intent with write-time behavior. Requires schema version bump and upgrade migration.

### T726-G — Tests for Tier Promotion Logic
**Scope:** Vitest unit tests for `runTierPromotion()` covering: short→medium promotion via citation track, quality track, verified track; medium→long promotion via citation track and verified track; soft eviction of stale short entries; protection of long-tier entries from eviction; medium→short LTD decay (once T726-D ships).

---

## Part 7: Cross-Council Dependencies

### Lead A (Transcripts)
Extracted artifacts from LLM transcript processing should route as:
- Agent-extracted observations → `memory_tier='short'`
- LLM-extracted decisions from transcripts → `memory_tier='medium'` (decisions skip short by design)
- LLM-extracted patterns → `memory_tier='medium'`

Lead A should confirm that the transcript extraction pipeline uses the existing write paths (not raw SQL inserts) so tier routing is inherited automatically.

### Lead C (Extraction Pipeline)
The citation increment pipeline determines how fast entries accumulate `citation_count` and therefore how quickly short→medium and medium→long promotions fire. Lead C must audit:
- Is `citation_count` being incremented on every retrieval hit?
- Is the increment happening at the time of `brain_retrieval_log` write, or separately?
- The current count on `D001` (14 citations in 2.9 days) suggests citations are being incremented correctly, but the threshold calibration should be reviewed if extraction is producing bulk citations.

### D008 Technique #4 — Temporal Supersession
Temporal supersession (entry A supersedes entry B — "B was true then, A is true now") interacts with long-tier specifically: a superseded long-tier entry should have `invalid_at` set but should NOT be deleted from the DB. The pointer chain (`supersedes_id`) is not yet implemented. This is a separate subtask that Lead C should own.

---

## Part 8: What IS Working (Do Not Break)

1. `runTierPromotion()` in `brain-lifecycle.ts` — fully functional, correct logic
2. `runConsolidation()` — all 9 steps wired correctly; tier promotion is Step 3
3. Session-end consolidation hook — fires via `setImmediate`; works when daemon is running
4. `BRAIN_MEMORY_TIERS` enum — `'long'` is a valid value; no type gap
5. `brain_consolidation_events` table — records every run; Step 9e working
6. Write-time tier routing in `decisions.ts`, `patterns.ts`, `learnings.ts` — correct
7. Quality score computation and Step 2 recompute — active and updating `quality_score`
8. `cleo memory consolidate` CLI command — manual trigger works

---

## Part 9: Summary Answer to Owner's Question

> "How are we truly handling Short term, Long Term, and Medium term tiers of memory?"

**Short (working memory):** All new observations start here. Write-fast, no quality gate. Survival requires promotion within 7 days or eviction if low quality. 849 active entries.

**Medium (episodic):** Promoted from short after 24h IF quality≥0.7 OR citation≥3 OR owner-verified. Decisions and patterns start here directly (they skip short by design). 173 active entries. Entries here have demonstrated cross-session value.

**Long (semantic):** Promoted from medium after 7 days IF citation≥5 OR owner-verified. This is permanent ground truth — never auto-evicted. Currently 0 entries, but 2 days away from first promotions (D-mntpeeer crosses the 7d gate ~2026-04-18). The pipeline is fully implemented.

> "Is your whole memory system a confusing mess?"

The MECHANICS are correct. The VISIBILITY is a mess. The owner cannot easily see:
- How many days until entries promote
- Which specific entries are about to become long-term
- Why any given entry is in the tier it's in (no `tier_promoted_at`, no `tier_promotion_reason`)
- A single CLI command that answers "what does the tier health look like?"

The 7 subtasks above fix the visibility problem.

---

## Appendix A: Files Referenced

- `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` — `runTierPromotion()` (lines 405-572), `runConsolidation()` (lines 647-~800)
- `/mnt/projects/cleocode/packages/core/src/store/brain-schema.ts` — `BRAIN_MEMORY_TIERS` (line 27), `BrainMemoryTier` (line 30)
- `/mnt/projects/cleocode/packages/core/src/memory/decisions.ts` — tier routing (line 159)
- `/mnt/projects/cleocode/packages/core/src/memory/learnings.ts` — tier routing (lines 103-120)
- `/mnt/projects/cleocode/packages/core/src/memory/patterns.ts` — tier routing (lines 125-128)
- `/mnt/projects/cleocode/packages/core/src/hooks/handlers/session-hooks.ts` — session-end consolidation trigger (lines 129-143)
- `/mnt/projects/cleocode/packages/core/src/memory/dream-cycle.ts` — auto-dream scheduler (volume/idle/cron tiers)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/memory-brain.ts` — `cleo memory consolidate` command

## Appendix B: Key DB Statistics at Audit Time

- Total observations (all tiers): 1076 (977 active, 99 invalidated)
- Consolidation runs total: 2 (1 manual, 1 session-end)
- Last consolidation: 2026-04-15 21:54:25 (manual)
- Step 3 last result: promoted 1 entry (short→medium on quality score)
- First expected long-tier promotion: ~2026-04-18 (D-mntpeeer, decisions table)
