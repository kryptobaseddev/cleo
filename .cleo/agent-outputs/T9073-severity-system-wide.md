# T9073 — --severity in cleo add+update + decouple from priority

## Status: COMPLETE

## What was done

### 1. T9071 cherry-pick (prerequisite)
Cherry-picked 4 commits from `task/T9071` into `task/T9073`:
- `SeverityAttestation` interface in `@cleocode/contracts`
- `severity-attestation.ts` core helper (system-wide attestation)
- `cleo bug` refactored to delegate to core helper
- Biome import sort fix

### 2. `cleo add --severity` (feat)
- Updated `--severity` description: valid for any `--role` (T9073)
- Added `appendSignedSeverityAttestation` call in `run()` before dispatch
- Non-fatal outside CLEO project (falls through)
- Skips attestation on `--dry-run`
- E_OWNER_ONLY propagated with exit 72

### 3. `cleo update --severity` (feat)
- Added `--severity` flag to update command args
- Added `appendSignedSeverityAttestation` call with `taskId` context
- `taskUpdate` / `taskUpdate` engine wrapper / `tasksUpdateOp` / dispatch handler all wired with `severity`
- `TasksUpdateQueryParams` in contracts updated with severity, role, scope, reason, dependsWaiver

### 4. Migration (feat)
- `20260508000000_t9073-severity-any-role`: full table rebuild
- Old CHECK: `severity IS NULL OR (severity IN (...) AND role='bug')`
- New CHECK: `severity IS NULL OR severity IN ('P0','P1','P2','P3')`
- All existing rows preserved; no data transformation needed
- `revert.sql` provided

### 5. Schema doc updates
- `tasks-schema.ts` TASK_SEVERITIES block doc comment updated
- `severity` column doc comment updated
- `core add.ts` `AddTaskOptions.severity` doc comment updated

### 6. Tests (14 new tests)
- `t9073-severity-cross-role.test.ts`: 9 attestation tests (bug, spike, incident, work roles; multiple attestations; taskId; epic; determinism; no SEVERITY_MAP)
- `t9073-severity-any-role-schema.test.ts`: 5 DB schema tests (ACCEPTS spike/work/bug, REJECTS INVALID, ACCEPTS NULL)
- `t944-role-scope-schema.test.ts`: inverted the old "rejects severity when role != bug" test (T9073 widened the constraint)

## Key design decisions
- SEVERITY_MAP stays only in `cleo bug` (priority mapping for bug shorthand)
- `cleo add`/`cleo update` do NOT map severity→priority — fully orthogonal
- Attestation writes to `.cleo/audit/severity-attestation.jsonl` (not `bug-severity.jsonl`)
- dispatch `tasks.update` now also wires `role`, `scope`, and `reason` (pre-existing gap fixed)

## Files changed
- `packages/cleo/src/cli/commands/add.ts`
- `packages/cleo/src/cli/commands/update.ts`
- `packages/cleo/src/dispatch/domains/tasks.ts`
- `packages/contracts/src/operations/tasks.ts`
- `packages/contracts/src/task.ts` (via T9071)
- `packages/core/src/store/__tests__/t944-role-scope-schema.test.ts`
- `packages/core/src/store/__tests__/t9073-severity-any-role-schema.test.ts` (new)
- `packages/core/src/store/tasks-schema.ts`
- `packages/core/src/tasks/__tests__/t9073-severity-cross-role.test.ts` (new)
- `packages/core/src/tasks/add.ts`
- `packages/core/src/tasks/index.ts` (via T9071)
- `packages/core/src/tasks/ops.ts`
- `packages/core/src/tasks/severity-attestation.ts` (new via T9071)
- `packages/core/src/tasks/update.ts`
- `packages/core/src/index.ts` (via T9071)
- `packages/core/migrations/drizzle-tasks/20260508000000_t9073-severity-any-role/` (new)

## Quality gates
- biome CI: PASS (2165 files, no fixes)
- build: PASS (Build complete)
- typecheck (tsc -b): PASS
- tests: 1826 passed, 0 failed
