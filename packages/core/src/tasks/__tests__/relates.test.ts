/**
 * Tests for relates.ts addRelation persistence fix (T5168).
 *
 * Verifies that the old core module addRelation() correctly writes
 * to the task_relations table via accessor.addRelation(), instead
 * of silently losing data through the in-memory mutation path.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { addRelation, listRelations, removeRelation } from '../relates.js';
import { coreTaskRelates } from '../task-data.js';

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
      description: 'Description for first task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    };
    const task2: Task = {
      id: 'T002',
      title: 'Second task',
      description: 'Description for second task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    };
    await accessor.upsertSingleTask(task1);
    await accessor.upsertSingleTask(task2);
  });

  afterEach(async () => {
    await accessor.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should persist relation to task_relations table via accessor', async () => {
    await addRelation('T001', 'T002', 'blocks', 'T001 blocks T002', testDir, accessor);

    // Reload data from database to verify persistence
    const task = await accessor.loadSingleTask('T001');

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

    const task = await accessor.loadSingleTask('T001');

    expect(task?.relates).toHaveLength(1);
    expect(task?.relates?.[0]).toEqual({
      taskId: 'T002',
      type: 'related',
      reason: 'test reason',
    });
  });

  it('should throw on non-existent source task', async () => {
    await expect(addRelation('T999', 'T002', 'blocks', 'test', testDir, accessor)).rejects.toThrow(
      'T999 not found',
    );
  });

  it('should throw on non-existent target task', async () => {
    await expect(addRelation('T001', 'T999', 'blocks', 'test', testDir, accessor)).rejects.toThrow(
      'T999 not found',
    );
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

  /**
   * T10111: round-trip — `add` then `remove` should leave zero relations.
   * Companion to the dispatch-registry fix that exposed
   * `mutate:tasks.relates.remove` to the CLI.
   */
  it('removeRelation round-trip (T10111): add → remove → empty', async () => {
    // Add a relation
    await addRelation('T001', 'T002', 'blocks', 'T001 blocks T002', testDir, accessor);

    let listed = await listRelations('T001', testDir, accessor);
    expect(listed).toEqual({
      taskId: 'T001',
      relations: [{ taskId: 'T002', type: 'blocks', reason: 'T001 blocks T002' }],
      count: 1,
    });

    // Remove it (typed)
    const removed = await removeRelation('T001', 'T002', 'blocks', testDir, accessor);
    expect(removed).toEqual({
      from: 'T001',
      to: 'T002',
      type: 'blocks',
      removed: true,
    });

    // Verify it's gone
    listed = await listRelations('T001', testDir, accessor);
    expect(listed).toEqual({
      taskId: 'T001',
      relations: [],
      count: 0,
    });
  });

  it('removeRelation without type narrows to any (T10111)', async () => {
    await addRelation('T001', 'T002', 'related', 'kept-shape', testDir, accessor);

    // Omit type — should still delete the lone relation
    const removed = await removeRelation('T001', 'T002', undefined, testDir, accessor);
    expect(removed.removed).toBe(true);

    const listed = await listRelations('T001', testDir, accessor);
    expect(listed).toEqual({
      taskId: 'T001',
      relations: [],
      count: 0,
    });
  });

  it('coreTaskRelates lists relation reasons plus dependency readiness with type/direction filters (T10626)', async () => {
    await accessor.upsertSingleTask({
      id: 'T003',
      title: 'Third task',
      description: 'Depends on first task',
      status: 'pending',
      priority: 'medium',
      depends: ['T001'],
      createdAt: new Date().toISOString(),
    });
    await addRelation('T002', 'T001', 'blocks', 'T002 blocks T001', testDir, accessor);

    const incoming = await coreTaskRelates(testDir, 'T001', { direction: 'in' });

    expect(incoming.relations).toContainEqual({
      taskId: 'T002',
      type: 'blocks',
      reason: 'T002 blocks T001',
      direction: 'in',
      source: 'relation',
    });
    expect(incoming.relations).toContainEqual({
      taskId: 'T003',
      type: 'depends',
      direction: 'in',
      source: 'dependency',
      ready: false,
      status: 'pending',
    });

    const dependsOnly = await coreTaskRelates(testDir, 'T001', {
      direction: 'in',
      type: 'depends',
    });
    expect(dependsOnly.relations).toEqual([
      {
        taskId: 'T003',
        type: 'depends',
        direction: 'in',
        source: 'dependency',
        ready: false,
        status: 'pending',
      },
    ]);
  });

  it('removeRelation rejects non-existent source task (T10111)', async () => {
    await expect(removeRelation('T999', 'T002', 'blocks', testDir, accessor)).rejects.toThrow(
      'T999 not found',
    );
  });

  it('removeRelation rejects non-existent target task (T10111)', async () => {
    await expect(removeRelation('T001', 'T999', 'blocks', testDir, accessor)).rejects.toThrow(
      'T999 not found',
    );
  });
});
