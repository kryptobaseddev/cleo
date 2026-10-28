/**
 * T12883 R3: pipeline_stage never moves backwards through `tasks.bulk-move`,
 * matching `updateTask`'s forward-only rule (validatePipelineTransition).
 *
 * @task T12883
 */

import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { coreTaskBulkMove } from '../task-reparent.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

describe('T12883 R3 — pipeline_stage only moves forward', () => {
  it('bulk-move refuses a backward stage for any task and moves nothing; forward still applies', async () => {
    const createdAt = new Date().toISOString();
    await seedTasks(env.accessor, [
      {
        id: 'T1',
        title: 'In testing',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'testing',
        createdAt,
      },
      {
        id: 'T2',
        title: 'In research',
        status: 'active',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt,
      },
    ]);
    let code: unknown = 'resolved';
    try {
      await coreTaskBulkMove(env.tempDir, ['T1', 'T2'], { pipelineStage: 'implementation' });
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBe(ExitCode.VALIDATION_ERROR);
    expect((await env.accessor.loadSingleTask('T2'))?.pipelineStage).toBe('research');

    const moved = await coreTaskBulkMove(env.tempDir, ['T2'], { pipelineStage: 'implementation' });
    expect(moved.moved).toEqual(['T2']);
    expect((await env.accessor.loadSingleTask('T2'))?.pipelineStage).toBe('implementation');
  });
});
