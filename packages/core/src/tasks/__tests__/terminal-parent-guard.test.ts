/**
 * T12883 R1: no terminal parent over live children, on every writer that can
 * produce one — completion of any parent type, a move under a cancelled or
 * archived parent (update and reparent), a terminal bulk status, and a
 * restore or unarchive under a cancelled parent.
 *
 * @task T12883
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';
import { coreTaskBulkMove, coreTaskReparent, coreTaskRestore } from '../task-reparent.js';
import { updateTask } from '../update.js';

let env: TestDbEnv;
let accessor: DataAccessor;
const now = new Date().toISOString();

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
  process.env['CLEO_DIR'] = env.cleoDir;
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

const live = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'pending' as const,
  priority: 'medium' as const,
  pipelineStage: 'implementation',
  createdAt: now,
  ...extra,
});
const cancelled = (id: string, extra: Record<string, unknown> = {}) => ({
  ...live(id, extra),
  status: 'cancelled' as const,
  pipelineStage: 'cancelled',
  cancelledAt: now,
});

/** The CleoError code of a rejected promise, or 'resolved'. */
async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return (err as { code?: unknown }).code ?? 'thrown';
  }
}

describe('T12883 R1 — terminal parent with live children', () => {
  it('completing a non-epic parent with a live subtask is refused', async () => {
    await seedTasks(accessor, [
      live('T100', { type: 'task' }),
      live('T101', { type: 'subtask', parentId: 'T100' }),
    ]);
    expect(await codeOf(completeTask({ taskId: 'T100' }, env.tempDir, accessor))).toBe(
      ExitCode.EPIC_HAS_PENDING_CHILDREN,
    );
    expect((await accessor.loadSingleTask('T100'))?.status).toBe('pending');
  });

  it('updateTask refuses to move a task under a cancelled parent', async () => {
    await seedTasks(accessor, [
      cancelled('T200', { type: 'epic' }),
      live('T201', { type: 'epic' }),
      live('T202', { type: 'task', parentId: 'T201' }),
    ]);
    expect(
      await codeOf(updateTask({ taskId: 'T202', parentId: 'T200' }, env.tempDir, accessor)),
    ).toBe(ExitCode.VALIDATION_ERROR);
    expect((await accessor.loadSingleTask('T202'))?.parentId).toBe('T201');
  });

  it('coreTaskReparent refuses a cancelled parent', async () => {
    await seedTasks(accessor, [
      cancelled('T300', { type: 'epic' }),
      live('T301', { type: 'epic' }),
      live('T302', { type: 'task', parentId: 'T301' }),
    ]);
    expect(await codeOf(coreTaskReparent(env.tempDir, 'T302', 'T300'))).toBe(
      ExitCode.VALIDATION_ERROR,
    );
  });

  it('a terminal bulk status refuses a parent with live children; a leaf still moves', async () => {
    await seedTasks(accessor, [
      live('T400', { type: 'epic' }),
      live('T401', { type: 'task', parentId: 'T400' }),
      live('T402', { type: 'epic' }),
    ]);
    expect(await codeOf(coreTaskBulkMove(env.tempDir, ['T400'], { status: 'cancelled' }))).toBe(
      ExitCode.HAS_CHILDREN,
    );
    expect((await accessor.loadSingleTask('T400'))?.status).toBe('pending');
    const moved = await coreTaskBulkMove(env.tempDir, ['T402'], { status: 'active' });
    expect(moved.moved).toEqual(['T402']);
  });

  it('restoring a child whose parent is still cancelled is refused', async () => {
    await seedTasks(accessor, [
      cancelled('T500', { type: 'epic' }),
      cancelled('T501', { type: 'task', parentId: 'T500' }),
    ]);
    expect(await codeOf(coreTaskRestore(env.tempDir, 'T501'))).toBe(ExitCode.VALIDATION_ERROR);
    // Restoring the parent with --cascade brings both back.
    const restored = await coreTaskRestore(env.tempDir, 'T500', { cascade: true });
    expect(restored.restored.sort()).toEqual(['T500', 'T501']);
  });
});
