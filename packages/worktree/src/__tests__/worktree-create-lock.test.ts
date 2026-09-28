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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorktreeLockRecord } from '@cleocode/contracts';
import { BRANCH_LOCK_ERROR_CODES, ExitCode } from '@cleocode/contracts';
import { resolveWorktreeTaskLockPath } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeProjectHash, resolveTaskWorktreePath } from '../paths.js';
import { createWorktree } from '../worktree-create.js';
import { destroyWorktree } from '../worktree-destroy.js';
import {
  acquireWorktreeTaskLock,
  isWorktreeLockedError,
  readProcessStartTime,
  readWorktreeTaskLock,
  releaseWorktreeTaskLock,
} from '../worktree-lock.js';

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
