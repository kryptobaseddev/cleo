/**
 * Tests for an explicit spawn base (`cleo orchestrate spawn --base <ref>`) in
 * `createWorktree` (T14027).
 *
 * 1. A non-HEAD base: the task branch starts at that commit, the primary
 *    checkout's HEAD never moves, and the resolved sha is audited.
 * 2. A ref that does not resolve is refused before anything is created.
 * 3. An existing worktree or branch with a different base is refused and left
 *    untouched; one cut from the same base is re-attached.
 *
 * @task T14027
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKTREE_LIFECYCLE_AUDIT_FILE } from '../worktree-audit.js';
import { createWorktree } from '../worktree-create.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(['add', file], cwd);
  git(['commit', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

describe('createWorktree — explicit base (T14027)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;
  /** Tip of `dep`, a branch the primary checkout does not have checked out. */
  let depSha: string;
  let mainSha: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-base-'));
    git(['init', '--initial-branch=main'], projectRoot);
    git(['config', 'user.email', 'test@example.com'], projectRoot);
    git(['config', 'user.name', 'Test'], projectRoot);
    commit(projectRoot, 'README.md', 'init');
    git(['checkout', '-b', 'dep'], projectRoot);
    depSha = commit(projectRoot, 'dep.txt', 'dependency work');
    git(['checkout', 'main'], projectRoot);
    mainSha = commit(projectRoot, 'main.txt', 'main moves on');
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(() => {
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function auditRows(): Array<Record<string, string | boolean>> {
    const file = join(projectRoot, WORKTREE_LIFECYCLE_AUDIT_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string | boolean>);
  }

  it('branches from a non-HEAD base, leaves the primary HEAD alone, and audits the sha', async () => {
    const result = await createWorktree(projectRoot, {
      taskId: 'T8001',
      baseRef: 'dep',
      lockWorktree: false,
      skipInstall: true,
    });

    expect(result.reused).toBe(false);
    expect(result.baseRef).toBe(depSha);
    expect(git(['rev-parse', 'task/T8001'], projectRoot)).toBe(depSha);
    expect(existsSync(join(result.path, 'dep.txt'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], projectRoot)).toBe(mainSha);
    expect(git(['symbolic-ref', 'HEAD'], projectRoot)).toBe('refs/heads/main');
    const create = auditRows().find((r) => r['action'] === 'create' && r['taskId'] === 'T8001');
    expect(create).toMatchObject({ baseRef: 'dep', baseSha: depSha });
  });

  it('refuses a base that does not resolve, creating nothing', async () => {
    for (const bad of ['no-such-ref', '--orphan']) {
      const err = await createWorktree(projectRoot, {
        taskId: 'T8002',
        baseRef: bad,
        lockWorktree: false,
      }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe(BRANCH_LOCK_ERROR_CODES.E_WORKTREE_BASE_INVALID);
    }
    expect(git(['branch', '--list', 'task/T8002'], projectRoot)).toBe('');
    expect(git(['rev-parse', 'HEAD'], projectRoot)).toBe(mainSha);
  });

  it('refuses an existing worktree created from a different base and leaves it untouched', async () => {
    const holder = { sessionId: 'ses_base', agentId: 'agent-t8003' };
    const first = await createWorktree(projectRoot, {
      taskId: 'T8003',
      lockWorktree: false,
      skipInstall: true,
      holder,
    });
    writeFileSync(join(first.path, 'wip.txt'), 'wip\n');

    const err = await createWorktree(projectRoot, {
      taskId: 'T8003',
      baseRef: 'dep',
      lockWorktree: false,
      holder,
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe(BRANCH_LOCK_ERROR_CODES.E_WORKTREE_BASE_MISMATCH);
    expect((err as { freshWorktreeCreated?: boolean }).freshWorktreeCreated).toBe(false);
    expect(readFileSync(join(first.path, 'wip.txt'), 'utf-8')).toBe('wip\n');
    expect(git(['rev-parse', 'task/T8003'], projectRoot)).toBe(mainSha);
    expect(git(['rev-parse', 'HEAD'], projectRoot)).toBe(mainSha);
  });

  it('refuses a recorded base that differs even when the branch contains the requested one', async () => {
    const holder = { sessionId: 'ses_base', agentId: 'agent-t8006' };
    // Cut from main (whose history contains the init commit), then ask for init.
    await createWorktree(projectRoot, {
      taskId: 'T8006',
      lockWorktree: false,
      skipInstall: true,
      holder,
    });
    const initSha = git(['rev-parse', 'main~1'], projectRoot);
    const err = await createWorktree(projectRoot, {
      taskId: 'T8006',
      baseRef: initSha,
      lockWorktree: false,
      holder,
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(BRANCH_LOCK_ERROR_CODES.E_WORKTREE_BASE_MISMATCH);
  });

  it('re-attaches an existing worktree cut from the same base', async () => {
    const holder = { sessionId: 'ses_base', agentId: 'agent-t8004' };
    const opts = {
      taskId: 'T8004',
      baseRef: 'dep',
      lockWorktree: false,
      skipInstall: true,
      holder,
    };
    await createWorktree(projectRoot, opts);
    const again = await createWorktree(projectRoot, opts);
    expect(again.reused).toBe(true);
    expect(git(['rev-parse', 'task/T8004'], projectRoot)).toBe(depSha);
  });

  it('refuses a leftover task branch that does not start at the base', async () => {
    git(['branch', 'task/T8005', 'main'], projectRoot);
    const err = await createWorktree(projectRoot, {
      taskId: 'T8005',
      baseRef: 'dep',
      lockWorktree: false,
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(BRANCH_LOCK_ERROR_CODES.E_WORKTREE_BASE_MISMATCH);
    expect(git(['rev-parse', 'task/T8005'], projectRoot)).toBe(mainSha);
  });
});
