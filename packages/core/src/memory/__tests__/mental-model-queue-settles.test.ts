/**
 * T12817 — `mentalModelQueue.enqueue()` must settle on its own.
 *
 * Before the fix the only drain a one-shot process could reach was an unref'd
 * 5 s interval, so an awaited `cleo memory observe --agent X` left the event
 * loop empty: Node exited 0 with nothing on stdout and nothing stored. These
 * tests pin the contract at the core seam: every enqueued observation is
 * written promptly (well inside the 5 s interval) with no manual `flush()`,
 * including entries enqueued while an earlier drain is still in flight.
 *
 * `observeBrain` is stubbed so the test exercises the queue alone.
 *
 * @task T12817
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written: string[] = [];
let writeDelayMs = 0;

vi.mock('../brain-retrieval.js', () => ({
  observeBrain: vi.fn(async (_root: string, params: { text: string }) => {
    if (writeDelayMs > 0) await new Promise((r) => setTimeout(r, writeDelayMs));
    written.push(params.text);
    return { id: `O-${written.length}`, type: 'discovery', createdAt: '2026-09-29 00:00:00' };
  }),
}));

const { mentalModelQueue, _resetMentalModelQueueForTests } = await import(
  '../mental-model-queue.js'
);

/** Well below the queue's 5 s backstop interval. */
const PROMPT_MS = 1_000;

/** Resolve with the promise's value, or reject once `ms` passes first. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

describe('mentalModelQueue settles without a manual flush (T12817)', () => {
  beforeEach(() => {
    written.length = 0;
    writeDelayMs = 0;
  });

  afterEach(() => {
    _resetMentalModelQueueForTests();
  });

  it('writes an enqueued observation promptly and resolves the caller', async () => {
    const result = await within(
      mentalModelQueue.enqueue('/tmp/p', { text: 'one', agent: 'tester', type: 'discovery' }),
      PROMPT_MS,
    );
    expect(result.id).toBe('O-1');
    expect(written).toEqual(['one']);
    expect(mentalModelQueue.size()).toBe(0);
  });

  it('batches same-tick enqueues and settles every caller', async () => {
    const results = await within(
      Promise.all([
        mentalModelQueue.enqueue('/tmp/p', { text: 'a', agent: 'tester' }),
        mentalModelQueue.enqueue('/tmp/p', { text: 'b', agent: 'tester' }),
        mentalModelQueue.enqueue('/tmp/p', { text: 'c', agent: 'tester' }),
      ]),
      PROMPT_MS,
    );
    expect(results.map((r) => r.id)).toEqual(['O-1', 'O-2', 'O-3']);
    expect(written).toEqual(['a', 'b', 'c']);
  });

  it('settles an entry enqueued while an earlier drain is still in flight', async () => {
    writeDelayMs = 100;
    const first = mentalModelQueue.enqueue('/tmp/p', { text: 'first', agent: 'tester' });
    // Let the first drain start (next macrotask), then enqueue during its write.
    await new Promise((r) => setTimeout(r, 20));
    const second = mentalModelQueue.enqueue('/tmp/p', { text: 'second', agent: 'tester' });
    await within(Promise.all([first, second]), PROMPT_MS);
    expect(written).toEqual(['first', 'second']);
  });
});
