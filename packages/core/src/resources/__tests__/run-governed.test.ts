/**
 * Tests for runGoverned (T12979, T12980, T12981): the `cleo run` engine,
 * driven entirely through fakes (a fake child process group, a fake clock,
 * scripted pressure samples). No real process is ever signalled.
 *
 * Coverage:
 *   - admitted run: env markers, renice, release, registry cleanup
 *   - deferral without --wait: nothing spawned; running[] names holders
 *   - --wait: FIFO (only the head acquires), timeout with queue position
 *   - pause under backoff when younger, resume when it eases, SIGCONT on exit
 *   - no signal after exit even when a sample resolves after the child died
 *   - non-pausable jobs are never paused
 *   - runner signals are forwarded to the group (SIGCONT first)
 *   - spawn failure releases the grant and cleans up
 *
 * @task T12979
 * @task T12980
 * @task T12981
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdmissionResult, ResourceClass } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResourceSample } from '../backend.js';
import { type RunJob, writeQueueTicket, writeRunJob } from '../run-admission.js';
import { type GovernedChild, type RunGovernedDeps, runGoverned } from '../run-governed.js';

type Level = 'ok' | 'hold' | 'backoff';

function sampleOf(level: Level): ResourceSample {
  const some = level === 'ok' ? 0 : level === 'hold' ? 15 : 30;
  const line = { avg10: some, avg60: some, avg300: some, totalUs: 0 };
  return {
    sampledAtMs: 0,
    pressureAvailable: true,
    memAvailableBytes: 8 * 1024 ** 3,
    globalPressure: { some: line, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
    slicePressure: null,
    cpuPressure: null,
    walObservations: [],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-run-governed-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  deps: Partial<RunGovernedDeps>;
  child: GovernedChild & { pid: number };
  signals: Array<[number, string]>;
  spawned: Array<{
    file: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    detached: boolean;
  }>;
  acquires: number;
  released: number;
  clock: { t: number };
  sampleCalls: () => number;
  forward: (sig: NodeJS.Signals) => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

function harness(opts: {
  levels?: Level[];
  admissions?: Array<'grant' | 'deny'>;
  onSample?: (n: number, h: Harness) => void;
  onSleep?: (n: number, h: Harness) => void;
  spawnThrows?: boolean;
  groupOf?: (pid: number) => number | null;
  onAcquire?: (h: Harness) => void;
}): Harness {
  const clock = { t: 1_000_000 };
  let calls = 0;
  let sleeps = 0;
  let handler: ((s: NodeJS.Signals) => void) | null = null;
  const child = Object.assign(new EventEmitter(), { pid: 500 }) as GovernedChild & { pid: number };
  const admissions = [...(opts.admissions ?? ['grant'])];
  const h: Harness = {
    child,
    signals: [],
    spawned: [],
    acquires: 0,
    released: 0,
    clock,
    sampleCalls: () => calls,
    forward: (sig) => handler?.(sig),
    exit: (code, signal = null) => child.emit('exit', code, signal),
    deps: {},
  };
  const grant = (): AdmissionResult => ({
    deferred: false,
    class: 'test-run',
    slot: 0,
    acquiredAtMs: clock.t,
    release: async () => {
      h.released++;
    },
  });
  h.deps = {
    sample: async () => {
      calls++;
      const levels = opts.levels ?? ['ok'];
      const level = levels[Math.min(calls - 1, levels.length - 1)] as Level;
      opts.onSample?.(calls, h);
      return sampleOf(level);
    },
    tryAcquire: async (cls: ResourceClass) => {
      h.acquires++;
      opts.onAcquire?.(h);
      const next = admissions.length > 1 ? admissions.shift() : admissions[0];
      return next === 'grant'
        ? grant()
        : { deferred: true, class: cls, retryAfterMs: 1000, reason: 'no slot free' };
    },
    spawn: (file, args, o) => {
      if (opts.spawnThrows) throw new Error('ENOENT: no such file');
      h.spawned.push({ file, args, env: o.env, detached: o.detached });
      return child;
    },
    signal: (pid, sig) => {
      h.signals.push([pid, sig]);
      return true;
    },
    start: (pid) => `start-${pid}`,
    renice: () => {},
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps++;
      clock.t += ms;
      await new Promise((r) => setImmediate(r));
      opts.onSleep?.(sleeps, h);
    },
    onRunnerSignal: (fn) => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    jobsDir: join(dir, 'jobs'),
    queueDir: () => join(dir, 'queue'),
    verifyHolders: () => [],
    pid: process.pid, // alive for the registry's liveness probe
    groupOf: opts.groupOf ?? (() => null),
  };
  return h;
}

/** A heartbeat within the stale window for every test's fake-clock span. */
const FRESH = 1_030_000;

/** An older live job, so this one is "younger" under backoff. */
function olderJob(): RunJob {
  return {
    id: 'older',
    pid: process.pid,
    runnerStart: `start-${process.pid}`,
    childPid: null,
    childStart: null,
    class: 'test-run',
    command: 'older',
    cwd: '/',
    startedAtMs: 1,
    sessionId: null,
    pausedAtMs: null,
    pausable: true,
    heartbeatAtMs: FRESH, // fresh for the fake clock's first minute
  };
}

const base = (h: Harness, over: Record<string, unknown> = {}) => ({
  argv: ['npx', 'vitest', 'run', 'a.test.ts'],
  cls: 'test-run' as const,
  cwd: dir,
  env: { PATH: '/bin' },
  sessionId: 'ses_1',
  pollMs: 5000,
  deps: h.deps,
  ...over,
});

describe('runGoverned', () => {
  it('runs an admitted command and cleans up', async () => {
    const h = harness({ onSample: (n, hh) => n === 2 && hh.exit(0) });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({
      kind: 'exited',
      exitCode: 0,
      signal: null,
      spawnError: null,
      pauses: 0,
    });
    expect(h.spawned[0]?.env).toMatchObject({ PATH: '/bin', CLEO_RUN_CLASS: 'test-run' });
    expect(h.spawned[0]?.env).not.toHaveProperty('CLEO_GOVERNOR_GRANT');
    expect(h.released).toBe(1);
    expect(h.signals).toEqual([]);
    expect(readdirSync(join(dir, 'jobs'))).toEqual([]);
  });

  it('a nested or forged grant marker buys nothing: every run is admitted on its own', async () => {
    const h = harness({ admissions: ['deny'] });
    const r = await runGoverned(base(h, { env: { CLEO_GOVERNOR_GRANT: 'test-run' } }));
    expect(h.acquires).toBe(1);
    expect(r.kind).toBe('deferred');
    expect(h.spawned).toEqual([]);
  });

  it('no barging: while someone waits in the queue, a newcomer defers without trying', async () => {
    writeQueueTicket(
      {
        id: 'ahead',
        pid: process.pid,
        runnerStart: null,
        enqueuedAtMs: 1,
        heartbeatAtMs: FRESH,
        command: 'x',
      },
      join(dir, 'queue'),
    );
    const h = harness({ admissions: ['grant'] });
    const r = await runGoverned(base(h));
    expect(h.acquires).toBe(0);
    expect(r.kind).toBe('deferred');
    if (r.kind === 'deferred') expect(r.reason).toMatch(/1 job\(s\) ahead in the test-run queue/);
  });

  it('defers without --wait: nothing spawned, holders listed', async () => {
    const h = harness({ admissions: ['deny'] });
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const r = await runGoverned(base(h));
    expect(r.kind).toBe('deferred');
    if (r.kind !== 'deferred') return;
    expect(h.spawned).toEqual([]);
    expect(r.details.running.map((e) => e.command)).toEqual(['older']);
    expect(r.details.queuePosition).toBeNull();
    expect(r.alternatives.at(-1)?.command).toContain('--wait');
  });

  it('--wait is FIFO: only the head of the queue tries to acquire', async () => {
    const qdir = join(dir, 'queue');
    writeQueueTicket(
      {
        id: 'ahead',
        pid: process.pid,
        runnerStart: null,
        enqueuedAtMs: 1,
        heartbeatAtMs: FRESH,
        command: 'x',
      },
      qdir,
    );
    const h = harness({
      admissions: ['grant'],
      onSleep: (n) => {
        if (n === 3) rmSync(join(qdir, 'ahead.json'));
      },
      // sample 1: arrival; 2: the first attempt as head; 3: supervision.
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    const r = await runGoverned(base(h, { wait: true, queuePollMs: 1000, timeoutMs: 60_000 }));
    expect(r.kind).toBe('exited');
    // No attempt on arrival (someone was waiting), none while behind 'ahead',
    // exactly one as head.
    expect(h.acquires).toBe(1);
    expect(existsSync(qdir) ? readdirSync(qdir) : []).toEqual([]);
  });

  it('--wait times out with the queue position', async () => {
    const h = harness({ admissions: ['deny'] });
    const r = await runGoverned(base(h, { wait: true, queuePollMs: 1000, timeoutMs: 5000 }));
    expect(r.kind).toBe('deferred');
    if (r.kind !== 'deferred') return;
    expect(r.reason).toMatch(/timed out after \d+s in the test-run queue \(position 1\)/);
    expect(r.details.queuePosition).toBe(1);
    expect(h.spawned).toEqual([]);
  });

  it('pauses a younger job at backoff, resumes when it eases, and SIGCONTs on exit', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    // sample 1 = admission; 2 = backoff → pause; 3 = backoff (stay); 4 = ok → resume; 5 → exit
    const h = harness({
      levels: ['ok', 'backoff', 'backoff', 'ok', 'ok'],
      onSample: (n, hh) => n === 5 && hh.exit(0),
    });
    const r = await runGoverned(base(h));
    expect(h.signals).toEqual([
      [500, 'SIGSTOP'],
      [500, 'SIGCONT'],
      [500, 'SIGCONT'], // exit path: workers must never stay stopped
    ]);
    expect(r).toMatchObject({ kind: 'exited', pauses: 1, pausedMs: 10_000 });
  });

  it('the oldest job is never paused', async () => {
    const h = harness({
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    await runGoverned(base(h));
    expect(h.signals).toEqual([]);
  });

  it('sends no signal when the child exits while a sample is in flight', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const h = harness({
      levels: ['ok', 'backoff'],
      onSample: (n, hh) => n === 2 && hh.exit(0), // exit lands before the sample resolves
    });
    await runGoverned(base(h));
    expect(h.signals.filter(([, s]) => s === 'SIGSTOP')).toEqual([]);
  });

  it('a job paused when the child dies still gets its group resumed', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const h = harness({
      levels: ['ok', 'backoff'],
      onSleep: (n, hh) => n === 2 && hh.exit(null, 'SIGKILL'),
    });
    const r = await runGoverned(base(h));
    expect(h.signals).toEqual([
      [500, 'SIGSTOP'],
      [500, 'SIGCONT'],
    ]);
    expect(r).toMatchObject({ kind: 'exited', signal: 'SIGKILL', pauses: 1 });
  });

  it('never pauses an install, even when younger at backoff', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const h = harness({
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    await runGoverned(base(h, { argv: ['pnpm', 'install'], cls: 'scoped-build' }));
    expect(h.signals).toEqual([]);
  });

  it('forwards runner signals to the group, resuming it first', async () => {
    const h = harness({
      onSample: (n, hh) => {
        if (n === 2) {
          hh.forward('SIGTERM');
          hh.exit(null, 'SIGTERM');
        }
      },
    });
    const r = await runGoverned(base(h));
    expect(h.signals).toEqual([
      [500, 'SIGCONT'],
      [500, 'SIGTERM'],
    ]);
    expect(r).toMatchObject({ kind: 'exited', signal: 'SIGTERM' });
  });

  it("a nested run inside a live job's group runs on its slot: no acquire, not detached, never paused", async () => {
    writeRunJob(
      { ...olderJob(), id: 'outer', childPid: 777, childStart: 'start-777' },
      join(dir, 'jobs'),
    );
    const h = harness({
      groupOf: () => 777,
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, slot: -1, pauses: 0 });
    expect(h.acquires).toBe(0);
    expect(h.spawned[0]?.detached).toBe(false);
    expect(h.signals).toEqual([]);
  });

  it('a non-nested run is spawned detached as its own group', async () => {
    const h = harness({ onSample: (n, hh) => n === 2 && hh.exit(0) });
    await runGoverned(base(h));
    expect(h.spawned[0]?.detached).toBe(true);
  });

  it('with --wait the ticket is written before the first try (L-1)', async () => {
    let ticketsAtFirstTry = -1;
    const h = harness({
      admissions: ['grant'],
      onAcquire: () => {
        if (ticketsAtFirstTry < 0) ticketsAtFirstTry = readdirSync(join(dir, 'queue')).length;
      },
      onSample: (n, hh) => n === 2 && hh.exit(0),
    });
    await runGoverned(base(h, { wait: true, queuePollMs: 1000, timeoutMs: 60_000 }));
    expect(ticketsAtFirstTry).toBe(1);
    expect(readdirSync(join(dir, 'queue'))).toEqual([]); // removed once admitted
  });

  it('a spawn failure releases the grant and leaves no record', async () => {
    const h = harness({ spawnThrows: true });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({ kind: 'exited', exitCode: null, spawnError: 'ENOENT: no such file' });
    expect(h.released).toBe(1);
    expect(readdirSync(join(dir, 'jobs'))).toEqual([]);
  });
});
