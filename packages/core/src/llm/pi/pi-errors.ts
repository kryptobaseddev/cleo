/**
 * Pi error / exit containment (T11761 · S1 · T11897).
 *
 * The Pi agent loop runs **in-process** inside the Cleo daemon with ZERO
 * authority. Two library packages are in the safe import set
 * (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and both are
 * verified exit-clean, but the daemon MUST be structurally immune to a process
 * termination originating from ANY Pi code path — present or future. This module
 * is the containment boundary: it converts a `process.exit()` call or a
 * `process.exitCode` mutation attempted while running Pi code into a typed
 * {@link PiContainmentError} thrown back to the caller, and it restores the real
 * process hooks in a `finally` so the trap never leaks past the wrapped call.
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
 * The scoped process-exit guard installed for the duration of one wrapped Pi
 * call. The two concerns have DIFFERENT lifecycles (see {@link
 * installProcessExitGuard}):
 * - {@link checkExitCode} is invoked SYNCHRONOUSLY immediately after the wrapped
 *   `fn` settles (before the outer `await` resolves) — this is the instant the
 *   mutated value is still observable.
 * - {@link restoreExit} is invoked in the `finally`.
 */
interface ProcessExitGuard {
  /**
   * Detect + neutralize a `process.exitCode` mutation. Compares the live value
   * against the pre-trap snapshot; on a difference, writes the snapshot back via
   * the native setter (so the daemon's eventual exit is unaffected) and returns
   * the offending value. Idempotent — a second call returns `undefined`.
   */
  checkExitCode(): { mutatedExitCode: typeof process.exitCode } | undefined;
  /** Reassign the original `process.exit`. MUST run exactly once in a `finally`. */
  restoreExit(): void;
}

/**
 * Install scoped guards around `process.exit` and `process.exitCode`.
 *
 * - `process.exit` is a plain writable function property, so it is REPLACED with
 *   a function that THROWS a {@link PiContainmentError} instead of terminating;
 *   {@link ProcessExitGuard.restoreExit} reassigns the original in the `finally`.
 * - `process.exitCode` is, on modern Node, a NON-CONFIGURABLE native accessor —
 *   it cannot be redefined to intercept writes (`Object.defineProperty`/`delete`
 *   both throw). It IS writable via its native setter. So the guard uses
 *   **snapshot + synchronous detect-and-restore** ({@link
 *   ProcessExitGuard.checkExitCode}): the caller invokes it the instant `fn`
 *   settles, while the mutated value is still observable, then writes the
 *   snapshot back and surfaces `E_PI_EXIT_CODE_MUTATION_TRAPPED`. (Detecting
 *   later — e.g. in `finally` after the outer `await` — is unreliable under some
 *   test harnesses that reset `exitCode` when `process.exit` is reassigned.)
 *
 * Re-entrant-safe: a second overlapping wrapped call snapshots the
 * already-trapped `process.exit` and the live `exitCode`; restore is a plain
 * reassignment and compare — no `defineProperty` ever runs.
 *
 * @returns A scoped guard handle.
 */
function installProcessExitGuard(): ProcessExitGuard {
  const originalExit = process.exit;
  // Snapshot the value (NOT the descriptor — the property is non-configurable on
  // modern Node, so we never redefine it; we compare-and-write via its setter).
  const originalExitCodeValue: typeof process.exitCode = process.exitCode;
  let exitCodeChecked = false;

  // `process.exit(code?)` → throw, never terminate. `never` return type is
  // preserved because the function always throws.
  const trappedExit = ((code?: number): never => {
    throw new PiContainmentError(
      'E_PI_PROCESS_EXIT_TRAPPED',
      `Pi attempted process.exit(${code ?? ''}) in-process; daemon-fatal exit neutralized`,
    );
  }) as typeof process.exit;
  process.exit = trappedExit;

  return {
    checkExitCode(): { mutatedExitCode: typeof process.exitCode } | undefined {
      if (exitCodeChecked) return undefined;
      exitCodeChecked = true;
      const current = process.exitCode;
      if (current !== originalExitCodeValue) {
        process.exitCode = originalExitCodeValue;
        return { mutatedExitCode: current };
      }
      return undefined;
    },
    restoreExit(): void {
      process.exit = originalExit;
    },
  };
}

/**
 * Run a Pi-touching async function under full process-exit containment +
 * abort routing.
 *
 * Behaviour:
 * - Installs the {@link installProcessExitGuard} trap for the duration of `fn`
 *   and restores the real hooks in a `finally` — a `process.exit()` call becomes
 *   a thrown {@link PiContainmentError} immediately, and a `process.exitCode`
 *   mutation is detected-and-restored at teardown then surfaced as a thrown
 *   `E_PI_EXIT_CODE_MUTATION_TRAPPED` (the value never leaks into the daemon's
 *   eventual exit code). Either way the daemon survives.
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

  const guard = installProcessExitGuard();
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
    guard.restoreExit();
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
