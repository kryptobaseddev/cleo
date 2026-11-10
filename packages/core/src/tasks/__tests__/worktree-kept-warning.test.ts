/**
 * A worktree that `cleo complete` or `cleo cancel` keeps is never silent: both
 * surface a `W_WORKTREE_KEPT` envelope warning naming the path and blockers,
 * and cancel returns the blockers too (T13701).
 *
 * @task T13701
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DisposeWorktreeOptions,
  DisposeWorktreeResult,
  ListWorktreesResult,
  WorktreeDisposalBlockers,
} from '@cleocode/contracts';
import { engineSuccess } from '@cleocode/contracts/engine-result.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainWarnings } from '../../output.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';
import { coreTaskCancel } from '../engine-wrap.js';

const KEPT: WorktreeDisposalBlockers = {
  dependents: ['/wt/T2/node_modules'],
  evidence: ['/wt/T1/tmp/vitest.json'],
};
const MESSAGE = 'Worktree /wt/T1 kept: 1 link(s) from other checkouts resolve into it.';

vi.mock('../../spawn/branch-integration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../spawn/branch-integration.js')>()),
  completeAgentWorktreeIntegration: () => ({
    taskId: 'T001',
    targetBranch: 'main',
    merged: true,
    commitCount: 1,
    rebased: false,
    worktreeRemoved: false,
    worktreeKept: KEPT,
    branchDeleted: false,
    error: MESSAGE,
    auditLogPath: '',
  }),
}));

vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  disposeWorktree: (options: DisposeWorktreeOptions): DisposeWorktreeResult => ({
    worktreePath: options.worktreePath,
    removed: false,
    keptReason: MESSAGE,
    kept: KEPT,
  }),
}));

vi.mock('../../worktree/list.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worktree/list.js')>()),
  listWorktrees: async () =>
    engineSuccess<ListWorktreesResult>({
      worktrees: [
        {
          path: '/wt/T1',
          branch: 'task/T001',
          taskId: 'T001',
          owningAgent: null,
          lastActivity: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          isLocked: false,
          lockState: 'unlocked',
          isStale: false,
          isMerged: true,
          owningTaskStatus: 'cancelled',
          statusCategory: 'keep',
          source: 'cleo-spawn',
        },
      ],
    }),
}));

describe('W_WORKTREE_KEPT (T13701)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Kept',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    drainWarnings();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('complete warns with the path and blockers', async () => {
    await completeTask({ taskId: 'T001' }, env.tempDir, env.accessor);
    const warning = drainWarnings()?.find((w) => w.code === 'W_WORKTREE_KEPT');
    expect(warning?.message).toBe(MESSAGE);
    expect(warning?.context).toEqual({ taskId: 'T001', ...KEPT });
  });

  it('cancel awaits disposal, warns, and returns the blockers', async () => {
    const result = await coreTaskCancel(env.tempDir, 'T001');
    expect(result.worktreeKept).toEqual(KEPT);
    const warning = drainWarnings()?.find((w) => w.code === 'W_WORKTREE_KEPT');
    expect(warning?.message).toBe(MESSAGE);
    expect(warning?.context).toEqual({ taskId: 'T001', ...KEPT });
  });
});
