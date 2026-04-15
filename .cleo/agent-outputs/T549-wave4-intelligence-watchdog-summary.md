# T549 Wave 4: Intelligence CLI + Watchdog Scheduler

**Task**: T549 (Memory Architecture v2 — Tiered Cognitive Memory System)
**Wave**: 4 — Intelligence CLI + Watchdog Wiring
**Date**: 2026-04-11
**Status**: COMPLETE

---

## Summary

Wave 4 implements two independent additions:

1. **Intelligence CLI** — exposes the five intelligence functions already in `packages/core/src/intelligence/` through a new `cleo intelligence` command group and a new `IntelligenceHandler` dispatch domain.

2. **Watchdog Scheduler** — wires a 60-second periodic health-check timer into the session lifecycle hooks so crashed agents are automatically detected and recovered while a session is active.

Both are purely additive. No existing code paths were modified except for:
- `packages/core/src/internal.ts` — added missing exports for `getBrainAccessor`, `suggestGateFocus`, `scoreVerificationConfidence`, `predictAndStore`, `storePrediction`, and their associated types.
- `packages/cleo/src/dispatch/domains/index.ts` — registered `IntelligenceHandler`.
- `packages/cleo/src/cli/index.ts` — registered `registerIntelligenceCommand`.
- `packages/core/src/hooks/handlers/index.ts` — added `watchdog-hooks.js` import and re-export.

---

## Part 1: Intelligence CLI

### New Files

**`packages/cleo/src/dispatch/domains/intelligence.ts`**
- `IntelligenceHandler` class implementing `DomainHandler`
- Supports 5 query operations: `predict`, `suggest`, `learn-errors`, `confidence`, `match`
- Mutate gateway returns `unsupportedOp` (intelligence is read-only at domain level)
- Constructs both `DataAccessor` (via `getAccessor`) and `BrainDataAccessor` (via `getBrainAccessor`) per call
- All paths wrapped in try/catch with structured LAFS error envelopes

**`packages/cleo/src/cli/commands/intelligence.ts`**
- `registerIntelligenceCommand(program)` function
- Registers 5 subcommands: `predict`, `suggest`, `learn-errors`, `confidence`, `match`
- All dispatch via `dispatchFromCli` to `query / intelligence / <operation>`
- `--json` flag supported on all subcommands

### Operations

| Command | Core Function | Required Params |
|---------|--------------|-----------------|
| `cleo intelligence predict --task <id>` | `calculateTaskRisk` | `taskId` |
| `cleo intelligence predict --task <id> --stage <stage>` | `predictValidationOutcome` | `taskId`, `stage` |
| `cleo intelligence suggest --task <id>` | `suggestGateFocus` | `taskId` |
| `cleo intelligence learn-errors [--limit <n>]` | `extractPatternsFromHistory` | none |
| `cleo intelligence confidence --task <id>` | `scoreVerificationConfidence` (dry-run) | `taskId` |
| `cleo intelligence match --task <id>` | `matchPatterns` | `taskId` |

### internal.ts additions

Added the following exports that were missing from `packages/core/src/internal.ts`:

- `getBrainAccessor` and `BrainDataAccessor` type from `store/brain-accessor.js`
- `suggestGateFocus`, `scoreVerificationConfidence`, `predictAndStore`, `storePrediction` from `intelligence/adaptive-validation.js`
- `AdaptiveValidationSuggestion`, `GateFocusRecommendation`, `StorePredictionOptions`, `VerificationConfidenceScore` types

---

## Part 2: Watchdog Scheduler

### New File

**`packages/core/src/hooks/handlers/watchdog-hooks.ts`**

**Design**:
- Module-level `activeWatchdogs: Map<string, ReturnType<typeof setInterval>>` — one timer per project root
- `WATCHDOG_INTERVAL_MS = 60_000` (60 seconds)
- Gated behind `brain.autoCapture` config (same gate as all other brain capture hooks)

**`handleWatchdogStart(projectRoot, payload)`**:
- Checks `isAutoCaptureEnabled` first; returns early if not enabled
- Idempotency guard: if watchdog already running for this root, returns
- Creates `setInterval` timer calling `runWatchdogTick`
- Registered at `SessionStart`, priority 50

**`handleWatchdogStop(projectRoot, payload)`**:
- Clears interval and deletes map entry
- Registered at `SessionEnd`, priority 50
- Safe to call when no watchdog is running

**`runWatchdogTick(projectRoot)`** (internal):
1. `detectCrashedAgents(STALE_THRESHOLD_MS, projectRoot)` — find stale agents
2. For each crashed agent: `processAgentLifecycleEvent(...)` — write failure to brain.db
3. `recoverCrashedAgents(STALE_THRESHOLD_MS, projectRoot)` — reset crashed agents
4. `hooks.dispatch('onPatrol', ...)` — fire patrol event for observability

All tick errors are caught and logged as warnings; the timer continues regardless. Brain schema errors (`isMissingBrainSchemaError`) are silently swallowed.

### Hook Registration

Priority 50 (below brain-session-start at 100, above session-end backup at 10):
- `watchdog-session-start` on `SessionStart`
- `watchdog-session-end` on `SessionEnd`

---

## Quality Gates

All gates passed:

| Gate | Result |
|------|--------|
| `pnpm biome check` | 0 errors, 5 style fixes applied |
| `pnpm run build` | Success (all packages) |
| `pnpm run test` | 1 pre-existing flaky timing failure (confirmed present on `main` without these changes); 0 new failures |

---

## Files Changed

| File | Action |
|------|--------|
| `packages/core/src/internal.ts` | Added exports for `getBrainAccessor`, `BrainDataAccessor`, and adaptive-validation intelligence functions |
| `packages/cleo/src/dispatch/domains/intelligence.ts` | Created — `IntelligenceHandler` |
| `packages/cleo/src/dispatch/domains/index.ts` | Added `IntelligenceHandler` import and registration |
| `packages/cleo/src/cli/commands/intelligence.ts` | Created — `registerIntelligenceCommand` |
| `packages/cleo/src/cli/index.ts` | Added import and registration call |
| `packages/core/src/hooks/handlers/watchdog-hooks.ts` | Created — `handleWatchdogStart`, `handleWatchdogStop` |
| `packages/core/src/hooks/handlers/index.ts` | Added watchdog-hooks import and re-export |
