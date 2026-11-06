/**
 * `memory find --limit 0` returns every match (T14320), and lessons are
 * findable through `memory find` (T14321).
 *
 * @task T14320
 * @task T14321
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainCompactHit } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryFind } from '../engine-compat.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-memory-find-'));
  await mkdir(join(root, '.cleo'), { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  process.env['CLEO_DIR'] = join(root, '.cleo');
  // An empty main brain of its own, so only the seeded rows can match.
  process.env['CLEO_HOME'] = join(root, 'home');
  const { _resetDualScopeDbCache } = await import('../../store/dual-scope-db.js');
  _resetDualScopeDbCache();
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  const { _resetDualScopeDbCache } = await import('../../store/dual-scope-db.js');
  _resetDualScopeDbCache();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];
  await rm(root, { recursive: true, force: true });
});

async function seed(
  rows: Array<{ id: string; type: 'lesson' | 'discovery'; title: string; narrative: string }>,
): Promise<void> {
  const { getBrainAccessor } = await import('../../store/memory-accessor.js');
  const accessor = await getBrainAccessor(root);
  for (const row of rows) await accessor.addObservation({ ...row, sourceType: 'manual' });
}

async function find(params: Parameters<typeof memoryFind>[0]): Promise<BrainCompactHit[]> {
  const result = await memoryFind(params, root);
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return (result.data as { results: BrainCompactHit[] }).results;
}

describe('memory find --limit 0 (T14320)', () => {
  it('returns every match of 4 seeded rows, and --limit 3 returns 3', async () => {
    await seed(
      [1, 2, 3, 4].map((n) => ({
        id: `O-wt${n}`,
        type: 'discovery' as const,
        title: `worktree note ${n}`,
        narrative: `the worktree index leaked in run ${n}`,
      })),
    );
    const all = await find({ query: 'worktree', limit: 0 });
    expect(all.map((h) => h.id).sort()).toEqual(['O-wt1', 'O-wt2', 'O-wt3', 'O-wt4']);
    expect(await find({ query: 'worktree', limit: 3 })).toHaveLength(3);
  });
});

describe('lessons through memory find (T14321)', () => {
  beforeEach(async () => {
    await seed([
      {
        id: 'O-rule',
        type: 'lesson',
        title: 'Stage explicit paths before every commit',
        narrative: 'A hook staged stray files into the index after a commit.',
      },
      {
        id: 'O-note',
        type: 'discovery',
        title: 'Explicit paths keep the index clean',
        narrative: 'A discovery, not a lesson row.',
      },
    ]);
  });

  it('a query naming the lesson type returns the lesson rows', async () => {
    const hits = await find({ query: 'lesson' });
    expect(hits.map((h) => h.id)).toContain('O-rule');
  });

  it('--type lesson filters to lessons, matched on the rule and the why', async () => {
    expect((await find({ query: 'explicit', lessons: true })).map((h) => h.id)).toEqual(['O-rule']);
    expect((await find({ query: 'stray index', lessons: true })).map((h) => h.id)).toEqual([
      'O-rule',
    ]);
    expect(await find({ query: 'unrelated', lessons: true })).toEqual([]);
    expect((await find({ query: 'lessons', lessons: true })).map((h) => h.id)).toEqual(['O-rule']);
  });
});
