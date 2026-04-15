# T527 — Sever Duplicate Session Observation Hooks

**Status**: complete
**Date**: 2026-04-11

## What Was Changed

### Fix 1: `packages/core/src/hooks/handlers/session-hooks.ts`

Removed the `observeBrain()` call from `handleSessionStart`. The function previously
wrote a "Session started: X" brain observation on every session start, duplicating
data that already exists in the sessions table. The `maybeRefreshMemoryBridge` call
was kept intact.

Removed the `observeBrain()` call from `handleSessionEnd`. Same rationale — session
end data (duration, tasks completed) already lives in the sessions table. The
gradeSession call, transcript extraction, and `maybeRefreshMemoryBridge` call were
all kept intact.

The unused import of `isMissingBrainSchemaError` from `handler-helpers.js` was also
removed since it was only needed for the removed error-handling blocks.

### Fix 2: `packages/core/src/sessions/session-memory-bridge.ts`

Removed both the `observeBrain()` call (which created a third session-end observation)
and the `extractSessionEndMemory()` call (which generated noise patterns/learnings from
sessions). The function is now a no-op retained for call-site compatibility in
`sessions/index.ts`.

## Test Updates

Three test files were updated to reflect the new behavior:

- `__tests__/session-hooks.test.ts` — rewrote to test memory bridge refresh instead
  of observeBrain calls; used `vi.hoisted()` pattern for mock initialization
- `sessions/__tests__/session-memory-bridge.test.ts` — rewrote to verify no-op
  behavior (resolves without throwing)
- `__tests__/hook-automation-e2e.test.ts` — updated SessionStart and SessionEnd
  describe blocks to assert `observeBrainMock.not.toHaveBeenCalled()` instead of
  asserting it was called; updated dedup test accordingly; added mock for
  `session-grade.js` to prevent real DB access

## Quality Gates

- `pnpm biome check` — passed on all 5 modified files
- `pnpm run build` — passed (Build complete)
- `pnpm run test` — 390 passed, 1 skipped, 0 new failures

## Verification

Remaining `observeBrain` calls in session-related paths that were NOT removed:
- `memory/session-memory.ts` — explicit user-triggered observations (not session hooks)
- `memory/brain-retrieval.ts` — the definition itself
- `cleo.ts` — the `observe` command entrypoint for `cleo memory observe`

The only `observeBrain` calls in session hook files that were removed are the
three duplicate writes targeted by this task.
