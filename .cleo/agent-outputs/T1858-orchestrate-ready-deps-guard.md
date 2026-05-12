# T1858: orchestrate ready dep-graph validation guard

## Task

`cleo orchestrate ready` refuses tasks when parent epic dep-graph fails validation.

## Status: complete

## Changes

### packages/core/src/orchestrate/query-ops.ts

- Added `OrchestrateReadyOptions` interface with `ignoreDepsValidate?: boolean`
- Added `OrchestrateDepsAuditEntry` interface for audit log entries
- Added `ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE` constant (`.cleo/audit/orchestrate-deps-bypass.jsonl`)
- Added `appendDepsValidateBypassAudit()` function (sync, swallows errors, matches worker-verify pattern)
- Updated `orchestrateReady()` signature to accept optional `opts: OrchestrateReadyOptions`
- Added dep-graph validation pre-step using `runValidation(tasks, { epicId })`:
  - `strict` mode: refuse with `E_DEP_GRAPH_INVALID` + issue details
  - `advisory` mode: set `depsWarning` in response, proceed
  - `off` mode: skip entirely
  - `ignoreDepsValidate` bypass: audit-log issues, proceed regardless of mode
- Issue filtering: `E_ORPHAN` excluded (project-level concern), `E_MISSING_REF` filtered when referenced task exists project-wide (cross-epic deps not flagged as missing)

### packages/cleo/src/cli/commands/orchestrate.ts

- Added `--ignore-deps-validate` boolean flag to `readyCommand`
- Passes `ignoreDepsValidate` to dispatch params

### packages/cleo/src/dispatch/domains/orchestrate.ts

- Extended `OrchestrateReadyParams` with `ignoreDepsValidate?: boolean`
- Updated `orchestrateReadyOp` to pass the flag through to core
- Updated `case 'ready':` switch to extract and forward `ignoreDepsValidate`

### packages/core/src/internal.ts

- Exported new types and functions: `ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE`, `OrchestrateDepsAuditEntry`, `OrchestrateReadyOptions`, `appendDepsValidateBypassAudit`

### packages/cleo/src/cli/commands/__tests__/orchestrate-ready-deps-guard.test.ts (new)

6 tests covering:
1. `invalid dep-graph + strict mode` → `E_DEP_GRAPH_INVALID`
2. `valid dep-graph` → proceeds to ready set
3. `--ignore-deps-validate` → bypass + audit entry written
4. `sentient (no bypass)` → strict enforced
5. `advisory mode` → `depsWarning` in response
6. `off mode` → no validation, no warning

## Commits

- `25c9a17a6` — feat(T1858) — on task/T1858 branch
- `5046af4af` — merge commit to main via `cleo orchestrate worktree-complete T1858`

## Key Design Decisions

- E_ORPHAN excluded: orphan detection is project-level, irrelevant to ready-set
- E_MISSING_REF filtered for cross-epic deps: T_A (in epic A) depends on T_B (in epic B) is valid if T_B exists project-wide — it's the epic that must declare the dep, not the task
- Bypass is CLI-only: the `ignoreDepsValidate` flag is only wired from the CLI dispatch path; sentient/worktree-dispatch callers do not receive it
- Audit is non-fatal: `appendFileSync` errors are swallowed per project convention
