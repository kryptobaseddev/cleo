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

import { describe, expect, it, vi } from 'vitest';

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

describe('shutdownCliRuntime — coordinated CLI teardown (T11568 · T11655)', () => {
  it('is callable and resolves with nothing initialized (best-effort)', async () => {
    await expect(shutdownCliRuntime()).resolves.toBeUndefined();
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
    await expect(shutdownCliRuntime()).resolves.toBeUndefined();
    // Steps after the throwing one still ran.
    expect(resetEmbeddingQueueMock).toHaveBeenCalledTimes(1);
    expect(closeLoggerMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call never throws', async () => {
    await shutdownCliRuntime();
    await expect(shutdownCliRuntime()).resolves.toBeUndefined();
  });
});
