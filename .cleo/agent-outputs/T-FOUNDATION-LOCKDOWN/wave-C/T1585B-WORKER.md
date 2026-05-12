# T1585B Worker — task-complete-lifecycle-gate.test.ts

**Final result: 14/14 tests pass** (all 11 originally failing tests + 3 already-passing tests)

Sibling regressions check: `pnpm vitest run packages/cleo/src/dispatch/engines/__tests__/` → **19 files, 205 passed, 2 skipped**. No spillover.

---

## Root cause

Stale mock for `@cleocode/core`. Production code in
`packages/cleo/src/dispatch/engines/_error.ts` was refactored to delegate
construction of `EngineResult` to canonical helpers exported from
`@cleocode/core` (commit `a6122477b` "EngineResult discriminated union + DRY
constructors"):

```ts
import { engineError as coreEngineError, ..., engineSuccess } from '@cleocode/core';
// ...
return coreEngineError<T>(code, message, { exitCode, ...options });
```

The test's `vi.mock('@cleocode/core', ...)` factory only exposed
`getLogger`, `completeTask`, `getAccessor`, `showTask`, `updateTask` — it
never exported `engineError` / `engineSuccess`. Vitest therefore threw at
runtime:

```
[vitest] No "engineError" export is defined on the "@cleocode/core" mock.
```

This caused every test that exercised the lifecycle-gate failure path
(11 of them) to crash before assertions, plus the test-level setup of the
3 always-pass cases that funnel through the same code path on the success
branch.

This is **stale mocks**, not a production bug. Production behavior is
correct; the test mock simply hadn't been updated to match the new core
re-export contract.

## Fix (test-only — production untouched)

`packages/cleo/src/dispatch/engines/__tests__/task-complete-lifecycle-gate.test.ts`:

- Extended the `@cleocode/core` mock to include `engineError` and
  `engineSuccess` constructors, mirroring the canonical implementations
  from `packages/core/src/engine-result.ts` (success/failure shape,
  exitCode/details/fix/alternatives propagation, optional `page`).
- Both helpers wrapped with `vi.fn(...)` so call-tracking still works.
- Added a comment pointing to the canonical source for future maintainers.

Diff scope: **1 file, 1 mock factory expanded** (~30 lines added). No other
test files modified, no production code touched, no imports added/removed.

## Production bugs flagged

**None.** The production refactor is sound — `_error.ts` correctly
delegates to canonical core constructors (DRY) and only adds the
dispatch-layer concerns (numeric exitCode resolution, structured logging,
Vitest log suppression). The failure was purely a test-infrastructure
debt left over from the `EngineResult` consolidation commit.

## Notes for adjacent waves

- `task-engine.test.ts` and `task-show-history.test.ts` in the same
  directory have the **same stale-mock issue** — they too will fail
  with `engineError export is defined` errors. Those are presumably
  T1585A / T1585C scope. The fix pattern is identical: extend the
  `@cleocode/core` mock factory.
- `lifecycle-scope-guard.test.ts` already passes in the directory-wide
  run, so it either dodges the code path or has been updated already.
