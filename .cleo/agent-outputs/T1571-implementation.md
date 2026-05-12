# T1571 Implementation — system-engine.ts Deletion (ENG-MIG-4)

**Task**: T1571 (ENG-MIG-4)
**Status**: PARTIAL — testsPassed gate blocked by pre-existing `nexus.diff` timeout
**Date**: 2026-05-01
**Branch**: task/T1571
**Worktree**: `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1571`

---

## Summary

Deleted `packages/cleo/src/dispatch/engines/system-engine.ts` (1855 LOC) across 4 atomic waves. All system dispatch logic moved to `packages/core/src/system/` and related modules. Admin domain handler and CLI commands updated to import directly from `@cleocode/core/internal`.

## Waves Completed

### Wave 1 (commit f4ccce9a6) — New core/system/ functions
Extended 8 core files + created 1 new file:
- `core/src/system/audit.ts` — `LogQueryData`, `queryAuditLog` (175 LOC from engine)
- `core/src/context/index.ts` — `ContextData`, `getContextWindow` (130 LOC)
- `core/src/system/platform-paths.ts` — `PathsData`, `getSystemPaths` (50 LOC)
- `core/src/system/backup.ts` — `FileRestoreResult`, `fileRestore` (65 LOC)
- `core/src/system/sync.ts` (NEW) — `SyncData`, `systemSync`
- `core/src/admin/help.ts` — `HelpData`, `SYSTEM_HELP_TOPICS`, `getSystemHelp` (50 LOC)
- `core/src/scaffold.ts` — `ScaffoldHubData`
- `core/src/stats/index.ts` — `DashboardData`, `StatsData`, `getProjectStatsExtended` (80 LOC)
- `core/src/compliance/index.ts` — `ComplianceData`, `getComplianceStats` (150 LOC)

### Wave 2 (commit 1a2dfee54) — Barrel wiring
- `core/src/system/index.ts` — added new exports
- `core/src/internal.ts` — added 20+ new exports including all Wave 1 symbols + `ensureCleoOsHub`

### Wave 3 (commit 8105c41af) — admin.ts + CLI caller updates
- `packages/cleo/src/dispatch/domains/admin.ts` — replaced engine imports with direct core/internal imports; inlined `runSystemSmoke()` private helper (dispatchRaw circular dep prevention); updated all 14 system operation handlers
- `packages/cleo/src/cli/commands/context.ts` — `systemContext` → `getContextWindow`
- `packages/cleo/src/cli/commands/sequence.ts` — dynamic `systemSequenceRepair` import → `repairSequence`
- `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts` — updated mocks to target `@cleocode/core/internal`
- SSoT-EXEMPT annotations added to 17 core functions (per ADR-057 hook contract)

### Wave 4 (commit d8efbb42a) — Delete + barrel update
- DELETED `packages/cleo/src/dispatch/engines/system-engine.ts`
- `packages/cleo/src/dispatch/lib/engine.ts` — replaced system-engine import block with type aliases from `@cleocode/core/internal`
- `packages/cleo/src/__tests__/core-parity.test.ts` — updated to verify core/internal exports
- `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` — removed stale system-engine mock
- `packages/cleo/src/dispatch/domains/__tests__/check.test.ts` — removed stale systemArchiveStats mock

## Gate Status

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | pending (orchestrator captures post-merge) | Worktree branch task/T1571 |
| testsPassed | PARTIAL — pre-existing failure | `nexus.diff` timeout exists on main; worktree tests: 1 failure (same nexus.diff), 0 new failures |
| qaPassed | green | biome lint: 0 errors; tsc: 0 errors |
| documented | green | .cleo/agent-outputs/T1571-migration-plan.md |
| securityPassed | green | refactor only, ADR-057 layering |
| cleanupDone | green | system-engine.ts deleted, no shim, no aliases |

## testsPassed Failure Explanation

`cleo verify --evidence "tool:test"` fails because `nexus.diff` (in `registry-parity.test.ts`) has a 60s timeout that is pre-existing on main (not introduced by this task). Evidence:

- Main branch: `nexus.diff` times out (verified by running main's test suite)
- Worktree: same 1 failure (`nexus.diff`), 0 new failures introduced by T1571
- All 14 admin operation tests pass with updated mocks

Orchestrator should adjudicate testsPassed based on worktree test evidence (see worktree test run: `Tests 1 failed | 2055 passed | 2 skipped`).

## Verification Commands (run in worktree)

```bash
# Confirm deletion
test ! -f /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1571/packages/cleo/src/dispatch/engines/system-engine.ts && echo OK

# Confirm no remaining imports
grep -rn "from.*system-engine" /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1571/packages/cleo/src/ --include="*.ts" | grep -v "__tests__\|comment"

# LOC confirmation
# Original: 1855 lines. Now: 0 lines (deleted).
```
