# T1596 — `cleo pivot` first-class context-switch verb (Foundation-Worker-6)

## Status: COMPLETE — 11/11 tests passing, both packages build clean

## New files

| Path | LOC | Purpose |
|------|-----|---------|
| `packages/core/src/orchestrate/pivot.ts` | 351 | Core `pivotTask` + `PivotOptions` + `PivotResult` + `PIVOT_AUDIT_FILE` |
| `packages/core/src/orchestrate/__tests__/pivot.test.ts` | 277 | 11 tests covering validation, active-task gate, audit/memory/blocker |
| `packages/cleo/src/cli/commands/pivot.ts` | 59 | Citty shim — body is a single `dispatchFromCli` call |

## Modified files (wire-in points)

| Path | Change |
|------|--------|
| `packages/core/src/internal.ts` | Added `export type { PivotOptions, PivotResult }` + `export { PIVOT_AUDIT_FILE, pivotTask }` from `./orchestrate/pivot.js` |
| `packages/cleo/src/cli/index.ts` | 1-line import + 1-line `subCommands['pivot'] = pivotCommand` |
| `packages/cleo/src/dispatch/registry.ts` | Added 1 OperationDef entry: `mutate / orchestrate / pivot` with 4 ParamDefs (fromTaskId+toTaskId positional, reason required, blocksFrom optional) |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | Added `OrchestratePivotParams` interface, `orchestratePivotOp` wrapper (maps CleoError exit codes to E_VALIDATION / E_NOT_FOUND / E_NOT_ACTIVE), registered in `coreOps`, switch case in `mutate()`, listed in `getSupportedOperations` |

## Test results

```
Test Files  1 passed (1)
     Tests  11 passed (11)
   Duration  36.85s
```

Tests cover all 4 acceptance criteria from the spec:
1. Pivot from active task → success (focus mutated, audit + memory + blocker recorded)
2. Pivot from non-active task → rejected (`ExitCode.ACTIVE_TASK_REQUIRED` / E_NOT_ACTIVE)
3. Pivot without `--reason` → rejected (`ExitCode.VALIDATION_ERROR` / E_VALIDATION)
4. Audit JSONL appended (`.cleo/audit/pivots.jsonl`); memory observation recorded (best-effort); blocker chain set when `blocksFrom: true` (default), skipped when `false`

Plus extras: empty/whitespace reason rejection, self-pivot rejection, missing-task rejection (both ends), pipelineStage-active path (no focus).

## Project-agnostic verification

- All business logic in `packages/core/src/orchestrate/pivot.ts` — zero project-type assumptions (no Node/Rust/build-system specifics).
- Active-task heuristic uses CLEO-level signals only: `focus_state.currentTask` OR `pipelineStage in {implementation, verification, test}`.
- Memory write uses canonical `BrainObservationType` (`decision`) with `[PIVOT]` title prefix — type `pivot` is not in the schema enum, so we annotate via title rather than mutate the contracts package (out of scope).
- CLI shim uses citty `defineCommand`; reason flag is `required: true` so citty rejects silent invocations before dispatch.
- Audit log path `.cleo/audit/pivots.jsonl` matches existing convention (mirrors `RECONCILE_AUDIT_FILE`).
- Dispatch registry entry has `tier: 0` (always-available), `idempotent: false` (records side-effecting audit + memory rows).

## Behavior summary

`cleo pivot <fromTaskId> <toTaskId> --reason "<text>" [--no-blocks-from]`

1. Validates both tasks exist (`loadSingleTask`).
2. Validates from is active (current focus OR in IVTR pipelineStage).
3. Validates `--reason` is non-empty (trimmed).
4. Stops `from` if it's the focus, then starts `to` (mutates `focus_state` via existing `startTask` / `stopTask`).
5. Adds `to` as a dep on `from` via `updateTask({addDepends:[to]})` unless `--no-blocks-from`.
6. Appends one JSON line to `.cleo/audit/pivots.jsonl` with `{pivotId, from, to, reason, timestamp, sessionId, agentId, blockedFrom}`.
7. Best-effort memory observation (`memoryObserve` with type `decision`, title `[PIVOT] <from> → <to>`).
8. Logs `task_pivot` operation row.
9. Returns `PivotResult` including `pivotId`, `auditEntry` (serialized JSON line), and `memoryObservationId` (or null).

## Constraints honored

- ✅ All business logic in core; CLI shim ≤ 5 LOC of body (1 dispatch call).
- ✅ TypeScript strict — no `any`, no `unknown`, no inline types; all types from `@cleocode/contracts`.
- ✅ Project-agnostic — pivot is a CLEO-level concept.
- ✅ Reason text REQUIRED — both citty (`required: true`) and core (`CleoError(VALIDATION_ERROR)`) enforce this.
- ✅ Touched only the files listed in the worker spec.

## Notes for downstream workers

- `BRAIN_OBSERVATION_TYPES` does not include `'pivot'`. Adding it is a small contract change; defer to the typed-memory epic.
- The `E_NOT_ACTIVE` string code is mapped only inside the orchestrate dispatch handler (not in `STRING_TO_EXIT`) to avoid linter conflicts with the existing `E_ACTIVE_TASK_REQUIRED: 38` entry. Both surface the same exit code (38).
- `pipelineStage`-only-active path stops_focus is intentionally a no-op (focus_state has no entry to clear); this is covered by the `accepts when from task is active by pipelineStage even if not focus` test.
