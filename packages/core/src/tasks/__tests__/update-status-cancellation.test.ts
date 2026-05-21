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
  });
});
