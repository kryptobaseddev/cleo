/** Terminal task lifecycle over real git, real locks and the task store (T14438). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProjectInfoAtDirectorySync } from '../../project-scope.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { completeTask } from '../complete.js';
import { coreTaskCancel } from '../engine-wrap.js';
import { updateTask } from '../update.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

describe('terminal task worktree release', () => {
  let env: TestDbEnv;
  let path: string;
  let hash: string;
  beforeEach(async () => {
    env = await createTestDb();
    vi.stubEnv('CLEO_DIR', env.cleoDir);
    vi.stubEnv('CLEO_ROOT', env.tempDir);
    writeFileSync(
      join(env.cleoDir, 'project.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: readProjectInfoAtDirectorySync(env.tempDir, env.cleoDir).projectId,
        name: 'terminal-release',
      }),
    );
    writeFileSync(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
    git(env.tempDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(env.tempDir, '.gitignore'), '.cleo/\n');
    git(env.tempDir, 'add', '.gitignore');
    git(env.tempDir, 'commit', '-q', '-m', 'initial');
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Release',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    hash = computeProjectHash(env.tempDir);
    const dir = resolveWorktreeRootForHash(hash);
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'T001');
    git(env.tempDir, 'worktree', 'add', '-q', '-b', 'task/T001', path, 'main');
    git(env.tempDir, 'worktree', 'lock', path);
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T001' });
  });
  afterEach(async () => {
    rmSync(path, { recursive: true, force: true });
    vi.unstubAllEnvs();
    await env.cleanup();
  });

  it('completion releases both locks and automatically removes a proven-safe worktree, retaining its branch', async () => {
    const result = await completeTask(
      { taskId: 'T001', noIntegrate: true },
      env.tempDir,
      env.accessor,
    );
    expect(result.task.status).toBe('done');
    expect(result.worktreeRelease).toEqual([{ worktreePath: path, removed: true }]);
    expect(existsSync(path)).toBe(false);
    expect(readWorktreeTaskLock(hash, 'T001')).toBeNull();
    expect(git(env.tempDir, 'rev-parse', '--verify', 'refs/heads/task/T001')).toBeTruthy();
  });

  it('cancellation unlocks but keeps unpublished work, reports why, and retains the branch', async () => {
    writeFileSync(join(path, 'unpublished.txt'), 'keep me');
    const result = await coreTaskCancel(env.tempDir, 'T001');
    expect(result.cancelled).toBe(true);
    expect(result.worktreeRelease?.[0]?.keptReason).toContain('uncommitted or untracked');
    expect(existsSync(path)).toBe(true);
    expect(readWorktreeTaskLock(hash, 'T001')).toBeNull();
    expect(git(env.tempDir, 'worktree', 'list', '--porcelain')).not.toContain('locked');
    expect(git(env.tempDir, 'rev-parse', '--verify', 'refs/heads/task/T001')).toBeTruthy();
  });

  it('status-update cancellation uses the same terminal-task release', async () => {
    await updateTask({ taskId: 'T001', status: 'cancelled' }, env.tempDir, env.accessor);
    expect(existsSync(path)).toBe(false);
    expect(readWorktreeTaskLock(hash, 'T001')).toBeNull();
    expect(git(env.tempDir, 'rev-parse', '--verify', 'refs/heads/task/T001')).toBeTruthy();
  });
});
