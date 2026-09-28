/**
 * T12506 review item 1 — `link(2)` failures must never cost data.
 *
 * On exFAT `link(2)` fails with ENOTSUP; on a read-only or full CLEO_HOME it
 * fails with EROFS / ENOSPC / EACCES. The first build of the lock rethrew these
 * as a generic error, spawn-ops answered it with `destroyWorktree(force,
 * deleteBranch)`, and a live worktree was deleted. Now:
 * - "hard links unsupported" falls back to O_EXCL on the final path;
 * - every other failure is an `E_WORKTREE_LOCKED` refusal (`lock-unavailable`)
 *   flagged `freshWorktreeCreated: false`, so no caller may clean up.
 *
 * `node:fs` is mocked so `linkSync` can be made to fail on demand.
 *
 * @task T12506
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linkFailure: { code: string | null } = { code: null };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const linkSync: typeof actual.linkSync = (existing, target) => {
    if (linkFailure.code !== null && String(target).endsWith('.lock')) {
      throw Object.assign(new Error(`${linkFailure.code}: mocked link failure`), {
        code: linkFailure.code,
      });
    }
    return actual.linkSync(existing, target);
  };
  return { ...actual, default: { ...actual, linkSync }, linkSync };
});

const { createWorktree } = await import('../worktree-create.js');
const { isWorktreeLockedError, readWorktreeTaskLock, releaseWorktreeTaskLock } = await import(
  '../worktree-lock.js'
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('worktree lock — link(2) failure (T12506 review item 1)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-link-'));
    git(['init', '--initial-branch=main'], projectRoot);
    git(['config', 'user.email', 't@example.com'], projectRoot);
    git(['config', 'user.name', 'T'], projectRoot);
    writeFileSync(join(projectRoot, 'README.md'), '# t\n');
    git(['add', 'README.md'], projectRoot);
    git(['commit', '-m', 'init'], projectRoot);
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-link-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
    linkFailure.code = null;
  });

  afterEach(() => {
    linkFailure.code = null;
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('ENOTSUP (exFAT): falls back to O_EXCL and still excludes a second spawn', async () => {
    linkFailure.code = 'ENOTSUP';
    const first = await createWorktree(projectRoot, {
      taskId: 'T8001',
      lockWorktree: false,
      holder: { sessionId: 'ses_a', agentId: 'agent-a' },
    });
    expect(first.lock?.status).toBe('acquired');
    expect(readWorktreeTaskLock(first.projectHash, 'T8001')?.sessionId).toBe('ses_a');
    await expect(
      createWorktree(projectRoot, {
        taskId: 'T8001',
        lockWorktree: false,
        holder: { sessionId: 'ses_b', agentId: 'agent-b' },
      }),
    ).rejects.toMatchObject({ code: 'E_WORKTREE_LOCKED' });
  });

  for (const code of ['EACCES', 'EROFS', 'ENOSPC']) {
    it(`${code}: a refusal flagged not-fresh, and the live worktree survives`, async () => {
      const live = await createWorktree(projectRoot, { taskId: 'T8002', lockWorktree: false });
      writeFileSync(join(live.path, 'committed.txt'), 'c\n');
      git(['add', 'committed.txt'], live.path);
      git(['commit', '-m', 'agent work'], live.path);
      writeFileSync(join(live.path, 'wip.txt'), 'uncommitted\n');
      // The live holder's lock goes away (e.g. reclaimed), then link breaks.
      releaseWorktreeTaskLock(live.projectHash, 'T8002');
      linkFailure.code = code;

      const err = await createWorktree(projectRoot, { taskId: 'T8002', lockWorktree: false }).catch(
        (e: unknown) => e,
      );
      expect(isWorktreeLockedError(err)).toBe(true);
      if (!isWorktreeLockedError(err)) return;
      expect(err.reason).toBe('lock-unavailable');
      expect(err.exitCode).toBe(25);
      expect(err.message).toContain(code);
      // spawn-ops cleans up only when this is true.
      expect((err as { freshWorktreeCreated?: boolean }).freshWorktreeCreated).not.toBe(true);
      expect(readFileSync(join(live.path, 'wip.txt'), 'utf-8')).toBe('uncommitted\n');
      expect(readFileSync(join(live.path, 'committed.txt'), 'utf-8')).toBe('c\n');
    });
  }
});
