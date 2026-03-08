/**
 * Tests for stats/index.ts: rankBlockedTask and getDashboard.
 *
 * @task T0000
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAccessor } from '../../../store/data-accessor.js';
import type { Task, TaskFile } from '../../../types/task.js';
import { getDashboard, rankBlockedTask } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    status: 'blocked',
    priority: 'medium',
    createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), // 5 days ago
    ...overrides,
  } as Task;
}

function makeAccessor(tasks: Task[], focusId?: string): DataAccessor {
  const taskFile: TaskFile = {
    version: '1.0.0',
    project: { name: 'Test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: { schemaVersion: '1.0.0', checksum: '', configVersion: '1.0.0' },
    focus: focusId ? { currentTask: focusId } : undefined,
    tasks,
  };
  return {
    engine: 'sqlite',
    loadTaskFile: vi.fn().mockResolvedValue(taskFile),
    saveTaskFile: vi.fn(),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue([]),
    saveSessions: vi.fn(),
  } as unknown as DataAccessor;
}

// ---------------------------------------------------------------------------
// rankBlockedTask
// ---------------------------------------------------------------------------

describe('rankBlockedTask', () => {
  const allTasks: Task[] = [];

  it('critical priority scores higher than high priority', () => {
    const critical = makeTask({ id: 'T001', title: 'Critical', priority: 'critical' });
    const high = makeTask({ id: 'T002', title: 'High', priority: 'high' });

    const scoreCritical = rankBlockedTask(critical, allTasks, null);
    const scoreHigh = rankBlockedTask(high, allTasks, null);

    expect(scoreCritical).toBeGreaterThan(scoreHigh);
  });

  it('high priority scores higher than low priority', () => {
    const high = makeTask({ id: 'T001', title: 'High', priority: 'high' });
    const low = makeTask({ id: 'T002', title: 'Low', priority: 'low' });

    expect(rankBlockedTask(high, allTasks, null)).toBeGreaterThan(
      rankBlockedTask(low, allTasks, null),
    );
  });

  it('downstream impact: more dependents yields higher score', () => {
    const blocker = makeTask({ id: 'T001', title: 'Blocker', priority: 'medium' });

    const manyDownstream: Task[] = [
      makeTask({ id: 'T010', title: 'D1', status: 'pending', depends: ['T001'] }),
      makeTask({ id: 'T011', title: 'D2', status: 'pending', depends: ['T001'] }),
      makeTask({ id: 'T012', title: 'D3', status: 'pending', depends: ['T001'] }),
    ];
    const noDownstream: Task[] = [];

    expect(rankBlockedTask(blocker, manyDownstream, null)).toBeGreaterThan(
      rankBlockedTask(blocker, noDownstream, null),
    );
  });

  it('downstream dependents with done status are not counted', () => {
    const blocker = makeTask({ id: 'T001', title: 'Blocker', priority: 'medium' });

    const doneDependent: Task[] = [
      makeTask({ id: 'T010', title: 'Done dep', status: 'done', depends: ['T001'] }),
    ];
    const pendingDependent: Task[] = [
      makeTask({ id: 'T011', title: 'Pending dep', status: 'pending', depends: ['T001'] }),
    ];

    expect(rankBlockedTask(blocker, doneDependent, null)).toBeLessThan(
      rankBlockedTask(blocker, pendingDependent, null),
    );
  });

  it('older task scores higher due to age weight (capped at 30)', () => {
    const old = makeTask({
      id: 'T001',
      title: 'Old',
      priority: 'medium',
      createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), // 20 days ago
    });
    const newer = makeTask({
      id: 'T002',
      title: 'Newer',
      priority: 'medium',
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), // 2 days ago
    });

    expect(rankBlockedTask(old, allTasks, null)).toBeGreaterThan(
      rankBlockedTask(newer, allTasks, null),
    );
  });

  it('age is capped at 30 days', () => {
    const veryOld = makeTask({
      id: 'T001',
      title: 'Very old',
      priority: 'medium',
      createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), // 60 days
    });
    const thirtyDaysOld = makeTask({
      id: 'T002',
      title: '30 days old',
      priority: 'medium',
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), // 30 days
    });

    // Both should be capped at 30 age points, so score should be equal (all else equal)
    expect(rankBlockedTask(veryOld, allTasks, null)).toBe(
      rankBlockedTask(thirtyDaysOld, allTasks, null),
    );
  });

  it('focus proximity: sibling of focused task gets +15 boost', () => {
    const focus = makeTask({ id: 'T100', title: 'Focus', parentId: 'T050' });
    const sibling = makeTask({
      id: 'T101',
      title: 'Sibling',
      priority: 'medium',
      parentId: 'T050',
    });
    const unrelated = makeTask({ id: 'T200', title: 'Unrelated', priority: 'medium' });

    expect(rankBlockedTask(sibling, allTasks, focus)).toBeGreaterThan(
      rankBlockedTask(unrelated, allTasks, focus),
    );

    // Exactly +15 difference (all else equal with same dates — we use same dates below)
    const siblingBase = makeTask({
      id: 'T001',
      title: 'Sib',
      priority: 'medium',
      parentId: 'T050',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const unrelatedBase = makeTask({
      id: 'T002',
      title: 'Unrel',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const diff =
      rankBlockedTask(siblingBase, allTasks, focus) -
      rankBlockedTask(unrelatedBase, allTasks, focus);
    expect(diff).toBe(15);
  });

  it('focus proximity: child of focused task gets +15 boost', () => {
    const focus = makeTask({ id: 'T100', title: 'Focus' });
    const child = makeTask({
      id: 'T101',
      title: 'Child',
      priority: 'medium',
      parentId: 'T100',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const unrelated = makeTask({
      id: 'T200',
      title: 'Unrelated',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    const diff =
      rankBlockedTask(child, allTasks, focus) - rankBlockedTask(unrelated, allTasks, focus);
    expect(diff).toBe(15);
  });

  it('focus proximity: parent of focused task gets +15 boost', () => {
    const focus = makeTask({ id: 'T100', title: 'Focus', parentId: 'T050' });
    const parent = makeTask({
      id: 'T050',
      title: 'Parent',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const unrelated = makeTask({
      id: 'T200',
      title: 'Unrelated',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    const diff =
      rankBlockedTask(parent, allTasks, focus) - rankBlockedTask(unrelated, allTasks, focus);
    expect(diff).toBe(15);
  });

  it('urgent label boost: +8 per urgent label', () => {
    const withUrgentLabel = makeTask({
      id: 'T001',
      title: 'Urgent',
      priority: 'medium',
      labels: ['bug'],
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const withoutLabels = makeTask({
      id: 'T002',
      title: 'Normal',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    const diff =
      rankBlockedTask(withUrgentLabel, allTasks, null) -
      rankBlockedTask(withoutLabels, allTasks, null);
    expect(diff).toBe(8);
  });

  it('urgent label boost: all three urgent labels accumulate (+24)', () => {
    const withAll = makeTask({
      id: 'T001',
      title: 'All urgent',
      priority: 'medium',
      labels: ['critical', 'blocker', 'bug'],
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const withNone = makeTask({
      id: 'T002',
      title: 'None',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    const diff =
      rankBlockedTask(withAll, allTasks, null) - rankBlockedTask(withNone, allTasks, null);
    expect(diff).toBe(24);
  });

  it('urgent label matching is case-insensitive', () => {
    const withUpper = makeTask({
      id: 'T001',
      title: 'Upper',
      priority: 'medium',
      labels: ['BUG'],
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const withLower = makeTask({
      id: 'T002',
      title: 'Lower',
      priority: 'medium',
      labels: ['bug'],
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    expect(rankBlockedTask(withUpper, allTasks, null)).toBe(
      rankBlockedTask(withLower, allTasks, null),
    );
  });

  it('staleness penalty: updated < 3 days ago subtracts 10', () => {
    const recentlyUpdated = makeTask({
      id: 'T001',
      title: 'Recent',
      priority: 'medium',
      updatedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // 1 day ago
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const neverUpdated = makeTask({
      id: 'T002',
      title: 'Stale',
      priority: 'medium',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });

    const diff =
      rankBlockedTask(neverUpdated, allTasks, null) -
      rankBlockedTask(recentlyUpdated, allTasks, null);
    expect(diff).toBe(10);
  });

  it('staleness penalty does not apply when updated >= 3 days ago', () => {
    const oldUpdate = makeTask({
      id: 'T001',
      title: 'Old update',
      priority: 'medium',
      updatedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), // 5 days ago
      createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    const neverUpdated = makeTask({
      id: 'T002',
      title: 'Never',
      priority: 'medium',
      createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });

    // Both have same age, old update doesn't trigger penalty, neverUpdated doesn't either
    expect(rankBlockedTask(oldUpdate, allTasks, null)).toBe(
      rankBlockedTask(neverUpdated, allTasks, null),
    );
  });
});

// ---------------------------------------------------------------------------
// getDashboard
// ---------------------------------------------------------------------------

describe('getDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct pagination shape: { count, limit, tasks }', async () => {
    const blockedTask = makeTask({ id: 'T001', title: 'Blocked', status: 'blocked' });
    const accessor = makeAccessor([blockedTask]);

    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const bt = result['blockedTasks'] as { count: number; limit: number; tasks: Task[] };

    expect(bt).toHaveProperty('count');
    expect(bt).toHaveProperty('limit');
    expect(bt).toHaveProperty('tasks');
    expect(typeof bt.count).toBe('number');
    expect(typeof bt.limit).toBe('number');
    expect(Array.isArray(bt.tasks)).toBe(true);
  });

  it('default blockedTasksLimit is 10', async () => {
    const accessor = makeAccessor([]);
    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const bt = result['blockedTasks'] as { limit: number };
    expect(bt.limit).toBe(10);
  });

  it('custom blockedTasksLimit is respected', async () => {
    const tasks: Task[] = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: `T${String(i).padStart(3, '0')}`, title: `Task ${i}`, status: 'blocked' }),
    );
    const accessor = makeAccessor(tasks);

    const result = await getDashboard({ cwd: '/fake', blockedTasksLimit: 5 }, accessor);
    const bt = result['blockedTasks'] as { count: number; limit: number; tasks: Task[] };

    expect(bt.limit).toBe(5);
    expect(bt.tasks.length).toBeLessThanOrEqual(5);
    expect(bt.count).toBe(15); // total count is unaffected by limit
  });

  it('count reflects all blocked tasks even when limit is smaller', async () => {
    const tasks: Task[] = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `T${String(i).padStart(3, '0')}`, title: `Task ${i}`, status: 'blocked' }),
    );
    const accessor = makeAccessor(tasks);

    const result = await getDashboard({ cwd: '/fake', blockedTasksLimit: 3 }, accessor);
    const bt = result['blockedTasks'] as { count: number; tasks: Task[] };

    expect(bt.count).toBe(20);
    expect(bt.tasks.length).toBe(3);
  });

  it('highPriority sorts critical before high', async () => {
    const highTask = makeTask({
      id: 'T001',
      title: 'High',
      status: 'pending',
      priority: 'high',
      createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    const criticalTask = makeTask({
      id: 'T002',
      title: 'Critical',
      status: 'pending',
      priority: 'critical',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const accessor = makeAccessor([highTask, criticalTask]);

    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const hp = result['highPriority'] as { tasks: Task[] };

    expect(hp.tasks.length).toBeGreaterThan(0);
    expect(hp.tasks[0]!.priority).toBe('critical');
    expect(hp.tasks[1]!.priority).toBe('high');
  });

  it('highPriority age tiebreaker: older task comes first within same priority', async () => {
    const newerHigh = makeTask({
      id: 'T001',
      title: 'Newer high',
      status: 'pending',
      priority: 'high',
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const olderHigh = makeTask({
      id: 'T002',
      title: 'Older high',
      status: 'pending',
      priority: 'high',
      createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    const accessor = makeAccessor([newerHigh, olderHigh]);

    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const hp = result['highPriority'] as { tasks: Task[] };

    const ids = hp.tasks.map((t) => t.id);
    expect(ids.indexOf('T002')).toBeLessThan(ids.indexOf('T001'));
  });

  it('blocked tasks are ranked by score (higher score first)', async () => {
    const criticalBlocked = makeTask({
      id: 'T001',
      title: 'Critical blocked',
      status: 'blocked',
      priority: 'critical',
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const lowBlocked = makeTask({
      id: 'T002',
      title: 'Low blocked',
      status: 'blocked',
      priority: 'low',
      createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    });
    const accessor = makeAccessor([lowBlocked, criticalBlocked]);

    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const bt = result['blockedTasks'] as { tasks: Task[] };

    expect(bt.tasks[0]!.id).toBe('T001'); // critical should rank first
  });

  it('non-blocked tasks are excluded from blockedTasks', async () => {
    const blocked = makeTask({ id: 'T001', title: 'Blocked', status: 'blocked' });
    const pending = makeTask({ id: 'T002', title: 'Pending', status: 'pending' });
    const done = makeTask({ id: 'T003', title: 'Done', status: 'done' });
    const accessor = makeAccessor([blocked, pending, done]);

    const result = await getDashboard({ cwd: '/fake' }, accessor);
    const bt = result['blockedTasks'] as { count: number; tasks: Task[] };

    expect(bt.count).toBe(1);
    expect(bt.tasks.every((t) => t.status === 'blocked')).toBe(true);
  });
});
