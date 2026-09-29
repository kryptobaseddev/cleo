/**
 * The System One benchmark reads a real fixture store through the core
 * accessors (temp project + temp CLEO_HOME), never raw SQL (T12495).
 *
 * @task T12495
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { benchDatasetSizes, buildBenchDataset, createStoreBenchSource } from '../bench/index.js';

describe('createStoreBenchSource over a fixture store', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    await env.cleanup();
  });

  it('builds every site from tasks, observations and decisions', async () => {
    await seedTasks(env.accessor, [
      { id: 'T100', title: 'Epic: benchmark fixture', type: 'epic' },
      { id: 'T101', title: 'Fix the writer lock timeout', parentId: 'T100' },
      { id: 'T102', title: 'Fix writer lock timeouts under load', parentId: 'T100' },
      {
        id: 'T103',
        title: 'Paginate search',
        parentId: 'T100',
        status: 'cancelled',
        cancellationReason: 'duplicate of T104',
        cancelledAt: '2026-09-01T00:00:00.000Z',
      },
      { id: 'T104', title: 'Search pagination', parentId: 'T100' },
      { id: 'T105', title: 'Rename the sentient tick', parentId: 'T100' },
      { id: 'T106', title: 'Audit the worktree guard', parentId: 'T100' },
    ]);
    await env.accessor.addRelation('T101', 'T102', 'duplicates', 'same bug');

    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const brain = await getBrainAccessor(env.tempDir);
    await brain.addObservation({
      id: 'O-1',
      type: 'decision',
      title: 'Chose SQLite',
      narrative: 'a crash in the old store settled it',
    });
    await brain.addObservation({
      id: 'O-2',
      type: 'bugfix',
      title: 'Crash',
      narrative: 'fixed a crash',
    });
    await brain.addDecision({
      id: 'D1',
      type: 'architecture',
      decision: 'Use SQLite for tasks',
      rationale: 'simple',
      confidence: 'high',
    });
    await brain.addDecision({
      id: 'D2',
      type: 'architecture',
      decision: 'Use Postgres instead of SQLite',
      rationale: 'scale',
      confidence: 'high',
      supersedes: 'D1',
    });
    await brain.addDecision({
      id: 'D3',
      type: 'process',
      decision: 'Release weekly',
      rationale: 'cadence',
      confidence: 'medium',
    });

    const rows = await buildBenchDataset(createStoreBenchSource(env.tempDir));
    const sizes = benchDatasetSizes(rows);
    expect(sizes.bySite['duplicateDetection']?.['duplicate']).toBe(2);
    expect(sizes.bySite['duplicateDetection']?.['distinct']).toBeGreaterThan(0);
    expect(sizes.bySite['observationType']).toEqual({ decision: 1 });
    expect(sizes.bySite['decisionContradiction']?.['conflict']).toBe(1);
    expect(sizes.bySite['decisionContradiction']?.['compatible']).toBeGreaterThan(0);
    const cancelled = rows.find((r) => r.provenance.rule === 'cancelled-duplicate-reason');
    expect(cancelled?.provenance.sourceIds).toEqual(['T103', 'T104']);
  });
});
