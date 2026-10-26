/**
 * `completeTask` runs worktree integration once, and `--no-integrate` or
 * `CLEO_NO_AUTO_WORKTREE_COMPLETE` switch that one call off; the completion
 * result carries the single integration outcome (T14053).
 *
 * @task T14053
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';

const integrate = vi.hoisted(() => vi.fn());

vi.mock('../../spawn/branch-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../spawn/branch-lock.js')>()),
  completeAgentWorktreeIntegration: integrate,
}));

describe('completeTask worktree integration gate (T14053)', () => {
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
        title: 'Gate',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    integrate.mockReset();
    integrate.mockReturnValue({
      taskId: 'T001',
      targetBranch: 'main',
      merged: true,
      mergeCommit: 'abc1234',
      commitCount: 1,
      rebased: false,
      worktreeRemoved: true,
      branchDeleted: true,
      auditLogEntry: null,
      plan: {
        branch: 'task/T001',
        worktreePath: '/wt/T001',
        targetBranch: 'main',
        action: 'merge',
        reason: 'merge',
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('integrates once and reports the merge, never pushed', async () => {
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, env.accessor);
    expect(integrate).toHaveBeenCalledTimes(1);
    expect(result.integration).toMatchObject({
      action: 'merge',
      mergeCommit: 'abc1234',
      targetBranch: 'main',
      pushed: false,
    });
  });

  it('--no-integrate skips the integration call', async () => {
    const result = await completeTask(
      { taskId: 'T001', noIntegrate: true },
      env.tempDir,
      env.accessor,
    );
    expect(integrate).not.toHaveBeenCalled();
    expect(result.integration?.action).toBe('skip');
    expect(result.integration?.reason).toMatch(/--no-integrate/);
    expect(result.integration?.pushed).toBe(false);
  });

  it('CLEO_NO_AUTO_WORKTREE_COMPLETE=1 skips the integration call', async () => {
    vi.stubEnv('CLEO_NO_AUTO_WORKTREE_COMPLETE', '1');
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, env.accessor);
    expect(integrate).not.toHaveBeenCalled();
    expect(result.integration?.action).toBe('skip');
    expect(result.integration?.reason).toMatch(/CLEO_NO_AUTO_WORKTREE_COMPLETE/);
  });
});
