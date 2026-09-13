/**
 * T12115 — shutting the embedding queue down must be purely subtractive.
 *
 * Before this fix, `doShutdown()` awaited `drain()`, and `drain()` called
 * `initWorker()` (spawning a `worker_threads.Worker`) and, with no worker
 * available, scheduled `setImmediate(fallbackEmbed)` callbacks that each
 * `await import('./embedding-local.js')` and run transformers.js inference on
 * the main thread. So the exit path *started* work: it loaded an ML model while
 * trying to shut down, and those callbacks outlived the `drain()` promise.
 *
 * The consequence was measured in production: one-shot `cleo` commands printed
 * their envelope and then sat in `ep_poll` — one for 12.9 hours — still holding
 * SQLite descriptors, because teardown never reached the close-databases step.
 */

import { describe, expect, it } from 'vitest';
import { EmbeddingQueue } from '../embedding-queue.js';

/** Queue with `count` pending items whose callbacks record if they ever fire. */
function queueWithPendingItems(count: number): {
  queue: EmbeddingQueue;
  completed: string[];
} {
  const queue = new EmbeddingQueue();
  const completed: string[] = [];

  for (let i = 0; i < count; i++) {
    queue.enqueue(`O-test-${i}`, `text to embed ${i}`, async (id) => {
      completed.push(id);
    });
  }

  return { queue, completed };
}

describe('EmbeddingQueue shutdown', () => {
  it('returns promptly with a full queue instead of draining it', async () => {
    const { queue } = queueWithPendingItems(50);

    const startedAt = Date.now();
    await queue.shutdown();
    const elapsed = Date.now() - startedAt;

    // Draining 50 items through a model load took unbounded time — that is the
    // hang. A subtractive shutdown is bounded by worker.terminate() alone.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('does not run embeddings while shutting down', async () => {
    const { queue, completed } = queueWithPendingItems(10);

    await queue.shutdown();
    // Give any stray setImmediate/fallbackEmbed callbacks a chance to run.
    await new Promise((r) => setTimeout(r, 100));

    // An embedding is enrichment; the observation row was already committed by
    // the caller. Dropping the tail is correct — and is what the old code did
    // anyway, since it terminated the worker without awaiting its results.
    expect(completed).toEqual([]);
  });

  it('is idempotent', async () => {
    const { queue } = queueWithPendingItems(5);
    await expect(queue.shutdown()).resolves.toBeUndefined();
    await expect(queue.shutdown()).resolves.toBeUndefined();
  });

  it('ignores work enqueued after shutdown has begun', async () => {
    const { queue, completed } = queueWithPendingItems(1);
    await queue.shutdown();

    queue.enqueue('O-late', 'arrived after teardown', async (id) => {
      completed.push(id);
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(completed).toEqual([]);
  });

  it('leaves no timer or worker handle holding the event loop', async () => {
    const { queue } = queueWithPendingItems(20);
    await queue.shutdown();
    await new Promise((r) => setTimeout(r, 50));

    const held = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'MessagePort' || r === 'Worker');
    expect(held).toEqual([]);
  });

  it('does not start a worker during shutdown of a queue that never had one', async () => {
    // Observable form of "doShutdown must not call initWorker". Spying on the
    // `node:worker_threads` export is impossible under ESM (the namespace is
    // not configurable), so assert the consequence instead: a queue that never
    // drained has no worker, and shutting it down must not create one — a fresh
    // Worker would surface as a live MessagePort on the loop.
    const { queue } = queueWithPendingItems(5);
    const before = process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;

    await queue.shutdown();
    await new Promise((r) => setTimeout(r, 50));

    const after = process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
    expect(after).toBeLessThanOrEqual(before);
  });
});
