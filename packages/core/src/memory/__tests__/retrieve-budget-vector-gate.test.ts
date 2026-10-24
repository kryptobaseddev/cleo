/**
 * retrieveWithBudget gates vector-only hits like FTS hits (T13968): an
 * embedded auto row, a low-quality row or an invalidated row that only the
 * vector search returns never reaches budgeted retrieval.
 *
 * @task T13968
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimilarityResult } from '../brain-similarity.js';

const { mockSearchSimilar } = vi.hoisted(() => ({
  mockSearchSimilar: vi.fn<() => Promise<SimilarityResult[]>>(),
}));
vi.mock('../brain-similarity.js', () => ({
  searchSimilar: mockSearchSimilar,
  searchSimilarWithStatus: vi.fn(async () => ({ results: await mockSearchSimilar() })),
}));

import { closeBrainDb, getBrainDb, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { buildTraceText } from '../dispatch-trace-format.js';
import { retrieveWithBudget } from '../retrieval/search.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-budget-vector-gate-'));
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'home'));
  vi.stubEnv('CLEO_DIR', join(dir, '.cleo'));
  vi.stubEnv('CLEO_ROOT', dir);
});

afterEach(() => {
  closeBrainDb();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A vector hit for a seeded row. */
function hit(id: string, type: string, text: string): SimilarityResult {
  return { id, type, title: text, text, distance: 0.1 };
}

describe('retrieveWithBudget vector gate (T13968)', () => {
  it('drops vector-only auto, low-quality and invalidated rows, keeps a real one', async () => {
    await getBrainDb(dir);
    const db = getBrainNativeDb(dir);
    if (!db) throw new Error('brain unavailable');
    const trace = buildTraceText({
      taskId: '',
      predictedAgentId: 'cleo-subagent',
      confidence: 0,
      reason: 'universal-base fallback',
      registryHit: false,
      fallbackUsed: true,
      resolvedAt: '2026-10-01T00:00:00.000Z',
    });
    db.prepare(
      "INSERT INTO main.brain_patterns (id, type, pattern, context) VALUES ('P-trace', 'workflow', ?, 'ctx')",
    ).run(trace);
    const observation = db.prepare(
      'INSERT INTO main.brain_observations (id, type, title, narrative, quality_score, invalid_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    observation.run(
      'O-stub',
      'feature',
      'Task complete: T1',
      'Task T1 completed with status: done',
      null,
      null,
    );
    observation.run('O-low', 'discovery', 'Low quality', 'barely anything', 0.01, null);
    observation.run('O-gone', 'discovery', 'Invalidated', 'superseded fact', null, '2026-10-01');
    observation.run('O-real', 'discovery', 'Worktree incident', 'cancel destroys it', null, null);
    mockSearchSimilar.mockResolvedValue([
      hit('P-trace', 'pattern', trace),
      hit('O-stub', 'observation', 'Task complete: T1'),
      hit('O-low', 'observation', 'Low quality'),
      hit('O-gone', 'observation', 'Invalidated'),
      hit('O-real', 'observation', 'Worktree incident'),
    ]);

    const result = await retrieveWithBudget(dir, 'semanticonlyquery', 5000);

    expect(result.entries.map((entry) => entry.id)).toEqual(['O-real']);
  });
});
