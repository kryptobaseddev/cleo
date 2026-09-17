/**
 * A registry of in-flight fire-and-forget background work, so teardown can
 * DRAIN it briefly instead of the exit backstop killing it blind (gh#1448).
 *
 * ## What this exists for
 *
 * Several session-lifecycle events start best-effort work and deliberately do
 * not await it — `sessions/index.ts` on session start and end, and
 * `sessions/handoff.ts` on handoff, each labelled "Fire-and-forget" (T11639).
 * That is a CORRECT requirement: a session-manifest mirror failure must never
 * block session start, and session start must never wait on the two `git`
 * spawns the mirror performs to resolve a canonical project id.
 *
 * The cost was that nothing awaited them either. Measured on `cleo memory
 * observe`: the loop was held open at teardown by unreaped child processes —
 * `[git] <defunct>`, i.e. exited but never reaped — running
 * `git rev-parse --show-toplevel` and `git remote get-url origin`. The holder
 * tally scaled cleanly at three pipes per child (`PipeWrap×7` with
 * `ProcessWrap×2`, `PipeWrap×10` with `ProcessWrap×3`) and VARIED run to run,
 * because what is still outstanding depends on how far each floating chain got
 * before the process tried to exit.
 *
 * ## What it deliberately does NOT do
 *
 * It does not sequence anything. {@link trackBackgroundWork} returns `void`,
 * never awaits, and never lets a rejection escape — registering a promise
 * cannot change the callsite's timing or its error behaviour, which is the
 * whole point. The registry OBSERVES; the callsite keeps its own `.catch()`.
 *
 * It also does not promise completion. {@link drainBackgroundWork} is run as an
 * ordinary teardown step, so it inherits the existing per-step deadline rather
 * than introducing a new bound, and the exit backstop still fires if the drain
 * is insufficient. This moves the work from "abandoned silently" to "awaited
 * briefly, then abandoned loudly" — which is what the backstop's own message
 * ("any unawaited background work was abandoned") has always claimed.
 *
 * @task T12217 (gh#1448)
 */

/**
 * Promises for background work that has started and not yet settled.
 *
 * A `Set` rather than an array so a settled entry is removed in O(1) and a
 * long-running process cannot accumulate a list of already-finished work.
 */
const inFlight = new Set<Promise<unknown>>();

/**
 * Register a fire-and-forget promise so teardown can wait on it briefly.
 *
 * Call this AT the callsite that starts the work, passing the promise it
 * already has. Do not `await` the result — there is none.
 *
 * @param work - the already-started promise. Its rejection is absorbed here in
 *   addition to whatever the callsite does, so registration is safe even for a
 *   chain with no `.catch()` of its own.
 *
 * @example
 * ```ts
 * trackBackgroundWork(
 *   import('./session-manifest-mirror.js')
 *     .then(({ mirror }) => mirror(root, session))
 *     .catch(() => {}),
 * );
 * ```
 *
 * @task T12217 (gh#1448)
 */
export function trackBackgroundWork(work: Promise<unknown>): void {
  // Absorb rejection on a DERIVED promise. Attaching the handler to `work`
  // itself would be observable by a caller that later adds its own handler
  // expecting to be the first; deriving keeps registration invisible.
  const tracked = work.then(
    () => undefined,
    () => undefined,
  );
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
}

/**
 * Set once teardown has begun. Guards the START of new background work.
 *
 * DISTINCT from `CLEO_DISABLE_PROJECT_AUTOREGISTER`, which must not be reused
 * for this. That env var means **"never register in this process"** and exists
 * so a unit test exercising the registration contract is not pre-empted — its
 * own comment says "Off by default — production always auto-registers on
 * encounter". This flag means **"stop registering, from now on"**. The two
 * predicates share an effect today and are not the same thing; collapsing them
 * is how the next reader mistakes a shutdown guard for a test hook and deletes
 * it.
 */
let shuttingDown = false;

/**
 * Declare that teardown has begun, so no NEW background work is started.
 *
 * Called by the shutdown sequence on entry. Idempotent.
 *
 * ## Why suppression rather than draining harder
 *
 * Measured: teardown itself starts new work. Each `shutdownCliRuntime` step
 * resolves paths, every resolution re-enters `registerProjectOnEncounter`, and
 * that spawns `git rev-parse --show-toplevel` + `git remote get-url origin`.
 * A timestamped trace of one `cleo memory observe` showed three bursts of async
 * git spawns, the second exactly 3000 ms (`EXIT_BACKSTOP_MS`) after the first —
 * i.e. created DURING teardown, after any drain had already snapshotted.
 *
 * Draining cannot fix that by reordering. Drain-first misses everything the
 * later steps start; drain-last catches those but they fail against databases
 * step 3 has already closed, and `closeLogger` can start more after it. Making
 * ordering work would require draining repeatedly until quiescent, which has no
 * termination proof: any step that resolves a path re-enters the registration.
 *
 * Suppression terminates by construction — it removes the source instead of
 * chasing the output. It composes with {@link drainBackgroundWork} rather than
 * replacing it: suppression stops new work, the drain finishes work already
 * outstanding from the command itself.
 *
 * @task T12217 (gh#1448)
 */
export function markShuttingDown(): void {
  shuttingDown = true;
}

/**
 * Is teardown underway? Callers that start best-effort background work should
 * skip it when this is `true`.
 *
 * @returns `true` once {@link markShuttingDown} has been called.
 * @task T12217 (gh#1448)
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * How many registered items have not settled. Diagnostics and tests only.
 *
 * @returns count of in-flight background promises.
 * @task T12217 (gh#1448)
 */
export function backgroundWorkCount(): number {
  return inFlight.size;
}

/**
 * Wait for every currently-registered background promise to settle.
 *
 * Unbounded BY DESIGN: the bound belongs to the teardown step that calls this,
 * so the deadline stays in one place instead of being duplicated here and
 * drifting from it. Work registered *after* the drain begins is not waited on —
 * draining is a snapshot, not a barrier, and a barrier could never terminate
 * against work that schedules more work.
 *
 * @returns the number of promises awaited.
 * @task T12217 (gh#1448)
 */
export async function drainBackgroundWork(): Promise<number> {
  const snapshot = [...inFlight];
  if (snapshot.length === 0) return 0;
  await Promise.allSettled(snapshot);
  return snapshot.length;
}

/**
 * Drop every registration without waiting. Test-only.
 *
 * @internal
 */
export function _resetBackgroundWork(): void {
  inFlight.clear();
  shuttingDown = false;
}
