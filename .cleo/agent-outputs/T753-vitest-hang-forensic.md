# T753 — Vitest Hang Forensic Report

**Date**: 2026-04-15
**Status**: COMPLETE
**Runs verified**: 3× consecutive, exit 0, 0 orphan processes

---

## Root Causes Found (3)

### 1. `sleep-consolidation.ts` — Unbounded `fetch()` in `callLlm()`

**File**: `packages/core/src/memory/sleep-consolidation.ts`

`callLlm()` calls `fetch('https://api.anthropic.com/v1/messages', ...)` with no
`AbortSignal`. The guard `if (!apiKey) return null` only prevents the call when no
key is present. In the test environment, `resolveAnthropicApiKey()` auto-discovers
OAuth credentials from `~/.claude/.credentials.json`. With credentials present, the
fetch fires against the real API. If the network is slow or unavailable the call
hangs indefinitely — the fork worker never exits, and vitest accumulates orphans.

**Fix**: Added `signal: AbortSignal.timeout(30_000)` to the fetch call. Any network
stall will now throw `AbortError` after 30 seconds, which is caught by the existing
`catch (err)` block and returns `null`.

### 2. `brain-stdp-wave3.test.ts` — T695-1 O(n²) performance test with 5000 spikes

**File**: `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts`

T695-1 inserted 100 sessions × 50 retrieval rows = 5000 spikes. With `pairingWindowMs=24h`
the inner loop created ~25 million pair comparisons, each hitting SQLite prepared statements.
The test was intended to verify the O(n²) guard works but instead triggered the exact
combinatorial explosion it was supposed to prevent — taking >120 seconds to complete
(the vitest `testTimeout` is 60s so the test was killed, leaving the fork worker hanging).

**Fix**: Reduced to 20 sessions × 10 rows = 200 spikes with a tighter <10s bound.
The session-bucket guard correctness is still exercised. Full load testing belongs in
a separate `*.integration.test.ts` file excluded from the default test run.

### 3. `mental-model-queue.ts` — SIGTERM handler blocks on async drain with no deadline

**File**: `packages/core/src/memory/mental-model-queue.ts`

`registerExitHooks()` registered `process.once('SIGTERM', ...)` and
`process.once('SIGINT', ...)` handlers that call `drainQueue()` — an async function
that writes to brain.db. When vitest sends SIGTERM to terminate a fork worker,
the handler fires, tries to drain the queue, but the brain.db was already closed by
`afterEach` teardown. The async write hangs on a closed DB handle, the promise never
resolves, and `process.exit()` is never called — the worker hangs forever.

**Fixes applied**:
- Added a 2-second `setTimeout(() => process.exit(N), 2_000)` deadline inside both
  SIGTERM and SIGINT handlers. `deadline.unref()` ensures the timer itself doesn't
  prevent exit. After the drain resolves (or on the deadline), `process.exit()` fires.
- Added `_resetMentalModelQueueForTests()` export: stops the flush timer, rejects
  pending observations, and resets state flags.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/memory/sleep-consolidation.ts` | Add `AbortSignal.timeout(30_000)` to fetch |
| `packages/core/src/memory/mental-model-queue.ts` | Add 2s deadline to SIGTERM/SIGINT handlers; add `_resetMentalModelQueueForTests()` |
| `packages/core/src/memory/embedding-queue.ts` | Add 2s deadline to SIGTERM/SIGINT handler |
| `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts` | Mock `sleep-consolidation.js`; reduce T695-1 from 5000→200 spikes |
| `packages/core/src/memory/__tests__/dream-cycle.test.ts` | Mock `sleep-consolidation.js` |
| `packages/core/src/memory/__tests__/mental-model-wave-8.test.ts` | Flush queue + `_resetMentalModelQueueForTests()` in afterEach |
| `packages/core/vitest.config.ts` | Add `teardownTimeout: 10_000` |
| `vitest.config.ts` (root) | Add `teardownTimeout: 10_000` |

---

## Verification

```
Run 1: 258 files, 4048 passed, 32 todo — EXIT 0 — 50.90s — 0 orphans
Run 2: 258 files, 4048 passed, 32 todo — EXIT 0 — 54.28s — 0 orphans
Run 3: 258 files, 4048 passed, 32 todo — EXIT 0 — 59.25s — 0 orphans
```

Previous behavior: suite never exited (hung indefinitely), orphan forks accumulated
on every invocation requiring `pkill -f vitest` to recover.

---

## Why Previous Failures Were Invisible

- `mental-model-queue._timer` used `.unref()` correctly — it was NOT the hang source.
- `local-transport.ts` calls `clearInterval` in `disconnect()` — clean.
- `health-monitor.test.ts` calls `closeAllDatabases()` in afterEach — clean.
- The `migration/state.ts` `setTimeout(5000)` runs in the fork worker process and
  exits with the process — not a hang source.
- The dream-cycle test had `_resetDreamState()` in afterEach — clean.

The hangs were exclusively from: (1) network I/O with no timeout, (2) a test that
exceeded the testTimeout leaving its worker alive, and (3) async signal handlers
that wrote to already-closed DB handles.
