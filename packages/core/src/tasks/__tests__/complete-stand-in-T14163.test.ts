/**
 * `cleo complete` records why a scoped post-merge run stood in for a
 * manifest-only workspace change (T14163, AC2 "with that reason recorded"):
 * the importers and merge commit land on the stored testsPassed evidence.
 *
 * @task T14163
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';
import type { MergedCiOutcome } from '../complete-ci.js';

const outcome = vi.hoisted(() => ({ value: null as null | MergedCiOutcome }));

vi.mock('../complete-ci.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../complete-ci.js')>();
  return {
    ...actual,
    satisfyGatesFromMergedCi: async (
      ...args: Parameters<typeof actual.satisfyGatesFromMergedCi>
    ): Promise<MergedCiOutcome> => outcome.value ?? actual.satisfyGatesFromMergedCi(...args),
  };
});

const MERGE = 'a'.repeat(40);

describe('cleo complete records a manifest-scoped stand-in (T14163)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: true, requiredGates: ['implemented', 'testsPassed'] },
      }),
    );
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dependency bump',
        status: 'active',
        priority: 'medium',
        createdAt: now,
        type: 'task',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true },
          lastAgent: 'testing',
          lastUpdated: now,
          failureLog: [],
          evidence: {
            implemented: {
              atoms: [
                {
                  kind: 'pr',
                  prNumber: 42,
                  mergedAt: '2026-10-29T00:00:00Z',
                  mergeCommitSha: MERGE,
                  successCount: 0,
                  totalChecks: 0,
                },
              ],
              capturedAt: now,
              capturedBy: 'test',
            },
            testsPassed: {
              atoms: [{ kind: 'tool', tool: 'test', exitCode: 0 }],
              capturedAt: now,
              capturedBy: 'test',
            },
          },
        },
      } as Parameters<typeof seedTasks>[1][number],
    ]);
  });

  afterEach(async () => {
    outcome.value = null;
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('writes the importers and merge commit onto the stored testsPassed evidence', async () => {
    outcome.value = {
      kind: 'skipped',
      testsPassedReason: null,
      qaPassedReason: null,
      testsPassedStandIn: { mergeCommit: MERGE, importers: ['packages/app'] },
    };
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    const stored = await accessor.loadSingleTask('T001');
    expect(stored?.verification?.evidence?.testsPassed?.standIn).toEqual({
      kind: 'manifest-scoped',
      mergeCommit: MERGE,
      importers: ['packages/app'],
      recordedAt: expect.any(String),
    });
  });

  it('records nothing when no stand-in applied', async () => {
    outcome.value = { kind: 'skipped', testsPassedReason: null, qaPassedReason: null };
    await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    const stored = await accessor.loadSingleTask('T001');
    expect(stored?.verification?.evidence?.testsPassed?.standIn).toBeUndefined();
  });
});
