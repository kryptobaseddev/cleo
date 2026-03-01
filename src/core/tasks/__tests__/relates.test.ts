/**
 * Tests for relates.ts addRelation persistence fix (T5168).
 *
 * Verifies that the old core module addRelation() correctly writes
 * to the task_relations table via accessor.addRelation(), instead
 * of silently losing data through the in-memory mutation path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import { addRelation, listRelations } from '../relates.js';
import type { Task } from '../../../types/task.js';

describe('relates.ts addRelation persistence (T5168)', () => {
  let testDir: string;
  let accessor: Awaited<ReturnType<typeof createSqliteDataAccessor>>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-relates-core-test-'));
    accessor = await createSqliteDataAccessor(testDir);

    // Seed two tasks
    const task1: Task = {
      id: 'T001',
      title: 'First task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    };
    const task2: Task = {
      id: 'T002',
      title: 'Second task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    };
    await accessor.upsertSingleTask!(task1);
    await accessor.upsertSingleTask!(task2);
  });

  afterEach(async () => {
    await accessor.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should persist relation to task_relations table via accessor', async () => {
    await addRelation('T001', 'T002', 'blocks', 'T001 blocks T002', testDir, accessor);

    // Reload data from database to verify persistence
    const taskFile = await accessor.loadTaskFile();
    const task = taskFile.tasks.find(t => t.id === 'T001');

    expect(task?.relates).toHaveLength(1);
    expect(task?.relates?.[0]).toEqual({
      taskId: 'T002',
      type: 'blocks',
      reason: 'T001 blocks T002',
    });
  });

  it('should survive accessor restart', async () => {
    await addRelation('T001', 'T002', 'related', 'test reason', testDir, accessor);

    // Close and reopen (simulates session restart)
    await accessor.close();
    accessor = await createSqliteDataAccessor(testDir);

    const taskFile = await accessor.loadTaskFile();
    const task = taskFile.tasks.find(t => t.id === 'T001');

    expect(task?.relates).toHaveLength(1);
    expect(task?.relates?.[0]).toEqual({
      taskId: 'T002',
      type: 'related',
      reason: 'test reason',
    });
  });

  it('should throw on non-existent source task', async () => {
    await expect(
      addRelation('T999', 'T002', 'blocks', 'test', testDir, accessor),
    ).rejects.toThrow('T999 not found');
  });

  it('should throw on non-existent target task', async () => {
    await expect(
      addRelation('T001', 'T999', 'blocks', 'test', testDir, accessor),
    ).rejects.toThrow('T999 not found');
  });

  it('listRelations should return relations from task_relations table', async () => {
    await addRelation('T001', 'T002', 'fixes', 'bugfix link', testDir, accessor);

    const result = await listRelations('T001', testDir, accessor);

    expect(result).toEqual({
      taskId: 'T001',
      relations: [{ taskId: 'T002', type: 'fixes', reason: 'bugfix link' }],
      count: 1,
    });
  });
});
