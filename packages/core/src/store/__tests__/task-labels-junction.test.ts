/**
 * Integration tests for the task_labels junction (T11356 · E4).
 *
 * Proves the fragile `labels_json LIKE '%label%'` filter is gone:
 *   - upsertSingleTask backfills the task_labels junction;
 *   - accessor.queryTasks({ label }) resolves via the index-backed junction;
 *   - a label that was previously a false-positive SUBSTRING match no longer
 *     matches (cross-array-boundary correctness);
 *   - updating labels keeps the junction in sync.
 *
 * @task T11356
 * @epic T11286
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataAccessor } from '../data-accessor.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

describe('task_labels junction (T11356)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('backfills the junction on upsert', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'tagged',
        status: 'pending',
        priority: 'medium',
        labels: ['bug', 'frontend'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const nativeDb = getNativeTasksDb();
    expect(nativeDb).not.toBeNull();
    const rows = nativeDb!
      .prepare('SELECT label FROM task_labels WHERE task_id = ? ORDER BY label')
      .all('T001') as Array<{ label: string }>;
    expect(rows.map((r) => r.label)).toEqual(['bug', 'frontend']);
  });

  it('queryTasks({ label }) returns only tasks carrying the exact label', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'a',
        status: 'pending',
        priority: 'medium',
        labels: ['bug', 'frontend'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'b',
        status: 'pending',
        priority: 'medium',
        labels: ['feature'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await accessor.queryTasks({ label: 'bug' });
    expect(result.tasks.map((t) => t.id)).toEqual(['T001']);
  });

  it('does NOT match across array boundaries (former substring false positive)', async () => {
    // Old behavior: `labels_json LIKE '%"tier2"%'` matched a note tagged
    // 'sentient-tier2' because the serialized JSON contained the substring.
    // The junction stores exact label values, so 'tier2' must NOT match
    // 'sentient-tier2'.
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'compound label',
        status: 'pending',
        priority: 'medium',
        labels: ['sentient-tier2'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'exact label',
        status: 'pending',
        priority: 'medium',
        labels: ['tier2'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const tier2 = await accessor.queryTasks({ label: 'tier2' });
    expect(tier2.tasks.map((t) => t.id)).toEqual(['T002']);

    const sentient = await accessor.queryTasks({ label: 'sentient-tier2' });
    expect(sentient.tasks.map((t) => t.id)).toEqual(['T001']);
  });

  it('keeps the junction in sync when labels change', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'changes labels',
        status: 'pending',
        priority: 'medium',
        labels: ['old'],
        createdAt: new Date().toISOString(),
      },
    ]);

    // Re-upsert with a different label set.
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'changes labels',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      size: 'small',
      parentId: null,
      labels: ['new'],
      depends: [],
      acceptance: [],
      createdAt: new Date().toISOString(),
    } as Parameters<DataAccessor['upsertSingleTask']>[0]);

    const oldHits = await accessor.queryTasks({ label: 'old' });
    expect(oldHits.tasks).toHaveLength(0);
    const newHits = await accessor.queryTasks({ label: 'new' });
    expect(newHits.tasks.map((t) => t.id)).toEqual(['T001']);
  });
});
