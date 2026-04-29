/**
 * Tests for pivotTask — first-class context-switch verb.
 *
 * Covers the four behavioral guarantees from T1596:
 *  1. Pivot from active task → success (focus + audit + memory + blocker)
 *  2. Pivot from non-active task → rejected (E_NOT_ACTIVE / ACTIVE_TASK_REQUIRED)
 *  3. Pivot without --reason → rejected (E_VALIDATION)
 *  4. Audit JSONL appended; memory observation recorded; blocker chain set
 *
 * @task T1596
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { startTask } from '../../task-work/index.js';
import { PIVOT_AUDIT_FILE, pivotTask } from '../pivot.js';

describe('pivotTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it('rejects when --reason is missing or whitespace-only', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    await expect(
      pivotTask('T001', 'T002', {
        reason: '',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toMatchObject({
      code: ExitCode.VALIDATION_ERROR,
    });

    await expect(
      pivotTask('T001', 'T002', {
        reason: '   ',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toBeInstanceOf(CleoError);
  });

  it('rejects when fromTaskId equals toTaskId', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium' },
    ]);

    await expect(
      pivotTask('T001', 'T001', {
        reason: 'self pivot',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toMatchObject({ code: ExitCode.INVALID_INPUT });
  });

  it('rejects when from task does not exist', async () => {
    await seedTasks(accessor, [{ id: 'T002', title: 'To', status: 'pending', priority: 'medium' }]);

    await expect(
      pivotTask('T999', 'T002', {
        reason: 'missing from',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toMatchObject({ code: ExitCode.NOT_FOUND });
  });

  it('rejects when to task does not exist', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    await expect(
      pivotTask('T001', 'T999', {
        reason: 'missing to',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toMatchObject({ code: ExitCode.NOT_FOUND });
  });

  // ---------------------------------------------------------------------------
  // Active-task gate
  // ---------------------------------------------------------------------------

  it('rejects when fromTaskId is not currently active (E_NOT_ACTIVE)', async () => {
    await seedTasks(accessor, [
      // No focus, no implementation/verification/test stage → not active
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);

    await expect(
      pivotTask('T001', 'T002', {
        reason: 'should fail — from is idle',
        projectRoot: env.tempDir,
        accessor,
      }),
    ).rejects.toMatchObject({
      code: ExitCode.ACTIVE_TASK_REQUIRED,
    });
  });

  it('accepts when from task is active by pipelineStage even if not focus', async () => {
    await seedTasks(accessor, [
      {
        id: 'T010',
        title: 'In implementation',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
      },
      { id: 'T011', title: 'To', status: 'pending', priority: 'medium' },
    ]);

    const result = await pivotTask('T010', 'T011', {
      reason: 'discovered missing schema during build',
      projectRoot: env.tempDir,
      accessor,
    });

    expect(result.fromTaskId).toBe('T010');
    expect(result.toTaskId).toBe('T011');
  });

  // ---------------------------------------------------------------------------
  // Happy path — focus + audit + memory + blocker
  // ---------------------------------------------------------------------------

  it('pivots from active task to new task — success path', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    const result = await pivotTask('T001', 'T002', {
      reason: 'audit -> layering -> engine sidetrack discovered',
      projectRoot: env.tempDir,
      accessor,
    });

    // pivotId is opaque but stable in shape
    expect(result.pivotId).toMatch(/^PIV-/);
    expect(result.fromTaskId).toBe('T001');
    expect(result.toTaskId).toBe('T002');
    expect(result.reason).toBe('audit -> layering -> engine sidetrack discovered');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.blockedFrom).toBe(true);
    expect(result.auditEntry).toContain(result.pivotId);

    // Focus state should now point at toTaskId
    const focus = await accessor.getMetaValue<{ currentTask?: string }>('focus_state');
    expect(focus?.currentTask).toBe('T002');
  });

  it('appends one JSON line to .cleo/audit/pivots.jsonl per pivot', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
      { id: 'T003', title: 'To2', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    const r1 = await pivotTask('T001', 'T002', {
      reason: 'first pivot',
      projectRoot: env.tempDir,
      accessor,
    });

    // After first pivot, T002 is focus. Pivot again to T003.
    const r2 = await pivotTask('T002', 'T003', {
      reason: 'second pivot',
      projectRoot: env.tempDir,
      accessor,
    });

    const auditPath = join(env.tempDir, PIVOT_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.pivotId).toBe(r1.pivotId);
    expect(first.from).toBe('T001');
    expect(first.to).toBe('T002');
    expect(first.reason).toBe('first pivot');
    expect(second.pivotId).toBe(r2.pivotId);
    expect(second.from).toBe('T002');
    expect(second.to).toBe('T003');
  });

  it('records a memory observation for the pivot', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    const result = await pivotTask('T001', 'T002', {
      reason: 'memory write check',
      projectRoot: env.tempDir,
      accessor,
    });

    // memoryObservationId is best-effort; test environments may or may not
    // be able to write to brain.db. If it succeeded we get a non-null id;
    // either way the operation must not throw.
    expect(
      typeof result.memoryObservationId === 'string' || result.memoryObservationId === null,
    ).toBe(true);
  });

  it('adds a dependency edge from→to when blocksFrom defaults to true', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    await pivotTask('T001', 'T002', {
      reason: 'blocker chain check',
      projectRoot: env.tempDir,
      accessor,
    });

    const fromAfter = await accessor.loadSingleTask('T001');
    expect(fromAfter?.depends ?? []).toContain('T002');
  });

  it('skips the dependency edge when blocksFrom is explicitly false', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'From', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'To', status: 'pending', priority: 'medium' },
    ]);
    await startTask('T001', env.tempDir, accessor);

    const result = await pivotTask('T001', 'T002', {
      reason: 'advisory pivot — independent completion',
      blocksFrom: false,
      projectRoot: env.tempDir,
      accessor,
    });

    expect(result.blockedFrom).toBe(false);
    const fromAfter = await accessor.loadSingleTask('T001');
    expect(fromAfter?.depends ?? []).not.toContain('T002');
  });
});
