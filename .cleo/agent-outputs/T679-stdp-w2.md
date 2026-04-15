# T679 STDP W2 — applyStdpPlasticity Retry

**Task**: T679  
**Date**: 2026-04-15  
**Commit**: d066073e  
**Status**: complete

## Summary

STDP Wave 2 implementation verified and committed. The prior worker had
already implemented the core changes in `brain-stdp.ts` and authored both
test files. This retry confirmed correctness, ran quality gates, and
committed the work.

## What Was Done

### Implementation (brain-stdp.ts) — already wired by prior worker

- `applyStdpPlasticity(root, options: StdpPlasticityOptions)` accepts
  `{ lookbackDays?: number; pairingWindowMs?: number }` (defaults: 30d / 5min)
- Legacy numeric call `applyStdpPlasticity(root, ms)` still accepted — maps
  to `pairingWindowMs` only; `lookbackDays` stays 30d
- SQL cutoff uses `lookbackDays` (BUG-1 fix): `datetime('now', '-N days')`
  replaces the old 5-min window that excluded all live rows
- INSERT into `brain_plasticity_events` includes `session_id`,
  `retrieval_log_id`, `weight_before`, `weight_after`, `delta_t_ms`
- INSERT into `brain_weight_history` per Δw (guarded — skips if table absent)

### Test Files Committed

**brain-stdp-w2.test.ts** (NEW — 8 real-SQLite tests, no mocks):

| Test | What it verifies |
|------|-----------------|
| STDP-W2-1 | Same-session rows within pairingWindowMs → LTP event written |
| STDP-W2-2 | Rows 10 min apart → 0 events (pairingWindowMs=5min) |
| STDP-W2-3 | Cross-session rows within window DO pair (spec §3.1) |
| STDP-W2-4 | session_id propagated to brain_plasticity_events |
| STDP-W2-5 | retrieval_log_id populated on events |
| STDP-W2-6 | BUG-1 fix: 24h-old rows fetched with lookbackDays=30 |
| STDP-W2-7 | CSV entry_ids (BUG-2) skipped gracefully, no throw |
| STDP-W2-8 | LTD fires and weakens pre-existing reverse edge |

**brain-stdp.test.ts** (modified): updated mock shape to match T679 schema
— session_id/reward_signal fields, weight_history guard, full edge row shape.

## Quality Gates

- `pnpm biome check --write packages/core/src/memory/` — no fixes needed
- `pnpm --filter @cleocode/core build` — clean (tsc 0 errors)
- `pnpm --filter @cleocode/core test` — 249 files, 3943 passed, 0 failures
- W2 file targeted: 8/8 passed
- Original brain-stdp.test.ts: 12/12 passed
