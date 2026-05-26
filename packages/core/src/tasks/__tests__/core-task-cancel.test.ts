/**
 * Engine-level tests for `coreTaskCancel` and `taskCancel`.
 *
 * Exercises the live SQLite DB (with the T877 BEFORE-UPDATE trigger) to:
 *   - Reproduce the T9838 regression: cancelling a task whose
 *     `pipelineStage='contribution'` previously failed with
 *     `T877_INVARIANT_VIOLATION` because the cancel handler skipped
 *     overwriting the terminal stage.
 *   - Verify the fix: pipeline_stage is always forced to 'cancelled'
 *     when status='cancelled'.
 *   - Verify idempotency: re-cancelling returns success with
 *     `alreadyCancelled: true`.
 *   - Verify dispatch wrapper maps errors to the correct sentinel codes
 *     (E_NOT_FOUND for missing tasks, E_INVALID_STATE for completed tasks).
 *
 * @task T9838
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { coreTaskCancel, taskCancel } from '../task-ops.js';

async function seedTask(
  env: TestDbEnv,
  overrides: { id: string; status?: string; pipelineStage?: string; parentId?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  // Cast through `unknown` rather than `any` — we provide the minimal shape
  // sufficient for the cancel paths under test; the rest of Task is optional.
  const seed = {
    id: overrides.id,
    title: `Seed ${overrides.id}`,
    status: overrides.status ?? 'pending',
    priority: 'medium',
    createdAt: now,
    updatedAt: now,
    pipelineStage: overrides.pipelineStage ?? null,
    parentId: overrides.parentId ?? null,
  } as unknown as Task;
  await env.accessor.upsertSingleTask(seed);
}

describe('coreTaskCancel (engine, with live T877 trigger)', () => {
  let env: TestDbEnv;
  beforeEach(async () => {
    env = await createTestDb();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('cancels a pending task and stamps cancelledAt + cancellationReason', async () => {
    await seedTask(env, { id: 'T0001', status: 'pending' });

    const result = await coreTaskCancel(env.tempDir, 'T0001', { reason: 'no longer needed' });
    expect(result.cancelled).toBe(true);
    expect(result.task).toBe('T0001');
    expect(result.cancelledAt).toBeDefined();
    expect(result.reason).toBe('no longer needed');

    const reread = await env.accessor.loadSingleTask('T0001');
    expect(reread?.status).toBe('cancelled');
    expect(reread?.cancellationReason).toBe('no longer needed');
    expect(reread?.pipelineStage).toBe('cancelled');
  });

  it('T9838 regression: cancels a task whose pipelineStage is contribution', async () => {
    // Prior to the T9838 fix, this raised:
    //   T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch.
    //   status=cancelled requires pipeline_stage=cancelled.
    // The T871 carve-out left `contribution` in place; the BEFORE-UPDATE
    // trigger then aborted the write.
    await seedTask(env, { id: 'T0002', status: 'done', pipelineStage: 'contribution' });
    // Move it out of `done` so canCancel allows it (canCancel rejects
    // `done` per design). pending + contribution stage exercises the same
    // trigger condition.
    await seedTask(env, { id: 'T0003', status: 'pending', pipelineStage: 'contribution' });

    const result = await coreTaskCancel(env.tempDir, 'T0003');
    expect(result.cancelled).toBe(true);

    const reread = await env.accessor.loadSingleTask('T0003');
    expect(reread?.status).toBe('cancelled');
    // Critical: stage MUST be 'cancelled' to satisfy the trigger.
    expect(reread?.pipelineStage).toBe('cancelled');
  });

  it('is idempotent: re-cancelling returns alreadyCancelled', async () => {
    await seedTask(env, { id: 'T0004', status: 'pending' });
    const first = await coreTaskCancel(env.tempDir, 'T0004', { reason: 'first' });
    expect(first.cancelled).toBe(true);
    expect(first.alreadyCancelled).toBeUndefined();

    const second = await coreTaskCancel(env.tempDir, 'T0004', { reason: 'second' });
    expect(second.cancelled).toBe(true);
    expect(second.alreadyCancelled).toBe(true);
    // Echoes the ORIGINAL cancelledAt, not a new one.
    expect(second.cancelledAt).toBe(first.cancelledAt);
    // Echoes the original reason, not the new one — true no-op semantics.
    expect(second.reason).toBe('first');
  });

  it('blocks parent cancellation unless child propagation is explicit', async () => {
    await seedTask(env, { id: 'T0020', status: 'pending' });
    await seedTask(env, { id: 'T0021', status: 'pending', parentId: 'T0020' });

    await expect(coreTaskCancel(env.tempDir, 'T0020')).rejects.toThrow(/E_HAS_CHILDREN/);

    const parent = await env.accessor.loadSingleTask('T0020');
    const child = await env.accessor.loadSingleTask('T0021');
    expect(parent?.status).toBe('pending');
    expect(child?.status).toBe('pending');
  });

  it('cascades cancellation to descendants only when children=cascade is explicit', async () => {
    await seedTask(env, { id: 'T0030', status: 'pending' });
    await seedTask(env, { id: 'T0031', status: 'pending', parentId: 'T0030' });
    await seedTask(env, { id: 'T0032', status: 'pending', parentId: 'T0031' });

    const result = await coreTaskCancel(env.tempDir, 'T0030', {
      reason: 'scope removed',
      children: 'cascade',
    });

    expect(result.childStrategy).toBe('cascade');
    expect(result.affectedTasks?.sort()).toEqual(['T0031', 'T0032']);
    expect(result.affectedCount).toBe(2);

    for (const taskId of ['T0030', 'T0031', 'T0032']) {
      const task = await env.accessor.loadSingleTask(taskId);
      expect(task?.status).toBe('cancelled');
      expect(task?.pipelineStage).toBe('cancelled');
    }
  });

  it('orphans direct children when children=orphan is explicit', async () => {
    await seedTask(env, { id: 'T0040', status: 'pending' });
    await seedTask(env, { id: 'T0041', status: 'pending', parentId: 'T0040' });

    const result = await coreTaskCancel(env.tempDir, 'T0040', { children: 'orphan' });

    expect(result.childStrategy).toBe('orphan');
    expect(result.affectedTasks).toEqual(['T0041']);
    const parent = await env.accessor.loadSingleTask('T0040');
    const child = await env.accessor.loadSingleTask('T0041');
    expect(parent?.status).toBe('cancelled');
    expect(child?.status).toBe('pending');
    expect(child?.parentId ?? null).toBeNull();
  });

  it('requires force waiver and audit log for large subtree cascade', async () => {
    await seedTask(env, { id: 'T0050', status: 'pending' });
    await seedTask(env, { id: 'T0051', status: 'pending', parentId: 'T0050' });
    await seedTask(env, { id: 'T0052', status: 'pending', parentId: 'T0050' });

    await expect(
      coreTaskCancel(env.tempDir, 'T0050', { children: 'cascade', cascadeThreshold: 1 }),
    ).rejects.toThrow(/E_CASCADE_THRESHOLD_EXCEEDED/);

    const result = await coreTaskCancel(env.tempDir, 'T0050', {
      children: 'cascade',
      cascadeThreshold: 1,
      force: true,
      reason: 'operator waiver',
    });

    expect(result.affectedCount).toBe(2);
    const child1 = await env.accessor.loadSingleTask('T0051');
    const child2 = await env.accessor.loadSingleTask('T0052');
    expect(child1?.status).toBe('cancelled');
    expect(child2?.status).toBe('cancelled');
  });
});

describe('taskCancel (dispatch wrapper, error mapping)', () => {
  let env: TestDbEnv;
  beforeEach(async () => {
    env = await createTestDb();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('returns E_NOT_FOUND when the task does not exist', async () => {
    const result = await taskCancel(env.tempDir, 'T9999');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_NOT_FOUND');
    }
  });

  it('returns E_INVALID_STATE for a completed task (not E_NOT_FOUND)', async () => {
    // Seed a `done` task with the matching terminal stage so the seed
    // itself doesn't trip the trigger.
    await seedTask(env, { id: 'T0010', status: 'done', pipelineStage: 'contribution' });

    const result = await taskCancel(env.tempDir, 'T0010');
    expect(result.success).toBe(false);
    if (!result.success) {
      // Prior to T9838 this returned E_NOT_FOUND for ALL errors. After the
      // fix, the dispatch wrapper distinguishes missing-task from
      // invalid-state from internal errors.
      expect(result.error.code).toBe('E_INVALID_STATE');
      expect(result.error.message).toMatch(/completed/i);
    }
  });

  it('returns success on a real cancel and again on idempotent re-cancel', async () => {
    await seedTask(env, { id: 'T0011', status: 'pending' });
    const first = await taskCancel(env.tempDir, 'T0011', 'first call');
    expect(first.success).toBe(true);
    if (first.success) {
      expect(first.data.cancelled).toBe(true);
      expect(first.data.alreadyCancelled).toBeUndefined();
    }

    const second = await taskCancel(env.tempDir, 'T0011', 'second call');
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.data.alreadyCancelled).toBe(true);
    }
  });
});
