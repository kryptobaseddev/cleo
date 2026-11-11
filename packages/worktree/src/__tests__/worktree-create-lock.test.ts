/**
 * T12506 — per-task worktree lock + never-destroy provisioning.
 *
 * Real git repositories, real processes. Covers:
 * 1. Concurrent spawns of one task → exactly one succeeds, the other gets
 *    `E_WORKTREE_LOCKED` naming the holder (in-process and across processes).
 * 2. A branch with commits not on the mainline is never deleted — neither on
 *    re-spawn over an existing clean-looking worktree nor under `forceReset`.
 * 3. A dead holder's lock (pid gone, pid recycled, heartbeat stale) is
 *    reclaimed; a live one is not.
 * 4. A second spawn leaves the live worktree's files untouched.
 *
 * @task T12506
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorktreeLockRecord } from '@cleocode/contracts';
import { BRANCH_LOCK_ERROR_CODES, ExitCode } from '@cleocode/contracts';
import { resolveWorktreeTaskLockPath } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeProjectHash, resolveTaskWorktreePath } from '../paths.js';
import { createWorktree } from '../worktree-create.js';
import { destroyWorktree } from '../worktree-destroy.js';
import { disposeOwnedWorktree } from '../worktree-dispose.js';
import {
  acquireWorktreeTaskLock,
  heartbeatWorktreeTaskLock,
  isWorktreeLockedError,
  readProcessStartTime,
  readWorktreeTaskLock,
  releaseWorktreeTaskLock,
  releaseWorktreeTaskLocksForSession,
} from '../worktree-lock.js';

/** T14407: runs once, right before the next `disposeWorktree` does its work. */
const beforeNextDispose = vi.hoisted(() => ({ run: null as (() => void) | null }));

/**
 * T14407: runs once, right after a file read returns text containing `marker`
 * (the source's mutex holder read), before the reader's next step.
 */
const afterMutexRead = vi.hoisted(() => ({
  marker: null as string | null,
  run: null as (() => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = actual.readFileSync(...args);
    const { marker, run } = afterMutexRead;
    if (run !== null && marker !== null && String(out).includes(marker)) {
      afterMutexRead.run = null;
      run();
    }
    return out;
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

vi.mock('../worktree-dispose.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree-dispose.js')>();
  return {
    ...actual,
    disposeWorktree: (...args: Parameters<typeof actual.disposeWorktree>) => {
      const run = beforeNextDispose.run;
      beforeNextDispose.run = null;
      run?.();
      return actual.disposeWorktree(...args);
    },
  };
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Repo with one commit on `main`; `.cleo/cleo.db` is gitignored like the real project. */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-wt-lock-'));
  git(['init', '--initial-branch=main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  writeFileSync(join(dir, '.gitignore'), '.cleo/cleo.db\n');
  git(['add', 'README.md', '.gitignore'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

/** Pid of a process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined) throw new Error('could not spawn');
  return r.pid;
}

/** Write a raw lock record for a bare project hash. */
function plantRaw(projectHash: string, taskId: string, over: Partial<WorktreeLockRecord>): void {
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  mkdirSync(dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  const record: WorktreeLockRecord = {
    schemaVersion: 1,
    token: `raw-${Math.random()}`,
    taskId,
    projectHash,
    sessionId: null,
    agentId: null,
    deviceId: null,
    pid: process.pid,
    processStartedAt: null,
    hostname: hostname(),
    acquiredAt: now,
    heartbeatAt: now,
    ...over,
  };
  writeFileSync(lockPath, JSON.stringify(record));
}

/** Write a lock record directly (simulates a holder from another process). */
function plantLock(projectRoot: string, taskId: string, over: Partial<WorktreeLockRecord>): void {
  const projectHash = computeProjectHash(projectRoot);
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  mkdirSync(dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  const record: WorktreeLockRecord = {
    schemaVersion: 1,
    token: `planted-${Math.random()}`,
    taskId,
    projectHash,
    sessionId: 'ses_holder',
    agentId: 'agent-holder',
    deviceId: null,
    pid: process.pid,
    processStartedAt: null,
    hostname: hostname(),
    acquiredAt: now,
    heartbeatAt: now,
    ...over,
  };
  writeFileSync(lockPath, JSON.stringify(record));
}

/** Commit a file inside a worktree on its task branch. */
function commitIn(worktree: string, file: string, body: string): string {
  writeFileSync(join(worktree, file), body);
  git(['add', file], worktree);
  git(['commit', '-m', `work: ${file}`], worktree);
  return git(['rev-parse', 'HEAD'], worktree).trim();
}

describe('createWorktree — per-task lock (T12506)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    projectRoot = initTempRepo();
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-lock-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('concurrent spawns of one task: exactly one succeeds, the other gets E_WORKTREE_LOCKED', async () => {
    const results = await Promise.allSettled([
      createWorktree(projectRoot, {
        taskId: 'T7001',
        lockWorktree: false,
        holder: { sessionId: 'ses_a', agentId: 'agent-a' },
      }),
      createWorktree(projectRoot, {
        taskId: 'T7001',
        lockWorktree: false,
        holder: { sessionId: 'ses_b', agentId: 'agent-b' },
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = failed[0]?.reason;
    expect(isWorktreeLockedError(err)).toBe(true);
    if (!isWorktreeLockedError(err)) return;
    expect(err.code).toBe(BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED);
    expect(err.exitCode).toBe(ExitCode.WORKTREE_LOCKED);
    expect(err.exitCode).toBe(25);
    // The error names the holder that won.
    expect(err.holder.sessionId).toBe('ses_a');
    expect(err.message).toContain('ses_a');
    expect(err.message).toContain(`pid ${process.pid}`);
  });

  it('records holder identity: session, agent, device, pid + ps start time, heartbeat', async () => {
    const r = await createWorktree(projectRoot, {
      taskId: 'T7002',
      lockWorktree: false,
      holder: { sessionId: 'ses_x', agentId: 'agent-x', deviceId: 'dev-1' },
    });
    const rec = readWorktreeTaskLock(r.projectHash, 'T7002');
    expect(rec).not.toBeNull();
    expect(rec?.sessionId).toBe('ses_x');
    expect(rec?.agentId).toBe('agent-x');
    expect(rec?.deviceId).toBe('dev-1');
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.processStartedAt).toBe(readProcessStartTime(process.pid));
    expect(rec?.heartbeatAt).toBe(rec?.acquiredAt);
    expect(r.lock?.status).toBe('acquired');
  });

  it('a live holder in ANOTHER process blocks the spawn and its worktree files are untouched', async () => {
    const first = await createWorktree(projectRoot, { taskId: 'T7003', lockWorktree: false });
    // Live agent state: committed work, an untracked edit, and gitignored cleo.db.
    const head = commitIn(first.path, 'feature.ts', 'export const x = 1;\n');
    writeFileSync(join(first.path, 'wip.ts'), 'in progress\n');
    mkdirSync(join(first.path, '.cleo'), { recursive: true });
    writeFileSync(join(first.path, '.cleo', 'cleo.db'), 'sqlite');

    // Hand the lock to a live foreign process (the running agent's harness).
    const holder = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(holder);
    const pid = holder.pid ?? 0;
    plantLock(projectRoot, 'T7003', {
      pid,
      processStartedAt: readProcessStartTime(pid),
      sessionId: 'ses_live',
    });

    await expect(
      createWorktree(projectRoot, { taskId: 'T7003', lockWorktree: false }),
    ).rejects.toMatchObject({ code: 'E_WORKTREE_LOCKED' });
    // forceReset does not bypass the lock either.
    await expect(
      createWorktree(projectRoot, { taskId: 'T7003', lockWorktree: false, forceReset: true }),
    ).rejects.toMatchObject({ code: 'E_WORKTREE_LOCKED' });

    expect(readFileSync(join(first.path, 'feature.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(readFileSync(join(first.path, 'wip.ts'), 'utf-8')).toBe('in progress\n');
    expect(readFileSync(join(first.path, '.cleo', 'cleo.db'), 'utf-8')).toBe('sqlite');
    expect(git(['rev-parse', 'task/T7003'], projectRoot).trim()).toBe(head);
  });

  it('dead holder + clean-looking worktree with unmerged commits: re-attached, never deleted', async () => {
    const first = await createWorktree(projectRoot, { taskId: 'T7004', lockWorktree: false });
    const head = commitIn(first.path, 'done.ts', 'committed work\n');
    mkdirSync(join(first.path, '.cleo'), { recursive: true });
    writeFileSync(join(first.path, '.cleo', 'cleo.db'), 'sqlite');
    // `git status --porcelain` is empty — exactly what the old code destroyed.
    expect(git(['status', '--porcelain'], first.path).trim()).toBe('');

    plantLock(projectRoot, 'T7004', { pid: deadPid() });
    const second = await createWorktree(projectRoot, { taskId: 'T7004', lockWorktree: false });

    expect(second.reused).toBe(true);
    expect(second.lock?.status).toBe('reclaimed');
    expect(second.lock?.reclaimReason).toBe('pid-gone');
    expect(second.path).toBe(first.path);
    expect(git(['rev-parse', 'task/T7004'], projectRoot).trim()).toBe(head);
    expect(readFileSync(join(second.path, 'done.ts'), 'utf-8')).toBe('committed work\n');
    expect(readFileSync(join(second.path, '.cleo', 'cleo.db'), 'utf-8')).toBe('sqlite');
  });

  it('forceReset never branch -D history that is not on the mainline — it is preserved', async () => {
    git(['checkout', '-b', 'task/T7005'], projectRoot);
    writeFileSync(join(projectRoot, 'orphan.txt'), 'history worth keeping\n');
    git(['add', 'orphan.txt'], projectRoot);
    git(['commit', '-m', 'unmerged work'], projectRoot);
    const orphan = git(['rev-parse', 'HEAD'], projectRoot).trim();
    git(['checkout', 'main'], projectRoot);

    const r = await createWorktree(projectRoot, {
      taskId: 'T7005',
      lockWorktree: false,
      forceReset: true,
    });
    expect(r.reused).toBe(false);
    expect(git(['log', '--format=%H', 'task/T7005'], projectRoot)).not.toContain(orphan);
    const preserved = git(
      ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/cleo/preserved/'],
      projectRoot,
    ).trim();
    expect(preserved).toContain('cleo/preserved/task/T7005/');
    expect(preserved).toContain(orphan);
  });

  it('forceReset twice within one second preserves BOTH histories under distinct names', async () => {
    const projectHash = computeProjectHash(projectRoot);
    const orphans: string[] = [];
    for (let round = 0; round < 2; round++) {
      git(['checkout', '-B', 'scratch', 'main'], projectRoot);
      writeFileSync(join(projectRoot, `o${round}.txt`), `${round}\n`);
      git(['add', `o${round}.txt`], projectRoot);
      git(['commit', '-m', `unmerged ${round}`], projectRoot);
      orphans.push(git(['rev-parse', 'HEAD'], projectRoot).trim());
      git(['checkout', 'main'], projectRoot);
      const wt = resolveTaskWorktreePath(projectHash, 'T7007');
      if (existsSync(wt)) git(['worktree', 'remove', '--force', wt], projectRoot);
      git(['branch', '-f', 'task/T7007', 'scratch'], projectRoot);
      releaseWorktreeTaskLock(projectHash, 'T7007');
      await createWorktree(projectRoot, { taskId: 'T7007', lockWorktree: false, forceReset: true });
    }
    const refs = git(
      [
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        'refs/heads/cleo/preserved/task/T7007/',
      ],
      projectRoot,
    )
      .trim()
      .split('\n');
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map((r) => r.split(' ')[0])).size).toBe(2);
    for (const sha of orphans) expect(refs.join('\n')).toContain(sha);
  });

  it('the same orchestrator retrying its own spawn re-attaches instead of exit 25 (review item 2)', async () => {
    const holder = { sessionId: 'ses_orch', agentId: 'agent-t7008' };
    const first = await createWorktree(projectRoot, {
      taskId: 'T7008',
      lockWorktree: false,
      holder,
    });
    const head = commitIn(first.path, 'a.ts', 'a\n');
    writeFileSync(join(first.path, 'wip.txt'), 'wip\n');
    const retry = await createWorktree(projectRoot, {
      taskId: 'T7008',
      lockWorktree: false,
      holder,
    });
    expect(retry.lock?.status).toBe('reentered');
    expect(retry.reused).toBe(true);
    expect(readFileSync(join(retry.path, 'wip.txt'), 'utf-8')).toBe('wip\n');
    expect(git(['rev-parse', 'task/T7008'], projectRoot).trim()).toBe(head);
  });

  it('a failure on a pre-existing branch is flagged NOT freshly created (callers must not clean up)', async () => {
    git(['checkout', '-b', 'task/T7009'], projectRoot);
    writeFileSync(join(projectRoot, 'p.txt'), 'x\n');
    git(['add', 'p.txt'], projectRoot);
    git(['commit', '-m', 'pre-existing'], projectRoot);
    git(['checkout', 'main'], projectRoot);
    const err = await createWorktree(projectRoot, { taskId: 'T7009', lockWorktree: false }).catch(
      (e: unknown) => e,
    );
    expect((err as { freshWorktreeCreated?: boolean }).freshWorktreeCreated).toBe(false);
  });

  it('destroyWorktree keeps a branch with unmerged commits unless explicitly forced (review item 5)', async () => {
    const r = await createWorktree(projectRoot, { taskId: 'T7010', lockWorktree: false });
    const head = commitIn(r.path, 'keep.ts', 'k\n');
    const d1 = await destroyWorktree(projectRoot, { taskId: 'T7010', force: true });
    expect(d1.branchDeleted).toBe(false);
    expect(d1.error).toMatch(/kept/);
    expect(git(['rev-parse', 'task/T7010'], projectRoot).trim()).toBe(head);
    const d2 = await destroyWorktree(projectRoot, {
      taskId: 'T7010',
      force: true,
      forceDeleteUnmergedBranch: true,
    });
    expect(d2.branchDeleted).toBe(true);
  });

  it('the lock is released when provisioning fails, so a retry is not blocked', async () => {
    git(['checkout', '-b', 'task/T7006'], projectRoot);
    writeFileSync(join(projectRoot, 'o.txt'), 'x\n');
    git(['add', 'o.txt'], projectRoot);
    git(['commit', '-m', 'orphan'], projectRoot);
    git(['checkout', 'main'], projectRoot);
    await expect(
      createWorktree(projectRoot, { taskId: 'T7006', lockWorktree: false }),
    ).rejects.toMatchObject({ code: BRANCH_LOCK_ERROR_CODES.E_DIRTY_BRANCH });
    expect(readWorktreeTaskLock(computeProjectHash(projectRoot), 'T7006')).toBeNull();
    // Branch untouched.
    expect(git(['log', '--format=%s', 'task/T7006'], projectRoot)).toContain('orphan');
  });

  it('a failed provision removes its fresh worktree before the lock goes, so a concurrent re-spawn is refused and its own worktree is never removed (T14407)', async () => {
    writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    git(['add', 'pnpm-lock.yaml'], projectRoot);
    git(['commit', '-m', 'lockfile'], projectRoot);
    const projectHash = computeProjectHash(projectRoot);
    const worktreePath = resolveTaskWorktreePath(projectHash, 'T7011');
    const respawn = () =>
      createWorktree(projectRoot, {
        taskId: 'T7011',
        lockWorktree: false,
        skipInstall: true,
        holder: { sessionId: 'ses_respawn', agentId: 'agent-respawn' },
      });

    // A re-spawn arrives while the failed call is cleaning up.
    let duringCleanup: Promise<unknown> | undefined;
    beforeNextDispose.run = () => {
      expect(existsSync(worktreePath)).toBe(true);
      duringCleanup = respawn().catch((e: unknown) => e);
    };
    const err = await createWorktree(projectRoot, {
      taskId: 'T7011',
      lockWorktree: false,
      admitInstall: async () => {
        throw new Error('admission failed');
      },
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({
      message: 'admission failed',
      freshWorktreeCreated: true,
      cleanup: { worktreeRemoved: true },
    });
    // Refused, not re-attached to the worktree being removed.
    expect(isWorktreeLockedError(await duringCleanup)).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(readWorktreeTaskLock(projectHash, 'T7011')).toBeNull();

    // The retry gets its own fresh worktree, and no cleanup is left to remove it.
    const second = await respawn();
    expect(second.reused).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    expect(readWorktreeTaskLock(projectHash, 'T7011')?.token).toBe(second.lock?.record.token);
  });

  it('a failed provision keeps the worktree a same-holder retry re-attached meanwhile, and its lock (T14407)', async () => {
    writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    git(['add', 'pnpm-lock.yaml'], projectRoot);
    git(['commit', '-m', 'lockfile'], projectRoot);
    const projectHash = computeProjectHash(projectRoot);
    const holder = { sessionId: 'ses_same', agentId: 'agent-same' };

    // While the first attempt waits on admission, the same caller retries,
    // re-enters the lock (new token) and re-attaches the worktree.
    let retry: Awaited<ReturnType<typeof createWorktree>> | undefined;
    const err = await createWorktree(projectRoot, {
      taskId: 'T7012',
      lockWorktree: false,
      holder,
      admitInstall: async () => {
        retry = await createWorktree(projectRoot, {
          taskId: 'T7012',
          lockWorktree: false,
          skipInstall: true,
          holder,
        });
        throw new Error('admission failed');
      },
    }).catch((e: unknown) => e);

    expect(retry?.lock?.status).toBe('reentered');
    expect(retry?.reused).toBe(true);
    expect(err).toMatchObject({
      message: 'admission failed',
      freshWorktreeCreated: true,
      cleanup: { worktreeRemoved: false, branchDeleted: false },
    });
    // The retry's checkout, branch and lock all survive the first attempt's failure.
    expect(existsSync(retry?.path ?? '')).toBe(true);
    expect(git(['branch', '--list', 'task/T7012'], projectRoot).trim()).not.toBe('');
    expect(readWorktreeTaskLock(projectHash, 'T7012')?.token).toBe(retry?.lock?.record.token);
  });

  it('a failed provision removes exactly the worktree it created, never an older checkout of the task (T14407)', async () => {
    writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    git(['add', 'pnpm-lock.yaml'], projectRoot);
    git(['commit', '-m', 'lockfile'], projectRoot);
    // An older checkout of the same task under another project hash and branch.
    // `-` sorts before any hex hash, so git lists it first, as a task-id lookup would pick it.
    const older = join(cleoHome, 'worktrees', '-olderhash', 'T7013');
    mkdirSync(dirname(older), { recursive: true });
    git(['worktree', 'add', '-b', 'task/T7013-older', older, 'main'], projectRoot);
    const olderHead = commitIn(older, 'older.txt', 'older work\n');
    const fresh = resolveTaskWorktreePath(computeProjectHash(projectRoot), 'T7013');

    const err = await createWorktree(projectRoot, {
      taskId: 'T7013',
      lockWorktree: false,
      admitInstall: async () => {
        throw new Error('admission failed');
      },
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({
      freshWorktreeCreated: true,
      cleanup: { worktreeRemoved: true, branchDeleted: true },
    });
    expect(existsSync(fresh)).toBe(false);
    expect(git(['branch', '--list', 'task/T7013'], projectRoot).trim()).toBe('');
    // The older checkout and its branch are untouched.
    expect(existsSync(join(older, 'older.txt'))).toBe(true);
    expect(git(['rev-parse', 'task/T7013-older'], projectRoot).trim()).toBe(olderHead);
  });
});

describe('acquireWorktreeTaskLock — holder liveness (T12506)', () => {
  let cleoHome: string;
  let originalCleoHome: string | undefined;
  const hash = '0123456789abcdef';
  const children: ChildProcess[] = [];

  beforeEach(() => {
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-lk-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    rmSync(cleoHome, { recursive: true, force: true });
  });

  it('reclaims a lock whose holder pid is gone', () => {
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T1', holder: { pid: deadPid() } });
    const r = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T1' });
    expect(r.status).toBe('reclaimed');
    expect(r.reclaimReason).toBe('pid-gone');
    expect(readWorktreeTaskLock(hash, 'T1')?.token).toBe(r.record.token);
  });

  it('reclaims a lock whose pid is alive but was recycled (start time differs)', () => {
    acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T2',
      holder: { pid: process.pid, processStartedAt: 'Thu Jan  1 00:00:00 1970' },
    });
    const r = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T2' });
    expect(r.status).toBe('reclaimed');
    expect(r.reclaimReason).toBe('pid-recycled');
  });

  it('never reclaims a VERIFIED live holder on heartbeat age (review item 3)', () => {
    const t0 = Date.parse('2026-09-27T00:00:00Z');
    // Holder = this live process with its real start time: verifiable.
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T3', now: () => t0 });
    let caught: unknown;
    try {
      acquireWorktreeTaskLock({
        projectHash: hash,
        taskId: 'T3',
        ttlMs: 60_000,
        now: () => t0 + 10 * 60 * 60 * 1000, // 10h later, TTL 1 min
      });
    } catch (err) {
      caught = err;
    }
    expect(isWorktreeLockedError(caught)).toBe(true);
  });

  it('reclaims an UNVERIFIABLE holder (other device) once its heartbeat is older than the TTL', () => {
    const t0 = Date.parse('2026-09-27T00:00:00Z');
    acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T3b',
      holder: { deviceId: 'other-device' },
      now: () => t0,
    });
    expect(() =>
      acquireWorktreeTaskLock({
        projectHash: hash,
        taskId: 'T3b',
        deviceId: 'this-device',
        ttlMs: 60_000,
        now: () => t0 + 30_000,
      }),
    ).toThrow(/E_WORKTREE_LOCKED/);
    const r = acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T3b',
      deviceId: 'this-device',
      ttlMs: 60_000,
      now: () => t0 + 61_000,
    });
    expect(r.status).toBe('reclaimed');
    expect(r.reclaimReason).toBe('heartbeat-stale');
  });

  it('probes the pid by DEVICE id, not host name (hostname changes do not matter)', () => {
    // Same device id but a different recorded host name: the pid is still
    // probed, so a dead pid is reclaimed immediately (no TTL wait).
    plantRaw(hash, 'T3c', { deviceId: 'dev-same', hostname: 'renamed-host', pid: deadPid() });
    const r = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T3c', deviceId: 'dev-same' });
    expect(r.reclaimReason).toBe('pid-gone');
  });

  it('the same caller (session, agent, owner process) re-enters its own lock (review item 2b)', () => {
    const holder = { sessionId: 'ses_orch', agentId: 'agent-t9' };
    const first = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T9', holder });
    const again = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T9', holder });
    expect(again.status).toBe('reentered');
    expect(again.reclaimedFrom?.token).toBe(first.record.token);
    // A different session with the same owner process is still refused.
    expect(() =>
      acquireWorktreeTaskLock({
        projectHash: hash,
        taskId: 'T9',
        holder: { sessionId: 'ses_other', agentId: 'agent-t9' },
      }),
    ).toThrow(/E_WORKTREE_LOCKED/);
  });

  it('an ENDED holder session releases the lock even while its harness pid is alive (T13425)', () => {
    // The worker's lock records the long-lived harness (this live process,
    // verified start time) as owner. Its session ended; a successor resumes.
    acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T20',
      holder: { sessionId: 'ses_worker', agentId: 'agent-w' },
    });
    const probe = (sid: string) =>
      sid === 'ses_worker' ? ('ended' as const) : ('unknown' as const);
    const r = acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T20',
      holder: { sessionId: 'ses_successor', agentId: 'agent-s' },
      sessionProbe: probe,
    });
    expect(r.status).toBe('reclaimed');
    expect(r.reclaimReason).toBe('session-ended');
    expect(r.reclaimedFrom?.sessionId).toBe('ses_worker');
    expect(readWorktreeTaskLock(hash, 'T20')?.sessionId).toBe('ses_successor');
  });

  it('an ACTIVE or unknown holder session with a live pid still refuses E_WORKTREE_LOCKED (T13425)', () => {
    acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T21',
      holder: { sessionId: 'ses_live', agentId: 'agent-l' },
    });
    for (const state of ['active', 'unknown'] as const) {
      expect(() =>
        acquireWorktreeTaskLock({
          projectHash: hash,
          taskId: 'T21',
          holder: { sessionId: 'ses_other', agentId: 'agent-o' },
          sessionProbe: () => state,
        }),
      ).toThrow(/E_WORKTREE_LOCKED/);
    }
  });

  it('an ended session on ANOTHER device does not release the lock early (T13425)', () => {
    plantRaw(hash, 'T22', { sessionId: 'ses_remote', deviceId: 'other-device' });
    expect(() =>
      acquireWorktreeTaskLock({
        projectHash: hash,
        taskId: 'T22',
        deviceId: 'this-device',
        sessionProbe: () => 'ended',
      }),
    ).toThrow(/E_WORKTREE_LOCKED/);
  });

  it("releaseWorktreeTaskLocksForSession frees only that session's locks (T13425)", () => {
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T30', holder: { sessionId: 'ses_a' } });
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T31', holder: { sessionId: 'ses_a' } });
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T32', holder: { sessionId: 'ses_b' } });
    const released = releaseWorktreeTaskLocksForSession(hash, 'ses_a');
    expect(released.map((r) => r.taskId).sort()).toEqual(['T30', 'T31']);
    expect(readWorktreeTaskLock(hash, 'T30')).toBeNull();
    expect(readWorktreeTaskLock(hash, 'T31')).toBeNull();
    expect(readWorktreeTaskLock(hash, 'T32')?.sessionId).toBe('ses_b');
    expect(releaseWorktreeTaskLocksForSession('no-such-hash', 'ses_a')).toEqual([]);
  });

  it('never reclaims a live, fresh holder', () => {
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T4', holder: { sessionId: 'ses_1' } });
    let caught: unknown;
    try {
      acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T4' });
    } catch (err) {
      caught = err;
    }
    expect(isWorktreeLockedError(caught)).toBe(true);
    if (isWorktreeLockedError(caught)) expect(caught.holder.sessionId).toBe('ses_1');
  });

  // Cross-process race through the BUILT package (the in-process test above
  // cannot interleave two processes' link(2) calls).
  const distLock = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/worktree-lock.js');
  it.skipIf(!existsSync(distLock))(
    'N processes racing for one task: exactly one acquires, the rest get E_WORKTREE_LOCKED',
    async () => {
      const script = `
        import { acquireWorktreeTaskLock } from ${JSON.stringify(distLock)};
        const start = Number(process.argv[1]);
        while (Date.now() < start) {}
        try {
          acquireWorktreeTaskLock({ projectHash: ${JSON.stringify(hash)}, taskId: 'TRACE' });
          process.stdout.write('ACQUIRED');
          setTimeout(() => {}, 3000);
        } catch (e) {
          process.stdout.write(String(e.code));
        }`;
      const start = Date.now() + 1500;
      const runs = Array.from({ length: 6 }, () => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', script, String(start)],
          {
            env: { ...process.env, CLEO_HOME: cleoHome },
            stdio: ['ignore', 'pipe', 'inherit'],
          },
        );
        children.push(child);
        return new Promise<string>((done) => {
          let out = '';
          child.stdout?.on('data', (d: Buffer) => {
            out += d.toString();
            if (out === 'ACQUIRED' || out.startsWith('E_')) done(out);
          });
          child.on('exit', () => done(out));
        });
      });
      const outcomes = await Promise.all(runs);
      expect(outcomes.filter((o) => o === 'ACQUIRED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'E_WORKTREE_LOCKED')).toHaveLength(5);
    },
    20_000,
  );
});

describe('disposeOwnedWorktree — dispose under the task lock (T14407)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;
  let hash: string;
  const children: ChildProcess[] = [];
  const holder = { sessionId: 'ses_owner', agentId: 'agent-owner' };

  beforeEach(() => {
    projectRoot = initTempRepo();
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-own-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
    hash = computeProjectHash(projectRoot);
  });

  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Lock the task, then add its worktree on `task/<id>`, as createWorktree does. */
  function provision(taskId: string): { path: string; branch: string; token: string } {
    const lock = acquireWorktreeTaskLock({ projectHash: hash, taskId, holder });
    const path = resolveTaskWorktreePath(hash, taskId);
    const branch = `task/${taskId}`;
    git(['worktree', 'add', '-b', branch, path, 'main'], projectRoot);
    return { path, branch, token: lock.record.token };
  }

  it('a successor cannot re-enter between the check and the disposal', () => {
    const { path, branch, token } = provision('T7101');
    let successorErr: unknown;
    let successorStatus: string | undefined;
    const result = disposeOwnedWorktree({
      projectHash: hash,
      taskId: 'T7101',
      worktreePath: path,
      branch,
      lockToken: token,
      reason: 'failed-provision-cleanup',
      force: true,
      // Runs after the ownership check, right before the removal: the same
      // caller re-spawns the task, 60 s later by its clock.
      inUse: () => {
        try {
          successorStatus = acquireWorktreeTaskLock({
            projectHash: hash,
            taskId: 'T7101',
            holder,
            now: () => Date.now() + 60_000,
          }).status;
        } catch (err) {
          successorErr = err;
        }
        return null;
      },
    });
    expect(successorStatus).toBeUndefined();
    expect(isWorktreeLockedError(successorErr)).toBe(true);
    expect(result).toMatchObject({ outcome: 'removed', lockReleased: true });
    expect(existsSync(path)).toBe(false);
    expect(readWorktreeTaskLock(hash, 'T7101')).toBeNull();
  });

  it('keeps the worktree when the lock passed to another acquisition', () => {
    const { path, branch, token } = provision('T7102');
    releaseWorktreeTaskLock(hash, 'T7102', token);
    const successor = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T7102', holder });
    const result = disposeOwnedWorktree({
      projectHash: hash,
      taskId: 'T7102',
      worktreePath: path,
      branch,
      lockToken: token,
      reason: 'failed-provision-cleanup',
      force: true,
    });
    expect(result).toMatchObject({ outcome: 'kept', lockReleased: false });
    expect(result.reason).toContain('passed to another acquisition');
    expect(existsSync(path)).toBe(true);
    expect(readWorktreeTaskLock(hash, 'T7102')?.token).toBe(successor.record.token);
  });

  it('keeps the worktree on a path or branch mismatch', () => {
    const { path, branch, token } = provision('T7103');
    const base = { projectHash: hash, taskId: 'T7103', lockToken: token, reason: 'r', force: true };
    const wrongPath = disposeOwnedWorktree({ ...base, worktreePath: projectRoot, branch });
    expect(wrongPath.outcome).toBe('kept');
    expect(wrongPath.reason).toContain("is not the task's worktree path");
    const wrongBranch = disposeOwnedWorktree({ ...base, worktreePath: path, branch: 'task/other' });
    expect(wrongBranch.outcome).toBe('kept');
    expect(wrongBranch.reason).toContain("not 'task/other'");
    expect(existsSync(path)).toBe(true);
    expect(readWorktreeTaskLock(hash, 'T7103')?.token).toBe(token);
  });

  it("never breaks a live holder's mutex as stale; breaks a dead holder's", () => {
    const lock = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T7104', holder });
    const mutexPath = `${resolveWorktreeTaskLockPath(hash, 'T7104')}.reclaim`;
    const plantMutex = (pid: number, processStartedAt: string | null) => {
      writeFileSync(
        mutexPath,
        JSON.stringify({ token: 'held', pid, processStartedAt, threadId: 0 }),
      );
      const old = new Date(Date.now() - 120_000);
      utimesSync(mutexPath, old, old);
    };
    const live = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(live);
    if (live.pid === undefined) throw new Error('could not spawn');
    plantMutex(live.pid, readProcessStartTime(live.pid));
    expect(heartbeatWorktreeTaskLock(hash, 'T7104', lock.record.token)).toBeNull();
    expect(existsSync(mutexPath)).toBe(true);
    plantMutex(deadPid(), 'Thu Jan  1 00:00:00 1970');
    expect(heartbeatWorktreeTaskLock(hash, 'T7104', lock.record.token)?.token).toBe(
      lock.record.token,
    );
  });

  it("never breaks a live holder's mutex whose start time is unknown (T14407)", () => {
    const lock = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T7105', holder });
    const mutexPath = `${resolveWorktreeTaskLockPath(hash, 'T7105')}.reclaim`;
    const live = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(live);
    if (live.pid === undefined) throw new Error('could not spawn');
    // Windows, or a failed `ps`: the holder recorded no start time.
    writeFileSync(
      mutexPath,
      JSON.stringify({ token: 'held', pid: live.pid, processStartedAt: null, threadId: 0 }),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(mutexPath, old, old);
    expect(heartbeatWorktreeTaskLock(hash, 'T7105', lock.record.token)).toBeNull();
    expect(existsSync(mutexPath)).toBe(true);
  });

  it('never breaks a live mutex that replaced the dead one between the holder read and the stat (T14407)', () => {
    const lock = acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T7107', holder });
    const mutexPath = `${resolveWorktreeTaskLockPath(hash, 'T7107')}.reclaim`;
    const old = new Date(Date.now() - 120_000);
    // Dead mutex X, stale by age.
    writeFileSync(
      mutexPath,
      JSON.stringify({ token: 'dead-x', pid: deadPid(), processStartedAt: null, threadId: 0 }),
    );
    utimesSync(mutexPath, old, old);
    const live = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(live);
    if (live.pid === undefined) throw new Error('could not spawn');
    const liveMutex = JSON.stringify({
      token: 'live-y',
      pid: live.pid,
      processStartedAt: readProcessStartTime(live.pid),
      threadId: 0,
    });
    // Right after the contender reads X's dead holder, another contender
    // replaces X with live mutex Y (a new inode), already older than the
    // stale age.
    afterMutexRead.marker = 'dead-x';
    afterMutexRead.run = () => {
      rmSync(mutexPath);
      writeFileSync(mutexPath, liveMutex);
      utimesSync(mutexPath, old, old);
    };
    expect(heartbeatWorktreeTaskLock(hash, 'T7107', lock.record.token)).toBeNull();
    expect(afterMutexRead.run).toBeNull(); // the swap happened
    expect(readFileSync(mutexPath, 'utf-8')).toBe(liveMutex);
  });

  it('a session-end release cannot free the lock for a successor while a dispose holds it (T14407)', () => {
    const { path, branch, token } = provision('T7106');
    let released: WorktreeLockRecord[] | undefined;
    let successorErr: unknown;
    let successorToken: string | undefined;
    const result = disposeOwnedWorktree({
      projectHash: hash,
      taskId: 'T7106',
      worktreePath: path,
      branch,
      lockToken: token,
      reason: 'failed-provision-cleanup',
      force: true,
      // Right before the removal: the owner's session ends, then another
      // session spawns the task.
      inUse: () => {
        released = releaseWorktreeTaskLocksForSession(hash, holder.sessionId);
        try {
          successorToken = acquireWorktreeTaskLock({
            projectHash: hash,
            taskId: 'T7106',
            holder: { sessionId: 'ses_next', agentId: 'agent-next' },
          }).record.token;
        } catch (err) {
          successorErr = err;
        }
        return null;
      },
    });
    expect(released).toEqual([]);
    expect(successorToken).toBeUndefined();
    expect(isWorktreeLockedError(successorErr)).toBe(true);
    expect(result).toMatchObject({ outcome: 'removed', lockReleased: true });
    expect(readWorktreeTaskLock(hash, 'T7106')).toBeNull();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an EACCES lookup keeps the worktree and its lock instead of reporting it gone (T14407)',
    () => {
      const { path, branch, token } = provision('T7107');
      const parent = dirname(path);
      chmodSync(parent, 0o000);
      let result: ReturnType<typeof disposeOwnedWorktree>;
      try {
        result = disposeOwnedWorktree({
          projectHash: hash,
          taskId: 'T7107',
          worktreePath: path,
          branch,
          lockToken: token,
          reason: 'failed-provision-cleanup',
          force: true,
        });
      } finally {
        chmodSync(parent, 0o755);
      }
      expect(result).toMatchObject({ outcome: 'kept', lockReleased: false });
      expect(result.reason).toContain('could not be looked up');
      expect(existsSync(path)).toBe(true);
      expect(readWorktreeTaskLock(hash, 'T7107')?.token).toBe(token);
    },
  );
});
