# T729 + T734 — Dream Cycle Real Wiring (No More Theater)

**Date**: 2026-04-15
**Tasks**: T729, T734
**Status**: complete

## Summary

Two P0 fixes that end "cleo memory dream" theater — "Summaries gen: 0" was caused by:
1. T729: `getTranscript()` walked UUID subdirs that contain no session JSONLs, so LLM extraction chain received no input since T144.
2. T734: `runSleepConsolidation()` was completely orphaned — the 4-step LLM pipeline never executed in production.

## T729 — getTranscript Bug Fix

### Root Cause

`getTranscript()` in `packages/adapters/src/providers/claude-code/hooks.ts` iterated
subdirectories under `~/.claude/projects/<project>/` and collected `*.jsonl` files inside
them. But the Claude Code directory layout is:

```
~/.claude/projects/<project>/
  <sessionId>.jsonl          <- ROOT-LEVEL (correct location)
  <uuid>/                    <- UUID subdir (only subagents/ + tool-results/ inside)
  <uuid>/subagents/
    agent-<id>.jsonl         <- subagent turns
  <uuid>/tool-results/       <- not session JSONLs
```

The old code iterated into UUID subdirs and found nothing (no JSONLs at UUID subdir root),
causing the LLM extraction chain to receive a null transcript since T144.

### Fix

- Walk root level of each project dir for `*.jsonl` files (siblings to UUID dirs)
- Additionally collect `<uuid>/subagents/agent-*.jsonl` files for subagent turns
- Parameter renamed from `_sessionId` to `sessionId` (available for future filtering)

### Files Changed

- `packages/adapters/src/providers/claude-code/hooks.ts` — `getTranscript()` rewritten
- `packages/adapters/src/providers/claude-code/__tests__/hooks-get-transcript.test.ts` — 6 new tests (GT-1 through GT-6)

### Tests

- GT-1: reads root-level session JSONL, not UUID subdir contents
- GT-2: returns null when projects dir does not exist
- GT-3: returns null when root-level JSONL has no recognizable turns
- GT-4: picks most-recent root JSONL when multiple projects exist
- GT-5: also ingests subagent JSONLs from UUID subdir when present
- GT-6: does NOT read JSONL files placed directly inside UUID subdirs (wrong layout)

All 6 pass. All 283 adapter tests pass.

## T734 — Wire runSleepConsolidation as Step 10

### Root Cause

`runSleepConsolidation()` in `packages/core/src/memory/sleep-consolidation.ts` implements
a 4-step LLM pipeline (merge duplicates, prune stale, strengthen patterns, generate
insights). It was never called from any production path — completely orphaned.

### Fix

Added Step 10 in `runConsolidation()` in `packages/core/src/memory/brain-lifecycle.ts`:

```typescript
// Step 10: LLM-driven sleep consolidation (T734)
const { runSleepConsolidation } = await import('./sleep-consolidation.js');
const sleepResult = await runSleepConsolidation(projectRoot);
result.sleepConsolidation = { ran, merged, pruned, patternsGenerated, insightsStored };
if (sleepResult.ran) {
  result.summariesGenerated += patternsGenerated + insightsStored;
} else {
  console.warn('[consolidation] Step 10 sleep consolidation skipped (disabled or no LLM)');
}
```

- Best-effort: wrapped in try/catch, never aborts the dream cycle
- Graceful skip: logs a warning when no LLM configured
- Rolls up LLM outputs into `summariesGenerated` counter (visible in `cleo memory dream`)
- Added `sleepConsolidation` field to `RunConsolidationResult` interface

### Files Changed

- `packages/core/src/memory/brain-lifecycle.ts` — Step 10 added, interface extended
- `packages/core/src/memory/__tests__/dream-cycle.test.ts` — 3 new SC tests appended

### Tests

- SC-1: triggerManualDream result includes sleepConsolidation stats (all fields present)
- SC-2: summariesGenerated includes sleep-consolidation LLM outputs when ran
- SC-3: dream cycle completes even when sleep consolidation throws (best-effort path)

All 3 pass. All 13 dream-cycle tests pass (9 original DC + 3 new SC + DC-1).

## Smoke Test Results

```
cleo memory dream  (no LLM configured)
---
Dream cycle complete.
  Deduplicated:    0
  Quality recomp:  153
  Tier promoted:   1 entries promoted
  Tier evicted:    0 entries evicted
  Contradictions:  50
  Soft evicted:    0
  Edges strength:  50
  Summaries gen:   0   <- 0 because no LLM key; graceful skip logged
  Graph links:     0
  Reward backfill: 0 labeled, 0 skipped
  STDP plasticity: 0 LTP, 0 LTD, 0 edges created
  Decay/pruning:   0 decayed, 0 pruned
```

"Summaries gen: 0" is now CORRECT behavior when no LLM is configured (graceful fallback).
When ANTHROPIC_API_KEY is set, `runSleepConsolidation` will execute its 4 steps and
`summariesGenerated` will be non-zero.

## Quality Gates

- pnpm biome check --write: PASS (no fixes applied)
- pnpm run build: PASS (build complete)
- Adapter tests (283): ALL PASS
- Core dream-cycle + sleep-consolidation tests (36): ALL PASS
