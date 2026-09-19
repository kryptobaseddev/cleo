/**
 * teardown-signal.ts — one process-wide "we are shutting down" fact, and a
 * registry of AbortControllers that should be cancelled when it becomes true.
 *
 * ## Why this exists
 *
 * `shutdownCliRuntime()` closes the writer, the leases and the databases, but
 * it cannot reach work that is already in flight in ANOTHER module holding its
 * own socket or timer. The concrete case is the dialectic hook in
 * `packages/runtime/src/gateway/dispatcher.ts`: it fires via `setImmediate`
 * after the response is returned, bounds its LLM call with an AbortController
 * on a 10-second deadline, and that call holds a `TCPSocketWrap`.
 *
 * The exit backstop is 3 seconds (`EXIT_BACKSTOP_MS`). So a dialectic still in
 * flight at teardown keeps the event loop alive for up to seven seconds PAST
 * the point where the backstop has already printed "event loop still alive
 * 3000ms after teardown" — which is the message users see on `add-batch`,
 * `verify`, `complete` and `relates add` (gh#1466). Shortening the dialectic
 * deadline would be the wrong fix: the deadline is correct for a dialectic that
 * is supposed to run. What is missing is a way to say "stop, we are leaving".
 *
 * ## Scope: deliberately three functions
 *
 * This module is the ONE idea kept from the abandoned
 * `wip/T12217-teardown-drain-and-suppression` branch (see tag
 * `tombstone/T12217`). That branch also carried `trackBackgroundWork` /
 * `drainBackgroundWork`, which are NOT reproduced here and should not be
 * revived by copy-paste: they guarded work-START sites, an open set that grows
 * with every new fire-and-forget caller, and measurement showed the suppression
 * they implemented was inert on the very command it was written for.
 *
 * A signal that in-flight work can VOLUNTARILY observe is a different thing
 * from a registry that tries to enumerate all of it. Only the first terminates.
 *
 * @task T12239
 * @epic T12114
 */

let _shuttingDown = false;

/** Controllers to abort when teardown begins. Held weakly by convention: every
 *  registrant deregisters in its own `finally`. */
const _controllers = new Set<AbortController>();

/**
 * Whether process teardown has begun.
 *
 * Callers doing optional background work should check this before STARTING
 * something new, and register their AbortController via
 * {@link registerTeardownAbort} for work already running.
 *
 * @returns `true` once {@link markShuttingDown} has been called.
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Declare that teardown has begun and abort everything registered.
 *
 * Idempotent. Called as the FIRST step of `shutdownCliRuntime()` — before the
 * writer, leases and databases are closed — so in-flight work is cancelled
 * while those resources are still valid rather than after they are gone.
 */
export function markShuttingDown(): void {
  if (_shuttingDown) return;
  _shuttingDown = true;
  for (const c of _controllers) {
    try {
      c.abort(new Error('E_TEARDOWN: process is shutting down'));
    } catch {
      // An already-aborted or detached controller is not a teardown failure.
    }
  }
  _controllers.clear();
}

/**
 * Register an AbortController to be cancelled at teardown.
 *
 * If teardown has ALREADY begun the controller is aborted immediately, which
 * closes the race where work starts between `markShuttingDown()` and this call.
 *
 * @param controller - The controller bounding some in-flight background work.
 * @returns A deregistration function; call it in a `finally` so a completed
 *   operation does not leave its controller retained for the process lifetime.
 */
export function registerTeardownAbort(controller: AbortController): () => void {
  if (_shuttingDown) {
    try {
      controller.abort(new Error('E_TEARDOWN: process is shutting down'));
    } catch {
      /* see markShuttingDown */
    }
    return () => undefined;
  }
  _controllers.add(controller);
  return () => {
    _controllers.delete(controller);
  };
}

/**
 * Test helper — clear the latch and the registry.
 * @internal
 */
export function _resetTeardownSignalForTests(): void {
  _shuttingDown = false;
  _controllers.clear();
}
