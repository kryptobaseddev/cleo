/**
 * Tests for label management.
 * @task T4627
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { getLabelStats, listLabels, showLabelTasks } from '../labels.js';

describe('label operations', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('listLabels', () => {
    it('lists all labels with counts', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task 1',
          status: 'pending',
          priority: 'medium',
          labels: ['bug', 'frontend'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Task 2',
          status: 'done',
          priority: 'high',
          labels: ['bug'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T003',
          title: 'Task 3',
          status: 'active',
          priority: 'low',
          labels: ['feature'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const labels = await listLabels(env.tempDir, accessor);
      expect(labels).toHaveLength(3);

      const bugLabel = labels.find((l) => l.label === 'bug');
      expect(bugLabel?.count).toBe(2);
      expect(bugLabel?.statuses['pending']).toBe(1);
      expect(bugLabel?.statuses['done']).toBe(1);
    });

    it('sorts by count descending', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task 1',
          status: 'pending',
          priority: 'medium',
          labels: ['a'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Task 2',
          status: 'pending',
          priority: 'medium',
          labels: ['b', 'a'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T003',
          title: 'Task 3',
          status: 'pending',
          priority: 'medium',
          labels: ['a'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const labels = await listLabels(env.tempDir, accessor);
      expect(labels[0].label).toBe('a');
      expect(labels[0].count).toBe(3);
    });

    it('returns empty for tasks without labels', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task 1',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const labels = await listLabels(env.tempDir, accessor);
      expect(labels).toHaveLength(0);
    });
  });

  describe('showLabelTasks', () => {
    it('returns tasks with matching label', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Bug fix',
          status: 'pending',
          priority: 'high',
          labels: ['bug'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Feature',
          status: 'active',
          priority: 'medium',
          labels: ['feature'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T003',
          title: 'Another bug',
          status: 'done',
          priority: 'low',
          labels: ['bug', 'frontend'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = (await showLabelTasks('bug', env.tempDir, accessor)) as {
        label: string;
        tasks: Array<{ id: string }>;
        count: number;
      };
      expect(result.label).toBe('bug');
      expect(result.count).toBe(2);
      expect(result.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['T001', 'T003']);
    });

    it('throws for nonexistent label', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          labels: ['bug'],
          createdAt: new Date().toISOString(),
        },
      ]);

      await expect(showLabelTasks('nonexistent', env.tempDir, accessor)).rejects.toThrow(
        'No tasks found',
      );
    });
  });

  describe('getLabelStats', () => {
    it('returns label statistics', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task 1',
          status: 'pending',
          priority: 'medium',
          labels: ['bug', 'frontend'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Task 2',
          status: 'done',
          priority: 'high',
          labels: ['bug'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const stats = (await getLabelStats(env.tempDir, accessor)) as {
        totalLabels: number;
        totalUsages: number;
        avgPerLabel: number;
      };
      expect(stats.totalLabels).toBe(2); // 'bug' and 'frontend'
      expect(stats.totalUsages).toBe(3); // bug x2 + frontend x1
      expect(stats.avgPerLabel).toBe(1.5);
    });
  });
});
