/**
 * One settled-child predicate across cancel, complete and done (T14266), and
 * an atomic cancel cascade (T14217).
 *
 * The repro shapes are the live ones that stalled agents:
 *   - T10410: an epic with 2 done + 2 cancelled children could not be
 *     cancelled without `--children` (E_HAS_CHILDREN on finished children).
 *   - T9740: an epic with 11 cancelled children tripped the cascade threshold
 *     although nothing was left to cancel.
 *   - T11478: an epic with a done and a cancelled child could not close
 *     through `cleo done --waive-cancelled-children` (the done plan ignored
 *     the waiver `cleo complete` accepts).
 *   - T14217: a cascade whose parent write failed left the children cancelled
 *     under a live parent.
 *
 * @task T14266
 * @task T14217
 * @task T14223
 */

import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { isSettledChild } from '@cleocode/contracts/status-registry.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getNativeTasksDb, resetDbState } from '../../store/sqlite.js';
import { decideCancelledChildWaiver } from '../cancelled-child-waiver.js';
import { completeTask } from '../complete.js';
import { planTaskDone } from '../done-plan.js';
import { coreTaskCancel, taskCancel } from '../task-ops.js';

const now = new Date().toISOString();

type SeedStatus = 'pending' | 'active' | 'done' | 'cancelled' | 'archived';

function task(
  id: string,
  status: SeedStatus,
  opts: { parentId?: string; type?: Task['type']; acceptance?: string[] } = {},
): Task {
  return {
    id,
    title: `Seed ${id}`,
    type: opts.type ?? 'task',
    status,
    priority: 'medium',
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    acceptance: opts.acceptance ?? [],
    createdAt: now,
    updatedAt: now,
    // T877: a terminal status needs its matching pipeline stage.
    ...(status === 'done' ? { completedAt: now, pipelineStage: 'contribution' } : {}),
    ...(status === 'cancelled' ? { cancelledAt: now, pipelineStage: 'cancelled' } : {}),
  } as Task;
}

const permissiveConfig = JSON.stringify({
  enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
  lifecycle: { mode: 'off' },
  verification: { enabled: false },
});

describe('isSettledChild (T14266)', () => {
  it('settles done, cancelled and archived only', () => {
    expect(
      ['done', 'cancelled', 'archived'].every((s) => isSettledChild(s as Task['status'])),
    ).toBe(true);
    expect(
      ['pending', 'active', 'blocked', 'proposed'].some((s) => isSettledChild(s as Task['status'])),
    ).toBe(false);
  });
});

describe('settled children across cancel, complete and done', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(env.cleoDir, 'config.json'), permissiveConfig);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('T10410: a parent with 2 done + 2 cancelled children cancels without --children', async () => {
    await seedTasks(env.accessor, [
      task('T0100', 'pending', { type: 'epic' }),
      task('T0101', 'done', { parentId: 'T0100' }),
      task('T0102', 'done', { parentId: 'T0100' }),
      task('T0103', 'cancelled', { parentId: 'T0100' }),
      task('T0104', 'cancelled', { parentId: 'T0100' }),
    ]);

    const result = await coreTaskCancel(env.tempDir, 'T0100', { reason: 'superseded' });

    expect(result.cancelled).toBe(true);
    expect(result.affectedTasks).toEqual([]);
    expect((await env.accessor.loadSingleTask('T0100'))?.status).toBe('cancelled');
    expect((await env.accessor.loadSingleTask('T0101'))?.status).toBe('done');
    expect((await env.accessor.loadSingleTask('T0103'))?.status).toBe('cancelled');
  });

  it('T9740: 11 cancelled children do not count toward the cascade threshold', async () => {
    const children = Array.from({ length: 11 }, (_, i) =>
      task(`T21${String(i).padStart(2, '0')}`, 'cancelled', { parentId: 'T0200' }),
    );
    await seedTasks(env.accessor, [task('T0200', 'pending', { type: 'epic' }), ...children]);

    const result = await coreTaskCancel(env.tempDir, 'T0200', { children: 'cascade' });

    expect(result.cancelled).toBe(true);
    expect(result.affectedCount).toBe(0);
    expect((await env.accessor.loadSingleTask('T0200'))?.status).toBe('cancelled');
  });

  it('a cascade skips a done descendant and cancels only the unsettled ones', async () => {
    await seedTasks(env.accessor, [
      task('T0300', 'pending', { type: 'epic' }),
      task('T0301', 'done', { parentId: 'T0300' }),
      task('T0302', 'pending', { parentId: 'T0300' }),
      task('T0303', 'archived', { parentId: 'T0300' }),
    ]);

    const result = await coreTaskCancel(env.tempDir, 'T0300', {
      children: 'cascade',
      cascadeThreshold: 1,
    });

    expect(result.affectedTasks).toEqual(['T0302']);
    expect((await env.accessor.loadSingleTask('T0301'))?.status).toBe('done');
    expect((await env.accessor.loadSingleTask('T0302'))?.status).toBe('cancelled');
    expect((await env.accessor.loadSingleTask('T0300'))?.status).toBe('cancelled');
  });

  it('E_HAS_CHILDREN names only the unsettled children', async () => {
    await seedTasks(env.accessor, [
      task('T0400', 'pending', { type: 'epic' }),
      task('T0401', 'done', { parentId: 'T0400' }),
      task('T0402', 'pending', { parentId: 'T0400' }),
    ]);

    await expect(coreTaskCancel(env.tempDir, 'T0400')).rejects.toThrow(
      /E_HAS_CHILDREN: Task T0400 has 1 unsettled child task\(s\) \(T0402\)/,
    );
  });

  it('T14217: a failed parent write leaves every child unchanged, with a bounded SQLite cause', async () => {
    await seedTasks(env.accessor, [
      task('T0500', 'pending', { type: 'epic' }),
      task('T0501', 'pending', { parentId: 'T0500' }),
      task('T0502', 'pending', { parentId: 'T0500' }),
    ]);
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('native db not open');
    // Inject a failure on the parent's write only.
    db.exec(`CREATE TRIGGER t14217_inject BEFORE UPDATE ON tasks_tasks
      WHEN NEW.id = 'T0500' AND NEW.status = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'T14217_INJECTED_PARENT_FAILURE'); END;`);

    const result = await taskCancel(env.tempDir, 'T0500', { children: 'cascade', reason: 'x' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INTERNAL');
    expect(result.error?.message).toContain('T14217_INJECTED_PARENT_FAILURE');
    expect(result.error?.message.length ?? 0).toBeLessThanOrEqual(600);
    for (const id of ['T0500', 'T0501', 'T0502']) {
      expect((await env.accessor.loadSingleTask(id))?.status).toBe('pending');
    }
  });

  it('an archived child never counts as pending in complete', async () => {
    await seedTasks(env.accessor, [
      task('T0600', 'active'),
      task('T0601', 'done', { parentId: 'T0600', type: 'subtask' }),
      task('T0602', 'archived', { parentId: 'T0600', type: 'subtask' }),
    ]);

    const result = await completeTask({ taskId: 'T0600' }, env.tempDir, env.accessor);

    expect(result.task.status).toBe('done');
  });

  it('T11478: an epic with a done and a cancelled child closes through done with the waiver', async () => {
    await seedTasks(env.accessor, [
      task('T0700', 'active', { type: 'epic' }),
      task('T0701', 'done', { parentId: 'T0700' }),
      task('T0702', 'cancelled', { parentId: 'T0700' }),
    ]);

    // Without the waiver the done plan blocks and names the flag.
    const blocked = await planTaskDone('T0700', { projectRoot: env.tempDir });
    expect(blocked.success).toBe(true);
    expect(blocked.data?.ready).toBe(false);
    expect(blocked.data?.blockers[0]?.message).toContain('--waive-cancelled-children');
    expect(blocked.data?.next.command).toContain('cleo done T0700 --waive-cancelled-children');
    // T14426: the rollup settles the cancelled child; the waiver is its own blocker.
    expect(blocked.data?.blockers.map((b) => b.code)).toEqual(['cancelled-child-waiver']);

    // With it the plan is ready, and completion goes through the same guard.
    const reason = 'T0702 superseded by T0701';
    const ready = await planTaskDone('T0700', {
      projectRoot: env.tempDir,
      cancelledChildWaiverReason: reason,
    });
    expect(ready.data?.ready).toBe(true);
    expect(ready.data?.blockers).toEqual([]);
    expect(ready.data?.commands[0]).toContain('--waive-cancelled-children');

    const done = await completeTask(
      { taskId: 'T0700', cancelledChildWaiverReason: reason },
      env.tempDir,
      env.accessor,
    );
    expect(done.task.status).toBe('done');
  });

  it('complete and done share one waiver decision', () => {
    const children = [
      { id: 'T0801', status: 'done' },
      { id: 'T0802', status: 'cancelled' },
    ];
    const forComplete = decideCancelledChildWaiver('T0800', children, undefined, 'complete');
    const forDone = decideCancelledChildWaiver('T0800', children, undefined, 'done');
    expect(forComplete.allowed).toBe(false);
    expect(forDone.allowed).toBe(false);
    expect(forComplete.cancelledChildIds).toEqual(['T0802']);
    expect(forComplete.fix).toContain('cleo complete T0800 --waive-cancelled-children');
    expect(forDone.fix).toContain('cleo done T0800 --waive-cancelled-children');
    expect(decideCancelledChildWaiver('T0800', children, ' reason ', 'done')).toMatchObject({
      allowed: true,
      waiverReason: 'reason',
    });
  });
});
