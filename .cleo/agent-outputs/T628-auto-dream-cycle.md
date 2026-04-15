# T628 — Auto-Dream Cycle Worker Report

**Task**: Auto-dream cycle — autonomous consolidation + plasticity on schedule
**Date**: 2026-04-15
**Agent**: cleo-subagent (Worker)
**Status**: complete
**Commit**: 1669f939 (dream-cycle.ts + test), plus earlier commits containing memory-brain.ts + internal.ts changes

---

## What Was Built

### New File: `packages/core/src/memory/dream-cycle.ts`

Three-tier autonomous dream cycle scheduler:

| Tier | Trigger | Default | Logic |
|------|---------|---------|-------|
| 1 — Volume | `brain_observations` delta since last consolidation | 10 new obs | `checkVolumeTrigger(threshold)` |
| 2 — Idle | No `brain_retrieval_log` activity | 30 min | `checkIdleTrigger(thresholdMin)` |
| 3 — Cron | Nightly timer | 4 AM UTC | `startDreamScheduler(root, hour)` |

Each trigger calls `runConsolidation(projectRoot, sessionId, 'scheduled')` which includes:
- Step 9a: R-STDP reward backfill (`backfillRewardSignals`)
- Step 9b: STDP timing-dependent plasticity (`applyStdpPlasticity`)
- Step 9c: Homeostatic decay + pruning (`applyHomeostaticDecay`)
- Step 9e: Log to `brain_consolidation_events`

#### Key Idempotency Guards
- `DREAM_COOLDOWN_MS` (5 min) — in-process cooldown prevents double-trigger
- `dreamInFlight` flag — prevents concurrent overlapping runs
- Idle trigger returns `shouldTrigger: false` when no retrievals ever recorded (newly initialised system)

#### Exported API
```typescript
checkAndDream(projectRoot, opts)          // evaluate all tiers, fire if any trigger
triggerManualDream(projectRoot, sessionId) // bypass thresholds, always runs
checkVolumeTrigger(threshold)             // exported for testing/inspection
checkIdleTrigger(thresholdMinutes)        // exported for testing/inspection
startDreamScheduler(projectRoot, hourUTC) // start nightly cron
stopDreamScheduler()                      // stop nightly cron
_resetDreamState()                        // test teardown helper
```

### Modified: `packages/cleo/src/cli/commands/memory-brain.ts`

Added `cleo memory dream` command (manual trigger):
```
cleo memory dream [--json]
```
- Calls `triggerManualDream(projectRoot)`
- Shows per-step counts including STDP plasticity and homeostatic decay
- JSON mode outputs full `RunConsolidationResult`

### Modified: `packages/core/src/internal.ts`

Exports `DreamCheckResult`, `DreamCycleOptions`, and all public functions from `dream-cycle.ts`.

### New Test File: `packages/core/src/memory/__tests__/dream-cycle.test.ts`

10 tests using real SQLite (no mocks):

| ID | Description | Result |
|----|-------------|--------|
| DC-1 | Volume trigger fires when observations exceed threshold | pass |
| DC-2 | Volume trigger does NOT fire when below threshold | pass |
| DC-3 | Idle trigger fires when last retrieval is older than threshold | pass |
| DC-4 | Idle trigger does NOT fire when recent retrieval activity exists | pass |
| DC-5 | Consolidation event recorded in brain_consolidation_events | pass |
| DC-6 | Cooldown prevents double-trigger within 5 min window | pass |
| DC-7 | triggerManualDream bypasses thresholds and always runs | pass |
| DC-8 | dreamInFlight guard suppresses concurrent overlapping calls | pass |
| DC-9 | checkVolumeTrigger reports correct observation count | pass |
| DC-9b | checkIdleTrigger reports correct idle minutes | pass |

---

## Quality Gates

- `pnpm biome check --write`: PASS (no issues)
- `pnpm run build`: PASS
- `pnpm run test` (full suite): PASS (exit code 0)
- `cleo memory dream` smoke test: PASS (runs consolidation, outputs step counts)

---

## Acceptance Criteria Mapping

| Criteria | Status |
|----------|--------|
| `cleo memory dream` command exists | DONE |
| Auto-fires on session.end (via existing `handleSessionEndConsolidation`) | DONE (existing hook) |
| Configurable schedule via trigger thresholds | DONE (volumeThreshold, idleThresholdMinutes opts) |
| Dream log stored in BRAIN (`brain_consolidation_events`) | DONE |
| Provider-agnostic (no Claude Code dependency) | DONE |

---

## Integration Notes

- Per spec §4.5: "Plasticity IS part of the dream cycle" — STDP Step 9b fires on every `runConsolidation` call
- Session-end consolidation backstop remains (existing `handleSessionEndConsolidation` at priority 5)
- `startDreamScheduler` must be called explicitly to activate nightly cron (not auto-started)
- SQLite datetime UTC normalisation: `minutesSince()` appends `Z` to SQLite datetime strings to prevent JS local-time misinterpretation
