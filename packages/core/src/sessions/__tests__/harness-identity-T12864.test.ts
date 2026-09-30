/**
 * Stable session identity for harnesses without a terminal key (T12864 · epic T12497).
 *
 * Kimi, aider, cron and one-shot ssh export no
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
 *  6. Review of #1750: a generic host (node / python orchestrator, IDE extension
 *     host) identifies nobody unless CLEO_AGENT_ID names the agent; a daemon
 *     spawning cleo directly is not skipped to the human's shell; option
 *     arguments before -c; npx; harnesses below a shared env key stay apart.
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
  env: Record<string, string>;
} = { table: {}, ppid: 0, env: {} };

// Live identity resolution reads the simulated tree instead of the real one.
vi.mock('../terminal-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-identity.js')>();
  return {
    ...actual,
    resolveTerminalKeys: (options?: ResolveTerminalKeysOptions): TerminalKey[] =>
      actual.resolveTerminalKeys(
        options ?? {
          env: sim.env,
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
    100: proc(100, 50, 'python3.12', 'python3.12 /Users/dev/.local/bin/kimi --yolo'),
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
  sim.env = {};
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
    expect(first).toBe(`harness:kimi:100@${T} #100`);
  });

  it('differs between two harness processes', () => {
    call(100);
    const a = liveKey();
    call(200);
    expect(liveKey()).toBe(`harness:aider:200@${T} #200`);
    expect(liveKey()).not.toBe(a);
  });

  it('keys a node harness (Gemini CLI style) past the bash -c, even though node is a launcher', () => {
    sim.table[300] = proc(300, 50, 'node', 'node /usr/local/bin/gemini');
    call(300);
    expect(liveKey()).toBe(`harness:gemini:300@${T} #300`);
  });

  it('skips wrappers and nested command shells (timeout, sh -c inside bash -c)', () => {
    sim.table[400] = proc(400, 100, 'bash', 'bash -lc "timeout 60 sh -c cleo"');
    sim.table[401] = proc(401, 400, 'timeout');
    sim.table[402] = proc(402, 401, 'sh', 'sh -c cleo');
    sim.ppid = 402;
    expect(liveKey()).toBe(`harness:kimi:100@${T} #100`);
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

  it('MEDIUM-2: an option argument is not the operand (-o, -O, --rcfile before -c)', () => {
    expect(isCommandStringShell("bash -o pipefail -c 'cleo start T1'")).toBe(true);
    expect(isCommandStringShell("bash -O extglob -c 'cleo start T1'")).toBe(true);
    expect(isCommandStringShell("bash --rcfile /tmp/rc -c 'cleo start T1'")).toBe(true);
    expect(isCommandStringShell('bash -o pipefail /tmp/script.sh')).toBe(false);
    expect(isCommandStringShell("fish --command 'cleo x'")).toBe(true);
  });

  it('recognises pwsh, nu and xonsh command forms', () => {
    expect(isCommandStringShell('pwsh -NoProfile -NonInteractive -Command cleo start T1')).toBe(
      true,
    );
    expect(isCommandStringShell('pwsh -NoProfile -NonInteractive')).toBe(false);
    expect(isCommandStringShell("nu -c 'cleo start T1'")).toBe(true);
    expect(isCommandStringShell("nu --commands 'cleo'")).toBe(true);
    expect(isCommandStringShell("/usr/bin/python3 /usr/bin/xonsh -c 'cleo'")).toBe(true);
    // A pwsh -Command layer is skipped on the way to the harness.
    sim.table[450] = proc(450, 100, 'pwsh', 'pwsh -NoProfile -Command cleo');
    sim.ppid = 450;
    expect(liveKey()).toBe(`harness:kimi:100@${T} #100`);
  });

  it('HIGH-1: two agents in one generic node host get NO key (not a shared one)', () => {
    sim.table[900] = proc(900, 50, 'node', 'node /opt/orchestrator/dist/main.js');
    call(900); // agent A shells out
    expect(resolveTerminalKeys()).toEqual([]);
    call(900); // agent B shells out from the same host
    expect(resolveTerminalKeys()).toEqual([]);
  });

  it('HIGH-1: CLEO_AGENT_ID makes each agent of a generic host its own key', () => {
    sim.table[900] = proc(900, 50, 'node', 'node /opt/orchestrator/dist/main.js');
    sim.env = { CLEO_AGENT_ID: 'agent-a' };
    call(900);
    const a = liveKey();
    sim.env = { CLEO_AGENT_ID: 'agent-b' };
    call(900);
    const b = liveKey();
    expect(a).toBe(`harness:main:900@${T} #900#agent=agent-a`);
    expect(b).toBe(`harness:main:900@${T} #900#agent=agent-b`);
  });

  it('HIGH-1: a known harness title (claude, codex, amp, cursor-agent) gets a key; opencode and goose do not', () => {
    for (const [pid, title] of [
      [910, 'claude'],
      [911, 'codex exec'],
      [914, 'node /usr/local/lib/node_modules/@sourcegraph/amp/bin/amp'],
      [915, 'cursor-agent -p'],
    ] as const) {
      sim.table[pid] = proc(pid, 50, 'x', title);
      call(pid);
      expect(liveKey()).toMatch(new RegExp(`^harness:[a-z-]+:${pid}@`));
    }
    // Multi-session server (opencode serve / attach) and a name collision
    // (pressly/goose, the migration tool): no key, the caller stays unidentified.
    for (const [pid, title] of [
      [912, '/usr/local/bin/opencode serve'],
      [913, 'goose up'],
    ] as const) {
      sim.table[pid] = proc(pid, 50, 'x', title);
      call(pid);
      expect(resolveTerminalKeys()).toEqual([]);
    }
  });

  it('HIGH-1 direct exec: a non-harness runtime spawning cleo without a shell is NOT skipped to the human shell', () => {
    sim.table[920] = proc(920, 50, 'zsh', '-zsh'); // the human's interactive shell
    sim.table[921] = proc(921, 920, 'node', 'node /opt/cleo/sentient/tick.js');
    sim.ppid = 921; // execFileSync('cleo', …) straight from the daemon
    expect(resolveTerminalKeys()).toEqual([]);
  });

  it('MEDIUM-3: npx / npm exec is a wrapper, so repeated npx calls keep the harness key', () => {
    const viaNpx = (host: number): void => {
      const shell = nextPid++;
      const npx = nextPid++;
      sim.table[shell] = proc(shell, host, 'bash', "bash -c 'npx cleo start T1'");
      sim.table[npx] = proc(npx, shell, 'node', 'npm exec cleo start T1');
      sim.ppid = npx;
    };
    viaNpx(100);
    const first = liveKey();
    viaNpx(100);
    expect(liveKey()).toBe(first);
    expect(first).toBe(`harness:kimi:100@${T} #100`);
  });

  it('MEDIUM-4: two harnesses under one ssh login (or tab) get distinct, more specific keys', () => {
    sim.env = { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22', SSH_TTY: '/dev/pts/3' };
    call(100);
    const kimi = resolveTerminalKeys();
    call(200);
    const aider = resolveTerminalKeys();
    expect(kimi[0]?.key).toBe(aider[0]?.key); // the shared login key
    expect(kimi[1]?.kind).toBe('harness');
    expect(aider[1]?.kind).toBe('harness');
    expect(kimi[1]?.key).not.toBe(aider[1]?.key);
    expect(kimi[1]?.key).toContain('|env:SSH_TTY=');
    // A plain shell under the tab adds nothing: the tab is its identity.
    sim.table[520] = proc(520, 50, 'zsh', '-zsh');
    sim.ppid = 520;
    expect(resolveTerminalKeys().map((k) => k.kind)).toEqual(['terminal']);
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

  it('MEDIUM-4: two harnesses under one tab env each start their own session', async () => {
    sim.env = { TERM_SESSION_ID: 'w0t0p0:SHARED' };
    call(100);
    const a = await sessionStart(root, { scope: 'global', name: 'kimi' });
    call(200);
    const b = await sessionStart(root, { scope: 'global', name: 'aider' });
    expect(b.error?.message).toBeUndefined();
    call(100);
    expect(await resolveBoundSessionId(root)).toBe(a.data!.id);
    call(200);
    expect(await resolveBoundSessionId(root)).toBe(b.data!.id);
  });

  it('HIGH-1: two agents of one generic host share nothing — both are unidentified', async () => {
    call(100);
    const a = await sessionStart(root, { scope: 'global', name: 'kimi' });
    expect(a.success).toBe(true);
    sim.table[900] = proc(900, 50, 'node', 'node /opt/orchestrator/dist/main.js');
    call(900);
    expect(await resolveBoundSessionId(root)).toBeNull();
    const b = await sessionStart(root, { scope: 'global', name: 'host-agent' });
    expect(b.error?.code).toBe('E_SESSION_CONFLICT');
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
