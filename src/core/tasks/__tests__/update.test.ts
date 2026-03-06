/**
 * Tests for task update.
 * @task T4461
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateTask } from '../update.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('updateTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ verification: { enabled: false } }));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('updates task title', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Old title', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', title: 'New title' }, env.tempDir, accessor);
    expect(result.task.title).toBe('New title');
    expect(result.changes).toContain('title');
  });

  it('updates task status', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'active' }, env.tempDir, accessor);
    expect(result.task.status).toBe('active');
  });

  it('adds labels', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', labels: ['bug'], createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', addLabels: ['security'] }, env.tempDir, accessor);
    expect(result.task.labels).toContain('bug');
    expect(result.task.labels).toContain('security');
  });

  it('removes labels', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', labels: ['bug', 'security'], createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', removeLabels: ['bug'] }, env.tempDir, accessor);
    expect(result.task.labels).toEqual(['security']);
  });

  it('adds notes', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', notes: 'Progress update' }, env.tempDir, accessor);
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Progress update');
  });

  it('throws if no changes specified', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    await expect(
      updateTask({ taskId: 'T001' }, env.tempDir, accessor),
    ).rejects.toThrow('No changes');
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(
      updateTask({ taskId: 'T999', title: 'New' }, env.tempDir, accessor),
    ).rejects.toThrow('Task not found');
  });

  it('sets completedAt when marking done', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'done' }, env.tempDir, accessor);
    expect(result.task.completedAt).toBeDefined();
  });

  it('status=done path enforces dependency checks via complete flow', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Dependency', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked', status: 'active', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    await expect(
      updateTask({ taskId: 'T002', status: 'done' }, env.tempDir, accessor),
    ).rejects.toThrow('incomplete dependencies');
  });

  it('rejects mixed status=done updates with other fields', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    await expect(
      updateTask({ taskId: 'T001', status: 'done', priority: 'high' }, env.tempDir, accessor),
    ).rejects.toThrow('status=done must use complete flow');
  });

  describe('parentId (reparent via update)', () => {
    it('sets parent on a root task', async () => {
      await seedTasks(accessor, [
        { id: 'T001', title: 'Epic', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Orphan', status: 'pending', priority: 'medium', type: 'task', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ hierarchy: { maxDepth: 3, maxSiblings: 20 } }));

      const result = await updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor);
      expect(result.task.parentId).toBe('T001');
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=null', async () => {
      await seedTasks(accessor, [
        { id: 'T001', title: 'Epic', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ hierarchy: { maxDepth: 3, maxSiblings: 20 } }));

      const result = await updateTask({ taskId: 'T002', parentId: null }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=""', async () => {
      await seedTasks(accessor, [
        { id: 'T001', title: 'Epic', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ hierarchy: { maxDepth: 3, maxSiblings: 20 } }));

      const result = await updateTask({ taskId: 'T002', parentId: '' }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('does not change when parentId is same as current', async () => {
      await seedTasks(accessor, [
        { id: 'T001', title: 'Epic', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ hierarchy: { maxDepth: 3, maxSiblings: 20 } }));

      await expect(
        updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor),
      ).rejects.toThrow('No changes');
    });

    it('can set parent and other fields simultaneously', async () => {
      await seedTasks(accessor, [
        { id: 'T001', title: 'Epic', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', type: 'task', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ hierarchy: { maxDepth: 3, maxSiblings: 20 } }));

      const result = await updateTask({
        taskId: 'T002',
        parentId: 'T001',
        priority: 'high',
      }, env.tempDir, accessor);
      expect(result.task.parentId).toBe('T001');
      expect(result.task.priority).toBe('high');
      expect(result.changes).toContain('parentId');
      expect(result.changes).toContain('priority');
    });
  });
});
