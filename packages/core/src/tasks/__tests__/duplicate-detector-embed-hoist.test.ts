/**
 * The incoming blob must be embedded ONCE per duplicate check, not once per
 * candidate (GH #1279 investigation).
 *
 * `tryVectorSimilarity` used to do:
 *
 *     Promise.all([embedText(incomingBlob), embedText(candidateBlob)])
 *
 * inside the loop over every active task. With 1,126 active tasks in the live
 * store that embedded the SAME incoming text 1,126 times per `cleo add` — the
 * O(active-tasks) cost on the write path, and the reason a `--dry-run` that
 * inserts nothing could exceed 120 seconds.
 *
 * The assertion is deliberately about CALL COUNT rather than wall-clock: a
 * timing test would be flaky and would not say which call was redundant.
 *
 * @epic T12119
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedCalls: string[] = [];

vi.mock('../../memory/brain-embedding.js', () => ({
  isEmbeddingAvailable: () => true,
  embedText: async (text: string) => {
    embedCalls.push(text);
    // Deterministic unit-ish vector; content-independent so every pair scores
    // identically and the test is about call count, not about similarity.
    return new Float32Array([1, 0, 0]);
  },
}));

describe('incoming-blob embedding is hoisted out of the candidate loop', () => {
  beforeEach(() => {
    embedCalls.length = 0;
  });

  it('embeds the incoming blob exactly once regardless of candidate count', async () => {
    const { checkDuplicates } = await import('../duplicate-detector.js');

    const CANDIDATES = 10; // deliberately under MAX_VECTOR_CANDIDATES (25) so the
    // assertion is about the hoist, not about #1258's budget cap
    const tasks = Array.from({ length: CANDIDATES }, (_, i) => ({
      id: `T${1000 + i}`,
      title: `Candidate task number ${i}`,
      description: `Description for candidate ${i}`,
      status: 'pending',
    }));

    const accessor = {
      queryTasks: async () => ({ tasks, total: tasks.length }),
    };

    const incomingTitle = 'ZZPROBE incoming title for the hoist test';
    await checkDuplicates(
      incomingTitle,
      'incoming description',
      accessor as Parameters<typeof checkDuplicates>[2],
    );

    const incomingBlobCalls = embedCalls.filter((t) => t.includes('zzprobe incoming title'));

    // The load-bearing assertion. Before the hoist this was CANDIDATES (25),
    // because the incoming blob was re-embedded once per candidate.
    expect(incomingBlobCalls).toHaveLength(1);

    // And the total is 1 + N, not 2N.
    expect(embedCalls).toHaveLength(1 + CANDIDATES);
  });
});
