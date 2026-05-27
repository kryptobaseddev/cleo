# T726 — Memory Architecture Council Synthesis

**Synthesized by**: Memory Council Synthesis Lead
**Date**: 2026-04-15
**Epic**: T726 — Memory Architecture Reality Check + Long-Term Tier Wire-Up + Transcript Lifecycle
**Synthesized from**:
- Lead A: `.cleo/agent-outputs/T726-council-transcripts.md` (Transcript Lifecycle)
- Lead B: `.cleo/agent-outputs/T726-council-tiers.md` (Tier Architecture)
- Lead C: `.cleo/agent-outputs/T726-council-extraction.md` (Extraction Pipeline)
- Prior Spec: `docs/specs/stdp-wire-up-spec.md` (STDP cross-reference)
- Prior Decisions: D008, D009, Memory Architecture v2 (14 directives)

---

## OWNER DECISIONS REQUIRED (Block Worker Spawn)

These are the ONLY open questions before workers can proceed. ALL other questions have been
resolved by this synthesis.

```
[ ] Q4: LLM model for transcript extraction
        Option A: Claude API (ANTHROPIC_API_KEY required) — better quality, ~$0.01-0.05/session
        Option B: Local Ollama/HuggingFace (free, lower quality, works offline)
        Option C: Hybrid — Claude API when key available, local fallback when absent
        Recommendation: Option C (hybrid is the right answer; both paths needed)
        Blocks: T730 (TranscriptExtractor service architecture)

[ ] Q5: Transcript GC automation mode
        Option A: Automatic systemd timer — silent nightly prune at 2am
        Option B: Owner-confirmed — interactive prompt before each GC destructive pass
        Option C: Auto for extraction, manual --confirm for deletion (hybrid)
        Recommendation: Option C during rollout phase (safe default), Option A later
        Blocks: T731 (systemd timer installation)
```

No other questions require owner input. All Lead-level questions Q1/Q2/Q3 (Lead A),
Q1–Q5 (Lead B Q1–Q3, Q5), and Q2–Q5 (Lead C) have been resolved below.

---

## §1 Decision Matrix

Every design choice from all three council leads, unified.

### 1.1 Transcript Lifecycle Decisions

| # | Decision | Lead A Position | Lead B/C Position | Final Unified | Owner Touchpoint? |
|---|----------|----------------|-------------------|---------------|-------------------|
| D-T1 | Hot retention window | 24h | N/A | **24h** — active sessions; negligible disk | No |
| D-T2 | Warm retention window | 7d | N/A | **7d** — balances recency vs disk | No |
| D-T3 | Extraction categories | 6 types (decisions/edits/completions/errors/learnings/directives) | Lead C: route through verifyAndStore | **All 6 categories** via verifyAndStore gate | No |
| D-T4 | Extraction API model | Q4 owner touchpoint | Lead C recommends local MiniLM for embeddings | **Owner decides** (Q4 above) | YES |
| D-T5 | Pruning automation | Systemd timer proposal | N/A | **Owner decides** (Q5 above) | YES |
| D-T6 | Subagent JSONL retention | Delete at same time as root | N/A | **Same-time deletion** — subagents are 309MB | No |
| D-T7 | tool-results retention | Delete at cold transition (7d) | N/A | **7d cold transition** — 182MB savings | No |
| D-T8 | getTranscript P0 bug | Two-pass read: root *.jsonl then UUID/subagents/ | N/A | **Fix immediately (T729, P0)** | No |
| D-T9 | .temp symlinks | Ignore for GC — all symlinks into .claude/projects/ | N/A | **Confirmed** — GC targets .claude/projects/ only | No |
| D-T10 | Transcript tombstone | brain_observations entry type=transcript-extracted | Lead B: enters short tier | **Confirmed** — tombstone at short tier, no extraction re-run | No |

### 1.2 Tier Architecture Decisions

| # | Decision | Lead A Position | Lead B Position | Lead C Position | Final Unified | Owner Touchpoint? |
|---|----------|----------------|-----------------|-----------------|---------------|-------------------|
| D-M1 | Long tier empty cause | By design (7d gate not elapsed) | Confirmed — by design, young DB | N/A | **By design. First long entries ~2026-04-18** | No |
| D-M2 | Promotion thresholds (short→medium) | N/A | 24h + cite≥3 OR quality≥0.7 OR verified=1 | N/A | **Keep current thresholds** | No |
| D-M3 | Promotion thresholds (medium→long) | N/A | 7d + cite≥5 OR verified=1 | N/A | **Keep current thresholds** | No |
| D-M4 | Long-tier decay | N/A | NO — long is permanent | N/A | **Long tier is permanent** — never auto-evicted | No |
| D-M5 | Long-tier cap | N/A | Proposed 2000 entries | N/A | **2000 entry cap** enforced at promotion time | No |
| D-M6 | Manual override CLI | N/A | Yes — cleo memory tier promote/demote | Lead C: yes | **Build cleo memory tier stats/promote/demote (T744)** | No |
| D-M7 | LTD analog for medium→short | N/A | Add decay for cite=0, verified=0, quality<0.4 after 30d | N/A | **Implement (T726-D deferred to T749 ADR scope)** | No |
| D-M8 | tier_promoted_at column | N/A | Missing from live DB — needs migration | N/A | **Add via T741 + T743** | No |
| D-M9 | Decisions/patterns start at medium | N/A | Correct behavior, misleading schema default | Lead C: confirmed | **Fix schema default (T746)** | No |

### 1.3 Extraction Pipeline Decisions

| # | Decision | Lead A Position | Lead B Position | Lead C Position | Final Unified | Owner Touchpoint? |
|---|----------|----------------|-----------------|-----------------|---------------|-------------------|
| D-E1 | runSleepConsolidation orphaned | N/A | N/A | P0 — never called | **Wire as Step 10 in runConsolidation (T734)** | No |
| D-E2 | LLM extraction bypass dedup gate | N/A | N/A | P0 — all LLM-extracted bypass verifyCandidate | **Route through verifyAndStore (T736)** | No |
| D-E3 | hashDedupCheck covers only brain_observations | N/A | N/A | P0 — decisions/patterns/learnings can dupe | **Extend to all 4 tables (T737)** | No |
| D-E4 | detectSupersession never auto-fires | N/A | N/A | P1 — design gap | **Auto-fire for owner/task-outcome writes only (T738)** | No |
| D-E5 | Embedding branch in detectSupersession stubbed | N/A | N/A | P1 — code comment, not executed | **Implement sqlite-vec ANN branch (T739)** | No |
| D-E6 | Observer never runs at session end | N/A | N/A | P1 — threshold=10 blocks low-count sessions | **Add unconditional session-end Observer (T740)** | No |
| D-E7 | Reflector missing supersedes graph edges | N/A | N/A | P1 — invalid_at set but no edge | **Add addGraphEdge() calls in Reflector (T742)** | No |
| D-E8 | LLM model for Reflector | N/A | N/A | Haiku for Observer, Sonnet configurable for Reflector | **Keep Haiku default; expose brain.reflector.model config** | No |
| D-E9 | Embedding model | N/A | N/A | Keep local MiniLM (sqlite-vec + all-MiniLM-L6-v2) | **Keep local embedding** — no API cost, already wired | No |
| D-E10 | Sync vs async extraction | N/A | N/A | Add setImmediate + --wait-for-memory flag | **Async default, opt-in sync (T732 scope)** | No |
| D-E11 | sourceConfidence for LLM-extracted | N/A | N/A | Currently 'agent' — need 'llm-extracted' | **Tag with 'llm-extracted' source_type (T730 scope)** | No |

### 1.4 Cross-Council Chain: Transcript → Extraction → Tiers

| Handoff | From | To | Interface | Gap? |
|---------|------|----|-----------|------|
| Transcript → LLM extraction | Lead A (T729/T730) | Lead C (T736/T734) | `getTranscript()` → `extractFromTranscript()` | YES: getTranscript returns null (P0 bug T729) |
| LLM-extracted → write gate | Lead C (T736) | Lead C (T737) | `verifyAndStore()` replaces direct `storeDecision` | YES: currently bypassed |
| Write gate → tier assignment | Lead C (T736/T737) | Lead B (T741/T743) | `memory_tier` field at write time | PARTIAL: correct routing exists, dedup before promotion needed |
| Tier promotion → long tier | Lead B (T741/T743) | Lead B | `runTierPromotion()` Step 3 | OK: pipeline correct, only schema audit columns missing |
| Sleep consolidation → extraction | Lead C (T734) | Lead C | `runSleepConsolidation()` in Step 10 | YES: orphaned (P0) |
| Observer/Reflector → session end | Lead C (T740/T742) | Lead A/B | Session-end hook priority ordering | PARTIAL: Observer missing, Reflector missing edges |

**RESOLVED CHAIN** (after all P0 fixes):
```
~/.claude/projects/*.jsonl          ← Lead A fixes getTranscript (T729)
        │
        ▼
extractFromTranscript()             ← lead A T730 TranscriptExtractor  
        │
        ▼
verifyAndStore()                    ← Lead C T736 routes through gate
        │
        ├── hashDedupCheck (all 4 tables)   ← Lead C T737
        ├── embeddingDedupCheck (sqlite-vec) ← already wired
        └── contradictionCheck              ← already wired
        │
        ▼
brain_observations / decisions / patterns / learnings
        │ (memory_tier='short' or 'medium' per write-time routing)
        ▼
runConsolidation() Step 3: runTierPromotion()
        │ (24h + quality/citation/verified → medium)
        │ (7d + citation≥5/verified → long)
        ▼
runConsolidation() Step 10: runSleepConsolidation()   ← Lead C T734
        │ (merge dups, prune stale, strengthen patterns, generate insights)
        ▼
nightly: cleo transcript prune (T731)
        │ (delete cold JSONLs, preserve brain.db entries)
        ▼
brain.db long-tier: permanent semantic memory
```

---

## §2 Contradiction Resolution

### CONTRADICTION-1: Reflector priority vs Observer priority

**Lead C GAP-6**: Observer should run at session end unconditionally (priority 4.5, between
consolidation at 5 and Reflector at 4).

**STDP spec §4.2**: Priority order is 100/10/5/4 — no 4.5 slot defined.

**Resolution**: Use priority 4 for Observer and bump Reflector to priority 3. Final order:
- Priority 100: transcript extraction + memory bridge
- Priority 10: backup
- Priority 5: runConsolidation() (Steps 1–10 including STDP 9b and sleep 10)
- Priority 4: runObserver() (unconditional)
- Priority 3: runReflector()

Observer must run before Reflector so Reflector reads post-compressed observations.
No fractional priority needed — existing system supports integer priorities.

### CONTRADICTION-2: T732 priority 3 (Lead A) vs T740 Observer priority 4.5 (Lead C)

Lead A specified `handleSessionEndTranscriptSchedule` at priority 3.
Lead C specified Observer at priority 4.5.

**Resolution**: Observer (priority 4) runs before Reflector (priority 3). Transcript schedule
hook runs at priority 2 (lower than both — scheduling a pending extraction record is not
time-sensitive relative to the current session's live processing).

Final priority ladder:
```
100  handleSessionEnd (LLM extraction + memory bridge)
10   handleSessionEndBackup (VACUUM INTO)
5    handleSessionEndConsolidation (runConsolidation Steps 1-10)
4    handleSessionEndObserver (runObserver unconditional)
3    handleSessionEndReflector (runReflector)
2    handleSessionEndTranscriptSchedule (write pending_extraction record)
```

### CONTRADICTION-3: Extraction model scope

Lead A Q4 defers model choice for transcript extraction.
Lead C says keep Haiku for extraction (already configured).
Lead B does not address model.

**Resolution**: The existing `llm-extraction.ts` uses `claude-haiku-4-5-20251001` via
`config.brain.llmExtraction.model`. The TranscriptExtractor (T730) MUST reuse this same
config key rather than hardcoding. Q4 remains an owner decision because it also controls
whether an API key is required at all (vs local fallback).

### CONTRADICTION-4: LTD analog (medium→short demotion)

Lead B proposed T726-D: medium entries with cite=0, verified=0, quality<0.4 after 30d demote
to short. Lead C did not address this. Lead A did not address this.

**Resolution**: Implement as T749 ADR scope first (document the rule), defer code to a
separate task after ADR is approved. This avoids shipping a demotion rule that hasn't been
validated. The current state (medium never demotes) is not harmful — it is conservative.

---

## §3 Duplicate Task Analysis

All 22 child tasks T728–T749 are analyzed for overlap:

| Task | Lead | Area | Duplicate? | Action |
|------|------|------|------------|--------|
| T728 | A | `cleo transcript` CLI | No | Keep |
| T729 | A | P0 getTranscript bug | No | Keep — P0 critical path |
| T730 | A | TranscriptExtractor service | No | Keep |
| T731 | A | systemd timer | No | Keep |
| T732 | A | session.end hook (schedule) | No | Keep |
| T733 | A | Migration of existing sessions | No | Keep |
| T734 | C | Wire runSleepConsolidation | No | Keep — P0 |
| T735 | A | ADR + tests: transcript lifecycle | Partial overlap with T749 | SCOPE REFINEMENT: T735 = transcript ADR only; T749 = extraction pipeline ADR. Different ADRs, no cancel. |
| T736 | C | Route LLM extraction through gate | No | Keep — P0 |
| T737 | C | Extend hashDedupCheck to all 4 tables | No | Keep — P0 |
| T738 | C | Wire detectSupersession auto-fire | No | Keep — P1 |
| T739 | C | Add sqlite-vec embedding to detectSupersession | No | Keep — P1 |
| T740 | C | Session-end Observer hook | No | Keep — P1 |
| T741 | B | Schema migration: tier audit columns | No | Keep |
| T742 | C | Reflector supersedes graph edges | No | Keep — P1 |
| T743 | B | Persist tier_promoted_at in runTierPromotion | Complements T741 | Keep — T741 = migration, T743 = logic |
| T744 | B | CLI: cleo memory tier stats/promote/demote | No | Keep |
| T745 | C | CLI: cleo memory reflect / dedup-scan | No | Keep |
| T746 | B | Fix brain_decisions/patterns schema DEFAULT | No | Keep |
| T747 | B | Vitest tests for runTierPromotion | No | Keep |
| T748 | B | Studio /brain/overview tier chart | No | Keep |
| T749 | C | ADR: unified extraction pipeline | No | Keep (see T735 note above) |

**No genuine duplicates found.** T735 and T749 are complementary ADRs for different concerns.
Zero tasks to cancel.

---

## §4 Wave-Ordered Task Plan

### Wave 0 — P0 Bug Fixes (MUST ship first; unblocks everything)

| Task | Title | Dependency | Who runs first? |
|------|-------|------------|----------------|
| T729 | Fix getTranscript: root-level JSONL path | None | YES — extraction pipeline has never worked |
| T734 | Wire runSleepConsolidation → Step 10 | None | YES — 4-step LLM pipeline orphaned |
| T736 | Route LLM extraction through verifyAndStore | None | YES — dedup bypass |
| T737 | Extend hashDedupCheck to all 4 tables | None | YES — decisions/patterns can dupe |

Wave 0 tasks are **independent of each other** and can run in parallel.

### Wave 1 — Schema Migrations (enable audit + quality data)

| Task | Title | Depends On |
|------|-------|------------|
| T741 | Schema migration: tier_promoted_at + tier_promotion_reason | None |
| T746 | Fix brain_decisions/patterns Drizzle schema DEFAULT 'medium' | None |
| T743 | Persist tier_promoted_at in runTierPromotion() | T741 (schema must exist first) |

T741 and T746 can run in parallel. T743 depends on T741.

### Wave 2 — Pipeline Wiring (D008 gaps closed)

| Task | Title | Depends On |
|------|-------|------------|
| T732 | session.end hook: schedule warm-tier extraction | T729 (correct path needed) |
| T730 | TranscriptExtractor warm-to-cold service | T729 (correct transcript), T736 (write gate) |
| T738 | Wire detectSupersession auto-fire | T736 (write gate in place) |
| T739 | Add sqlite-vec ANN to detectSupersession | T738 (wiring first, then enrich) |
| T740 | Session-end Observer unconditional hook | None |
| T742 | Reflector supersedes graph edges | None |

### Wave 3 — CLI + Studio Surface

| Task | Title | Depends On |
|------|-------|------------|
| T728 | cleo transcript scan/extract/prune CLI | T729 (P0 fix), T730 (extraction service) |
| T744 | cleo memory tier stats/promote/demote | T741+T743 (schema + logic) |
| T745 | cleo memory reflect / dedup-scan | T740 (Observer wired), T742 (Reflector edges) |
| T748 | Studio /brain/overview tier chart | T741+T743 (data available) |

### Wave 4 — Automation, Migration, Docs, Tests

| Task | Title | Depends On |
|------|-------|------------|
| T731 | systemd timer + budget cap (OWNER Q5 decision required) | T728 (CLI exists), Q5 owner answer |
| T733 | Migration: extract existing 86 sessions | T729+T730 (full pipeline working) |
| T735 | ADR + tests: transcript lifecycle | T729+T730 wired |
| T747 | Vitest tests: runTierPromotion all tracks | T741+T743 (schema + logic) |
| T749 | ADR: unified extraction pipeline | T734+T736+T737 done |

### Full Wave Summary

```
Wave 0 (parallel): T729, T734, T736, T737
Wave 1 (parallel): T741, T746  →  T743
Wave 2 (parallel): T732, T730*, T738  →  T739; T740, T742
Wave 3 (parallel): T728*, T744, T745, T748
Wave 4 (partial blocked): T731**(Q5), T733, T735, T747, T749

*T730 blocked on Q4 owner decision (model architecture)
**T731 blocked on Q5 owner decision (automation mode)
```

---

## §5 STDP Cross-Reference

The STDP spec (`docs/specs/stdp-wire-up-spec.md`) governs `brain_plasticity_events`,
`brain_page_edges`, `brain_weight_history`, `brain_modulators`, and `brain_consolidation_events`.

Memory architecture (T726) governs `brain_observations`, `brain_decisions`,
`brain_patterns`, `brain_learnings`, extraction pipeline, tier promotion, and transcript lifecycle.

**Intersection points** (no conflict, just shared infrastructure):
1. `brain_consolidation_events` — STDP spec §2.1.6 defines the table; T726 adds extraction
   telemetry to `step_results_json` (Lead C GAP-11). Additive, no conflict.
2. `runConsolidation()` step ordering — STDP spec §4.2 defines Steps 6/9a/9b/9c/9d/9e.
   T726 adds Step 10 (`runSleepConsolidation`). Step 10 runs after 9e (consolidation log).
3. `brain_page_edges` supersedes edges — STDP spec uses `plasticity_class='stdp'` on
   `co_retrieved` edges. Lead C's `detectSupersession` writes `supersedes` edge_type. These
   are orthogonal edge types. No conflict.
4. Priority ordering — STDP is in Step 9b of `runConsolidation` (priority 5 hook).
   Observer (priority 4) and Reflector (priority 3) run AFTER. Correct causal direction:
   plasticity updates edges → Reflector synthesizes from updated graph.

---

## §6 Files to Supersede

The following council .md files MUST have supersession notices prepended (done by this agent):
- `.cleo/agent-outputs/T726-council-transcripts.md` — superseded
- `.cleo/agent-outputs/T726-council-tiers.md` — superseded
- `.cleo/agent-outputs/T726-council-extraction.md` — superseded

---

## §7 Summary Statistics

| Category | Count |
|----------|-------|
| Total child tasks under T726 | 22 |
| Wave 0 P0 tasks | 4 |
| Wave 1 schema tasks | 3 |
| Wave 2 pipeline tasks | 6 |
| Wave 3 CLI/Studio tasks | 4 |
| Wave 4 automation/docs/tests tasks | 5 |
| Tasks blocked on Q4 (owner) | 1 (T730) |
| Tasks blocked on Q5 (owner) | 1 (T731) |
| Genuine duplicates found | 0 |
| Tasks cancelled | 0 |
| Owner decisions required | 2 (Q4, Q5) |

---

## §8 What Is Confirmed Working (Do Not Break)

Per Lead B and Lead C audits:

1. `runTierPromotion()` in `brain-lifecycle.ts` — fully functional, correct logic
2. `runConsolidation()` Steps 1–9e — all wired correctly except Step 10 (T734)
3. `BRAIN_MEMORY_TIERS` enum — 'long' is valid; no type gap
4. Write-time tier routing: `decisions.ts:159`, `patterns.ts:125`, `learnings.ts:103` — correct
5. `brain_consolidation_events` table — exists and is being written
6. `extractFromTranscript()` in `llm-extraction.ts` — architecturally correct; needs T729 input
7. `observer-reflector.ts` Observer and Reflector — both functional; need T740/T742 completion
8. `cleo memory consolidate` CLI — manual trigger works
9. `brain-similarity.ts` sqlite-vec integration — wired and working when ANTHROPIC_API_KEY available
10. Session-end consolidation hook at priority 5 — fires reliably
