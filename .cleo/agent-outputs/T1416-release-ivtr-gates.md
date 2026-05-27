# T1416 Implementation: RELEASE-03 IVTR Gate + RELEASE-07 Auto-Suggest

## Summary

Closes the two acceptance criteria gaps from T820 identified by the 2026-04-24 Council audit (T1216).

## RELEASE-03: `release.gate` IVTR Gate Check

**Operation**: `cleo release gate --epic <epicId>`

Inspects all child tasks of a release epic and verifies every task with an active IVTR loop has reached the `released` phase. Tasks without IVTR loops (docs, chores) are reported as `unchecked` — non-blocking. Tasks in `implement`/`validate`/`test` phase block release with `E_IVTR_INCOMPLETE`.

`--force` bypass available for owner-level override with a loud warning emitted to stdout.

### Implementation

- **`packages/contracts/src/operations/release.ts`**: Added `ReleaseGateCheckParams`, `ReleaseGateCheckResult`, `IvtrTaskStatus` types
- **`packages/cleo/src/dispatch/engines/release-engine.ts`**: Public `releaseGateCheck(epicId, force, projectRoot)` engine function; private `buildTaskStatusList` helper
- **`packages/cleo/src/dispatch/domains/release.ts`**: `ReleaseHandler` with `query.gate` and `mutate.gate` operations
- **`packages/cleo/src/dispatch/domains/index.ts`**: `ReleaseHandler` registered under `release` domain key

## RELEASE-07: IVTR → Release Auto-Suggest

**Trigger**: after `cleo orchestrate ivtr <taskId> --release` succeeds

After an IVTR loop transitions to `released`, the `ivtr.release` dispatch case calls `releaseIvtrAutoSuggest` (best-effort, non-blocking). It checks whether all sibling tasks in the parent epic are also released. If so, the response includes an `autoSuggest` field with `epicFullyReleased: true` and `suggestedCommand: "cleo release ship <version> --epic <epicId>"`.

### Implementation

- **`packages/contracts/src/operations/release.ts`**: Added `IvtrAutoSuggestResult` type
- **`packages/cleo/src/dispatch/engines/release-engine.ts`**: `releaseIvtrAutoSuggest(taskId, projectRoot)` engine function
- **`packages/cleo/src/dispatch/domains/ivtr.ts`**: `ivtr.release` case wired to call `releaseIvtrAutoSuggest` post-release; `autoSuggest` field added to response
- **`packages/cleo/src/dispatch/domains/release.ts`**: `query.ivtr-suggest` and `mutate.ivtr-suggest` operations

## Tests

**File**: `packages/cleo/src/dispatch/domains/__tests__/release.test.ts`

28 tests covering:
- `getSupportedOperations` — declares gate + ivtr-suggest
- `query("gate")` — missing epicId, pass/fail/force bypass, meta envelope, unknown operation
- `query("ivtr-suggest")` — missing taskId, fully released, partially released, meta
- `mutate("gate")` — missing epicId, delegation, force, meta gateway, unknown operation
- `mutate("ivtr-suggest")` — missing taskId, success, meta gateway
- Error handling — unexpected engine errors in all 3 paths

## Test Results

- 112 test files passing, 1927 tests passed, 2 skipped, 0 new failures
- Build: full monorepo `pnpm run build` passes (Build complete)
- Biome: exit 0 on all changed files

## Commit

`f1cde94e80dc796644a8eca188ebc585c5d70f27` on branch `task/T1416`
