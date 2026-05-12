# T993 — Check A0 Title-Prefix Blocklist in verifyCandidate

**Status**: complete
**Date**: 2026-04-20
**Session**: ses_20260419003330_22e46b
**Commit**: 738d4bd1adbea2a9ee45f12ba51ab652320f529e

## What was done

Added Check A0 (title-prefix blocklist) as the first guard in `verifyCandidate` inside
`packages/core/src/memory/extraction-gate.ts`. This rejects known-noise memory candidates
before any hash-dedup DB calls or cosine-similarity embedding work runs.

## Changes

### packages/core/src/memory/extraction-gate.ts

- Exported `BRAIN_NOISE_PREFIXES: readonly string[]` const with 7 entries:
  `Task start:`, `Session note:`, `Started work on:`, `Fix evidence:`,
  `Verified:`, `Completed:`, `Auto-generated:`
- Added Check A0 as first block inside `verifyCandidate` try block — returns
  `{ action: 'rejected', id: null, reason: 'noise-prefix' }` immediately when
  `candidate.title` starts with any listed prefix
- Updated JSDoc on `verifyCandidate` to list A0 before A, B, C

### packages/core/src/memory/__tests__/dedup-gates.test.ts

Added describe block `T993 — Check A0 title-prefix blocklist in verifyCandidate` with 8 tests:
1. Rejects `Task start: T123`
2. Rejects `Session note: handoff summary`
3. Rejects `Started work on: new feature`
4. Rejects `Fix evidence: commit abc123`
5. Rejects `Verified: T993 gates passed`
6. Passes `Hebbian plasticity insight` (legitimate title — not rejected)
7. Passes `Decision: SQLite over Y.js` (legitimate title — not rejected)
8. `BRAIN_NOISE_PREFIXES` exported with at least 7 entries

## Test results

- 30 tests pass in dedup-gates.test.ts (22 pre-existing + 8 new T993 tests)
- 0 failures in T993-scoped tests

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:738d4bd1a + files |
| testsPassed | PASS | test-run:/tmp/T993-vitest-out.json (30 pass, 0 fail) |
| qaPassed | PASS (owner override) | pnpm biome ci packages/core/src/memory/ exits 0; tsc exits 0; repo-wide biome fails on pre-existing studio Svelte5 issues outside T993 scope |

## Notes

- `brain-purge.ts` was NOT modified — it still defines its own prefix rules inline.
  The worker spec says this cleanup is optional/follow-on; noted in code comment.
- The Svelte5 `$state is not defined` test failures and `cleo memory dream` failures
  are pre-existing issues unrelated to T993.
