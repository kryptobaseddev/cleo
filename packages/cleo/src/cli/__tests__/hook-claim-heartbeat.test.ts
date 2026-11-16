/**
 * The claim heartbeat of `cleo hook heavy-command`, end to end (T14546).
 *
 * These tests run the real hook entry point (`runHookCli`) against a real
 * project store: no core module is mocked. They cover what a unit test of the
 * renewer cannot:
 *
 *  - a live worker session in its locked task worktree keeps its claim across
 *    several default lease lengths while it only runs shell commands;
 *  - the command line is never an identity: a command that prints, comments or
 *    exports another session's id renews nothing;
 *  - a hook process bound to a session that does not hold the claim renews
 *    nothing, so an idle holder's claim still lapses.
 *
 * A real Orca dispatch is not exercised here: the worker is modelled by what
 * spawn leaves behind (an active session, its claim and its worktree lock).
 *
 * @task T14546
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session, Task, WorktreeLockRecord } from '@cleocode/contracts';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { DEFAULT_TASK_CLAIM_LEASE_MS, isLiveClaim } from '@cleocode/core/store/task-claim';
import {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeTaskLockPath,
} from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HookIo, runHookCli } from '../hook-entry.js';

const WORKER = 'ses_20261116000001_aaaaaa';
const OTHER = 'ses_20261116000002_bbbbbb';
const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const MINUTE = 60_000;
const LAPSED = '2000-01-01T00:00:00.000Z';
const iso = (ms: number) => new Date(ms).toISOString();

let root: string;

const session = (id: string): Session => ({
  id,
  name: `session-${id}`,
  status: 'active',
  scope: { type: 'global' },
  taskWork: { taskId: null, setAt: null },
  startedAt: iso(T0),
  agentHandle: `agent-${id.slice(-6)}`,
});

const task = (id: string): Task => ({
  id,
  title: id,
  description: 'Claim heartbeat fixture',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  createdAt: iso(T0),
});

const claimOf = async (taskId = 'T001') =>
  (await (await getTaskAccessor(root)).loadSingleTask(taskId))?.claim;

/** Push a task's lease into the past: its holder stopped renewing. */
const lapse = async (taskId = 'T001') =>
  (await getTaskAccessor(root)).updateTaskFields(
    taskId,
    { leaseExpiresAt: LAPSED },
    { keepVersion: true },
  );

/**
 * The task's canonical worktree, with the lock record spawn writes for it. The
 * record is written as a file: taking the lock needs the native addon, and the
 * hook only reads it.
 */
function lockedWorktree(taskId: string, sessionId: string, agentId: string): string {
  const projectHash = computeProjectHash(root);
  const record: WorktreeLockRecord = {
    schemaVersion: 1,
    token: `token-${taskId}`,
    taskId,
    projectHash,
    sessionId,
    agentId,
    deviceId: null,
    pid: process.pid,
    processStartedAt: null,
    hostname: 'test-host',
    acquiredAt: iso(T0),
    heartbeatAt: iso(T0),
  };
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(record));
  const dir = resolveTaskWorktreePath(projectHash, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run the hook as a harness would before one shell command. */
async function hook(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const io: HookIo = {
    readStdin: async () =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
        permission_mode: 'bypassPermissions',
      }),
    writeStdout: (text) => out.push(text),
    writeStderr: () => undefined,
    env: { PATH: '/usr/bin:/bin', ...env },
    cwd,
  };
  return { code: await runHookCli(['heavy-command', '--provider', 'codex'], io), out };
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-hook-claim-')));
  mkdirSync(join(root, '.cleo'));
  mkdirSync(join(root, '.git'));
  vi.stubEnv('CLEO_ROOT', root);
  vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
  const accessor = await getTaskAccessor(root);
  await accessor.upsertSingleTask(task('T001'));
  await accessor.upsertSingleSession(session(WORKER));
  await accessor.upsertSingleSession(session(OTHER));
});

afterEach(async () => {
  vi.useRealTimers();
  await awaitBackgroundOps();
  await closeAllDatabases();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('cleo hook heavy-command: claim heartbeat (T14546)', () => {
  it('a live worker in its task worktree keeps its claim across three default leases, running only shell commands (AC1, AC3)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await (await getTaskAccessor(root)).claimTask('T001', {
      sessionId: WORKER,
      agentId: 'agent-t001',
      mode: 'acquire',
    });
    const worktree = lockedWorktree('T001', WORKER, 'agent-t001');
    const granted = await claimOf();
    expect(granted?.leaseExpiresAt).toBe(iso(T0 + DEFAULT_TASK_CLAIM_LEASE_MS));
    // With no hook, this lease is over at its default length.
    expect(isLiveClaim(granted, iso(T0 + DEFAULT_TASK_CLAIM_LEASE_MS))).toBe(false);

    const end = T0 + 3 * DEFAULT_TASK_CLAIM_LEASE_MS;
    for (let now = T0 + 10 * MINUTE; now <= end; now += 10 * MINUTE) {
      vi.setSystemTime(now);
      // The worker's harness carries no CLEO session in its environment.
      expect(await hook('gh pr checks 7', worktree)).toEqual({ code: 0, out: [] });
      expect(isLiveClaim(await claimOf(), iso(now))).toBe(true);
    }
    const kept = await claimOf();
    expect(kept).toMatchObject({ sessionId: WORKER, agentId: 'agent-t001' });
    expect(kept?.claimedAt).toBe(iso(T0));
    expect(Date.parse(kept?.leaseExpiresAt ?? '')).toBeGreaterThan(end);
  });

  it("a command that names the holder's session id, in any form, renews nothing", async () => {
    await (await getTaskAccessor(root)).claimTask('T001', {
      sessionId: WORKER,
      agentId: null,
      mode: 'acquire',
    });
    await lapse();
    // This process is bound to nobody: no session in its environment, no task worktree.
    for (const command of [
      `printf '%s\\n' 'CLEO_SESSION_ID=${WORKER}'`,
      `ls # CLEO_SESSION_ID=${WORKER}`,
      `export CLEO_SESSION_ID='${WORKER}' CLEO_AGENT_ID='agent-t001'; git status`,
      `CLEO_SESSION_ID="${WORKER}" cleo show T001`,
    ]) {
      expect((await hook(command, root)).code).toBe(0);
      expect((await claimOf())?.leaseExpiresAt).toBe(LAPSED);
    }
  });

  it('a process bound to a session that does not hold the claim renews nothing, and the takeover goes through', async () => {
    const accessor = await getTaskAccessor(root);
    await accessor.claimTask('T001', { sessionId: WORKER, agentId: null, mode: 'acquire' });
    await lapse();
    // OTHER is active and is this process's own session; WORKER's id is only in the command.
    const run = await hook(`export CLEO_SESSION_ID='${WORKER}'; git status`, root, {
      CLEO_SESSION_ID: OTHER,
    });
    expect(run.code).toBe(0);
    expect((await claimOf())?.leaseExpiresAt).toBe(LAPSED);
    const taken = await accessor.claimTask('T001', {
      sessionId: OTHER,
      agentId: null,
      mode: 'take-over',
    });
    expect(taken?.sessionId).toBe(OTHER);
  });

  it("a process whose own environment names the holder renews the holder's lapsed claim", async () => {
    await (await getTaskAccessor(root)).claimTask('T001', {
      sessionId: WORKER,
      agentId: null,
      mode: 'acquire',
    });
    await lapse();
    expect((await hook('git status', root, { CLEO_SESSION_ID: WORKER })).code).toBe(0);
    expect(isLiveClaim(await claimOf(), new Date().toISOString())).toBe(true);
  });
});
