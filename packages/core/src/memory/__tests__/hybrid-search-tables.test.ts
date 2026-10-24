/**
 * Recall ranking follow-ups (T13978): a table filter applies to every memory
 * source before the limit, so `memory find --tables` fills its limit even when
 * vector hits from other tables rank higher; eligibility checks reuse one
 * prepared statement per table.
 *
 * @task T13978
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { vectorHits } = vi.hoisted(() => ({
  vectorHits: {
    current: [] as Array<{
      id: string;
      distance: number;
      type: string;
      title: string;
      text: string;
    }>,
  },
}));

vi.mock('../brain-similarity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brain-similarity.js')>();
  return {
    ...actual,
    searchSimilarWithStatus: async () => ({ results: vectorHits.current }),
  };
});

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-hybrid-tables-'));
  await mkdir(join(root, '.cleo'), { recursive: true });
  process.env['CLEO_DIR'] = join(root, '.cleo');
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  const { resetFts5Cache } = await import('../brain-search.js');
  closeBrainDb();
  resetFts5Cache();
  delete process.env['CLEO_DIR'];
  vectorHits.current = [];
  await rm(root, { recursive: true, force: true });
});

/** Three decisions that match the query, and ten observations only the vector layer finds. */
async function seed(): Promise<void> {
  const { getBrainAccessor } = await import('../../store/memory-accessor.js');
  const accessor = await getBrainAccessor(root);
  for (const n of [1, 2, 3]) {
    await accessor.addDecision({
      id: `D-${n}`,
      type: 'technical',
      decision: `Worktree cleanup policy ${n}`,
      rationale: 'worktree cleanup',
      confidence: 'high',
    });
  }
  for (let n = 1; n <= 10; n++) {
    await accessor.addObservation({
      id: `O-${n}`,
      type: 'discovery',
      title: `Unrelated note ${n}`,
      narrative: `vector-only neighbour ${n}`,
      sourceType: 'agent',
    });
  }
  // The observations are also graph neighbours of every decision, so they rank
  // above the decisions on two sources (vector and graph) against one (FTS).
  const { writeGraphBatch } = await import('../graph-auto-populate.js');
  const nodes = [
    ...[1, 2, 3].map((n) => ({
      id: `decision:D-${n}`,
      nodeType: 'decision' as const,
      label: `D-${n}`,
      qualityScore: 0.8,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `observation:O-${i + 1}`,
      nodeType: 'observation' as const,
      label: `Unrelated note ${i + 1}`,
      qualityScore: 0.8,
    })),
  ];
  const edges = [1, 2, 3].flatMap((d) =>
    Array.from({ length: 10 }, (_, i) => ({
      fromId: `decision:D-${d}`,
      toId: `observation:O-${i + 1}`,
      edgeType: 'applies_to' as const,
      provenance: 'test',
    })),
  );
  await writeGraphBatch(root, nodes, edges);
  vectorHits.current = Array.from({ length: 10 }, (_, i) => ({
    id: `O-${i + 1}`,
    distance: 0.01 * (i + 1),
    type: 'observation',
    title: `Unrelated note ${i + 1}`,
    text: `vector-only neighbour ${i + 1}`,
  }));
}

describe('table-filtered recall fills its limit (T13978)', () => {
  it('hybridSearch drops other tables from every source before the limit', async () => {
    await seed();
    const { hybridSearch } = await import('../brain-search.js');
    const hits = await hybridSearch('worktree cleanup', root, { limit: 3, tables: ['decisions'] });
    expect(hits.map((hit) => hit.id).sort()).toEqual(['D-1', 'D-2', 'D-3']);
    // Without the filter the vector hits still take part.
    const all = await hybridSearch('worktree cleanup', root, { limit: 13 });
    expect(all.some((hit) => hit.type === 'observation')).toBe(true);
  });

  it('memory find --tables returns up to --limit hits when enough exist', async () => {
    await seed();
    const { searchBrainCompact } = await import('../retrieval/search.js');
    const found = await searchBrainCompact(root, {
      query: 'worktree cleanup',
      limit: 3,
      tables: ['decisions'],
    });
    // Before T13978 the fused top 6 were the vector+graph observations, which the
    // table filter then removed, leaving no decisions at all.
    expect(found.results.map((hit) => hit.id).sort()).toEqual(['D-1', 'D-2', 'D-3']);
  });
});

describe('eligibility statements are prepared once per table (T13978)', () => {
  it('reuses one prepared statement across hits of the same table', async () => {
    await seed();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { recallEligibleDate } = await import('../brain-search.js');
    const db = getBrainNativeDb(root)!;
    const prepare = vi.spyOn(db, 'prepare');
    const statements = new Map();
    for (const id of ['D-1', 'D-2', 'D-3']) {
      expect(recallEligibleDate(db, 'decision', id, undefined, statements)).not.toBeNull();
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(statements.size).toBe(1);
    prepare.mockRestore();
  });
});
