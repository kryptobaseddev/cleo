# T1590 Worker-3 Report — AC-Immutability Guard

**Epic:** T1586 Foundation Lockdown · **Wave:** A · **Worker:** Foundation-Worker-3
**Task:** T1590 — Lock acceptance criteria once a task enters `implementation` stage.

## Outcome

Implemented an AC-immutability guard in `@cleocode/core` that rejects
acceptance-criteria mutations on tasks whose `pipelineStage` is in
`{implementation, validation, testing, release, contribution}` unless
the operator passes an explicit `--reason "<text>"`. Overrides are
appended to an append-only audit log at `.cleo/audit/ac-changes.jsonl`.

The guard prevents the predecessor's "T-THIN-WRAPPER feature-complete"
pattern (silently reframing AC after work has shipped to match what was
built).

## Files touched

| File | Change |
|------|--------|
| `packages/contracts/src/exit-codes.ts` | Added `ExitCode.AC_LOCKED = 48` (with full TSDoc citing T1586/T1590). |
| `packages/contracts/src/operations/tasks.ts` | Added `reason?: string`, `role?: string`, `scope?: string` to `TasksUpdateQueryParams`. |
| `packages/core/src/tasks/ac-immutability.ts` | **NEW** — `AC_LOCKED_STAGES`, `AC_CHANGES_AUDIT_FILE`, `AcceptanceChangeAuditEntry`, `isAcceptanceLocked`, `acceptanceEquals`, `enforceAcceptanceImmutability`, `appendAcceptanceChangeAudit`. |
| `packages/core/src/tasks/update.ts` | Imports `enforceAcceptanceImmutability`, threads `reason?: string` on `UpdateTaskOptions`, calls the guard immediately after the existing acceptance enforcement validator. |
| `packages/core/src/tasks/__tests__/ac-immutability.test.ts` | **NEW** — 14 tests (4 covering pure helpers; 6 integration tests against `updateTask` with real SQLite + audit log). |
| `packages/cleo/src/cli/commands/update.ts` | Added `--reason` CLI flag and forwards it as `reason` in dispatch params. |
| `packages/cleo/src/dispatch/engines/_error.ts` | Added `E_AC_LOCKED: 48` to `STRING_TO_EXIT`. |
| `packages/cleo/src/dispatch/engines/task-engine.ts` | Added `reason?: string` to `taskUpdate` updates type and forwards to `coreUpdateTask`. |

## Exit code added

* **Path:** `packages/contracts/src/exit-codes.ts`
* **Value:** `ExitCode.AC_LOCKED = 48`
* **String code:** `E_AC_LOCKED` (registered in `STRING_TO_EXIT`).
* **Rationale for slot 48:** the `80–89` lifecycle range was already
  fully populated (`LIFECYCLE_GATE_FAILED…ARTIFACT_PUBLISH_FAILED`).
  Slot 48 sits immediately after the verification range (40–47) and is
  semantically aligned with verification/contract-protection codes,
  rather than mis-classifying the new code as a non-error informational
  code (100+).

## AC handler location

The acceptance-criteria handling code already lives in
`packages/core/src/tasks/update.ts` (per the Package-Boundary Check),
**not** in `packages/cleo/src/dispatch/engines/task-engine.ts`. No
relocation was required. The dispatch-layer `taskUpdate` shim simply
forwards the new `reason` field through to `coreUpdateTask`.

## Audit log

* **Relative path:** `.cleo/audit/ac-changes.jsonl`
* **Constant:** `AC_CHANGES_AUDIT_FILE` (exported from
  `packages/core/src/tasks/ac-immutability.ts`).
* **Pattern:** append-only JSONL — one record per successful override.
  Mirrors `force-bypass.jsonl` and `contract-violations.jsonl` per
  ADR-039. Errors are deliberately swallowed so audit failures never
  block a legitimate operator-approved update.
* **Schema:** `{ timestamp, taskId, stage, reason, oldAcceptance,
  newAcceptance, agent }`. `agent` is sourced from the `CLEO_AGENT_ID`
  env var, falling back to `"cleo"`.

## Tests

* **File:** `packages/core/src/tasks/__tests__/ac-immutability.test.ts`
* **Result:** **14 / 14 pass** (`pnpm --filter @cleocode/core exec
  vitest run src/tasks/__tests__/ac-immutability.test.ts`).
* **Coverage:**
  * Pure helpers — 8 tests for `isAcceptanceLocked` (5 cases) and
    `acceptanceEquals` (4 cases).
  * Integration — 6 tests against `updateTask` with real SQLite:
    1. Stage `research`, no `--reason` → succeeds, no audit entry.
    2. Stage `implementation`, no `--reason` → rejected with
       `ExitCode.AC_LOCKED`; AC remains unchanged; no audit entry.
    3. Stage `implementation`, `--reason "operator approved scope
       expansion"` → succeeds; audit entry written with full
       `oldAcceptance`/`newAcceptance` snapshots and the
       `CLEO_AGENT_ID`-derived agent identifier.
    4. Two consecutive overrides → JSONL is append-only (2 lines, the
       second `oldAcceptance` reflects the first override's result).
    5. Idempotent payload at locked stage → no error, no audit entry.
    6. Whitespace-only `--reason` at locked stage → rejected.
* **Regression check:** `update.test.ts` and
  `update-pipelinestage.test.ts` continue to pass (20/20).
* **Lint:** `pnpm biome check --write` passes on all changed files.
* **Build:** `@cleocode/contracts` and `@cleocode/cleo` build clean.
  `@cleocode/core` build surfaces only **two pre-existing**, unrelated
  errors (`release/pipeline.ts` unused `cwd`,
  `spawn/branch-lock.ts` missing `WorktreeMergeResult` export) that
  match the dirty-tree state from session start; my changes contribute
  zero build errors.

## Coordination notes

* Touched only the files declared in the worker brief. No other
  workers' surfaces were modified.
* The new `reason` field on `TasksUpdateQueryParams` is additive and
  fully backward-compatible.
* Type-safe throughout — no `any`, no `unknown`-as-shortcut, no
  `as unknown as X` chains. All shared shapes import from
  `@cleocode/contracts`.

## Summary (≤ 80 words)

* `ExitCode.AC_LOCKED = 48` added in `@cleocode/contracts`; `E_AC_LOCKED`
  string-code registered in dispatch.
* New `enforceAcceptanceImmutability` guard in core blocks AC writes at
  stages `implementation+`; `--reason` opens an audited override path.
* CLI `--reason` flag wired through `update` command → dispatch →
  core. AC handler was already in core — no relocation.
* 14 new tests pass; 20 existing update tests still pass; biome clean.
