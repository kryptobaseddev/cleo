/**
 * T12115 — teardown must be bounded, and the exit path must not be holdable.
 *
 * Each test below fails against the pre-T12115 code: `safely()` awaited a step
 * with no deadline, so a never-settling teardown step hung the CLI forever
 * (measured: 12.9 hours resident, SQLite descriptors still open because the
 * close step was never reached).
 */

import type { ShutdownStepOutcome } from '@cleocode/contracts/jobs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeHandleSummary,
  armExitBackstop,
  EXIT_BACKSTOP_MS,
  formatShutdownOutcomes,
  STEP_DEADLINE_MS,
  withDeadline,
} from '../shutdown-deadline.js';
import { OperationExecutionError } from '../store/background-ops.js';

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

describe('typed shutdown outcomes preserve actual causes (T12265)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks a completed step separately from a rejected step', async () => {
    const complete = await withDeadline('complete', async () => {});
    const rejected = await withDeadline('reject', async () => {
      throw new Error('write refused');
    });
    expect(complete).toMatchObject({ status: 'completed', settled: true, threw: false });
    expect(rejected).toMatchObject({
      status: 'failed',
      reason: 'step-rejected',
      error: 'write refused',
      settled: true,
      threw: true,
    });
  });

  it.each([
    ['E_OPERATION_CANCELLED', 'cancelled', 'operation-cancelled'],
    ['E_OPERATION_CLOSED', 'cancelled', 'operation-closed'],
    ['E_OPERATION_DEADLINE', 'timed-out', 'execution-deadline'],
  ] as const)('retains the known operation stop %s', async (code, status, reason) => {
    const outcome = await withDeadline('producer', async () => {
      throw new OperationExecutionError(code, 'original scope stopped');
    });
    expect(outcome).toMatchObject({
      status,
      reason,
      error: 'original scope stopped',
      settled: true,
      threw: true,
    });
  });

  it('records a timer expiry without fabricating a thrown error', async () => {
    const outcomePromise = withDeadline('pending', () => new Promise<void>(() => {}), 40);
    await vi.advanceTimersByTimeAsync(40);
    expect(await outcomePromise).toMatchObject({
      status: 'timed-out',
      reason: 'step-deadline',
      settled: false,
      threw: false,
      durationMs: 40,
    });
    expect(await outcomePromise).not.toHaveProperty('error');
  });

  it('keeps a deadline receipt unchanged when the abandoned promise later rejects', async () => {
    const pending = Promise.withResolvers<void>();
    const outcomePromise = withDeadline('late', () => pending.promise, 40);
    await vi.advanceTimersByTimeAsync(40);
    const outcome = await outcomePromise;
    const snapshot = structuredClone(outcome);
    pending.reject(new Error('late rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual(snapshot);
    expect(outcome.status).toBe('timed-out');
    expect(outcome).not.toHaveProperty('error');
  });
});

describe('shutdown diagnostics report assessed causes, not guessed deadlines', () => {
  it.each([
    ['failed', 'step-rejected', 'failed'],
    ['cancelled', 'operation-cancelled', 'cancelled'],
    ['timed-out', 'step-deadline', 'timed out'],
    ['not-started', 'background-pending', 'not started'],
    ['not-started', 'prior-step-incomplete', 'not started'],
    ['not-started', 'shutdown-deadline', 'not started'],
  ] as const)('renders %s with %s', (status, reason, wording) => {
    const outcome: ShutdownStepOutcome = {
      label: 'databases',
      settled: status === 'failed' || status === 'cancelled',
      threw: status === 'failed' || status === 'cancelled',
      durationMs: 0,
      status,
      reason,
    };
    const text = formatShutdownOutcomes([outcome]);
    expect(text).toContain(`databases: ${wording}`);
    expect(text).toContain(reason);
    expect(text).toContain("The command's own result stands");
    if (status === 'not-started') expect(text).not.toMatch(/exceeded|timed out/);
  });

  it('does not infer a timeout from an untyped legacy incomplete outcome', () => {
    const legacy: ShutdownStepOutcome = {
      label: 'old',
      settled: false,
      threw: false,
      durationMs: 0,
    };
    const text = formatShutdownOutcomes([legacy]);
    expect(text).toContain('old: incomplete');
    expect(text).toContain('reason unavailable');
    expect(text).not.toMatch(/deadline|timed out/);
  });

  it('does not turn a settled producer barrier into verified producer success', () => {
    const text = formatShutdownOutcomes([
      {
        label: 'background-operations',
        settled: true,
        threw: false,
        durationMs: 1,
        status: 'completed',
        producerOutcome: 'unassessed',
      },
    ]);
    expect(text).toContain('tracked promises settled');
    expect(text).toContain('producer outcomes unassessed');
    expect(text).not.toMatch(/success|failed|timed out/);
  });

  it('omits successful resource steps and preserves known error detail safely', () => {
    expect(
      formatShutdownOutcomes([
        { label: 'closed', settled: true, threw: false, durationMs: 0, status: 'completed' },
      ]),
    ).toBe('');
    const text = formatShutdownOutcomes([
      {
        label: 'logger',
        settled: true,
        threw: true,
        durationMs: 0,
        status: 'failed',
        reason: 'step-rejected',
        error: 'cannot close\nforged second line',
      },
    ]);
    expect(text).toContain('cannot close\\nforged second line');
    expect(text.split('\n')).toHaveLength(3);
  });
});
