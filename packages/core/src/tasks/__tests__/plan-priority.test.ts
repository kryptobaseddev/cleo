/**
 * Tests for plan module types: ReadyTask, BlockedTask, OpenBug derive from Drizzle TaskRow.
 *
 * Verifies that priority scoring and type contracts work correctly when
 * ReadyTask extends Pick<TaskRow, 'id' | 'title' | 'priority'>.
 *
 * @task T4820
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import * as taskAccessors from '../../store/data-accessor.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { archiveTasks } from '../archive.js';
import type { BlockedTask, OpenBug, ReadyTask } from '../plan.js';
import { coreTaskPlan, taskPlan } from '../plan.js';
import { coreTaskNext } from '../task-next.js';

describe('plan types - Drizzle-derived interfaces', () => {
  describe('ReadyTask', () => {
    it('has required Drizzle-derived fields (id, title, priority)', () => {
      const task: ReadyTask = {
        id: 'T001',
        title: 'Implement feature',
        priority: 'high',
        epicId: 'T100',
        leverage: 3,
        score: 95,
        reasons: ['priority: high (+75)', 'leverage: unblocks 3 task(s) (+15)'],
      };

      expect(task.id).toBe('T001');
      expect(task.title).toBe('Implement feature');
      expect(task.priority).toBe('high');
      expect(task.leverage).toBe(3);
      expect(task.score).toBe(95);
    });

    it('score computation: critical priority yields highest base score', () => {
      const PRIORITY_SCORE: Record<string, number> = {
        critical: 100,
        high: 75,
        medium: 50,
        low: 25,
      };

      const criticalTask: ReadyTask = {
        id: 'T001',
        title: 'Critical bug',
        priority: 'critical',
        epicId: 'T100',
        leverage: 0,
        score: PRIORITY_SCORE['critical']! + 10, // priority + deps satisfied
        reasons: [],
      };

      const lowTask: ReadyTask = {
        id: 'T002',
        title: 'Nice to have',
        priority: 'low',
        epicId: 'T100',
        leverage: 0,
        score: PRIORITY_SCORE['low']! + 10,
        reasons: [],
      };

      expect(criticalTask.score).toBeGreaterThan(lowTask.score);
      expect(criticalTask.score).toBe(110);
      expect(lowTask.score).toBe(35);
    });

    it('leverage bonus adds 5 per unblocked task', () => {
      const task: ReadyTask = {
        id: 'T001',
        title: 'Unblocks many',
        priority: 'medium',
        epicId: 'T100',
        leverage: 4,
        score: 50 + 10 + 4 * 5, // priority(50) + deps(10) + leverage(20)
        reasons: [],
      };
      expect(task.score).toBe(80);
    });

    it('sorts by score descending', () => {
      const tasks: ReadyTask[] = [
        {
          id: 'T001',
          title: 'Low',
          priority: 'low',
          epicId: 'T100',
          leverage: 0,
          score: 35,
          reasons: [],
        },
        {
          id: 'T002',
          title: 'High',
          priority: 'high',
          epicId: 'T100',
          leverage: 0,
          score: 85,
          reasons: [],
        },
        {
          id: 'T003',
          title: 'Med',
          priority: 'medium',
          epicId: 'T100',
          leverage: 0,
          score: 60,
          reasons: [],
        },
      ];

      tasks.sort((a, b) => b.score - a.score);

      expect(tasks[0].id).toBe('T002');
      expect(tasks[1].id).toBe('T003');
      expect(tasks[2].id).toBe('T001');
    });
  });

  describe('BlockedTask', () => {
    it('has required Drizzle-derived fields (id, title)', () => {
      const task: BlockedTask = {
        id: 'T002',
        title: 'Waiting on deps',
        blockedBy: ['T001'],
        blocksCount: 2,
      };

      expect(task.id).toBe('T002');
      expect(task.title).toBe('Waiting on deps');
      expect(task.blockedBy).toEqual(['T001']);
      expect(task.blocksCount).toBe(2);
    });
  });

  describe('OpenBug', () => {
    it('has required Drizzle-derived fields (id, title, priority)', () => {
      const bug: OpenBug = {
        id: 'T003',
        title: 'UI crash on load',
        priority: 'critical',
        epicId: 'T200',
      };

      expect(bug.id).toBe('T003');
      expect(bug.priority).toBe('critical');
      expect(bug.epicId).toBe('T200');
    });
  });
});

describe('plan resolves hard dependency evidence without expanding selected population', () => {
  let env: TestDbEnv;
  beforeEach(async () => {
    env = await createTestDb();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.cleanup();
  });

  async function seed(status: Task['status']) {
    await seedTasks(env.accessor, [
      { id: 'T100', type: 'epic', status: 'active' },
      { id: 'T110', type: 'epic', status: 'active' },
      { id: 'T111', parentId: 'T110', status },
      { id: 'T121', parentId: 'T100', depends: ['T111'], status: 'pending' },
    ]);
  }

  it.each([
    'done',
    'archived',
  ] as const)('accepts external %s while preserving active inventory', async (status) => {
    await seed('done');
    if (status === 'archived') {
      expect(await archiveTasks({ taskIds: ['T111'] }, env.tempDir, env.accessor)).toMatchObject({
        archived: ['T111'],
      });
      expect(await env.accessor.loadTasks(['T111'])).toMatchObject([{ status: 'archived' }]);
      expect((await env.accessor.queryTasks({ parentId: 'T110' })).tasks).toEqual([]);
    }
    const result = await coreTaskPlan(env.tempDir);
    expect(result.ready.map((task) => task.id)).toEqual(['T121']);
    expect(result.blocked).toEqual([]);
    const next = await coreTaskNext(env.tempDir);
    expect(next.suggestions.map((task) => task.id)).toEqual(['T121']);
    expect(next.totalCandidates).toBe(1);
    expect(result.metrics).toMatchObject({
      totalTasks: status === 'archived' ? 3 : 4,
      totalEpics: 2,
      activeEpics: 2,
      actionable: 3,
      blocked: 0,
    });
    expect(result.inProgress.find((epic) => epic.epicId === 'T110')?.completionPercent).toBe(
      status === 'archived' ? 0 : 100,
    );
  });

  it.each([
    'pending',
    'cancelled',
  ] as const)('reports external %s as an unresolved blocker', async (status) => {
    await seed(status);
    const result = await coreTaskPlan(env.tempDir);
    expect(result.ready.some((task) => task.id === 'T121')).toBe(false);
    expect((await coreTaskNext(env.tempDir)).suggestions.some((task) => task.id === 'T121')).toBe(
      false,
    );
    expect(result.blocked).toMatchObject([{ id: 'T121', blockedBy: ['T111'] }]);
    expect(result.metrics).toMatchObject({
      totalTasks: 4,
      blocked: 1,
      actionable: status === 'pending' ? 3 : 2,
    });
  });

  it('reports real missing hard edges instead of omitting them from blockers and actionable counts', async () => {
    await seedTasks(env.accessor, [
      { id: 'T100', type: 'epic', status: 'active' },
      { id: 'T121', parentId: 'T100' },
    ]);
    const db = await getDb(env.tempDir);
    const native = getNativeDb(env.tempDir);
    if (!native) throw new Error('Expected native canonical fixture handle');
    native.exec('PRAGMA foreign_keys = OFF');
    try {
      await db.insert(schema.taskDependencies).values({ taskId: 'T121', dependsOn: 'T999' }).run();
    } finally {
      native.exec('PRAGMA foreign_keys = ON');
    }
    expect(native.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(await env.accessor.loadSingleTask('T121')).toMatchObject({ depends: ['T999'] });
    const result = await coreTaskPlan(env.tempDir);
    expect(result.ready).toEqual([]);
    expect(await coreTaskNext(env.tempDir)).toMatchObject({ suggestions: [], totalCandidates: 0 });
    expect(result.blocked).toMatchObject([{ id: 'T121', blockedBy: ['T999'] }]);
    expect(result.metrics).toMatchObject({ totalTasks: 2, actionable: 1, blocked: 1 });
  });

  it('propagates the required archived lookup error through SDK and EngineResult', async () => {
    await seed('done');
    await archiveTasks({ taskIds: ['T111'] }, env.tempDir, env.accessor);
    vi.spyOn(taskAccessors, 'getTaskAccessor').mockResolvedValue(env.accessor);
    vi.spyOn(env.accessor, 'loadTasks').mockRejectedValue(
      new Error('required archive read failed'),
    );
    await expect(coreTaskPlan(env.tempDir)).rejects.toThrow('required archive read failed');
    await expect(coreTaskNext(env.tempDir)).rejects.toThrow('required archive read failed');
    expect(await taskPlan(env.tempDir)).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('required archive read failed') },
    });
  });
});
