/**
 * T12506 — spawn-side identity for the per-task worktree lock, and
 * convergence of concurrent per-agent session allocation.
 *
 * @task T12506
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
import { computeProjectHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProcessAncestor, resolveOwnerProcess } from '../../sessions/terminal-identity.js';
import { optOutOfForeignKeys } from '../../store/__tests__/test-db-helper.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { allocateSpawnSession, electSpawnSession } from '../agent-identity.js';
import { createAgentWorktree, pruneWorktree } from '../branch-lock.js';
import {
  auditWorktreeLockReclaim,
  lockSessionState,
  releaseSessionWorktreeLocks,
  resolveLockSessionProbe,
  resolveSpawnLockHolder,
} from '../worktree-lock-holder.js';

// T13228: fixture spawns allocate sessions for task ids that are never seeded; they run with foreign keys OFF.
optOutOfForeignKeys();

/** Fake process table: pid → entry. */
function table(entries: ProcessAncestor[]): (pid: number) => ProcessAncestor | null {
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  return (pid) => byPid.get(pid) ?? null;
}

describe('resolveOwnerProcess (T12506)', () => {
  it('skips launchers AND per-call shells to reach the long-lived harness', () => {
    const lookup = table([
      { pid: 40, ppid: 30, startedAt: 'a', command: 'node' },
      { pid: 30, ppid: 20, startedAt: 'b', command: 'zsh' },
      { pid: 20, ppid: 10, startedAt: 'c', command: 'claude' },
      { pid: 10, ppid: 1, startedAt: 'd', command: 'zsh' },
    ]);
    expect(resolveOwnerProcess(40, lookup)?.pid).toBe(20);
  });

  it('falls back to the last readable ancestor when all are skippable', () => {
    const lookup = table([
      { pid: 40, ppid: 30, startedAt: 'a', command: 'pnpm' },
      { pid: 30, ppid: 99, startedAt: 'b', command: 'bash' },
    ]);
    expect(resolveOwnerProcess(40, lookup)?.pid).toBe(30);
  });

  it('returns null when the chain cannot be read', () => {
    expect(resolveOwnerProcess(40, () => null)).toBeNull();
  });
});

describe('resolveSpawnLockHolder (T12506)', () => {
  it('records session, agent, device and the owner pid + start time', () => {
    const holder = resolveSpawnLockHolder({
      sessionId: 'ses_1',
      agentId: 'agent-t1',
      resolveOwner: () => ({
        pid: 77,
        ppid: 1,
        startedAt: 'Sun Sep 27 03:00:00 2026',
        command: 'claude',
      }),
      deviceId: () => 'dev-xyz',
    });
    expect(holder).toEqual({
      sessionId: 'ses_1',
      agentId: 'agent-t1',
      deviceId: 'dev-xyz',
      pid: 77,
      processStartedAt: 'Sun Sep 27 03:00:00 2026',
    });
  });

  it('leaves pid to the worktree package when the owner is unreadable', () => {
    const holder = resolveSpawnLockHolder({ resolveOwner: () => null, deviceId: () => 'd' });
    expect(holder.pid).toBeUndefined();
    expect(holder.deviceId).toBe('d');
  });
});

describe('electSpawnSession (T12506)', () => {
  const s = (id: string, startedAt: string): Session => ({ id, startedAt }) as Session;
  it('elects the earliest startedAt, then the smallest id — order-independent', () => {
    const a = s('ses_b', '2026-09-27T00:00:00.000Z');
    const b = s('ses_a', '2026-09-27T00:00:00.000Z');
    const c = s('ses_0', '2026-09-27T00:00:01.000Z');
    expect(electSpawnSession([a, b, c])?.id).toBe('ses_a');
    expect(electSpawnSession([c, b, a])?.id).toBe('ses_a');
    expect(electSpawnSession([])).toBeUndefined();
  });
});

describe('allocateSpawnSession — concurrent allocators converge (T12506)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-spawn-converge-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* ignore */
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => {},
    );
  });

  it('four simultaneous spawns of one task end with ONE active session, returned to all', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => allocateSpawnSession(tempDir, 'T5150')),
    );
    const ids = new Set(results.map((r) => r.sessionId));
    expect(ids.size).toBe(1);

    const accessor = await getTaskAccessor(tempDir);
    const active = (await accessor.loadSessions()).filter(
      (x) => x.status === 'active' && x.agentHandle === 'agent-t5150',
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe([...ids][0]);
  });
});

describe('branch-lock pruneWorktree releases the per-task lock (T12506 CI regression)', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-prune-lock-'));
    home = await mkdtemp(join(tmpdir(), 'cleo-prune-home-'));
    vi.stubEnv('CLEO_HOME', home);
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    };
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    await writeFile(join(root, 'README.md'), '# t\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('a worktree removed by pruneWorktree (the post-merge path) can be re-created by the same process', () => {
    const first = createAgentWorktree('T12506-prune', root);
    expect(readWorktreeTaskLock(first.projectHash, 'T12506-prune')).not.toBeNull();
    const pruned = pruneWorktree('T12506-prune', root);
    expect(pruned.worktreeRemoved).toBe(true);
    expect(readWorktreeTaskLock(first.projectHash, 'T12506-prune')).toBeNull();
    // Before the fix this threw E_WORKTREE_LOCKED: the lock outlived its worktree.
    const again = createAgentWorktree('T12506-prune', root);
    expect(existsSync(again.path)).toBe(true);
  });
});

describe('worktree lock follows the holder SESSION, not the harness pid (T13425)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-t13425-proj-'));
    cleoHome = await mkdtemp(join(tmpdir(), 'cleo-t13425-home-'));
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(async () => {
    if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = originalCleoHome;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cleoHome, { recursive: true, force: true });
  });

  it('maps session rows to lock states: active and suspended keep; ended, orphaned and missing release', () => {
    expect(lockSessionState({ status: 'active' })).toBe('active');
    expect(lockSessionState({ status: 'suspended' })).toBe('active');
    expect(lockSessionState({ status: 'ended' })).toBe('ended');
    expect(lockSessionState({ status: 'orphaned' })).toBe('ended');
    expect(lockSessionState(null)).toBe('ended');
  });

  it('the probe answers for the current holder session only', async () => {
    const hash = computeProjectHash(projectRoot);
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T1562', holder: { sessionId: 'ses_w' } });
    const lookup = vi.fn(async (id: string) => (id === 'ses_w' ? { status: 'ended' } : null));
    const probe = await resolveLockSessionProbe(projectRoot, 'T1562', lookup);
    expect(probe('ses_w')).toBe('ended');
    expect(probe('ses_other')).toBe('unknown');
    expect(lookup).toHaveBeenCalledTimes(1);
    // No lock, or a lookup failure: unknown (pid and heartbeat decide).
    expect((await resolveLockSessionProbe(projectRoot, 'T9999', lookup))('ses_w')).toBe('unknown');
    const failing = async (): Promise<{ status: string } | null> => {
      throw new Error('store busy');
    };
    expect((await resolveLockSessionProbe(projectRoot, 'T1562', failing))('ses_w')).toBe('unknown');
  });

  it('a successor --resume after session end: reclaimed while the harness pid lives, and audited', async () => {
    const hash = computeProjectHash(projectRoot);
    // The worker's lock: owner = this live process (the "harness").
    acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T1562',
      holder: { sessionId: 'ses_worker', agentId: 'agent-w' },
    });
    const probe = await resolveLockSessionProbe(projectRoot, 'T1562', async () => ({
      status: 'ended',
    }));
    const lock = acquireWorktreeTaskLock({
      projectHash: hash,
      taskId: 'T1562',
      holder: { sessionId: 'ses_successor', agentId: 'agent-s' },
      sessionProbe: probe,
    });
    expect(lock.reclaimReason).toBe('session-ended');
    auditWorktreeLockReclaim(projectRoot, 'T1562', '/wt/T1562', lock);
    const audit = await readFile(
      join(projectRoot, '.cleo/audit/worktree-lifecycle.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(audit.trim().split('\n').at(-1) ?? '{}');
    expect(entry).toMatchObject({ action: 'lock-reclaim', taskId: 'T1562', success: true });
    expect(entry.reason).toContain('session-ended from session ses_worker');
  });

  it("session end releases exactly the ending session's locks, and audits each", async () => {
    const hash = computeProjectHash(projectRoot);
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T1', holder: { sessionId: 'ses_end' } });
    acquireWorktreeTaskLock({ projectHash: hash, taskId: 'T2', holder: { sessionId: 'ses_keep' } });
    expect(releaseSessionWorktreeLocks(projectRoot, 'ses_end')).toEqual(['T1']);
    expect(readWorktreeTaskLock(hash, 'T1')).toBeNull();
    expect(readWorktreeTaskLock(hash, 'T2')?.sessionId).toBe('ses_keep');
    const audit = await readFile(
      join(projectRoot, '.cleo/audit/worktree-lifecycle.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(audit.trim())).toMatchObject({
      action: 'lock-release',
      taskId: 'T1',
      success: true,
    });
  });
});
