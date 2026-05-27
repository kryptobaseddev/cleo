/**
 * Tests for the `--urgent` unified urgency surface (T9905).
 *
 * Tasks carry two orthogonal urgency axes: `priority` (low|medium|high|critical)
 * and `severity` (P0|P1|P2|P3). Before T9905 there was no unified way to surface
 * "urgent" tasks — agents had to query each axis separately. The `--urgent` flag
 * on `cleo find` selects tasks where
 *
 *   priority IN ('critical','high') OR severity IN ('P0','P1')
 *
 * This file covers the core `findTasks({ urgent: true })` behaviour.
 *
 * @task T9905
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../find.js';

/** Build a mock DataAccessor wrapping an in-memory task array. */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async () => ({ tasks, total: tasks.length }),
    loadArchive: async () => ({ archivedTasks: [] }),
  } as unknown as DataAccessor;
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.id,
    description: '',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    parentId: null,
    labels: [],
    depends: [],
    acceptance: [],
    createdAt: '2026-04-22T00:00:00Z',
    ...overrides,
  } as Task;
}

describe('findTasks --urgent', () => {
  it('selects critical-priority tasks', async () => {
    const tasks = [
      makeTask({ id: 'T001', priority: 'critical' }),
      makeTask({ id: 'T002', priority: 'medium' }),
      makeTask({ id: 'T003', priority: 'low' }),
    ];
    const result = await findTasks({ urgent: true }, '/mock', mockAccessor(tasks));
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['T001']);
  });

  it('selects high-priority tasks', async () => {
    const tasks = [
      makeTask({ id: 'T001', priority: 'high' }),
      makeTask({ id: 'T002', priority: 'medium' }),
    ];
    const result = await findTasks({ urgent: true }, '/mock', mockAccessor(tasks));
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('selects P0/P1 severity tasks regardless of priority', async () => {
    const tasks = [
      makeTask({ id: 'T001', priority: 'low', severity: 'P0' }),
      makeTask({ id: 'T002', priority: 'medium', severity: 'P1' }),
      makeTask({ id: 'T003', priority: 'medium', severity: 'P2' }),
      makeTask({ id: 'T004', priority: 'medium' }),
    ];
    const result = await findTasks({ urgent: true }, '/mock', mockAccessor(tasks));
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('combines priority OR severity disjunctively (T9905 unified surface)', async () => {
    const tasks = [
      makeTask({ id: 'T001', priority: 'critical', severity: 'P3' }), // critical wins
      makeTask({ id: 'T002', priority: 'low', severity: 'P0' }), // P0 wins
      makeTask({ id: 'T003', priority: 'medium', severity: 'P2' }), // neither
    ];
    const result = await findTasks({ urgent: true }, '/mock', mockAccessor(tasks));
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('returns empty results when nothing is urgent', async () => {
    const tasks = [
      makeTask({ id: 'T001', priority: 'medium', severity: 'P3' }),
      makeTask({ id: 'T002', priority: 'low' }),
    ];
    const result = await findTasks({ urgent: true }, '/mock', mockAccessor(tasks));
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });
});
