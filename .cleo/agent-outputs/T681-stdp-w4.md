# T681 — STDP W4: backfillRewardSignals + Step 9a Wiring

**Status**: complete
**Task**: T681
**Commit**: 5044097d
**Date**: 2026-04-15

## Summary

Implements `backfillRewardSignals` as Step 9a of the `runConsolidation` pipeline
per `docs/specs/stdp-wire-up-spec.md §3.6 R-STDP + §4.3`.

## Files Modified

- `packages/core/src/memory/brain-stdp.ts` — Added `backfillRewardSignals` function + `RewardBackfillResult` interface. Also fixed pre-existing T679 bug: `sessionWindowMs` → `pairingWindowMs` in inner pair loop (caused ReferenceError in mocked tests).
- `packages/core/src/memory/__tests__/brain-stdp-reward.test.ts` — New: 9 real-SQLite tests, no mocks.

## Function Signature

```ts
export async function backfillRewardSignals(
  projectRoot: string,
  sessionId: string | null | undefined,
  lookbackDays?: number, // default 30
): Promise<RewardBackfillResult>

export interface RewardBackfillResult {
  rowsLabeled: number;
  rowsSkipped: number;
}
```

## Reward Signal Derivation

| Task state | Signal |
|-----------|--------|
| `done` + `verification.passed=true` | +1.0 |
| `done`, verification not passed | +0.5 |
| `cancelled` | -0.5 |
| No matching tasks | null (no-op) |

When multiple tasks in session, MAXIMUM reward takes precedence.

## Idempotency

`WHERE reward_signal IS NULL` ensures already-labeled rows are never overwritten.
Running twice on same session is safe.

## brain_modulators

For each task outcome processed, inserts a row into `brain_modulators`:
- `modulator_type`: `task_verified` / `task_completed` / `task_cancelled`
- `valence`: same scalar as reward_signal
- `source_event_id`: task ID
- `session_id`: session ID

## Step 9a Wiring

Already present in `brain-lifecycle.ts:runConsolidation` (committed in T693):
- Runs before Step 9b (`applyStdpPlasticity`)
- No-op when `sessionId` is null/undefined
- Result stored in `result.rewardBackfilled`

## Tests (9 passing)

| ID | Case | Expected |
|----|------|----------|
| T681-R1 | Verified done task | reward_signal = +1.0 |
| T681-R2 | Done, unverified | reward_signal = +0.5 |
| T681-R3 | Cancelled task | reward_signal = -0.5 |
| T681-R4 | No matching tasks | reward_signal stays NULL |
| T681-R5 | ses_backfill_ session | no-op |
| T681-R6 | null/undefined sessionId | no-op |
| T681-R7 | Run twice | idempotent, 0 re-labels |
| T681-R8 | brain_modulators | row inserted per task |
| T681-R9 | Mixed session (verified + cancelled) | +1.0 wins |

## Bug Fixed (T679 incomplete)

`applyStdpPlasticity` inner loop used `sessionWindowMs` (undefined variable) instead of
`pairingWindowMs`. This was a pre-existing T679 regression that caused 5 mocked tests to
fail with `ReferenceError: sessionWindowMs is not defined`.
