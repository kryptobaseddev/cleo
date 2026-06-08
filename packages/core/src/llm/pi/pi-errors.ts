/**
 * Pi error / exit containment (T11761 · S1 · T11897).
 *
 * The Pi agent loop runs **in-process** inside the Cleo daemon with ZERO
 * authority. Two library packages are in the safe import set
 * (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and both are
 * verified exit-clean, but the daemon MUST be protected from a process
 * termination originating from a Pi code path. This module is the containment
 * boundary: it converts a `process.exit()` call or a `process.exitCode` mutation
 * attempted while running Pi code into a typed {@link PiContainmentError} thrown
 * back to the caller.
 *
 * ## Containment scope (honest guarantee)
 *
 * The `process.exit` trap is process-global and REF-COUNTED across overlapping
 * {@link wrapPiCall} scopes, so it covers the synchronous body, every awaited
 * continuation, AND any deferred/detached exit (`setTimeout`, un-awaited
 * promise, microtask) that fires while ANY Pi call is still active. The ONLY
 * residual window is an exit fired AFTER the last active call has settled. To
 * close that too — a daemon-lifetime guarantee covering ANY present/future Pi
 * exit, synchronous or detached — the daemon calls {@link installDaemonExitGuard}
 * once at startup to PIN the trap for its whole lifetime.
 *
 * Scope discipline (S1): NO `pi-ai`/`pi-agent-core` imports, NO DB access, NO
 * LLM calls. Import-time side-effect free — the logger is resolved lazily
 * (never at module top level).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../../errors.js';
import { getLogger } from '../../logger.js';

/**
 * Stable string codes for the Pi-containment error surface.
 *
 * `CleoError` carries a NUMERIC {@link ExitCode}; these string codes are the
 * machine-readable discriminators a caller switches on, carried on
 * {@link PiContainmentError.piCode} (and mirrored into the LAFS error `details`
 * via `CleoErrorDetails`). They are NOT exit codes themselves.
 */
export type PiContainmentCode =
  /** Pi (or a transitive dep) called `process.exit()` while in-process. */
  | 'E_PI_PROCESS_EXIT_TRAPPED'
  /** Pi (or a transitive dep) mutated `process.exitCode` while in-process. */
  | 'E_PI_EXIT_CODE_MUTATION_TRAPPED'
  /** The wrapped Pi call was aborted via the supplied `AbortSignal`. */
  | 'E_PI_ABORTED'
  /** The wrapped Pi call threw an unexpected error. */
  | 'E_PI_LOOP_FAILED';

/**
 * Typed containment error for the Pi in-process embed.
 *
 * Extends {@link CleoError} so it flows through the existing LAFS error
 * projection (`toLAFSError`/`toProblemDetails`). It carries the Pi-specific
 * string {@link PiContainmentCode} on {@link piCode} (the numeric `ExitCode`
 * super-field is `INTERNAL`/`GENERAL_ERROR`-class — it is the daemon, not the
 * caller, that is being protected, so the failure is an internal one).
 */
export class PiContainmentError extends CleoError {
  /** Machine-readable Pi-containment discriminator. */
  readonly piCode: PiContainmentCode;

  /**
   * @param piCode - The Pi-containment discriminator.
   * @param message - Human-readable description.
   * @param options - Optional `cause` and the numeric `ExitCode` (defaults to
   *   {@link ExitCode.GENERAL_ERROR}).
   */
  constructor(
    piCode: PiContainmentCode,
    message: string,
    options?: { cause?: unknown; exitCode?: ExitCode },
  ) {
    super(options?.exitCode ?? ExitCode.GENERAL_ERROR, message, {
      cause: options?.cause,
      details: { field: 'pi', piCode },
    });
    this.name = 'PiContainmentError';
    this.piCode = piCode;
  }
}

/**
 * Type guard for {@link PiContainmentError} (cross-realm-safe via `piCode`).
 *
 * @param err - The value to test.
 * @returns `true` when `err` is a {@link PiContainmentError}.
 */
export function isPiContainmentError(err: unknown): err is PiContainmentError {
  return err instanceof PiContainmentError;
}

/**
 * Convert an arbitrary thrown value into a {@link PiContainmentError}.
 *
 * A value that is ALREADY a {@link PiContainmentError} passes through unchanged
 * (so an exit-trap error is not re-wrapped as a generic loop failure). Anything
 * else becomes an `E_PI_LOOP_FAILED` carrying the original as `cause`.
 *
 * @param err - The thrown value.
 * @returns A typed {@link PiContainmentError}.
 */
export function wrapPiError(err: unknown): PiContainmentError {
  if (isPiContainmentError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PiContainmentError('E_PI_LOOP_FAILED', `Pi loop failed: ${message}`, { cause: err });
}

/**
 * The scoped process-exit guard for the duration of one wrapped Pi call.
 *
 * The `process.exit` TRAP itself is NOT per-call: it is installed
 * process-globally and REF-COUNTED across overlapping {@link wrapPiCall} scopes
 * (see {@link acquireExitTrap}/{@link releaseExitTrap}). This closes the async
 * leak window — while ANY Pi call is active the trap stays installed, so a
 * DEFERRED or DETACHED `process.exit()` (a `setTimeout`, an un-awaited promise,
 * a microtask outliving the await) fired during the active window is still
 * neutralized, not run against the real exit.
 *
 * Only {@link checkExitCode} is per-scope: it snapshots `process.exitCode` at
 * acquire and is invoked SYNCHRONOUSLY the instant `fn` settles, while a mutated
 * value is still observable.
 */
interface ProcessExitGuard {
  /**
   * Detect + neutralize a `process.exitCode` mutation. Compares the live value
   * against this scope's acquire-time snapshot; on a difference, writes the
   * snapshot back via the native setter (so the daemon's eventual exit is
   * unaffected) and returns the offending value. Idempotent — a second call
   * returns `undefined`.
   */
  checkExitCode(): { mutatedExitCode: typeof process.exitCode } | undefined;
  /** Release this scope's hold on the ref-counted trap. MUST run exactly once in a `finally`. */
  release(): void;
}

/**
 * The original `process.exit`, captured at the FIRST trap install and restored
 * only when the ref-count returns to zero. `null` while no trap is installed.
 */
let originalProcessExit: typeof process.exit | null = null;

/** Number of live {@link wrapPiCall} scopes currently holding the exit trap. */
let exitTrapRefCount = 0;

/** Whether the daemon has pinned the trap for its whole lifetime (never released). */
let daemonExitTrapPinned = false;

/** The trapped `process.exit` — throws instead of terminating. Built once, reused. */
const trappedExit = ((code?: number): never => {
  throw new PiContainmentError(
    'E_PI_PROCESS_EXIT_TRAPPED',
    `Pi attempted process.exit(${code ?? ''}) in-process; daemon-fatal exit neutralized`,
  );
}) as typeof process.exit;

/**
 * Install the process-global `process.exit` trap if it is not already installed.
 * Idempotent — overlapping callers share ONE trap.
 */
function ensureExitTrapInstalled(): void {
  if (originalProcessExit === null) {
    originalProcessExit = process.exit;
    process.exit = trappedExit;
  }
}

/**
 * Restore the real `process.exit` when (and only when) no scope holds the trap
 * and the daemon has not pinned it. A no-op otherwise.
 */
function maybeRestoreExitTrap(): void {
  if (exitTrapRefCount === 0 && !daemonExitTrapPinned && originalProcessExit !== null) {
    process.exit = originalProcessExit;
    originalProcessExit = null;
  }
}

/**
 * Pin the `process.exit` trap for the ENTIRE daemon lifetime.
 *
 * This is the durable, complete fix for the async-exit leak: once pinned, the
 * trap is NEVER restored, so a `process.exit()` originating from ANY Pi code path
 * — synchronous, awaited, deferred (`setTimeout`), detached (fire-and-forget),
 * present or future — is neutralized for as long as the daemon runs. Call this
 * once at daemon startup BEFORE any Pi-touching work is dispatched.
 *
 * Idempotent. The returned function un-pins (e.g. for a graceful shutdown that
 * legitimately needs to exit); after un-pinning, the trap is restored when no
 * {@link wrapPiCall} scope is active.
 *
 * @returns A function that un-pins the daemon-lifetime trap.
 *
 * @example
 * ```ts
 * // daemon bootstrap, before serving requests:
 * const unpin = installDaemonExitGuard();
 * // ... daemon runs; all Pi exits are trapped for the whole lifetime ...
 * unpin(); // only if a controlled shutdown must reach the real process.exit
 * ```
 */
export function installDaemonExitGuard(): () => void {
  daemonExitTrapPinned = true;
  ensureExitTrapInstalled();
  return () => {
    daemonExitTrapPinned = false;
    maybeRestoreExitTrap();
  };
}

/**
 * Acquire the ref-counted process-exit guard for one wrapped Pi call.
 *
 * Increments the global ref-count and installs the shared `process.exit` trap on
 * the 0→1 transition; snapshots `process.exitCode` for this scope. The trap is
 * released (and, at the last release, restored — unless daemon-pinned) via
 * {@link ProcessExitGuard.release}.
 *
 * `process.exitCode` is, on modern Node, a NON-CONFIGURABLE native accessor — it
 * cannot be redefined to intercept writes. It IS writable via its native setter,
 * so the guard uses **snapshot + synchronous detect-and-restore**
 * ({@link ProcessExitGuard.checkExitCode}).
 *
 * Re-entrant-safe: overlapping calls share the single installed trap; each holds
 * its own `exitCode` snapshot and `release` is an idempotent decrement.
 *
 * @returns A scoped guard handle.
 */
function acquireExitTrap(): ProcessExitGuard {
  // Snapshot the value (NOT the descriptor — the property is non-configurable on
  // modern Node, so we never redefine it; we compare-and-write via its setter).
  const snapshotExitCode: typeof process.exitCode = process.exitCode;
  let exitCodeChecked = false;
  let released = false;

  exitTrapRefCount += 1;
  ensureExitTrapInstalled();

  return {
    checkExitCode(): { mutatedExitCode: typeof process.exitCode } | undefined {
      if (exitCodeChecked) return undefined;
      exitCodeChecked = true;
      const current = process.exitCode;
      if (current !== snapshotExitCode) {
        process.exitCode = snapshotExitCode;
        return { mutatedExitCode: current };
      }
      return undefined;
    },
    release(): void {
      if (released) return;
      released = true;
      exitTrapRefCount -= 1;
      maybeRestoreExitTrap();
    },
  };
}

/**
 * Run a Pi-touching async function under process-exit containment + abort
 * routing.
 *
 * Behaviour:
 * - Acquires the REF-COUNTED, process-global {@link acquireExitTrap} for the
 *   duration of `fn` and releases it in a `finally`. A `process.exit()` call —
 *   synchronous, awaited, OR deferred/detached but firing while ANY Pi call is
 *   still active — becomes a thrown {@link PiContainmentError} (the daemon
 *   survives). A `process.exitCode` mutation is detected-and-restored the instant
 *   `fn` settles, then surfaced as a thrown `E_PI_EXIT_CODE_MUTATION_TRAPPED`.
 *   For a guarantee that spans even an exit fired AFTER the last call settles,
 *   the daemon should additionally pin the trap once at startup via
 *   {@link installDaemonExitGuard}.
 * - If `signal` is already aborted, rejects with `E_PI_ABORTED` WITHOUT invoking
 *   `fn`. Otherwise the signal is propagated to `fn` (the caller threads it into
 *   Pi's agent loop); an abort that surfaces as a thrown `AbortError`/`DOMException`
 *   is normalized to `E_PI_ABORTED`.
 * - Any other thrown value is normalized via {@link wrapPiError}.
 *
 * @typeParam T - The resolved value type of the wrapped call.
 * @param fn - The Pi-touching async function. Receives the (live) `AbortSignal`
 *   so it can thread cancellation into the agent loop.
 * @param signal - Optional cancellation signal.
 * @returns The resolved value of `fn`.
 * @throws {PiContainmentError} On exit-trap, abort, or any failure from `fn`.
 *
 * @example
 * ```ts
 * const result = await wrapPiCall(async (sig) => runAgentLoop(prompts, ctx, cfg, emit, sig), signal);
 * ```
 */
export async function wrapPiCall<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new PiContainmentError('E_PI_ABORTED', 'Pi call aborted before start');
  }

  // A local controller is always passed to `fn` so cancellation has a single
  // shape; when an external signal is supplied we mirror its abort into ours.
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(signal?.reason);
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  const guard = acquireExitTrap();
  try {
    const value = await fn(controller.signal);
    // Detect a quiet `process.exitCode` mutation SYNCHRONOUSLY here — the instant
    // `fn` settled — while the value is still observable. If Pi set it, the value
    // is restored and a typed error replaces the clean return.
    const mutation = guard.checkExitCode();
    if (mutation !== undefined) {
      throw new PiContainmentError(
        'E_PI_EXIT_CODE_MUTATION_TRAPPED',
        `Pi set process.exitCode=${String(mutation.mutatedExitCode)} in-process; neutralized`,
      );
    }
    return value;
  } catch (err) {
    // A mutation can also accompany a thrown failure — neutralize the leak even
    // though the thrown error (below) is the primary signal.
    guard.checkExitCode();
    if (err instanceof PiContainmentError) throw err;
    if (isAbortError(err) || controller.signal.aborted) {
      throw new PiContainmentError('E_PI_ABORTED', 'Pi call aborted', { cause: err });
    }
    throw wrapPiError(err);
  } finally {
    guard.release();
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    // Lazy logger — never resolved at import time (S1 import-side-effect rule).
    getLogger('pi-errors').debug({ aborted: controller.signal.aborted }, 'pi call boundary closed');
  }
}

/**
 * Whether a thrown value represents an abort (a `DOMException`/`Error` whose
 * `name` is `AbortError`).
 *
 * @param err - The thrown value.
 * @returns `true` when `err` is an abort error.
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}
