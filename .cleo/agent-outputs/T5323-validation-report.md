# T5323 Final Validation Report
Date: 2026-03-04
Agent: validation-agent

## Summary
PASS

## Check Results
| Check | Status | Issues Found | Fixed |
|-------|--------|-------------|-------|
| Zero TODOs | PASS | 0 | — |
| No direct core imports | PASS | 0 non-allowed | — |
| No store imports | PASS | 0 non-allowed | — |
| TypeScript compilation | PASS | 0 | — |
| Test suite | PASS | 15 (stale parity counts) | yes |
| CLI registration | PASS | sharing removed | — |
| MANIFEST coverage | PASS | all phases present | — |
| Dispatch compliance | PASS | 24/24 commands clean | — |
| Unused imports (_) | PASS | 0 | — |

## Issues Found and Fixed

### 1. Stale Parity/Registry Test Counts (15 test failures)
The CLI-to-dispatch migration added new operations to the registry across multiple domains, but parity gate tests and domain handler tests still expected the old counts.

**Files fixed:**
- `tests/integration/parity-gate.test.ts` — Updated total counts from 207 to 234 (132q + 102m). Updated per-domain counts for tasks (29), check (18), pipeline (32), admin (43), nexus (24). Removed `tasks.reopen` from REMOVED_ALIASES since it is now a real operation.
- `src/dispatch/__tests__/parity.test.ts` — Updated total counts to 132q + 102m = 234.
- `src/dispatch/__tests__/registry.test.ts` — Updated tasks domain total from 27 to 29.
- `src/dispatch/domains/__tests__/admin.test.ts` — Updated query list (+4: sync.status, export, snapshot.export, export.tasks) and mutate list (+5: backup.restore, sync.clear, import, snapshot.import, import.tasks).
- `src/dispatch/domains/__tests__/tasks.test.ts` — Updated mutate list (+2: reopen, unarchive).
- `src/dispatch/domains/__tests__/nexus.test.ts` — Updated query list (+2: discover, search).
- `src/mcp/gateways/__tests__/mutate.test.ts` — Updated domain counts for tasks (14), pipeline (20), admin (20).
- `src/mcp/gateways/__tests__/query.test.ts` — Updated domain counts for pipeline (12), check (16), admin (23).

### 2. No Other Issues Found
- Zero TODO/FIXME/XXX comments in CLI commands
- No unauthorized direct core imports (only allowed errors.js, output.js, config.js, paths.js)
- Store imports limited to approved patterns (restore.ts hybrid pre-flight, and pre-existing non-migrated commands)
- TypeScript compiles cleanly (zero errors)
- sharing.ts registration removed from cli/index.ts
- All 24 spot-checked commands use dispatchFromCli/dispatchRaw with zero direct core imports

## Remaining Issues (Need Human Review)

### Store imports in non-migrated commands
The following commands have store imports but were NOT part of the T5323 migration scope:
- `archive-stats.ts` — `getAccessor()` (dispatch wrapper added, store import pre-existing)
- `relates.ts` — `getAccessor()` (pre-existing, not in migration scope)
- `extract.ts` — `readJson`, `computeChecksum`, `getAccessor()` (pre-existing)
- `focus.ts` — `getAccessor()` (pre-existing)
- `docs.ts` — `readJson` (pre-existing)
- `checkpoint.ts` — git-checkpoint imports (CLI-only command, pre-existing)
- `commands.ts` — `readJson` (pre-existing)

These are outside the T5323 scope but could be migrated in a future sweep.

### Direct core imports in non-migrated commands
Commands like `focus.ts`, `remote.ts`, `init.ts`, `relates.ts`, `env.ts`, `extract.ts`, `otel.ts`, `mcp-install.ts`, `self-update.ts`, `upgrade.ts`, `web.ts`, `sticky.ts`, etc. have direct core imports. These were NOT part of the T5323 migration scope (they are either CLI-only commands or were not included in the migration plan).

## Migration Statistics
- Commands migrated to dispatch: 24 (labels, grade, archive-stats, skills, issue, memory-brain, history, testing, consensus, contribution, decomposition, implementation, specification, verify, nexus, export, import, snapshot, export-tasks, import-tasks, phase, phases, sync, restore)
- Commands verified pre-existing dispatch: 0
- Commands with CLI-only justification: ~20 (checkpoint, env, web, init, mcp-install, self-update, upgrade, etc.)
- Registry operations added this session: 27 (234 - 207)
- Total registry operations: 234 (132 query + 102 mutate)
- Test suite: 235 files, 3878 tests, 0 failures
