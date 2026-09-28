/**
 * T12506 — spawn-side identity for the per-task worktree lock, and
 * convergence of concurrent per-agent session allocation.
 *
 * @task T12506
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
import { readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProcessAncestor, resolveOwnerProcess } from '../../sessions/terminal-identity.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { allocateSpawnSession, electSpawnSession } from '../agent-identity.js';
import { createAgentWorktree, pruneWorktree } from '../branch-lock.js';
import { resolveSpawnLockHolder } from '../worktree-lock-holder.js';

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
