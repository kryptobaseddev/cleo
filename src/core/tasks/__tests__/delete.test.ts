/**
 * Tests for task deletion (soft delete to archive).
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deleteTask } from '../delete.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('deleteTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('deletes a leaf task (moves to archive)', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task to delete', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Other task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await deleteTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');

    // Verify task removed from active tasks
    const updated = await accessor.loadTaskFile();
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');

    // Verify task added to archive
    const archive = await accessor.loadArchive();
    expect(archive).not.toBeNull();
    expect(archive!.archivedTasks).toHaveLength(1);
    expect(archive!.archivedTasks[0].id).toBe('T001');
  });

  it('throws for nonexistent task', async () => {
    await seedTasks(accessor, []);

    await expect(
      deleteTask({ taskId: 'T999' }, env.tempDir, accessor),
    ).rejects.toThrow('Task not found');
  });

  it('throws when task has children without cascade/force', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
    ]);

    await expect(
      deleteTask({ taskId: 'T001' }, env.tempDir, accessor),
    ).rejects.toThrow(/children/i);
  });

  it('cascade deletes children', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Grandchild', status: 'pending', priority: 'medium', parentId: 'T002', createdAt: new Date().toISOString() },
    ]);

    const result = await deleteTask({ taskId: 'T001', cascade: true }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');
    expect(result.cascadeDeleted).toEqual(expect.arrayContaining(['T002', 'T003']));

    const updated = await accessor.loadTaskFile();
    expect(updated.tasks).toHaveLength(0);
  });

  it('force deletes by orphaning children', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', type: 'subtask', createdAt: new Date().toISOString() },
    ]);

    const result = await deleteTask({ taskId: 'T001', force: true }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');

    const updated = await accessor.loadTaskFile();
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');
    expect(updated.tasks[0].parentId).toBeFalsy();
  });

  it('throws when task has dependents without force', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Dep target', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Dependent', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    await expect(
      deleteTask({ taskId: 'T001' }, env.tempDir, accessor),
    ).rejects.toThrow(/dependency/i);
  });

  it('cleans up dependency references after deletion', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Target', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Other', status: 'pending', priority: 'medium', depends: ['T001', 'T003'], createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Third', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    await deleteTask({ taskId: 'T001', force: true }, env.tempDir, accessor);

    const updated = await accessor.loadTaskFile();
    const t002 = updated.tasks.find(t => t.id === 'T002');
    expect(t002?.depends).toEqual(['T003']);
  });
});
