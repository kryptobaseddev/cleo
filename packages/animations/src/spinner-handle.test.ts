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
import { createSpinnerHandle } from './spinner-handle.js';

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
});
