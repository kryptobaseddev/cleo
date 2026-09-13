/**
 * T12115 — teardown must be bounded, and the exit path must not be holdable.
 *
 * Each test below fails against the pre-T12115 code: `safely()` awaited a step
 * with no deadline, so a never-settling teardown step hung the CLI forever
 * (measured: 12.9 hours resident, SQLite descriptors still open because the
 * close step was never reached).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeHandleSummary,
  armExitBackstop,
  EXIT_BACKSTOP_MS,
  STEP_DEADLINE_MS,
  withDeadline,
} from '../shutdown-deadline.js';

describe('withDeadline', () => {
  it('abandons a step that never settles, rather than awaiting it forever', async () => {
    // The exact shape of the real defect: EmbeddingQueue.doShutdown awaited a
    // drain that could spawn a worker and load a model, and never came back.
    const neverSettles = () => new Promise<void>(() => {});

    const outcome = await withDeadline('stuck', neverSettles, 50);

    expect(outcome.settled).toBe(false);
    expect(outcome.label).toBe('stuck');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('reports a fast step as settled', async () => {
    const outcome = await withDeadline('quick', async () => {}, 1_000);
    expect(outcome.settled).toBe(true);
  });

  it('treats a throwing step as settled — teardown is best-effort', async () => {
    const outcome = await withDeadline(
      'throws',
      () => {
        throw new Error('worker already gone');
      },
      1_000,
    );
    expect(outcome.settled).toBe(true);
  });

  it('RECORDS that a step threw, so a failing teardown is not invisible', async () => {
    // `settled` alone includes "threw immediately", so without `threw` four
    // steps that all failed and four that all succeeded produce identical
    // outcome arrays — absence reading as success, in the teardown path.
    const ok = await withDeadline('fine', async () => {}, 1_000);
    const bad = await withDeadline(
      'boom',
      () => {
        throw new Error('unclean close');
      },
      1_000,
    );

    expect(ok.settled).toBe(true);
    expect(ok.threw).toBe(false);
    expect(bad.settled).toBe(true);
    expect(bad.threw).toBe(true);
  });

  it('does not itself keep the event loop alive', async () => {
    // A deadline timer that was ref'd would recreate the very hang it guards
    // against, holding the process open for the full budget on every command.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await withDeadline('quick', async () => {}, STEP_DEADLINE_MS);
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('armExitBackstop', () => {
  it('arms an unref-ed timer so a healthy process still exits on its own', () => {
    const timer = armExitBackstop(0, 60_000);
    try {
      // `hasRef` is the observable proof: a ref'd 60s timer here would delay
      // every single CLI invocation by a minute.
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('activeHandleSummary', () => {
  it('names what is holding the loop, for the next leak report', () => {
    const summary = activeHandleSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('tallies repeated handle types instead of listing duplicates', async () => {
    const timers = [setTimeout(() => {}, 30_000), setTimeout(() => {}, 30_000)];
    try {
      expect(activeHandleSummary()).toMatch(/Timeout×\d+/);
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  });
});

describe('armExitBackstop — exit code inheritance (gh regression)', () => {
  const realExit = process.exit;
  const realExitCode = process.exitCode;
  let exited: number | undefined;

  beforeEach(() => {
    exited = undefined;
    // @ts-expect-error — test double for a never-returning signature
    process.exit = (code?: number) => {
      exited = code;
    };
  });

  afterEach(() => {
    process.exit = realExit;
    process.exitCode = realExitCode;
    vi.useRealTimers();
  });

  it('inherits a non-zero process.exitCode instead of forcing 0', () => {
    // ~199 call sites report failure by SETTING process.exitCode and returning
    // normally (add-batch, agent, …). Those return through the SUCCESS-path
    // finally, so a backstop that hardcodes 0 tells the caller a failed command
    // succeeded — while its own envelope says it failed.
    vi.useFakeTimers();
    process.exitCode = 6;
    armExitBackstop();
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS + 10);
    expect(exited).toBe(6);
  });

  it('reads the exit code at FIRE time, not arm time', () => {
    vi.useFakeTimers();
    process.exitCode = 0;
    armExitBackstop();
    // A command that decides it failed after the backstop was armed must still
    // be reported honestly.
    process.exitCode = 1;
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS + 10);
    expect(exited).toBe(1);
  });

  it('still honours an explicitly supplied code', () => {
    vi.useFakeTimers();
    process.exitCode = 6;
    armExitBackstop(0);
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS + 10);
    expect(exited).toBe(0);
  });

  it('falls back to 0 when no code is set anywhere', () => {
    vi.useFakeTimers();
    process.exitCode = undefined;
    armExitBackstop();
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS + 10);
    expect(exited).toBe(0);
  });
});
