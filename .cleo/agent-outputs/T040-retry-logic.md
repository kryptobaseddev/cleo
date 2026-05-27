# T040 — Retry Logic with Exponential Backoff

**Epic:** T038 (Documentation-Implementation Drift Remediation)
**Status:** complete
**Date:** 2026-03-22

## Summary

Implemented a general-purpose, dependency-free retry utility at `packages/core/src/lib/retry.ts`. This is distinct from the agent-specific retry in `agents/retry.ts` which is coupled to the DB registry layer.

## Files Created

- `packages/core/src/lib/retry.ts` — shared retry primitive
- `packages/core/src/lib/index.ts` — barrel for the new `lib/` namespace
- `packages/core/src/lib/__tests__/retry.test.ts` — 16 tests, all passing

## Files Modified

- `packages/core/src/index.ts` — added `export * as lib from './lib/index.js'`
- `packages/core/src/internal.ts` — added flat exports (`computeDelay`, `withRetry as withRetryShared`, type exports)

## Implementation Details

### API

```ts
withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>
```

- Default: 3 attempts, 2000 ms / 4000 ms inter-attempt delays
- On final failure: throws last error augmented with `{ attempts, totalDelayMs }`
- `retryableErrors`: optional `(RegExp | predicate)[]` filter — all errors retried when omitted
- `computeDelay(attempt, baseDelayMs, maxDelayMs)` exported for composability

### Default Delay Schedule

| Between attempts | Delay |
|------------------|-------|
| 1 → 2 | 2 000 ms |
| 2 → 3 | 4 000 ms |

### Design Decisions

- No imports from `agents/registry.ts` — fully standalone
- Throw semantics (not `RetryResult`) — simpler call sites, no `if (!result.success)` boilerplate
- `RetryContext` fields attached to the Error object for post-catch introspection
- `computeDelay` exported so callers can preview delays without invoking retry

## Test Results

274 test files, 4821 tests — all passing. Zero regressions.

## Quality Gates

- [x] `pnpm biome check --write packages/core/src/lib/` — passed (2 files fixed formatting)
- [x] `pnpm run test` — 274/274 files, 4821/4821 tests
- [x] `tsc --noEmit` on lib/ — zero errors
- Note: pre-existing build errors in `health-monitor.ts` and `intelligence/impact.ts` exist in baseline (verified by stash/restore)
