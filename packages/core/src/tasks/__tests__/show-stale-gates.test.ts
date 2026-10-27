/**
 * `cleo show` flags a recorded gate whose evidence no longer stands, but loads
 * the staleness checks only for a task with a recorded passed gate, and judges
 * offline (no merge lookup), so a plain show keeps its startup budget (T14037).
 *
 * @task T14037
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

const staleness = vi.hoisted(() => ({ loaded: false, calls: [] as unknown[][] }));

vi.mock('../gate-staleness.js', () => {
  staleness.loaded = true;
  return {
    gateStaleness: vi.fn(async (...args: unknown[]) => {
      staleness.calls.push(args);
      return [
        {
          gate: 'testsPassed',
          reason: 'test-run output modified since verify: r.json',
          source: 'revalidate',
        },
      ];
    }),
  };
});

describe('cleo show and recorded-gate staleness (T14037)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
  });
  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await env.cleanup();
  });

  const base: Task = {
    id: 'T001',
    title: 'Fixture task',
    description: 'show fixture',
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  };

  it('a task with no recorded evidence never loads the staleness checks', async () => {
    await seedTasks(env.accessor, [base]);
    const { taskShowOperation } = await import('../show.js');
    expect((await taskShowOperation(env.tempDir, { taskId: 'T001' })).success).toBe(true);
    expect(staleness.loaded).toBe(false);
  });

  it('a recorded passed gate is judged offline and flagged W_GATE_STALE', async () => {
    await seedTasks(env.accessor, [
      {
        ...base,
        verification: {
          passed: false,
          round: 1,
          gates: { testsPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
          evidence: {
            testsPassed: {
              atoms: [{ kind: 'tool', tool: 'test', exitCode: 0 }],
              capturedAt: new Date().toISOString(),
              capturedBy: 'test',
            },
          },
        },
      },
    ]);
    const { drainWarnings } = await import('../../output.js');
    drainWarnings();
    const { taskShowOperation } = await import('../show.js');
    expect((await taskShowOperation(env.tempDir, { taskId: 'T001' })).success).toBe(true);
    expect(staleness.loaded).toBe(true);
    expect(staleness.calls.at(-1)?.[3]).toEqual({ offline: true });
    expect(drainWarnings()).toContainEqual(
      expect.objectContaining({
        code: 'W_GATE_STALE',
        message: expect.stringContaining('cleo done T001 --plan gives the full verdict'),
      }),
    );
  });
});
