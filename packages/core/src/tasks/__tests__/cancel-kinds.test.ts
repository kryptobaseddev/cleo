/**
 * Cancel kinds and replacements (T14267, owner decision D11229): a child
 * cancelled as superseded or duplicate whose replacement is done counts as
 * covered in rollup and `done --plan` with no waiver; an abandoned child
 * still needs `--waive-cancelled-children`; `replaced_by` follows a
 * display-id re-mint.
 *
 * @task T14267
 */

import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getNativeTasksDb, resetDbState } from '../../store/sqlite.js';
import { renameTaskDisplayIdNative } from '../../store/sqlite-data-accessor.js';
import { taskReferenceColumns } from '../../store/task-reference-columns.js';
import { completeTask } from '../complete.js';
import { planTaskDone } from '../done-plan.js';
import { coreTaskCancel } from '../task-ops.js';

const now = new Date().toISOString();

function task(
  id: string,
  status: 'pending' | 'active' | 'done' | 'cancelled',
  opts: { parentId?: string; type?: Task['type'] } = {},
): Task {
  return {
    id,
    title: `Seed ${id}`,
    type: opts.type ?? 'task',
    status,
    priority: 'medium',
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    acceptance: [],
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: now, pipelineStage: 'contribution' } : {}),
    ...(status === 'cancelled' ? { cancelledAt: now, pipelineStage: 'cancelled' } : {}),
  } as Task;
}

describe('cancel kinds (T14267)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
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

  it('records the kind and replacement, and refuses a bad kind or replacement', async () => {
    await seedTasks(env.accessor, [
      task('T0901', 'done'),
      task('T0902', 'pending'),
      task('T0903', 'pending'),
    ]);

    await expect(coreTaskCancel(env.tempDir, 'T0902', { kind: 'gone' })).rejects.toThrow(
      /E_INVALID_INPUT: Unknown cancel kind 'gone'/,
    );
    await expect(
      coreTaskCancel(env.tempDir, 'T0902', { kind: 'abandoned', replacedBy: 'T0901' }),
    ).rejects.toThrow(/E_INVALID_INPUT: --replaced-by needs --kind superseded/);
    await expect(
      coreTaskCancel(env.tempDir, 'T0902', { kind: 'duplicate', replacedBy: 'T0999' }),
    ).rejects.toThrow(/E_INVALID_INPUT: Replacement T0999/);

    const result = await coreTaskCancel(env.tempDir, 'T0902', {
      kind: 'superseded',
      replacedBy: 'T0901',
    });
    expect(result).toMatchObject({ kind: 'superseded', replacedBy: 'T0901' });
    expect(await env.accessor.loadSingleTask('T0902')).toMatchObject({
      status: 'cancelled',
      cancellationKind: 'superseded',
      replacedBy: 'T0901',
    });

    // A re-cancel that names a kind records it on an already-cancelled task.
    await coreTaskCancel(env.tempDir, 'T0903', {});
    const again = await coreTaskCancel(env.tempDir, 'T0903', { kind: 'obsolete' });
    expect(again).toMatchObject({ alreadyCancelled: true, kind: 'obsolete' });
    expect((await env.accessor.loadSingleTask('T0903'))?.cancellationKind).toBe('obsolete');
  });

  it('an epic with one done child and one superseded child whose replacement is done rolls up', async () => {
    await seedTasks(env.accessor, [
      task('T1000', 'active', { type: 'epic' }),
      task('T1001', 'done', { parentId: 'T1000' }),
      task('T1002', 'pending', { parentId: 'T1000' }),
    ]);
    await coreTaskCancel(env.tempDir, 'T1002', { kind: 'superseded', replacedBy: 'T1001' });

    const plan = await planTaskDone('T1000', { projectRoot: env.tempDir });
    expect(plan.data?.blockers).toEqual([]);
    expect(plan.data?.ready).toBe(true);

    const done = await completeTask({ taskId: 'T1000' }, env.tempDir, env.accessor);
    expect(done.task.status).toBe('done');
  });

  it('an abandoned child, or a replacement not yet done, still needs the waiver', async () => {
    await seedTasks(env.accessor, [
      task('T1100', 'active', { type: 'epic' }),
      task('T1101', 'done', { parentId: 'T1100' }),
      task('T1102', 'pending', { parentId: 'T1100' }),
      task('T1200', 'active', { type: 'epic' }),
      task('T1201', 'pending'),
      task('T1202', 'pending', { parentId: 'T1200' }),
    ]);
    await coreTaskCancel(env.tempDir, 'T1102', { kind: 'abandoned' });
    await coreTaskCancel(env.tempDir, 'T1202', { kind: 'duplicate', replacedBy: 'T1201' });

    for (const epic of ['T1100', 'T1200']) {
      const plan = await planTaskDone(epic, { projectRoot: env.tempDir });
      expect(plan.data?.ready).toBe(false);
      expect(plan.data?.blockers[0]?.message).toContain('--waive-cancelled-children');
      await expect(completeTask({ taskId: epic }, env.tempDir, env.accessor)).rejects.toThrow(
        /cancelled child/,
      );
    }
  });

  it('replaced_by follows a display-id re-mint of the replacement', async () => {
    await seedTasks(env.accessor, [task('T1301', 'done'), task('T1302', 'pending')]);
    await coreTaskCancel(env.tempDir, 'T1302', { kind: 'duplicate', replacedBy: 'T1301' });
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('native db not open');
    const { uid } = db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get('T1301') as {
      uid: string;
    };

    expect(taskReferenceColumns(db)).toContainEqual(
      expect.objectContaining({ table: 'tasks_tasks', column: 'replaced_by' }),
    );
    db.exec('BEGIN IMMEDIATE');
    renameTaskDisplayIdNative(db, uid, 'T1399', taskReferenceColumns(db));
    db.exec('COMMIT');

    expect((await env.accessor.loadSingleTask('T1302'))?.replacedBy).toBe('T1399');
  });
});
