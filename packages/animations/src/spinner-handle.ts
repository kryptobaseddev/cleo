/**
 * SpinnerHandle — the canonical owner of `\r` writes for CLEO animations.
 *
 * @remarks
 * Wraps a {@link Spinner} frame set with a managed timer, cursor hiding, and
 * idempotent start/stop. All animation output flows through here so the
 * `AnimateContext` gate can be enforced at one place.
 *
 * The handle is silent when its {@link AnimateContext} has `enabled === false`
 * (JSON output, --quiet, non-TTY, NO_COLOR). All public methods become no-ops
 * in that case so callers never need to branch on output mode.
 *
 * Lint rule: any `process.stdout.write` of a string starting with `\r` outside
 * `@cleocode/animations` is a violation. Route through `createSpinnerHandle`.
 */

import type { AnimateContext } from './animate-context.js';
import { type BrailleSpinnerName, type CanonSpinnerName, resolveSpinner } from './braille.js';

/**
 * Imperative handle to a running spinner.
 *
 * @remarks
 * `start()` and `stop()` are idempotent — calling `start()` twice has the same
 * effect as calling it once; calling `stop()` on a handle that never started
 * is a no-op. `update()` changes the label without restarting the timer.
 */
export interface SpinnerHandle {
  /** Begin rendering frames. Idempotent. */
  start(): void;
  /**
   * Stop rendering, clear the spinner line, and (optionally) print a final
   * line in its place.
   *
   * @param finalLine - Optional message to print after clearing (no `\r` needed).
   */
  stop(finalLine?: string): void;
  /** Update the trailing label without restarting the frame timer. */
  update(label: string): void;
  /**
   * Whether this handle will actually render. `false` when the underlying
   * {@link AnimateContext} disabled output (e.g. `--json`, `--quiet`).
   */
  readonly enabled: boolean;
}

/**
 * Options controlling spinner timing.
 */
export interface SpinnerHandleOptions {
  /**
   * Milliseconds to wait before showing the spinner. Prevents flashing on
   * fast operations.
   *
   * @defaultValue `150`
   */
  readonly delayMs?: number;
}

const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
const CLEAR_LINE = '\r\x1B[2K';

/** Frozen no-op handle returned when the animate context is disabled. */
const NOOP_HANDLE: SpinnerHandle = Object.freeze({
  start() {},
  stop() {},
  update() {},
  enabled: false,
});

/* -------------------------------------------------------------------------
   Process-wide exit-handler registry.

   Every active handle registers a cleanup callback in `activeRestores`
   when it starts, and removes it when it stops. The `exit` / `SIGINT` /
   `SIGTERM` listeners are installed exactly ONCE per Node.js process
   (the first time any handle starts) and iterate the registry on fire,
   so N concurrent handles → 1 listener per signal regardless of N.

   This avoids the per-handle listener leak that would otherwise hit
   Node's default 10-listener warning threshold once 4–5 spinners run
   concurrently (cleo orchestrate spawn fan-out, IVTR multi-agent loops).
   ------------------------------------------------------------------------- */

/** Cleanup callback contract — best-effort cursor / line restoration. */
type RestoreCallback = () => void;

/** Active handles whose cursor needs restoring on process exit. */
const activeRestores = new Set<RestoreCallback>();

/** Whether the process-level signal listeners have been installed yet. */
let exitListenersInstalled = false;

/**
 * Lazily install the single set of process-level exit listeners.
 *
 * @remarks
 * Idempotent — only the first call installs listeners; subsequent calls
 * are no-ops. On `exit` / `SIGINT` / `SIGTERM`, every callback in
 * {@link activeRestores} fires exactly once and the set is cleared.
 * Errors thrown from a restore callback are swallowed so one bad handle
 * cannot block others from cleaning up.
 */
function ensureProcessExitListeners(): void {
  if (exitListenersInstalled) return;
  exitListenersInstalled = true;

  const restoreAll = (): void => {
    for (const fn of activeRestores) {
      try {
        fn();
      } catch {
        // Best-effort cleanup — continue restoring siblings.
      }
    }
    activeRestores.clear();
  };

  process.once('exit', restoreAll);
  process.once('SIGINT', () => {
    restoreAll();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    restoreAll();
    process.exit(143);
  });
}

/**
 * Test-only: reset the process-exit listener install state and clear the
 * active-handles registry.
 *
 * @internal
 * @remarks
 * Vitest reuses the same Node.js process across multiple test files.
 * Without this hook, tests that assert listener-count invariants would
 * see state from earlier files. Production code MUST NOT call this.
 */
export function __resetExitListenersForTesting(): void {
  activeRestores.clear();
  exitListenersInstalled = false;
}

/**
 * Create a managed spinner that obeys the {@link AnimateContext} gate.
 *
 * @param context - Resolved render gate (typically from `createAnimateContext`)
 * @param name    - Spinner name from {@link spinners} or {@link canonSpinners}
 * @param label   - Trailing label rendered next to the frame
 * @param options - Optional timing controls
 * @returns A handle whose methods are no-ops when `context.enabled === false`
 *
 * @example
 * ```ts
 * import { resolveOutputFormat } from '@cleocode/lafs';
 * import { createAnimateContext, createSpinnerHandle } from '@cleocode/animations';
 *
 * const flags = resolveOutputFormat({ humanFlag: true });
 * const ctx = createAnimateContext({ flagResolution: flags });
 * const spinner = createSpinnerHandle(ctx, 'weaving', 'Loading tasks…');
 *
 * spinner.start();
 * try {
 *   const result = await heavyWork();
 *   spinner.stop();
 *   console.log(result);
 * } catch (err) {
 *   spinner.stop();
 *   throw err;
 * }
 * ```
 */
export function createSpinnerHandle(
  context: AnimateContext,
  name: CanonSpinnerName | BrailleSpinnerName,
  label: string,
  options?: SpinnerHandleOptions,
): SpinnerHandle {
  if (!context.enabled) return NOOP_HANDLE;

  const spinner = resolveSpinner(name);
  if (!spinner) return NOOP_HANDLE;

  const delayMs = options?.delayMs ?? 150;

  let timer: NodeJS.Timeout | null = null;
  let delayTimer: NodeJS.Timeout | null = null;
  let frameIndex = 0;
  let currentLabel = label;
  let visible = false;
  let registeredRestore: RestoreCallback | null = null;

  function render(): void {
    const frame = spinner!.frames[frameIndex++ % spinner!.frames.length];
    process.stdout.write(`${CLEAR_LINE}  ${frame} ${currentLabel}`);
  }

  function clear(): void {
    if (visible) {
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
      visible = false;
    }
  }

  function deregister(): void {
    if (registeredRestore) {
      activeRestores.delete(registeredRestore);
      registeredRestore = null;
    }
  }

  return {
    enabled: true,
    start() {
      if (timer || delayTimer) return;
      ensureProcessExitListeners();

      // Register this handle's clear() with the module-scoped registry,
      // so an abnormal exit cleans it up alongside every other active
      // spinner — without installing a new process-level listener.
      registeredRestore = clear;
      activeRestores.add(registeredRestore);

      delayTimer = setTimeout(() => {
        delayTimer = null;
        process.stdout.write(HIDE_CURSOR);
        visible = true;
        render();
        timer = setInterval(render, spinner.interval);
      }, delayMs);
    },
    stop(finalLine?: string) {
      if (delayTimer) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clear();
      deregister();
      if (finalLine !== undefined && finalLine.length > 0) {
        process.stdout.write(`${finalLine}\n`);
      }
    },
    update(newLabel: string) {
      currentLabel = newLabel;
    },
  };
}
