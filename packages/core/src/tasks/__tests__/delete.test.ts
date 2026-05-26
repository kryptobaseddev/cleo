/**
 * Tests for task deletion (soft delete to archive).
 * @task T4627
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { addTask } from '../add.js';
import { deleteTask } from '../delete.js';

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
      {
        id: 'T001',
        title: 'Task to delete',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Other task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await deleteTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');

    // Verify task removed from active tasks
    const { tasks: remaining } = await accessor.queryTasks({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('T002');

    // Verify task added to archive
    const archive = await accessor.loadArchive();
    expect(archive).not.toBeNull();
    expect(archive!.archivedTasks).toHaveLength(1);
    expect(archive!.archivedTasks[0].id).toBe('T001');
  });

  it('throws for nonexistent task', async () => {
    await seedTasks(accessor, []);

    await expect(deleteTask({ taskId: 'T999' }, env.tempDir, accessor)).rejects.toThrow(
      'Task not found',
    );
  });

  it('throws when task has children without cascade/force', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Parent',
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
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(deleteTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      /children/i,
    );
  });

  it('cascade deletes children', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Parent',
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
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Grandchild',
        status: 'pending',
        priority: 'medium',
        parentId: 'T002',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await deleteTask({ taskId: 'T001', cascade: true }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');
    expect(result.cascadeDeleted).toEqual(expect.arrayContaining(['T002', 'T003']));

    const { tasks: remaining } = await accessor.queryTasks({});
    expect(remaining).toHaveLength(0);
  });

  it('force deletes by orphaning children', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Parent',
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
        parentId: 'T001',
        type: 'subtask',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await deleteTask({ taskId: 'T001', force: true }, env.tempDir, accessor);
    expect(result.deletedTask.id).toBe('T001');

    const { tasks: remaining } = await accessor.queryTasks({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('T002');
    expect(remaining[0].parentId).toBeFalsy();
  });

  it('throws when task has dependents without force', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dep target',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Dependent',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(deleteTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      /dependency/i,
    );
  });

  it('cleans up dependency references after deletion', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Target',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Other',
        status: 'pending',
        priority: 'medium',
        depends: ['T001', 'T003'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Third',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await deleteTask({ taskId: 'T001', force: true }, env.tempDir, accessor);

    const t002 = await accessor.loadSingleTask('T002');
    expect(t002?.depends).toEqual(['T003']);
  });

  it('removes parent child_task AC projection and records history when deleting a child task', async () => {
    await addTask(
      {
        title: 'Parent',
        description: 'Parent epic task',
        type: 'epic',
        acceptance: ['manual parent AC'],
      },
      env.tempDir,
      accessor,
    );
    await addTask(
      { title: 'Child projection', description: 'Child of parent epic', parentId: 'T001' },
      env.tempDir,
      accessor,
    );

    const beforeRows = await accessor.getAcRows('T001');
    const manualRow = beforeRows.find((row) => row.text === 'manual parent AC');
    const childProjection = beforeRows.find((row) => row.targetTaskId === 'T002');
    expect(manualRow).toBeTruthy();
    expect(childProjection?.kind).toBe('child_task');

    await deleteTask({ taskId: 'T002' }, env.tempDir, accessor);

    const afterRows = await accessor.getAcRows('T001');
    expect(afterRows.map((row) => row.text)).toEqual(['manual parent AC']);
    expect(afterRows[0]?.id).toBe(manualRow!.id);

    const parent = await accessor.loadSingleTask('T001');
    expect(parent?.acceptance).toEqual(['manual parent AC']);

    const { getNativeTasksDb } = await import('../../store/sqlite.js');
    const historyRows = getNativeTasksDb()!
      .prepare(
        'SELECT ac_id, previous_text, reason FROM task_acceptance_criteria_history ORDER BY id ASC',
      )
      .all() as Array<{ ac_id: string; previous_text: string; reason: string }>;
    expect(historyRows).toEqual([
      {
        ac_id: childProjection!.id,
        previous_text: 'Complete child T002: Child projection',
        reason: 'delete',
      },
    ]);
  });
});
