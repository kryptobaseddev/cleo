/**
 * Tests for createSpinnerHandle — the canonical owner of \r writes.
 *
 * Covers:
 * - No-op behavior when AnimateContext is disabled (JSON / quiet / non-TTY / NO_COLOR)
 * - Idempotent start/stop
 * - Delayed first render (no flash on fast operations)
 * - Cursor hide/show + line clearing
 * - Frame cycling using the resolved spinner interval
 * - Final-line emission via stop()
 * - update() changes label without restarting timer
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from './animate-context.js';
import { __resetExitListenersForTesting, createSpinnerHandle } from './spinner-handle.js';

const ENABLED_CTX = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

/**
 * Tuple of arguments observed on every spied `process.stdout.write` call.
 *
 * @remarks
 * Matches the runtime contract of {@link createSpinnerHandle}: the spinner
 * only writes strings (frame, label, cursor codes, line clears) — never
 * Uint8Array — so `chunk` is narrowed to `string`. Callbacks are unused.
 */
type StdoutWriteCall = readonly [chunk: string];

/** Strongly-typed spy mirroring `process.stdout.write` for assertion ergonomics. */
type StdoutWriteSpy = MockInstance<(chunk: string) => boolean>;

describe('createSpinnerHandle', () => {
  let writeSpy: StdoutWriteSpy;

  /** Extract the string chunks captured by the spy in call order. */
  function recordedChunks(): string[] {
    return (writeSpy.mock.calls as readonly StdoutWriteCall[]).map((call) => call[0]);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    writeSpy.mockRestore();
  });

  describe('disabled contexts → no-op handle', () => {
    it('returns no-op handle when format=json', () => {
      const ctx = createAnimateContext({
        flagResolution: { format: 'json', quiet: false },
        isTTY: true,
        noColor: false,
      });
      const handle = createSpinnerHandle(ctx, 'weaving', 'loading');
      expect(handle.enabled).toBe(false);
      handle.start();
      vi.advanceTimersByTime(1000);
      handle.stop('done');
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('returns no-op handle when quiet=true', () => {
      const ctx = createAnimateContext({
        flagResolution: { format: 'human', quiet: true },
        isTTY: true,
        noColor: false,
      });
      const handle = createSpinnerHandle(ctx, 'weaving', 'loading');
      handle.start();
      vi.advanceTimersByTime(1000);
      handle.stop();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('returns no-op handle when isTTY=false', () => {
      const ctx = createAnimateContext({
        flagResolution: { format: 'human', quiet: false },
        isTTY: false,
        noColor: false,
      });
      const handle = createSpinnerHandle(ctx, 'weaving', 'loading');
      handle.start();
      vi.advanceTimersByTime(1000);
      handle.stop();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('returns no-op handle when NO_COLOR is set', () => {
      const ctx = createAnimateContext({
        flagResolution: { format: 'human', quiet: false },
        isTTY: true,
        noColor: true,
      });
      const handle = createSpinnerHandle(ctx, 'weaving', 'loading');
      handle.start();
      vi.advanceTimersByTime(1000);
      handle.stop();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('SILENT_CONTEXT yields no-op handle', () => {
      const handle = createSpinnerHandle(SILENT_CONTEXT, 'weaving', 'loading');
      expect(handle.enabled).toBe(false);
      handle.start();
      vi.advanceTimersByTime(5000);
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('unknown spinner name yields no-op handle', () => {
      // @ts-expect-error - intentionally invalid name to test guard
      const handle = createSpinnerHandle(ENABLED_CTX, 'not-a-real-spinner', 'loading');
      expect(handle.enabled).toBe(false);
      handle.start();
      vi.advanceTimersByTime(1000);
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('enabled context', () => {
    it('marks handle as enabled', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading');
      expect(handle.enabled).toBe(true);
    });

    it('does not write before delay elapses', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 200 });
      handle.start();
      vi.advanceTimersByTime(150);
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('writes hide-cursor and first frame after delay', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 100 });
      handle.start();
      vi.advanceTimersByTime(100);
      const calls = recordedChunks();
      expect(calls.some((s) => s.includes('\x1B[?25l'))).toBe(true); // hide cursor
      expect(calls.some((s) => s.includes('loading'))).toBe(true); // label rendered
      expect(calls.some((s) => s.startsWith('\r'))).toBe(true); // line-clear prefix
    });

    it('cycles frames at spinner interval', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(0);
      const callsAfterFirst = writeSpy.mock.calls.length;
      // weaving = braillewave = 100ms interval
      vi.advanceTimersByTime(500);
      expect(writeSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('clears line and shows cursor on stop', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(50);
      writeSpy.mockClear();
      handle.stop();
      const calls = recordedChunks();
      expect(calls.some((s) => s.includes('\x1B[?25h'))).toBe(true); // show cursor
      expect(calls.some((s) => s.startsWith('\r'))).toBe(true); // line-clear
    });

    it('emits final line after stop when provided', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(50);
      writeSpy.mockClear();
      handle.stop('Tapestry complete.');
      const written = recordedChunks().join('');
      expect(written).toContain('Tapestry complete.\n');
    });

    it('stop() before delay elapses does not write spinner frames', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 200 });
      handle.start();
      vi.advanceTimersByTime(100);
      handle.stop();
      vi.advanceTimersByTime(500); // ensure no late frames
      // Only the line-clear from stop() should have written; no hide-cursor
      const calls = recordedChunks();
      expect(calls.some((s) => s.includes('\x1B[?25l'))).toBe(false);
    });

    it('start() is idempotent', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 0 });
      handle.start();
      handle.start();
      handle.start();
      vi.advanceTimersByTime(50);
      const calls = recordedChunks();
      const hideCursorCount = calls.filter((s) => s.includes('\x1B[?25l')).length;
      expect(hideCursorCount).toBe(1);
    });

    it('stop() is idempotent', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'loading', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(50);
      handle.stop();
      writeSpy.mockClear();
      handle.stop();
      handle.stop();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('update() changes label visible on next render', () => {
      const handle = createSpinnerHandle(ENABLED_CTX, 'weaving', 'old-label', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(50);
      handle.update('new-label');
      vi.advanceTimersByTime(200);
      const written = recordedChunks().join('');
      expect(written).toContain('new-label');
    });
  });

  /**
   * Process-level listener invariant.
   *
   * @remarks
   * The previous implementation installed a fresh `process.once('SIGINT', …)`
   * (plus `'SIGTERM'`, plus `'exit'`) for every started handle. With CLEO's
   * orchestrator fan-out spawning 4–5 concurrent spinners, this hit Node's
   * default 10-listener warning threshold and created the visible
   * "MaxListenersExceededWarning" line in production logs. The fix hoists
   * the listeners to a single module-scoped registry; this suite pins that
   * contract so future refactors cannot regress it.
   */
  describe('process-level exit listeners are shared, not per-handle', () => {
    /** Signals the SpinnerHandle module installs listeners on. */
    const TRACKED_SIGNALS = ['exit', 'SIGINT', 'SIGTERM'] as const;

    /** Snapshot of the listener counts on each tracked signal. */
    function snapshotListenerCounts(): Record<(typeof TRACKED_SIGNALS)[number], number> {
      return {
        exit: process.listenerCount('exit'),
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      };
    }

    beforeEach(() => {
      // Each invariant test starts from a clean module state so the
      // assertion targets the new registration cycle, not residual
      // listeners installed by earlier tests in the same vitest run.
      __resetExitListenersForTesting();
    });

    it('installs at most one listener per signal regardless of how many handles start', () => {
      const before = snapshotListenerCounts();

      const handles = Array.from({ length: 15 }, (_, i) =>
        createSpinnerHandle(ENABLED_CTX, 'weaving', `task ${i}`, { delayMs: 0 }),
      );
      for (const h of handles) h.start();
      vi.advanceTimersByTime(50);

      const after = snapshotListenerCounts();

      // Every signal gains exactly one listener — the shared dispatcher.
      // Per-handle leak would have added 15 listeners per signal.
      for (const signal of TRACKED_SIGNALS) {
        expect(after[signal] - before[signal]).toBe(1);
      }

      for (const h of handles) h.stop();
    });

    it('a single handle still installs exactly one listener per signal', () => {
      const before = snapshotListenerCounts();

      const handle = createSpinnerHandle(ENABLED_CTX, 'looming', 'one', { delayMs: 0 });
      handle.start();
      vi.advanceTimersByTime(50);

      const after = snapshotListenerCounts();

      for (const signal of TRACKED_SIGNALS) {
        expect(after[signal] - before[signal]).toBe(1);
      }

      handle.stop();
    });

    it('starting and stopping many handles does not leak listeners across cycles', () => {
      const before = snapshotListenerCounts();

      // 5 sequential start/stop cycles — old design would have leaked
      // (`process.once` removes itself when fired, but the registration
      // happens once per start; without a shared dispatcher each new
      // start re-registered, accumulating handlers when none had fired).
      for (let cycle = 0; cycle < 5; cycle++) {
        const h = createSpinnerHandle(ENABLED_CTX, 'weaving', `c${cycle}`, { delayMs: 0 });
        h.start();
        vi.advanceTimersByTime(50);
        h.stop();
      }

      const after = snapshotListenerCounts();

      // Cumulative listener delta still 1 per signal (the shared dispatcher
      // installed during the first start; never reinstalled).
      for (const signal of TRACKED_SIGNALS) {
        expect(after[signal] - before[signal]).toBe(1);
      }
    });
  });
});
