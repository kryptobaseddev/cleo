/**
 * Tests for task update.
 * @task T4461
 * @epic T4454
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { updateTask } from '../update.js';

describe('updateTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    // Pin CLEO_DIR so concurrent workers cannot contaminate path resolution
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: {
          session: { requiredForMutate: false },
          acceptance: { mode: 'off' },
        },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('updates task title', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Old title',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', title: 'New title' }, env.tempDir, accessor);
    expect(result.task.title).toBe('New title');
    expect(result.changes).toContain('title');
  });

  it('updates task status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'active' }, env.tempDir, accessor);
    expect(result.task.status).toBe('active');
  });

  it('adds labels', async () => {
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

    const result = await updateTask(
      { taskId: 'T001', addLabels: ['security'] },
      env.tempDir,
      accessor,
    );
    expect(result.task.labels).toContain('bug');
    expect(result.task.labels).toContain('security');
  });

  it('removes labels', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        labels: ['bug', 'security'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T001', removeLabels: ['bug'] },
      env.tempDir,
      accessor,
    );
    expect(result.task.labels).toEqual(['security']);
  });

  it('adds notes', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T001', notes: 'Progress update' },
      env.tempDir,
      accessor,
    );
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Progress update');
  });

  it('throws if no changes specified', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(updateTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'No changes',
    );
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(
      updateTask({ taskId: 'T999', title: 'New' }, env.tempDir, accessor),
    ).rejects.toThrow('Task not found');
  });

  it('sets completedAt when marking done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'done' }, env.tempDir, accessor);
    expect(result.task.completedAt).toBeDefined();
  });

  it('status=done path enforces dependency checks via complete flow', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dependency',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'active',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T002', status: 'done' }, env.tempDir, accessor),
    ).rejects.toThrow('unresolved dependencies');
  });

  it('rejects mixed status=done updates with other fields', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T001', status: 'done', priority: 'high' }, env.tempDir, accessor),
    ).rejects.toThrow('status=done must use complete flow');
  });

  describe('parentId (reparent via update)', () => {
    it('sets parent on a root task', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Orphan',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor);
      expect(result.task.parentId).toBe('T001');
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=null', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: null }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=""', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: '' }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('does not change when parentId is same as current', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      await expect(
        updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor),
      ).rejects.toThrow('No changes');
    });

    it('can set parent and other fields simultaneously', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask(
        {
          taskId: 'T002',
          parentId: 'T001',
          priority: 'high',
        },
        env.tempDir,
        accessor,
      );
      expect(result.task.parentId).toBe('T001');
      expect(result.task.priority).toBe('high');
      expect(result.changes).toContain('parentId');
      expect(result.changes).toContain('priority');
    });
  });

  describe('blockedBy set/clear (T9241)', () => {
    it('sets blockedBy reason text', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', blockedBy: 'waiting on infra' },
        env.tempDir,
        accessor,
      );
      expect(result.task.blockedBy).toBe('waiting on infra');
      expect(result.changes).toContain('blockedBy');
    });

    it('clears blockedBy via --clear-blocked-by flag', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'waiting on infra',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', clearBlockedBy: true },
        env.tempDir,
        accessor,
      );
      expect(result.task.blockedBy).toBeUndefined();
      expect(result.changes).toContain('blockedBy');
    });

    it('auto-clears blockedBy when set to empty string', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'waiting on infra',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T001', blockedBy: '' }, env.tempDir, accessor);
      expect(result.task.blockedBy).toBeUndefined();
      expect(result.changes).toContain('blockedBy');
    });

    it('stale text does not persist in cleo show after clear', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'stale reason',
          createdAt: new Date().toISOString(),
        },
      ]);

      await updateTask({ taskId: 'T001', clearBlockedBy: true }, env.tempDir, accessor);
      const reloaded = await accessor.loadSingleTask('T001');
      expect(reloaded?.blockedBy).toBeUndefined();
    });
  });

  describe('files add/remove (T9242)', () => {
    it('sets files via --files (replace)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', files: ['src/a.ts', 'src/b.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.changes).toContain('files');
    });

    it('adds files without replacing existing via addFiles', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', addFiles: ['src/b.ts', 'src/c.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).toContain('src/a.ts');
      expect(result.task.files).toContain('src/b.ts');
      expect(result.task.files).toContain('src/c.ts');
      expect(result.changes).toContain('files');
    });

    it('addFiles deduplicates — does not add already-present files twice', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', addFiles: ['src/a.ts', 'src/b.ts'] },
        env.tempDir,
        accessor,
      );
      const files = result.task.files ?? [];
      expect(files.filter((f) => f === 'src/a.ts')).toHaveLength(1);
      expect(files).toContain('src/b.ts');
    });

    it('removes specific files via removeFiles', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', removeFiles: ['src/b.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).not.toContain('src/b.ts');
      expect(result.task.files).toContain('src/a.ts');
      expect(result.task.files).toContain('src/c.ts');
      expect(result.changes).toContain('files');
    });

    it('removeFiles on empty files list is a no-op', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', removeFiles: ['src/a.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files ?? []).toHaveLength(0);
    });
  });
});
