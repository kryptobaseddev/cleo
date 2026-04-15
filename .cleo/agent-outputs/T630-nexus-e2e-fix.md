# T630 — nexus-e2e.test.ts 71-Failure Regression Fix Report

**Task**: T630 — BUG: v2026.4.52 CI regression — nexus-e2e.test.ts 71 failures
**Date**: 2026-04-15
**Status**: COMPLETE (regression already resolved; verification confirmed)

## Root Cause

**vi.mock pollution in paths.js across 20 test files.**

Starting at v2026.4.52, tests in the same vitest shard as nexus-e2e.test.ts were
using synchronous `vi.mock` factory functions that replaced the entire `paths.js`
module with a stub exposing only one or two exports (e.g. `getProjectRoot`).

When vitest's module cache served this incomplete mock to nexus tests, the
functions `getCleoHome`, `getNexusDbPath`, and `getCleoDirAbsolute` all returned
`undefined`. The `nexusInit` / `getNexusDb` path construction then pointed at
`undefined/nexus.db`, causing every database operation in nexus-e2e.test.ts to
fail with either a path error or a missing table error — producing 71+ failures
in a single pass depending on shard assignment.

## Failure Timeline

| Release    | Status |
|------------|--------|
| v2026.4.51 | Green  |
| v2026.4.52 | RED — introduced via T626 STDP session changes (brain-schema.ts, brain-retrieval.ts) which shifted shard assignments, causing polluted mock to co-locate with nexus tests |
| v2026.4.53 | RED    |
| v2026.4.54 | RED (typecheck fix only) |
| v2026.4.55 | RED (partial: 6 of 26 mock sites fixed in paths.js) |
| v2026.4.56 | RED (partial fix shipped) |
| v2026.4.57 | GREEN — commit 427eccf0 fixed remaining 20 of 26 vi.mock paths.js sites |
| v2026.4.58 | GREEN (current HEAD) |

## Fix Applied

Commit `427eccf0` (released in v2026.4.57) addressed all remaining polluted mock
sites using the canonical async `vi.importActual` spread pattern:

```ts
vi.mock('…/paths.js', async () => {
  const actual = await vi.importActual<typeof import('…/paths.js')>('…/paths.js');
  return { ...actual, /* targeted overrides */ };
});
```

This preserves all real exports while allowing specific functions to be overridden,
preventing the incomplete stub from poisoning the module cache for other tests.

## Verification (current HEAD = v2026.4.60)

- nexus-e2e.test.ts: **89/89 passed** (0 failures)
- packages/core full suite: **3910 passed | 32 todo** (246 test files)
- Build: SUCCESS
- No new failures introduced

## Before / After

| Metric           | Before (v2026.4.52-56 CI) | After (v2026.4.57+) |
|------------------|---------------------------|----------------------|
| nexus-e2e fails  | 71                        | 0                    |
| Total CI status  | RED                       | GREEN                |

## Recurrence Prevention

Commit 427eccf0 included `edge-type-enum-coverage.test.ts` (14 tests) as part of
the T645 sub-task, preventing edge-type schema drift. The correct vi.mock pattern
is now documented in the codebase via the 20 fixed sites as a living standard.

If any future test introduces a new `vi.mock('…/paths.js', () => ({...}))` with a
synchronous factory, biome's ESLint-compatible plugin can be configured to flag
partial mocks — file a follow-up task to add that lint rule if desired.
