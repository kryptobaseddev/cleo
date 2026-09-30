/**
 * Stable session identity for harnesses without a terminal key (T12864 · epic T12497).
 *
 * Kimi, aider, OpenCode, Gemini CLI, cron and one-shot ssh export no
 * per-session / per-tab variable, and they run every tool call in a fresh
 * `bash -c`, so the immediate parent pid changes on each call. The identity is
 * the nearest LONG-LIVED ancestor instead: the harness process (past the
 * throwaway shells), an interactive or script shell, or a platform job id
 * (GitHub Actions, GitLab CI, an ssh login with a tty).
 *
 * Proves:
 *  1. Repeated `bash -c` calls from one simulated harness resolve one key, and
 *     end to end: `session start` in one call, then the next call (a new
 *     `bash -c`, new immediate ppid) is bound to that session and can start a task.
 *  2. Two harness processes never share a key or a session.
 *  3. A pid-1 / init ancestor (daemon, systemd / launchd job) yields no key:
 *     the caller is unidentified and keeps the legacy single-session guard.
 *  4. Shells that outlive the call (interactive, login, script) are the key;
 *     an unreadable shell command line yields no key.
 *  5. CI and ssh env keys: GitHub Actions per job, GitLab per job, ssh per login tty.
 *
 * @task T12864
 * @epic T12497
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProcessAncestor,
  ResolveTerminalKeysOptions,
  TerminalKey,
} from '../terminal-identity.js';

/** The simulated process tree and the pid `cleo`'s parent has for the current call. */
const sim: {
  table: Record<number, ProcessAncestor & { args?: string }>;
  ppid: number;
} = { table: {}, ppid: 0 };

// Live identity resolution reads the simulated tree instead of the real one.
vi.mock('../terminal-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-identity.js')>();
  return {
    ...actual,
    resolveTerminalKeys: (options?: ResolveTerminalKeysOptions): TerminalKey[] =>
      actual.resolveTerminalKeys(
        options ?? {
          env: {},
          ppid: sim.ppid,
          lookupProcess: (pid) => sim.table[pid] ?? null,
          lookupArgs: (pid) => sim.table[pid]?.args ?? null,
        },
      ),
  };
});

// session start refreshes GLOBAL provider instruction files; never touch them.
vi.mock('../../injection.js', () => ({
  refreshStaleGlobalInstructions: vi.fn().mockResolvedValue({
    status: 'skipped',
    stale: [],
    duplicates: [],
    updated: [],
  }),
}));

import { sessionStart } from '../../session/engine-ops.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { findSessionStartConflicts, resolveBoundSessionId } from '../../store/session-store.js';
import { startTask } from '../../task-work/index.js';
import { SESSION_ENV_KEY_PRECEDENCE } from '../session-id.js';
import {
  isCommandStringShell,
  resolveTerminalKeys,
  TERMINAL_KEY_SOURCES,
} from '../terminal-identity.js';

const T = 'Tue Sep 30 12:00:00 2026';

/** A process-table row. */
function proc(
  pid: number,
  ppid: number,
  command: string,
  args?: string,
): ProcessAncestor & { args?: string } {
  return { pid, ppid, startedAt: `${T} #${pid}`, command, ...(args ? { args } : {}) };
}

/**
 * Two harnesses (python Kimi / aider style, pids 100 and 200) launched from an
 * IDE process, plus a daemon under launchd. Each tool call adds a fresh
 * `bash -c` and a `node` (cleo's launcher) with new pids.
 */
function baseTable(): Record<number, ProcessAncestor & { args?: string }> {
  return {
    1: proc(1, 0, 'launchd'),
    50: proc(50, 1, 'Code Helper'),
    100: proc(100, 50, 'python3.12', 'python3.12 -m kimi_cli'),
    200: proc(200, 50, 'python3.12', 'python3.12 -m aider'),
  };
}

let nextPid = 1000;
/** Simulate one tool call from `harnessPid`: harness → `bash -c` → `pnpm` → cleo. */
function call(harnessPid: number): void {
  const shell = nextPid++;
  const launcher = nextPid++;
  sim.table[shell] = proc(shell, harnessPid, 'bash', "/bin/bash -c 'cleo start T1'");
  sim.table[launcher] = proc(launcher, shell, 'pnpm');
  sim.ppid = launcher;
}

function liveKey(): string | undefined {
  return resolveTerminalKeys()[0]?.key;
}

let root: string;

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  for (const s of TERMINAL_KEY_SOURCES) vi.stubEnv(s.envVar, undefined);
  for (const name of SESSION_ENV_KEY_PRECEDENCE) vi.stubEnv(name, undefined);
  sim.table = baseTable();
  root = await mkdtemp(join(tmpdir(), 'cleo-t12864-'));
  const cleoDir = join(root, '.cleo');
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  await writeFile(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  const acc = await getTaskAccessor(root);
  for (const id of ['T1', 'T2'])
    await acc.upsertSingleTask({
      id,
      title: `task ${id}`,
      description: 'T12864 fixture',
      status: 'pending',
      priority: 'medium',
      acceptance: ['first', 'second', 'third'],
      createdAt: '2026-09-30T00:00:00Z',
    });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
});

describe('harness-ancestor key (T12864)', () => {
  it('is the same across repeated bash -c calls from one harness, with a changing immediate ppid', () => {
    call(100);
    const first = liveKey();
    const firstPpid = sim.ppid;
    call(100);
    call(100);
    expect(sim.ppid).not.toBe(firstPpid);
    expect(liveKey()).toBe(first);
    expect(first).toBe(`proc:100@${T} #100`);
  });

  it('differs between two harness processes', () => {
    call(100);
    const a = liveKey();
    call(200);
    expect(liveKey()).toBe(`proc:200@${T} #200`);
    expect(liveKey()).not.toBe(a);
  });

  it('keys a node harness (Gemini CLI style) past the bash -c, even though node is a launcher', () => {
    sim.table[300] = proc(300, 50, 'node', 'node /usr/local/bin/gemini');
    call(300);
    expect(liveKey()).toBe(`proc:300@${T} #300`);
  });

  it('skips wrappers and nested command shells (timeout, sh -c inside bash -c)', () => {
    sim.table[400] = proc(400, 100, 'bash', 'bash -lc "timeout 60 sh -c cleo"');
    sim.table[401] = proc(401, 400, 'timeout');
    sim.table[402] = proc(402, 401, 'sh', 'sh -c cleo');
    sim.ppid = 402;
    expect(liveKey()).toBe(`proc:100@${T} #100`);
  });

  it('stops at a long-lived shell: interactive, login, or a script (CI step, cron script)', () => {
    sim.table[500] = proc(500, 50, 'zsh', '-zsh');
    sim.ppid = 500;
    expect(liveKey()).toBe(`proc:500@${T} #500`);
    sim.table[510] = proc(
      510,
      50,
      'bash',
      '/bin/bash --noprofile --norc -eo pipefail /tmp/step.sh',
    );
    sim.ppid = 510;
    expect(liveKey()).toBe(`proc:510@${T} #510`);
  });

  it('yields NO key when the walk reaches pid 1 / launchd / systemd (daemon or service job)', () => {
    sim.table[600] = proc(600, 1, 'bash', "bash -c 'cleo start T1'");
    sim.ppid = 600;
    expect(resolveTerminalKeys()).toEqual([]);
    sim.table[610] = proc(610, 611, 'sh', 'sh -c cleo');
    sim.table[611] = proc(611, 1, 'systemd');
    sim.ppid = 610;
    expect(resolveTerminalKeys()).toEqual([]);
  });

  it('yields NO key when a shell command line cannot be read', () => {
    sim.table[700] = proc(700, 100, 'bash'); // no args
    sim.ppid = 700;
    expect(resolveTerminalKeys()).toEqual([]);
  });

  it('recognises command-string shells', () => {
    expect(isCommandStringShell("/bin/bash -c 'x'")).toBe(true);
    expect(isCommandStringShell('bash -lc x')).toBe(true);
    expect(isCommandStringShell('/bin/zsh -c source snap && eval x')).toBe(true);
    expect(isCommandStringShell('-zsh')).toBe(false);
    expect(isCommandStringShell('bash -i')).toBe(false);
    expect(isCommandStringShell('bash --norc -eo pipefail /tmp/x.sh')).toBe(false);
    expect(isCommandStringShell('bash script.sh -c')).toBe(false);
  });
});

describe('session start then cleo start in separate bash -c calls (T12864 AC1, AC2)', () => {
  it('one harness: the second call is bound to the session the first call started', async () => {
    call(100);
    const started = await sessionStart(root, { scope: 'global', name: 'kimi' });
    expect(started.success).toBe(true);

    call(100); // a new bash -c: new immediate ppid, same harness
    expect(await resolveBoundSessionId(root)).toBe(started.data!.id);
    const res = await startTask('T1', root);
    expect(res.claim?.sessionId).toBe(started.data!.id);

    call(100); // a second session from the same harness is refused as its own
    const again = await sessionStart(root, { scope: 'global', name: 'kimi-2' });
    expect(again.error?.code).toBe('E_SESSION_CONFLICT');
    expect(again.error?.details?.heldVia).toBe('terminal');
  });

  it('two harnesses each start their own session and never share one', async () => {
    call(100);
    const a = await sessionStart(root, { scope: 'global', name: 'kimi' });
    call(200);
    const b = await sessionStart(root, { scope: 'global', name: 'aider' });
    expect(b.error?.message).toBeUndefined();
    expect(b.data!.id).not.toBe(a.data!.id);

    call(100);
    expect(await resolveBoundSessionId(root)).toBe(a.data!.id);
    call(200);
    expect(await resolveBoundSessionId(root)).toBe(b.data!.id);
  });

  it('a caller under pid 1 is unidentified and keeps the single-session guard', async () => {
    call(100);
    const a = await sessionStart(root, { scope: 'global', name: 'kimi' });
    expect(a.success).toBe(true);

    sim.table[800] = proc(800, 1, 'sh', 'sh -c cleo');
    sim.ppid = 800;
    const active = (await (await getTaskAccessor(root)).loadSessions()).filter(
      (s) => s.status === 'active',
    );
    const verdict = await findSessionStartConflicts(active, root);
    expect(verdict.identified).toBe(false);
    const res = await sessionStart(root, { scope: 'global', name: 'daemon' });
    expect(res.error?.code).toBe('E_SESSION_CONFLICT');
    expect(await resolveBoundSessionId(root)).toBeNull();
  });
});

describe('CI and ssh env keys (T12864)', () => {
  it('GitHub Actions: one key per run attempt and job; steps of one job share it', () => {
    const job = { GITHUB_RUN_ID: '9001', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'test' };
    const key = resolveTerminalKeys({ env: job })[0];
    expect(key).toEqual({
      key: 'env:GITHUB_RUN_ID=1|test|9001',
      source: 'GITHUB_RUN_ID',
      kind: 'terminal',
    });
    expect(resolveTerminalKeys({ env: { ...job, GITHUB_JOB: 'lint' } })[0]?.key).not.toBe(key?.key);
    expect(resolveTerminalKeys({ env: { ...job, GITHUB_RUN_ATTEMPT: '2' } })[0]?.key).not.toBe(
      key?.key,
    );
  });

  it('GitLab CI: one key per job', () => {
    expect(resolveTerminalKeys({ env: { CI_JOB_ID: '77' } })[0]?.key).toBe('env:CI_JOB_ID=77');
  });

  it('ssh: a login with a tty is keyed by connection + tty; a one-shot command without a tty is not', () => {
    const login = { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22', SSH_TTY: '/dev/pts/3' };
    expect(resolveTerminalKeys({ env: login })[0]?.key).toBe(
      'env:SSH_TTY=10.0.0.2 51234 10.0.0.9 22|/dev/pts/3',
    );
    const lookup = vi.fn(() => null);
    expect(
      resolveTerminalKeys({
        env: { SSH_CONNECTION: login.SSH_CONNECTION },
        ppid: 5,
        lookupProcess: lookup,
      }),
    ).toEqual([]);
    expect(lookup).toHaveBeenCalled();
  });
});
