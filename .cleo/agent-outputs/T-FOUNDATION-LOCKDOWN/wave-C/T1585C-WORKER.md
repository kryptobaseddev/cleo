# T1585C — Test-Fix-Worker-3 Deliverable

**Task:** T1585 (Wave C — predecessor test debt cleanup)
**Worker:** Test-Fix-Worker-3
**File touched:** `packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts`
**Production code touched:** none

## Final test count

`pnpm vitest run packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts --no-coverage`

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

3/3 previously failing tests now pass. The other 4 tests in the file remain green. No new failures elsewhere were introduced (test file is the only edit).

## Root cause

The test file declares two top-level `vi.mock(...)` factories: one for
`@cleocode/core/internal` (rich, ~30 stubs) and one for `@cleocode/core`
(thin, 5 stubs). When `_error.ts` was refactored to delegate construction
of `EngineResult` to a single canonical implementation (commit `a6122477b`,
"EngineResult discriminated union + DRY constructors"), it began importing
`engineError as coreEngineError` and `engineSuccess` directly from
`@cleocode/core` (lines 25, 267 of `_error.ts`).

The `@cleocode/core` mock factory replaced the module wholesale and never
exposed those new exports, so the moment any taskComplete / taskCompleteStrict
path hit its catch-boundary error-mapping (or constructed an explicit
E_EVIDENCE_MISSING for the verification_json NULL gate), vitest threw:

```
[vitest] No "engineError" export is defined on the "@cleocode/core" mock.
```

The 3 failing tests are exactly the ones that exercise an error path through
`cleoErrorToEngineError` → `coreEngineError` (T100 already-completed,
T999 not-found, T300 verification_json NULL).

## Fix

Switched the `@cleocode/core` mock from a wholesale-replace factory to an
`importOriginal()`-based partial mock (the form the vitest error message
literally recommends). Canonical pure helpers (`engineError`, `engineSuccess`,
`EngineResult` type, exit-code map, …) remain real; only the side-effecting
domain functions (`completeTask`, `getAccessor`, `showTask`, `updateTask`,
`getActiveSession`, `getLogger`) are stubbed.

This is also the right shape for the T1568 migration: when `task-engine.ts`
moves into `packages/core`, `engineError` will still be reachable as a real
implementation, so the partial-mock contract holds without changes to the
import surface.

## Diff summary

`packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts` — 1 hunk:

- Replaced `vi.mock('@cleocode/core', () => ({ ... }))` with
  `vi.mock('@cleocode/core', async (importOriginal) => { const actual = await
  importOriginal<typeof import('@cleocode/core')>(); return { ...actual, ...stubs }; })`
- Added a TSDoc-style comment block explaining why `importOriginal()` is
  required (canonical helpers must remain real) and why this shape is stable
  across the upcoming T1568 migration.
- Net: +9 / -7 lines. No other test file edits. No production edits.

## Constraints honored

- Only edited the target test file.
- TypeScript strict (no `any`, used `importOriginal<typeof import('@cleocode/core')>()`).
- No imports from `@cleocode/contracts`.
- No pre-emptive refactor for T1568. Import shape (`from '../task-engine.js'`)
  unchanged — the migration is free to update it as part of wave 4.
- Did not touch `task-engine.ts` itself.
- Did not touch sibling worker files (T1585A / T1585B).
