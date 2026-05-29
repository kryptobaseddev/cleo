/**
 * Lifecycle-bound registry for fire-and-forget best-effort DB writes (T10490).
 *
 * Task mutators (`addTask`, `completeTask`) kick off best-effort graph/LOOM
 * population that must NOT block or fail the mutation. Historically these were
 * orphaned `import().then().catch()` promises with no handle. Under the vitest
 * `forks` pool that creates two failure modes:
 *
 *   1. **Cross-test DB races (intermittent shard failures).** A detached op
 *      from test/file A can still be in flight when test/file B has already
 *      created a fresh fixture and reset the shared SQLite singleton
 *      (`store/sqlite.ts` `_db`/`_nativeDb`). The late write/read then lands on
 *      B's connection, corrupting B's reads — e.g. a freshly-written
 *      `pipeline_stage` reading back as null, which silently flips a
 *      forward-only transition guard.
 *   2. **`EnvironmentTeardownError: Closing rpc while onUserConsoleLog was
 *      pending`.** A detached op logging as the worker tears down races the
 *      RPC close. (The structured-logger sweep, T10490 §3.3, addresses the
 *      logging half; this registry addresses the lifetime half.)
 *
 * Registering each op here lets the test harness (and any caller that needs a
 * barrier) drain them via {@link awaitBackgroundOps} before resetting DB state.
 *
 * **Production behaviour is unchanged**: ops still run detached and nobody
 * awaits them on the hot path. The registry only adds an opt-in flush point.
 *
 * @task T10490
 * @see packages/core/src/store/__tests__/test-db-helper.ts (flush wiring)
 */

/** Promises for best-effort background work that has not yet settled. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Register a best-effort background promise so a later {@link awaitBackgroundOps}
 * can flush it. The promise is wrapped so a rejection never escapes the
 * registry (callers keep their own `.catch`); the wrapper removes itself from
 * the set once settled.
 *
 * @param op - the detached best-effort promise to track
 */
export function trackBackgroundOp(op: Promise<unknown>): void {
  const tracked = Promise.resolve(op).catch(() => {
    /* Best-effort — the caller owns error handling; never reject the registry. */
  });
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
}

/**
 * Await every currently in-flight background op, then return. Safe to call
 * repeatedly and when nothing is pending. Loops until the set drains so an op
 * that schedules further tracked work during the flush is also awaited.
 */
export async function awaitBackgroundOps(): Promise<void> {
  // Bound the drain so a pathological self-rescheduling op cannot spin forever.
  for (let i = 0; i < 100 && inFlight.size > 0; i++) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

/**
 * Number of background ops currently in flight. Diagnostic/test use — assert it
 * is `0` after a flush to prove no detached promise survives a test boundary.
 */
export function pendingBackgroundOpCount(): number {
  return inFlight.size;
}
