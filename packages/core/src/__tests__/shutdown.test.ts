/**
 * T11568 / T11655 — unit coverage for the coordinated CLI teardown aggregator.
 *
 * The end-to-end "does the process actually exit" assertion lives in the CLI
 * subprocess test (`packages/cleo/src/cli/__tests__/process-exit-no-hang.test.ts`),
 * because the brain-writer / embedding worker threads only spawn when their
 * compiled worker files are resolvable on disk — which is true for the shipped
 * dist but not inside the vitest worker. This unit test guards the aggregator's
 * CONTRACT so a future refactor cannot silently drop one of the teardown steps:
 *
 *   - `shutdownCliRuntime` is exported and callable.
 *   - It is best-effort + idempotent: calling it twice never throws, even with
 *     no subsystem initialized.
 *   - It tears down the embedding-queue worker (T11655) so a `cleo briefing`
 *     cannot leave a live `MessagePort` keeping the loop alive at exit.
 *
 * @task T11568
 * @task T11655
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resetEmbeddingQueueMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const shutdownBrainWriterMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const closeAllDatabasesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const closeLoggerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../memory/embedding-queue.js', () => ({
  resetEmbeddingQueue: resetEmbeddingQueueMock,
}));
vi.mock('../memory/brain-writer-thread.js', () => ({
  shutdownBrainWriter: shutdownBrainWriterMock,
}));
vi.mock('../store/sqlite.js', () => ({
  closeAllDatabases: closeAllDatabasesMock,
}));
vi.mock('../logger.js', () => ({
  closeLogger: closeLoggerMock,
}));

import { shutdownCliRuntime } from '../shutdown.js';
import { formatShutdownOutcomes, STEP_DEADLINE_MS } from '../shutdown-deadline.js';
import {
  awaitBackgroundOps,
  createOperationExecutionContext,
  pendingBackgroundOpCount,
  trackBackgroundOp,
} from '../store/background-ops.js';
import { _resetTeardownSignalForTests } from '../teardown-signal.js';

const resourceClosers = [
  shutdownBrainWriterMock,
  resetEmbeddingQueueMock,
  closeAllDatabasesMock,
  closeLoggerMock,
];

beforeEach(() => {
  vi.useFakeTimers();
  _resetTeardownSignalForTests();
  for (const closer of resourceClosers) closer.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await awaitBackgroundOps();
  vi.useRealTimers();
  _resetTeardownSignalForTests();
});

describe('shutdownCliRuntime — coordinated CLI teardown (T11568 · T11655)', () => {
  it('is callable and resolves with nothing initialized (best-effort)', async () => {
    // T12115 changed the return from `void` to one StepOutcome per step, so the
    // CLI can report a step that blew its deadline. The assertion these tests
    // always MEANT was "resolves without throwing" — `toBeUndefined()` was the
    // incidental return value, not the contract under test. Asserting the
    // outcomes is strictly stronger.
    const outcomes = await shutdownCliRuntime();
    expect(outcomes.map((o) => o.label)).toEqual([
      'background-operations',
      'brain-writer',
      'embedding-queue',
      'databases',
      'logger',
    ]);
  });

  it('tears down the embedding-queue worker (T11655 contract)', async () => {
    resetEmbeddingQueueMock.mockClear();
    await shutdownCliRuntime();
    expect(resetEmbeddingQueueMock).toHaveBeenCalledTimes(1);
  });

  it('a failing teardown step never aborts the others (best-effort)', async () => {
    shutdownBrainWriterMock.mockRejectedValueOnce(new Error('boom'));
    resetEmbeddingQueueMock.mockClear();
    closeLoggerMock.mockClear();
    // Previously this could only assert "did not throw". The outcomes make the
    // actual claim directly checkable: every step ran despite one rejecting.
    const outcomes = await shutdownCliRuntime();
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.settled)).toBe(true);
    // Steps after the throwing one still ran.
    expect(resetEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(closeLoggerMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call never throws', async () => {
    await shutdownCliRuntime();
    // Label assertion, not a count: a renamed or swapped step would pass a
    // length check while changing the contract.
    await expect(shutdownCliRuntime()).resolves.toEqual([
      expect.objectContaining({ label: 'background-operations' }),
      expect.objectContaining({ label: 'brain-writer' }),
      expect.objectContaining({ label: 'embedding-queue' }),
      expect.objectContaining({ label: 'databases' }),
      expect.objectContaining({ label: 'logger' }),
    ]);
  });
});

describe('shutdown waits for registered producers under one deadline (T12265)', () => {
  it('does not close resources until a registered producer settles', async () => {
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    trackBackgroundOp(release.promise.then(() => events.push('producer-settled')));
    closeAllDatabasesMock.mockImplementation(async () => {
      events.push('databases-closed');
    });
    const shutdown = shutdownCliRuntime();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingBackgroundOpCount()).toBe(1);
      for (const closer of resourceClosers) expect(closer).not.toHaveBeenCalled();
      release.resolve();
      const outcomes = await shutdown;
      expect(pendingBackgroundOpCount()).toBe(0);
      expect(events).toEqual(['producer-settled', 'databases-closed']);
      expect(outcomes[0]).toMatchObject({
        label: 'background-operations',
        settled: true,
        threw: false,
        status: 'completed',
        producerOutcome: 'assessed',
        failedOperations: 0,
        pendingOperations: 0,
      });
      for (const closer of resourceClosers) expect(closer).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await shutdown;
    }
  });

  it('includes descendants registered while an earlier producer settles', async () => {
    const releaseParent = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();
    trackBackgroundOp(
      releaseParent.promise.then(() => {
        trackBackgroundOp(releaseChild.promise);
      }),
    );
    const shutdown = shutdownCliRuntime();
    try {
      releaseParent.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingBackgroundOpCount()).toBe(1);
      for (const closer of resourceClosers) expect(closer).not.toHaveBeenCalled();
      releaseChild.resolve();
      await shutdown;
      expect(pendingBackgroundOpCount()).toBe(0);
      expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseParent.resolve();
      releaseChild.resolve();
      await shutdown;
    }
  });

  it('cancels the original context but awaits its cleanup without extending its deadline', async () => {
    const context = createOperationExecutionContext(
      {
        projectId: 'shutdown-fixture',
        projectRoot: process.cwd(),
        actor: 'unit-test',
        operation: 'shutdown-contract',
        idempotencyKey: 'cancel-original-context',
      },
      { budgetMs: 1700 },
    );
    const originalDeadline = context.deadlineAt;
    const cancelled = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    trackBackgroundOp(cancelled.promise.then(() => cleanup.promise));
    const shutdown = shutdownCliRuntime();
    try {
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(context.signal.aborted).toBe(true);
      expect(context.deadlineAt).toBe(originalDeadline);
      expect(() => context.assertActive()).toThrow('cancelled during teardown');
      expect(pendingBackgroundOpCount()).toBe(1);
      for (const closer of resourceClosers) expect(closer).not.toHaveBeenCalled();
      cleanup.resolve();
      await shutdown;
      expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      context.close();
      await shutdown;
    }
  });

  it('reports an expired drain and leaves resources open while work remains', async () => {
    const release = Promise.withResolvers<void>();
    trackBackgroundOp(release.promise);
    const startedAt = Date.now();
    const shutdown = shutdownCliRuntime();
    try {
      await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS);
      const outcomes = await shutdown;
      expect(Date.now() - startedAt).toBe(STEP_DEADLINE_MS);
      expect(pendingBackgroundOpCount()).toBe(1);
      expect(outcomes.map((outcome) => outcome.label)).toEqual([
        'background-operations',
        'brain-writer',
        'embedding-queue',
        'databases',
        'logger',
      ]);
      expect(outcomes.every((outcome) => !outcome.settled && !outcome.threw)).toBe(true);
      expect(outcomes[0]).toMatchObject({
        status: 'timed-out',
        reason: 'shutdown-deadline',
        pendingOperations: 1,
        producerOutcome: 'unassessed',
      });
      expect(outcomes.find((outcome) => outcome.label === 'databases')).toMatchObject({
        status: 'not-started',
        reason: 'background-pending',
        pendingOperations: 1,
      });
      for (const closer of resourceClosers) expect(closer).not.toHaveBeenCalled();
      release.resolve();
      await awaitBackgroundOps();
      // An abandoned drain must not later resume resource closure behind the caller.
      for (const closer of resourceClosers) expect(closer).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await shutdown;
    }
  });

  it('shares the same deadline across draining and subsequent resource closers', async () => {
    trackBackgroundOp(new Promise<void>((resolve) => setTimeout(resolve, 700)));
    shutdownBrainWriterMock.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    );
    resetEmbeddingQueueMock.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    );
    const startedAt = Date.now();
    let finished = false;
    const shutdown = shutdownCliRuntime().then((outcomes) => {
      finished = true;
      return outcomes;
    });
    try {
      await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      const outcomes = await shutdown;
      expect(Date.now() - startedAt).toBe(STEP_DEADLINE_MS);
      expect(outcomes.find((outcome) => outcome.label === 'brain-writer')).toMatchObject({
        settled: true,
        durationMs: 1000,
      });
      expect(outcomes.find((outcome) => outcome.label === 'embedding-queue')).toMatchObject({
        settled: false,
        durationMs: 300,
        status: 'timed-out',
        reason: 'shutdown-deadline',
      });
      expect(outcomes.find((outcome) => outcome.label === 'databases')).toMatchObject({
        settled: false,
        durationMs: 0,
      });
      expect(closeAllDatabasesMock).not.toHaveBeenCalled();
      expect(closeLoggerMock).not.toHaveBeenCalled();
    } finally {
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;
    }
  });

  it('does not grant a new budget after synchronous work crosses the deadline', async () => {
    const startedAt = Date.now();
    shutdownBrainWriterMock.mockImplementation(async () => {
      vi.setSystemTime(startedAt + STEP_DEADLINE_MS + 1);
    });
    const outcomes = await shutdownCliRuntime();
    expect(resetEmbeddingQueueMock).not.toHaveBeenCalled();
    expect(closeAllDatabasesMock).not.toHaveBeenCalled();
    expect(closeLoggerMock).not.toHaveBeenCalled();
    expect(outcomes.find((outcome) => outcome.label === 'brain-writer')).toMatchObject({
      settled: true,
      durationMs: STEP_DEADLINE_MS + 1,
    });
    expect(outcomes.find((outcome) => outcome.label === 'databases')).toMatchObject({
      settled: false,
      durationMs: 0,
      status: 'not-started',
      reason: 'shutdown-deadline',
    });
  });
});

describe('shutdown producer result disclosure', () => {
  it('prints no teardown diagnostics for a clean run (T12310)', async () => {
    // The shipped 2026.9.11 binary printed the "producer outcomes unassessed"
    // caveat on EVERY successful command, including runs where the barrier had
    // observed no producer at all — nothing to assess, and a line anyway.
    const outcomes = await shutdownCliRuntime();
    expect(outcomes[0]).toMatchObject({
      label: 'background-operations',
      status: 'completed',
      producerOutcome: 'assessed',
      failedOperations: 0,
    });
    expect(formatShutdownOutcomes(outcomes)).toBe('');
  });

  it('stays silent when teardown itself cancelled an in-flight producer (T12310)', async () => {
    const execution = createOperationExecutionContext({
      projectId: 'p',
      projectRoot: '/tmp/t12310',
      actor: 'test',
      operation: 'test.op',
      idempotencyKey: 'k',
    });
    const release = Promise.withResolvers<void>();
    trackBackgroundOp(async () => {
      await release.promise;
      execution.assertActive();
    }, execution);
    const shutdown = shutdownCliRuntime();
    await vi.advanceTimersByTimeAsync(0);
    release.resolve();
    const outcomes = await shutdown;
    // Abandonment by our own teardown is not a producer failure to report.
    expect(outcomes[0]).toMatchObject({ producerOutcome: 'assessed', failedOperations: 0 });
    expect(formatShutdownOutcomes(outcomes)).toBe('');
    execution.close();
  });

  it('does not call a rejected producer successful merely because the barrier drained', async () => {
    const error = new Error('optional projection refused');
    const result = trackBackgroundOp(Promise.reject(error));
    expect(await result).toEqual({ status: 'rejected', reason: error });
    const outcomes = await shutdownCliRuntime();
    // T12310: the barrier assesses producers, so the rejection is DISCLOSED by
    // count rather than covered by a standing "unassessed" caveat.
    expect(outcomes[0]).toMatchObject({
      status: 'completed',
      producerOutcome: 'assessed',
      failedOperations: 1,
      pendingOperations: 0,
    });
    expect(formatShutdownOutcomes(outcomes)).toContain('1 background operation failed');
    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
  });

  it('reports newly registered producer ownership without inventing deadline expiry', async () => {
    const release = Promise.withResolvers<void>();
    shutdownBrainWriterMock.mockImplementation(async () => {
      trackBackgroundOp(release.promise);
    });
    try {
      const startedAt = Date.now();
      const outcomes = await shutdownCliRuntime();
      expect(Date.now()).toBe(startedAt);
      expect(outcomes.find((outcome) => outcome.label === 'databases')).toMatchObject({
        status: 'not-started',
        reason: 'background-pending',
        pendingOperations: 1,
        settled: false,
        threw: false,
        durationMs: 0,
      });
      expect(closeAllDatabasesMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
  });
});
