/**
 * Tests for label management.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listLabels, showLabelTasks, getLabelStats } from '../labels.js';
import type { TodoFile } from '../../../types/task.js';

describe('label operations', () => {
  let tempDir: string;
  let cleoDir: string;

  const makeTodoFile = (tasks: TodoFile['tasks']): TodoFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    tasks,
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('listLabels', () => {
    it('lists all labels with counts', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', labels: ['bug', 'frontend'], createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', labels: ['bug'], createdAt: new Date().toISOString() },
        { id: 'T003', title: 'Task 3', status: 'active', priority: 'low', labels: ['feature'], createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      const labels = await listLabels(tempDir);
      expect(labels).toHaveLength(3);

      const bugLabel = labels.find(l => l.label === 'bug');
      expect(bugLabel?.count).toBe(2);
      expect(bugLabel?.statuses['pending']).toBe(1);
      expect(bugLabel?.statuses['done']).toBe(1);
    });

    it('sorts by count descending', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', labels: ['a'], createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Task 2', status: 'pending', priority: 'medium', labels: ['b', 'a'], createdAt: new Date().toISOString() },
        { id: 'T003', title: 'Task 3', status: 'pending', priority: 'medium', labels: ['a'], createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      const labels = await listLabels(tempDir);
      expect(labels[0].label).toBe('a');
      expect(labels[0].count).toBe(3);
    });

    it('returns empty for tasks without labels', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      const labels = await listLabels(tempDir);
      expect(labels).toHaveLength(0);
    });
  });

  describe('showLabelTasks', () => {
    it('returns tasks with matching label', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Bug fix', status: 'pending', priority: 'high', labels: ['bug'], createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Feature', status: 'active', priority: 'medium', labels: ['feature'], createdAt: new Date().toISOString() },
        { id: 'T003', title: 'Another bug', status: 'done', priority: 'low', labels: ['bug', 'frontend'], createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      const result = await showLabelTasks('bug', tempDir) as { label: string; tasks: Array<{ id: string }>; count: number };
      expect(result.label).toBe('bug');
      expect(result.count).toBe(2);
      expect(result.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['T001', 'T003']);
    });

    it('throws for nonexistent label', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', labels: ['bug'], createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      await expect(showLabelTasks('nonexistent', tempDir)).rejects.toThrow('No tasks found');
    });
  });

  describe('getLabelStats', () => {
    it('returns label statistics', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', labels: ['bug', 'frontend'], createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', labels: ['bug'], createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

      const stats = await getLabelStats(tempDir) as { totalLabels: number; totalUsages: number; avgPerLabel: number };
      expect(stats.totalLabels).toBe(2); // 'bug' and 'frontend'
      expect(stats.totalUsages).toBe(3); // bug x2 + frontend x1
      expect(stats.avgPerLabel).toBe(1.5);
    });
  });
});
