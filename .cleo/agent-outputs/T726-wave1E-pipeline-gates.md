# T726 Wave 1E — Extraction Pipeline Gates + ADRs + Spec Lock

**Worker**: Worker E  
**Date**: 2026-04-15  
**Tasks**: T749, T745, T742, T740, T739, T738  
**Status**: complete

---

## Summary

Implemented all 6 tasks in T726 Wave 1E. All changes are additive and idempotent. Build passes, tests pass (zero new failures).

---

## T738 — Gate detectSupersession to owner/task-outcome writes

**File**: `packages/core/src/memory/patterns.ts`, `packages/core/src/memory/learnings.ts`

**Change**: Added `if (sourceConfidence === 'owner' || sourceConfidence === 'task-outcome')` gate before the `detectSupersession()` fire-and-forget block in both `storePattern()` and `storeLearning()`. Agent/speculative confidence writes now skip write-time supersession and rely on sleep-consolidation dedup instead.

**Note**: `decisions.ts` was already correct — `storeDecision()` always uses `sourceConfidence='owner'` so the gate is always true there.

---

## T739 — sqlite-vec ANN branch in detectSupersession

**File**: `packages/core/src/memory/temporal-supersession.ts`

**Change**: Added `isBrainVecLoaded` import from `brain-sqlite.ts`. In `detectSupersession()`, before the keyword loop, conditionally runs a `brain_embeddings` KNN query when sqlite-vec is loaded:

```
SELECT id, distance FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 50
```

Converts cosine distance to similarity as `max(0, 1 - distance/2)`. For each existing entry, uses `max(embeddingScore, keywordJaccardScore)` as the combined similarity. Falls back to keyword-only when embeddings unavailable. All embedding queries are wrapped in try/catch (best-effort).

---

## T740 — Session-end Observer hook

**File**: `packages/core/src/hooks/handlers/session-hooks.ts`

**Change**: Added `handleSessionEndObserver` function and registered it at priority 4.5 (between consolidation at 5 and reflector at 4). Calls `runObserver(projectRoot, sessionId, { thresholdOverride: 1 })` so Observer fires unconditionally at session end regardless of observation count.

**File**: `packages/core/src/memory/observer-reflector.ts`

Added `RunObserverOptions` interface with `thresholdOverride?: number` and updated `runObserver()` signature to accept it as third parameter. Uses `effectiveThreshold = options?.thresholdOverride ?? cfg.threshold`.

---

## T742 — Supersedes graph edges from Reflector

**File**: `packages/core/src/memory/observer-reflector.ts`

**Change**: In `runReflector()`, collect IDs of newly stored patterns/learnings in a `newEntryIds: string[]` array. After `markSuperseded(supersededIds)`, write `supersedes` edges via `addGraphEdge()` from each new entry (`pattern:id` / `learning:id`) to each superseded observation (`observation:id`). All edge writes are fire-and-forget best-effort.

---

## T745 — cleo memory reflect + dedup-scan CLI

**File**: `packages/cleo/src/cli/commands/memory-brain.ts`

Added two new subcommands:

### `cleo memory reflect [--session <id>] [--json]`
Manually triggers Observer + Reflector pipeline. Imports `runObserver` and `runReflector` from `@cleocode/core/internal`. Runs Observer with `thresholdOverride: 1` then Reflector. Reports patterns stored, learnings stored, superseded observation count.

### `cleo memory dedup-scan [--apply] [--json]`
Scans `brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings` for content-hash duplicates. Reports groups with count and sample labels. With `--apply`, calls `runConsolidation()` to merge duplicates.

**File**: `packages/core/src/internal.ts`

Added exports:
```typescript
export type { ObserverResult, ReflectorResult, RunObserverOptions } from './memory/observer-reflector.js';
export { runObserver, runReflector } from './memory/observer-reflector.js';
```

---

## T749 — ADR-048 Unified Memory Extraction Pipeline

**File**: `.cleo/adrs/ADR-048-memory-extraction-pipeline.md`

Documents:
- All-writes-through-verifyAndStore rule
- T738/T739/T740/T742 gap remediation decisions
- D008 7-technique status after Wave 1E
- Model tier choices (Q4 locked: warm=Ollama+Gemma4E2B, cold=claude-sonnet-4-6)
- Q5 locked: hybrid cleo daemon (not systemd)
- 9 acceptance criteria for Wave 1E

---

## Spec Updates

**File**: `docs/specs/memory-architecture-spec.md`

- §7.1: Replaced "OWNER DECISION REQUIRED" with locked hybrid+Sonnet choice
- §8.1: Replaced "Owner Decision Required" with locked cleo-daemon hybrid choice  
- §13: Added AC-18, AC-19, AC-20 with checkmarks for T739, T738, T745
- §14: Renamed from "Open Questions" to "Owner-Locked Decisions" with rationale

---

## Files Changed

| File | Task |
|------|------|
| `packages/core/src/memory/temporal-supersession.ts` | T739 |
| `packages/core/src/memory/learnings.ts` | T738 |
| `packages/core/src/memory/patterns.ts` | T738 |
| `packages/core/src/memory/observer-reflector.ts` | T740 + T742 |
| `packages/core/src/hooks/handlers/session-hooks.ts` | T740 |
| `packages/core/src/internal.ts` | T745 |
| `packages/cleo/src/cli/commands/memory-brain.ts` | T745 |
| `.cleo/adrs/ADR-048-memory-extraction-pipeline.md` | T749 (new) |
| `docs/specs/memory-architecture-spec.md` | T749 |

---

## Quality Gates

- [x] `pnpm biome check --write` — passed (2 files auto-fixed)
- [x] `pnpm run build` — passed (all packages)
- [x] Tests: `temporal-supersession.test.ts` — 34 tests passed
- [x] Tests: `observer-reflector.test.ts` — 18 tests passed
- [x] Tests: `decisions.test.ts` — 14 tests passed
- [x] Tests: `brain-lifecycle-tier-promotion.test.ts + sleep-consolidation.test.ts` — 32 passed
- [x] Tests: `graph-memory-bridge-integration.test.ts + embedding-pipeline.test.ts` — 29 passed
