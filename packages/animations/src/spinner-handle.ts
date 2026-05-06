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
  let exitHandlerInstalled = false;

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

  function installExitHandler(): void {
    if (exitHandlerInstalled) return;
    exitHandlerInstalled = true;
    // Restore cursor on abnormal exit (Ctrl-C, uncaught throw, etc.)
    const restore = () => {
      if (visible) {
        process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
      }
    };
    process.once('exit', restore);
    process.once('SIGINT', () => {
      restore();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      restore();
      process.exit(143);
    });
  }

  return {
    enabled: true,
    start() {
      if (timer || delayTimer) return;
      installExitHandler();
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
      if (finalLine !== undefined && finalLine.length > 0) {
        process.stdout.write(`${finalLine}\n`);
      }
    },
    update(newLabel: string) {
      currentLabel = newLabel;
    },
  };
}
