# T1635: Stage Drift Auto-Detector (Sentient Tick)

**Status**: complete
**Task**: T1635 — T-HR-S4: Stage drift auto-detector (sentient tick) — flag and optionally auto-correct
**Branch**: task/T1635

## Summary

Implemented a sentient hygiene check that detects when an epic's stored `pipelineStage` diverges from its actual child-progress-based effective stage (the T1232 bug class).

## Files Changed

### New Files
- `packages/core/src/lifecycle/effective-stage.ts` — Pure helper: `computeEffectiveStage`, `fetchEpicProgressBatch`, `EFFECTIVE_STAGE_INDEX`, `EffectiveStage` type
- `packages/core/src/sentient/stage-drift-tick.ts` — `runStageDriftScan`, `safeRunStageDriftScan`, `StageDriftOptions`, `EpicDriftRecord`, `StageDriftOutcome` + constants
- `packages/core/src/sentient/__tests__/stage-drift.test.ts` — 18 vitest tests

### Modified Files
- `packages/core/src/sentient/tick.ts` — `TickOptions.stageDriftScan` + `stageDriftIntervalMs`, `maybeTriggerStageDriftScan`, `_resetStageDriftScanAt`, `_getLastStageDriftScanAt`, `_lastStageDriftScanAt` module var, DRIFT_SCAN_INTERVAL_MS import
- `packages/core/src/sentient/index.ts` — export `./stage-drift-tick.js`
- `packages/core/src/lifecycle/index.ts` — export T1635 effective-stage symbols
- `CHANGELOG.md` — T1635 entry added

## Architecture

**Stage derivation rule (4-tier)**:
- 0% children done → `research` (index 1)
- 1–99% children done → `implementation` (index 6)
- 100% done, gates pending → `testing` (index 8)
- 100% done + all gates passed → `release` (index 9)

**Drift detection**: `|effective_index - stored_index| > 2` (configurable, default 2)

**Proposal format**: `[T2-DRIFT] auto-fix stage drift on T<id>: <stored> → <effective>` — uses existing transactional INSERT path (daily rate-limit + per-parent dedup T1592)

**Integration**: `safeRunTick` calls `maybeTriggerStageDriftScan` (fire-and-forget, best-effort) on 30-min cadence (configurable)

**Owner workflow**: `cleo sentient propose accept <id>` → `cleo update <epicId> --pipeline-stage <effective>`

## Test Coverage

18 tests all green:
- `computeEffectiveStage` pure unit tests (7 cases)
- `runStageDriftScan`: kill-switch, tier2 disabled, no-epics, no-drift path, single-stage drift (no proposal), threshold boundary, multi-stage drift (proposal emitted + DB verification), implementation→release drift (gap=3), dedup guard, multiple epics
- `safeRunStageDriftScan`: error swallowing

## Quality Gates

- biome CI: clean (0 errors on my files)
- tsc: exit 0
- pnpm run test: 729 test files, 11972 tests passed (zero new failures)
- Commits: 39ff4fc6 (implementation), c1f12ba3 (changelog)
