/**
 * Regression tests for T832 / T834 — `cleo update --pipelineStage` must work
 * end-to-end. Covers the core-level code path; the dispatch-layer plumbing
 * is tested at the cleo package level.
 *
 * @task T832
 * @task T834
 * @adr ADR-051
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { updateTask } from '../update.js';

describe('updateTask --pipelineStage (T832 / T834)', () => {
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

  it('advances pipelineStage forward (research → consensus)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T500',
        title: 'Epic being advanced',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T500', pipelineStage: 'consensus' },
      env.tempDir,
      accessor,
    );

    expect(result.task.pipelineStage).toBe('consensus');
    expect(result.changes).toContain('pipelineStage');
  });

  it('rejects backward transition (implementation → research)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T501',
        title: 'Cannot go backward',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'implementation',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T501', pipelineStage: 'research' }, env.tempDir, accessor),
    ).rejects.toThrow(/cannot move backward|backward/i);
  });

  it('rejects invalid stage name', async () => {
    await seedTasks(accessor, [
      {
        id: 'T502',
        title: 'Invalid stage test',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T502', pipelineStage: 'bogus_stage' }, env.tempDir, accessor),
    ).rejects.toThrow(/Invalid pipeline stage/i);
  });

  it('allows same-stage no-op', async () => {
    await seedTasks(accessor, [
      {
        id: 'T503',
        title: 'Same-stage noop',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'specification',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T503', pipelineStage: 'specification' },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('specification');
  });

  it('accepts first assignment when currentStage is undefined', async () => {
    await seedTasks(accessor, [
      {
        id: 'T504',
        title: 'No current stage',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T504', pipelineStage: 'decomposition' },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('decomposition');
  });
});
