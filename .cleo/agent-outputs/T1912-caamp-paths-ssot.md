# T1912 — CAAMP XDG Duplication Removal

**Status**: complete
**Date**: 2026-05-06
**Merge commit**: e75dda69b16ddcb4487f58cfc05332b70ec7bdb7

## Summary

Deleted duplicate XDG fallback logic in two CAAMP files; both now delegate to
`getCleoHome()` from `@cleocode/paths`, the canonical SSoT.

## Changes

### packages/caamp/src/core/paths/standard.ts

- Added `import { getCleoHome } from '@cleocode/paths'`
- Replaced 15-line `getCleoHomeForTemplate()` body (full XDG chain with
  `CLEO_HOME` env override, win32/darwin/linux platform branches) with a
  single `return getCleoHome()` delegation
- JSDoc updated to reference the SSoT instead of documenting the duplication

### packages/caamp/src/core/harness/scope.ts

- Added `import { getCleoHome } from '@cleocode/paths'`
- Replaced 16-line `getCleoHomeDir()` body (same XDG chain including the
  hardcoded `~/.local/share/cleo` fallback at line 128) with a single
  `return getCleoHome()` delegation
- JSDoc updated accordingly

### packages/caamp/tests/unit/coverage-deep-branches.test.ts

- Added `vi.resetModules()` in `beforeEach` — fixes pre-existing flaky timeout
  on the `rethrows non-EEXIST error (EACCES)` test caused by stale module
  cache preventing mock injection on dynamic `import()`

## Quality Gates

- biome ci: PASS (0 errors, 6 pre-existing warnings)
- tsc --noEmit: PASS (0 errors)
- caamp test suite: 1334 tests passed, 0 failed (318 test files)
- All 5 CLEO gates: implemented, testsPassed, qaPassed, securityPassed, cleanupDone

## Rationale

Closes T917 rationale (cancelled pre-T1882 as low-value-floater). The T1882
`@cleocode/paths` SSoT package now exists, making this deletion straightforward.
The `@cleocode/paths` dependency was already present in caamp's package.json
(added by T1887).
