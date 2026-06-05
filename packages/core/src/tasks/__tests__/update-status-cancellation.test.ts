/**
 * Tests for the cancellation path of `updateTask` (`cleo update --status cancelled`).
 *
 * Closes the T9838-D gap: prior to this fix, `cleo update T### --status cancelled`
 * on a pending task threw `T877_INVARIANT_VIOLATION` because the status flipped to
 * `cancelled` without the pipeline_stage trigger being satisfied; the
 * `taskUpdate` engine wrapper then mis-labelled the error as `E_NOT_INITIALIZED`.
 *
 * Fix verifies:
 *  - pending -> cancelled succeeds, cancelledAt stamped, pipelineStage synced.
 *  - active -> cancelled succeeds, same.
 *  - blocked -> cancelled succeeds, same.
 *  - cancelled -> cancelled is rejected by transition validator (no idempotent re-cancel).
 *  - done -> cancelled is rejected with a clear E_VALIDATION (not E_NOT_INITIALIZED).
 *  - pending -> done still funnels through the dedicated complete flow.
 *  - the engine-result wrapper surfaces real CleoError codes, not E_NOT_INITIALIZED.
 *
 * @task T9838-D
 * @epic T9838
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { taskUpdate, updateTask } from '../update.js';

describe('updateTask cancellation path (T9838-D)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
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

  it('pending -> cancelled succeeds, stamps cancelledAt, syncs pipelineStage', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Pending task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'cancelled' }, env.tempDir, accessor);

    expect(result.task.status).toBe('cancelled');
    expect(result.task.cancelledAt).toBeTruthy();
    expect(result.task.pipelineStage).toBe('cancelled');
    expect(result.changes).toContain('status');
    expect(result.changes).toContain('pipelineStage');
  });

  it('pending task with NO verification gates initialized -> cancelled succeeds (T9947)', async () => {
    // T9947 repro: a pending task with `verification` left explicitly null
    // (gates never initialized via `cleo verify`) historically caused the
    // engine wrapper to mis-label the rejection as `E_NOT_INITIALIZED`.
    // Post-T9838-D + T9940 the wrapper surfaces real CleoError codes, but
    // we lock the behaviour to prevent the regression class.
    await seedTasks(accessor, [
      {
        id: 'T9947A',
        title: 'Misfiled placeholder task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
        // verification is intentionally undefined — the task has never been
        // routed through `cleo verify`, so no gate state exists.
        verification: undefined,
      },
    ]);

    const result = await updateTask(
      { taskId: 'T9947A', status: 'cancelled' },
      env.tempDir,
      accessor,
    );

    expect(result.task.status).toBe('cancelled');
    expect(result.task.cancelledAt).toBeTruthy();
    expect(result.task.pipelineStage).toBe('cancelled');
    expect(result.changes).toContain('status');
  });

  it('active -> cancelled succeeds, stamps cancelledAt, syncs pipelineStage', async () => {
    await seedTasks(accessor, [
      {
        id: 'T002',
        title: 'Active task',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'validation',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T002', status: 'cancelled' }, env.tempDir, accessor);

    expect(result.task.status).toBe('cancelled');
    expect(result.task.cancelledAt).toBeTruthy();
    expect(result.task.pipelineStage).toBe('cancelled');
  });

  it('blocked -> cancelled succeeds, stamps cancelledAt, syncs pipelineStage', async () => {
    await seedTasks(accessor, [
      {
        id: 'T003',
        title: 'Blocked task',
        status: 'blocked',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T003', status: 'cancelled' }, env.tempDir, accessor);

    expect(result.task.status).toBe('cancelled');
    expect(result.task.cancelledAt).toBeTruthy();
    expect(result.task.pipelineStage).toBe('cancelled');
  });

  it('forces pipelineStage=cancelled even when the prior stage was contribution', async () => {
    // The T877 DB invariant (Part B) requires `status=cancelled` rows to have
    // `pipeline_stage='cancelled'` — stricter than the in-memory cancel-ops
    // sync which preserved any terminal stage. Cancellation routes ALL
    // pipelineStage values to the 'cancelled' marker so the trigger accepts
    // the write and Studio Pipeline groups the task under CANCELLED.
    await seedTasks(accessor, [
      {
        id: 'T004',
        title: 'Contribution stage task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'contribution',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T004', status: 'cancelled' }, env.tempDir, accessor);

    expect(result.task.status).toBe('cancelled');
    expect(result.task.cancelledAt).toBeTruthy();
    expect(result.task.pipelineStage).toBe('cancelled');
    expect(result.changes).toContain('pipelineStage');
  });

  it('cancelled -> cancelled rejects (transition validator blocks self-loop)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T005',
        title: 'Already cancelled',
        status: 'cancelled',
        priority: 'medium',
        pipelineStage: 'cancelled',
        cancelledAt: '2026-05-20T00:00:00.000Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T005', status: 'cancelled' }, env.tempDir, accessor),
    ).rejects.toThrow(CleoError);
  });

  it('done -> cancelled is rejected with E_VALIDATION (not E_NOT_INITIALIZED)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T006',
        title: 'Completed task',
        status: 'done',
        priority: 'medium',
        pipelineStage: 'contribution',
        completedAt: '2026-05-20T00:00:00.000Z',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T006', status: 'cancelled' }, env.tempDir, accessor),
    ).rejects.toMatchObject({
      code: ExitCode.VALIDATION_ERROR,
    });
  });

  it('pending -> done still routes through the dedicated complete flow', async () => {
    await seedTasks(accessor, [
      {
        id: 'T007',
        title: 'To be completed',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'contribution',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T007', status: 'done' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.changes).toEqual(['status']);
  });

  describe('taskUpdate engine-result wrapper (T9838-D — error surfacing)', () => {
    it('pending -> cancelled returns success envelope (no E_NOT_INITIALIZED)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T010',
          title: 'Wrapper pending',
          status: 'pending',
          priority: 'medium',
          pipelineStage: 'implementation',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await taskUpdate(env.tempDir, 'T010', { status: 'cancelled' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.task.status).toBe('cancelled');
        expect(result.data.task.cancelledAt).toBeTruthy();
        expect(result.data.task.pipelineStage).toBe('cancelled');
      }
    });

    it('done -> cancelled surfaces validation error (not E_NOT_INITIALIZED)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T011',
          title: 'Wrapper done',
          status: 'done',
          priority: 'medium',
          pipelineStage: 'contribution',
          completedAt: '2026-05-20T00:00:00.000Z',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await taskUpdate(env.tempDir, 'T011', { status: 'cancelled' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        // CleoError.toLAFSError() emits the catalog lafsCode for VALIDATION_ERROR.
        expect(result.error.code).toBe('E_CLEO_VALIDATION');
        expect(result.error.message).toMatch(/Cannot transition from 'done'/);
      }
    });

    it('not-found task surfaces NOT_FOUND code (not E_NOT_INITIALIZED)', async () => {
      const result = await taskUpdate(env.tempDir, 'T999', { status: 'cancelled' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        // CleoError.toLAFSError() emits the catalog lafsCode for NOT_FOUND.
        expect(result.error.code).toBe('E_CLEO_NOT_FOUND');
      }
    });

    it('pending task with verification=undefined cancels via wrapper (T9947)', async () => {
      // T9947 repro through the engine wrapper:
      // `cleo update <id> --status cancelled` on a pending task whose
      // `verification` column is null/undefined MUST succeed. The earlier
      // failure mode dressed an internal validation throw up as
      // E_NOT_INITIALIZED at the wrapper layer.
      await seedTasks(accessor, [
        {
          id: 'T9947B',
          title: 'Wrapper repro — no gates initialized',
          status: 'pending',
          priority: 'medium',
          pipelineStage: 'research',
          createdAt: new Date().toISOString(),
          verification: undefined,
        },
      ]);

      const result = await taskUpdate(env.tempDir, 'T9947B', { status: 'cancelled' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.task.status).toBe('cancelled');
        expect(result.data.task.cancelledAt).toBeTruthy();
        expect(result.data.task.pipelineStage).toBe('cancelled');
      }
    });
  });

  // ==========================================================================
  // T11811 AC2 — orphan-prevention guard: `update --status cancelled` MUST NOT
  // silently strand active children. Before this fix, cancelling a parent via
  // the update path flipped the parent to cancelled while leaving its active
  // children attached to a terminal parent (the exact T9031/T9044 strand). The
  // guard routes the cancellation through the SAME child-disposition decision
  // `coreTaskCancel` uses: the DEFAULT on a parent with active children BLOCKS
  // with E_HAS_CHILDREN, pointing the agent at `cleo cancel <id> --children …`.
  // ==========================================================================
  describe('child-disposition guard (T11811 AC2)', () => {
    /**
     * Seed an epic with two active task children. The epic is the
     * cancellation target; the children are the strand risk.
     */
    async function seedParentWithActiveChildren(): Promise<void> {
      await seedTasks(accessor, [
        {
          id: 'T8000',
          title: 'Parent epic with active children',
          type: 'epic',
          status: 'active',
          priority: 'medium',
          pipelineStage: 'implementation',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T8001',
          title: 'Active child A',
          type: 'task',
          parentId: 'T8000',
          status: 'active',
          priority: 'medium',
          pipelineStage: 'implementation',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T8002',
          title: 'Active child B',
          type: 'task',
          parentId: 'T8000',
          status: 'pending',
          priority: 'medium',
          pipelineStage: 'research',
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    it('STRANDS active children — update --status=cancelled bypasses child disposition (T11811 AC2 repro)', async () => {
      // This is the pinned bug. With the guard in place, cancelling a parent
      // that still has ACTIVE children via the update path MUST be rejected
      // (E_HAS_CHILDREN) rather than silently flipping the parent and orphaning
      // the children. The repro asserts the children remain UNCHANGED because
      // the operation was refused — no silent strand.
      await seedParentWithActiveChildren();

      await expect(
        updateTask({ taskId: 'T8000', status: 'cancelled' }, env.tempDir, accessor),
      ).rejects.toMatchObject({ code: ExitCode.HAS_CHILDREN });

      // Parent unchanged (still active), children unchanged (still attached).
      const parent = await accessor.loadSingleTask('T8000');
      const childA = await accessor.loadSingleTask('T8001');
      const childB = await accessor.loadSingleTask('T8002');
      expect(parent?.status).toBe('active');
      expect(childA?.status).toBe('active');
      expect(childA?.parentId).toBe('T8000');
      expect(childB?.status).toBe('pending');
      expect(childB?.parentId).toBe('T8000');
    });

    it('the E_HAS_CHILDREN error points the operator at `cleo cancel`', async () => {
      await seedParentWithActiveChildren();

      await expect(
        updateTask({ taskId: 'T8000', status: 'cancelled' }, env.tempDir, accessor),
      ).rejects.toMatchObject({
        code: ExitCode.HAS_CHILDREN,
        fix: expect.stringContaining('cleo cancel'),
      });
    });

    it('cancelling a leaf (no children) via update still succeeds', async () => {
      await seedTasks(accessor, [
        {
          id: 'T8100',
          title: 'Leaf task',
          type: 'task',
          status: 'active',
          priority: 'medium',
          pipelineStage: 'implementation',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T8100', status: 'cancelled' },
        env.tempDir,
        accessor,
      );
      expect(result.task.status).toBe('cancelled');
      expect(result.task.pipelineStage).toBe('cancelled');
    });

    it('cancelling a parent whose children are already terminal succeeds (no active strand risk)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T8200',
          title: 'Parent with done children',
          type: 'epic',
          status: 'active',
          priority: 'medium',
          pipelineStage: 'implementation',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T8201',
          title: 'Done child',
          type: 'task',
          parentId: 'T8200',
          status: 'done',
          priority: 'medium',
          completedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T8200', status: 'cancelled' },
        env.tempDir,
        accessor,
      );
      expect(result.task.status).toBe('cancelled');
    });
  });
});
