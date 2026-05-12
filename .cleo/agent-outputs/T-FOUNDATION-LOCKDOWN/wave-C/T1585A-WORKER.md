# T1585A — lifecycle-scope-guard.test.ts (Wave C)

**Worker**: Test-Fix-Worker-1
**Date**: 2026-04-29
**Status**: COMPLETE

## Final Test Count

**11/11 pass** (the brief said 12 — actual vitest sub-test count is 11: 3 scope-denied mutate ops + 1 epic-scoped + 1 global + 1 no-session + 1 owner-override + 3 role-restricted + 1 T1150 regression).

Full `pnpm vitest run packages/cleo` = **124 files passed, 2061/2061 tests pass, 2 skipped**. No spillover.

## Root Cause

Stale `vi.mock('@cleocode/core', ...)` factory. The mock returned only `{ getLogger }`, but `packages/cleo/src/dispatch/engines/_error.ts` (called by `lifecycle-engine.ts`) imports **three** symbols from `@cleocode/core`: `engineError as coreEngineError`, `engineSuccess`, and `getLogger`. When the engine hit the error path (every test exercises it: scope-denied or success-with-engineSuccess), vitest threw `No "engineError" export is defined on the "@cleocode/core" mock`. This is the same shape as the T1564 nexus-projects-clean fix — production added a re-export from `@cleocode/core`, mock factories never updated.

## Fix

Single edit: replaced the static factory with the `importOriginal()` partial-mock pattern recommended in the vitest error message itself — preserves the canonical `engineError` / `engineSuccess` while still stubbing `getLogger` to a no-op so pino doesn't write to stderr during tests. Test logic, expectations, and downstream-stub behavior are unchanged.

## File Diff Summary

`packages/cleo/src/dispatch/engines/__tests__/lifecycle-scope-guard.test.ts` (lines 92-114, ~12 line net delta):

- Before: `vi.mock('@cleocode/core', () => ({ getLogger: vi.fn(...) }))` — broke `engineError` import in `_error.ts`.
- After: `vi.mock('@cleocode/core', async (importOriginal) => { const actual = await importOriginal<typeof import('@cleocode/core')>(); return { ...actual, getLogger: vi.fn(...) }; })` — preserves canonical exports, stubs only logger.

No other files touched. No production code touched (per constraint). No `any` types introduced. No `@cleocode/contracts` imports added.

## Genuine Production Bugs Found

**None.** All failures were stale-mock test debt. Production `_error.ts` and `lifecycle-engine.ts` are correct — they delegate to canonical core helpers per ADR-039 envelope contract.

## Coordination

Did not touch sibling files `task-complete-lifecycle-gate.test.ts` (T1585B) or `task-engine.test.ts` (T1585C).
