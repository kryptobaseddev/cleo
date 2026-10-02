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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdmissionResult, ResourceClass } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../backend.js';
import { _resetGovernorStateForTest, governorSlotDir, ResourceGovernor } from '../governor.js';
import { type RunJob, writeQueueTicket, writeRunJob } from '../run-admission.js';
import { type GovernedChild, type RunGovernedDeps, runGoverned } from '../run-governed.js';
import {
  assessGovernorHolder,
  lockSlot,
  readGovernorHolder,
  writeHolderRecord,
} from '../slot-holder.js';
import { _resetToolGroupsForTest } from '../tool-groups.js';

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
    passthrough: boolean;
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
  ancestorsOf?: (pid: number) => readonly number[] | null;
  onAcquire?: (h: Harness) => void;
  acquireThrows?: Error;
  jobsDir?: string;
  /** The fake child's pid. @defaultValue 500 */
  childPid?: number;
}): Harness {
  const clock = { t: 1_000_000 };
  let calls = 0;
  let sleeps = 0;
  let handler: ((s: NodeJS.Signals) => void) | null = null;
  const child = Object.assign(new EventEmitter(), {
    pid: opts.childPid ?? 500,
  }) as GovernedChild & {
    pid: number;
  };
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
      if (opts.acquireThrows) throw opts.acquireThrows;
      const next = admissions.length > 1 ? admissions.shift() : admissions[0];
      return next === 'grant'
        ? grant()
        : { deferred: true, class: cls, retryAfterMs: 1000, reason: 'no slot free' };
    },
    spawn: (file, args, o) => {
      if (opts.spawnThrows) throw new Error('ENOENT: no such file');
      h.spawned.push({
        file,
        args,
        env: o.env,
        detached: o.detached,
        passthrough: o.passthrough,
      });
      return child;
    },
    signal: (pid, sig) => {
      h.signals.push([pid, sig]);
      return true;
    },
    signalPid: (pid, sig) => {
      h.signals.push([pid, `pid:${sig}`]);
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
    jobsDir: opts.jobsDir ?? join(dir, 'jobs'),
    queueDir: () => join(dir, 'queue'),
    verifyHolders: () => [],
    pid: process.pid, // alive for the registry's liveness probe
    groupOf: opts.groupOf ?? (() => null),
    ancestorsOf: opts.ancestorsOf ?? (() => []),
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

  it('a nested run forwards runner signals to the child process, not its group (L-A)', async () => {
    writeRunJob(
      { ...olderJob(), id: 'outer', childPid: 777, childStart: 'start-777' },
      join(dir, 'jobs'),
    );
    const h = harness({
      groupOf: () => 777,
      onSample: (n, hh) => {
        if (n === 2) {
          hh.forward('SIGTERM');
          hh.exit(null, 'SIGTERM');
        }
      },
    });
    await runGoverned(base(h));
    expect(h.signals).toEqual([
      [500, 'pid:SIGCONT'],
      [500, 'pid:SIGTERM'],
    ]);
  });

  it('a nested run under a parent of ANOTHER class is admitted on its own (MED-1)', async () => {
    writeRunJob(
      { ...olderJob(), id: 'outer', class: 'full-build', childPid: 777, childStart: 'start-777' },
      join(dir, 'jobs'),
    );
    const h = harness({ groupOf: () => 777, admissions: ['deny'] });
    const r = await runGoverned(base(h));
    expect(h.acquires).toBe(1);
    expect(r.kind).toBe('deferred');
  });

  it('a nested run of ANOTHER class takes its own slot but stays in the enclosing group (N1)', async () => {
    writeRunJob(
      { ...olderJob(), id: 'outer', class: 'full-build', childPid: 777, childStart: 'start-777' },
      join(dir, 'jobs'),
    );
    let record: RunJob | undefined;
    const h = harness({
      groupOf: () => 777,
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => {
        if (n === 2) {
          const own = readdirSync(join(dir, 'jobs')).find((f) => f !== 'outer.json');
          record = JSON.parse(readFileSync(join(dir, 'jobs', own as string), 'utf8')) as RunJob;
          hh.forward('SIGTERM');
        }
        if (n === 3) hh.exit(null, 'SIGTERM');
      },
    });
    const r = await runGoverned(base(h));
    expect(h.acquires).toBe(1);
    expect(r).toMatchObject({ kind: 'exited', slot: 0, pauses: 0 });
    expect(h.spawned[0]?.detached).toBe(false);
    expect(record).toMatchObject({ parentJob: 'outer', holdsSlot: true, pausable: false });
    // Never SIGSTOPped on its own (backoff, younger), and forwarded by pid.
    expect(h.signals).toEqual([
      [500, 'pid:SIGCONT'],
      [500, 'pid:SIGTERM'],
    ]);
  });

  it('a job whose group holds a slot-owning nested run is never paused (N1)', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const h = harness({
      levels: ['ok', 'backoff', 'backoff', 'backoff'],
      onSample: (n, hh) => {
        if (n === 2) {
          const own = readdirSync(join(dir, 'jobs')).find((f) => f !== 'older.json') as string;
          writeRunJob(
            {
              ...olderJob(),
              id: 'inner',
              class: 'test-run',
              startedAtMs: hh.clock.t,
              heartbeatAtMs: hh.clock.t,
              parentJob: own.replace(/\.json$/, ''),
              holdsSlot: true,
            },
            join(dir, 'jobs'),
          );
        }
        if (n === 4) hh.exit(0);
      },
    });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, pauses: 0 });
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

describe('fail open when the governor cannot write its state (#1781 review, HIGH)', () => {
  const ioError = (code: string) =>
    Object.assign(new Error(`${code}: mkdir '/sandbox/cleo/locks/resource-test-run'`), {
      code,
      path: '/sandbox/cleo/locks/resource-test-run',
    });

  it.each([
    'EACCES',
    'EPERM',
    'EROFS',
    'ENOSPC',
    'ENOTDIR',
  ])('%s on the slot acquire: the command runs ungoverned, its exit code passes through', async (code) => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const notices: string[] = [];
    const h = harness({
      acquireThrows: ioError(code),
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => n === 3 && hh.exit(3),
    });
    const r = await runGoverned(base(h, { notice: (m: string) => notices.push(m) }));
    expect(r).toMatchObject({
      kind: 'exited',
      exitCode: 3,
      slot: -1,
      pauses: 0, // ungoverned: never paused, even younger at backoff
      ungoverned: { code, path: '/sandbox/cleo/locks/resource-test-run' },
    });
    expect(h.spawned).toHaveLength(1);
    expect(h.signals).toEqual([]);
    expect(notices.some((m) => m.includes(code) && m.includes('running ungoverned'))).toBe(true);
  });

  it('with --wait as well', async () => {
    const h = harness({
      acquireThrows: ioError('EACCES'),
      onSample: (n, hh) => n === 2 && hh.exit(0),
    });
    const r = await runGoverned(base(h, { wait: true, queuePollMs: 1000, timeoutMs: 60_000 }));
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, ungoverned: { code: 'EACCES' } });
  });

  it('an unwritable job registry never blocks the run (writes are best effort)', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const h = harness({
      jobsDir: join(file, 'jobs'), // mkdir fails with ENOTDIR
      onSample: (n, hh) => n === 2 && hh.exit(0),
    });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, slot: 0, ungoverned: null });
  });

  describe('with the REAL governor (R8-1)', () => {
    // Root ignores directory permissions: the read-only case cannot be staged.
    const asRoot = process.getuid?.() === 0;
    const slotDir = governorSlotDir('db-heavy');
    afterEach(() => {
      if (existsSync(slotDir)) chmodSync(slotDir, 0o755);
      _resetGovernorStateForTest();
    });

    it.skipIf(asRoot)(
      'a home whose slot dir exists but is read-only runs ungoverned, exit code kept',
      async () => {
        _resetGovernorStateForTest();
        const gov = new ResourceGovernor();
        // An earlier unsandboxed run created the slot dir; now writes are denied.
        const first = await gov.tryAcquire('db-heavy', { sample: sampleOf('ok') });
        expect(first.deferred).toBe(false);
        if (!first.deferred) await first.release();
        chmodSync(slotDir, 0o555);

        const notices: string[] = [];
        const h = harness({ onSample: (n, hh) => n === 2 && hh.exit(4) });
        const r = await runGoverned(
          base(h, {
            argv: ['pnpm', 'run', 'db:migrate'],
            cls: 'db-heavy',
            notice: (m: string) => notices.push(m),
            deps: {
              ...h.deps,
              tryAcquire: (cls: ResourceClass, sample: ResourceSample) =>
                gov.tryAcquire(cls, { sample }),
            },
          }),
        );
        expect(r).toMatchObject({ kind: 'exited', exitCode: 4, slot: -1 });
        if (r.kind === 'exited') expect(r.ungoverned?.code).toMatch(/^(EACCES|EPERM)$/);
        expect(h.spawned).toHaveLength(1);
        expect(notices.some((m) => m.includes('running ungoverned'))).toBe(true);
      },
    );
  });

  it('any other acquire error is a bug: it propagates and nothing runs', async () => {
    const h = harness({ acquireThrows: new TypeError('cannot read properties of undefined') });
    await expect(runGoverned(base(h))).rejects.toThrow(TypeError);
    expect(h.spawned).toEqual([]);
  });

  it('a deferral is unchanged: E_RESOURCE_DEFERRED, nothing spawned', async () => {
    const h = harness({ admissions: ['deny'] });
    const r = await runGoverned(base(h));
    expect(r.kind).toBe('deferred');
    expect(h.spawned).toEqual([]);
  });
});

describe('--passthrough and a terminal in the foreground (#1777 R7)', () => {
  it('passthrough hands the child the stdio; without a terminal it stays detached and pausable', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const h = harness({
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    await runGoverned(base(h, { passthrough: true }));
    expect(h.spawned[0]).toMatchObject({ passthrough: true, detached: true });
    expect(h.signals).toEqual([
      [500, 'SIGSTOP'],
      [500, 'SIGCONT'],
    ]);
  });

  it("without passthrough the child's stdout goes to stderr", async () => {
    const h = harness({ onSample: (n, hh) => n === 2 && hh.exit(0) });
    await runGoverned(base(h));
    expect(h.spawned[0]).toMatchObject({ passthrough: false, detached: true });
  });

  it('foreground: not detached, never paused, signals forwarded by pid, recorded as leading no group', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    let record: RunJob | undefined;
    const h = harness({
      levels: ['ok', 'backoff', 'backoff'],
      onSample: (n, hh) => {
        if (n === 2) {
          const own = readdirSync(join(dir, 'jobs')).find((f) => f !== 'older.json');
          record = JSON.parse(readFileSync(join(dir, 'jobs', own as string), 'utf8')) as RunJob;
          // Ctrl-C already reached the whole foreground group: not forwarded.
          hh.forward('SIGINT');
          hh.forward('SIGTERM');
        }
        if (n === 3) hh.exit(null, 'SIGTERM');
      },
    });
    const r = await runGoverned(base(h, { passthrough: true, foreground: true }));
    expect(h.spawned[0]).toMatchObject({ detached: false, passthrough: true });
    expect(record).toMatchObject({ pausable: false, leadsGroup: false, holdsSlot: true });
    // Younger at backoff and still never SIGSTOPped; SIGTERM goes to the pid,
    // SIGINT not at all (no second Ctrl-C for the child).
    expect(h.signals).toEqual([
      [500, 'pid:SIGCONT'],
      [500, 'pid:SIGTERM'],
    ]);
    expect(r).toMatchObject({ kind: 'exited', signal: 'SIGTERM', pauses: 0, slot: 0 });
  });

  it('a detached run records that its child leads its group', async () => {
    let record: RunJob | undefined;
    const h = harness({
      onSample: (n, hh) => {
        if (n === 2) {
          const own = readdirSync(join(dir, 'jobs'))[0] as string;
          record = JSON.parse(readFileSync(join(dir, 'jobs', own), 'utf8')) as RunJob;
          hh.exit(0);
        }
      },
    });
    await runGoverned(base(h));
    expect(record).toMatchObject({ leadsGroup: true, pausable: true });
  });

  it('a run under a foreground job (which leads no group) is found by ancestry and rides its slot', async () => {
    writeRunJob(
      { ...olderJob(), id: 'fg', childPid: 777, childStart: 'start-777', leadsGroup: false },
      join(dir, 'jobs'),
    );
    const h = harness({
      groupOf: () => 650, // the terminal's group: says nothing
      ancestorsOf: () => [640, 777, 600],
      onSample: (n, hh) => n === 2 && hh.exit(0),
    });
    const r = await runGoverned(base(h));
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, slot: -1 });
    expect(h.acquires).toBe(0);
    expect(h.spawned[0]?.detached).toBe(false);
  });
});

describe('notice levels (#1777 R7: --passthrough prints only warnings)', () => {
  it('a pause and its resume warn', async () => {
    writeRunJob(olderJob(), join(dir, 'jobs'));
    const notices: Array<[string, string]> = [];
    const h = harness({
      levels: ['ok', 'backoff', 'backoff', 'ok', 'ok'],
      onSample: (n, hh) => n === 5 && hh.exit(0),
    });
    await runGoverned(base(h, { notice: (m: string, l: string) => notices.push([l, m]) }));
    expect(notices.map(([l, m]) => [l, m.split(':')[0]])).toEqual([
      ['warn', 'paused'],
      ['warn', 'resumed.'],
    ]);
  });

  it('an ungoverned run warns', async () => {
    const notices: Array<[string, string]> = [];
    const h = harness({
      acquireThrows: Object.assign(new Error('EROFS'), { code: 'EROFS' }),
      onSample: (n, hh) => n === 2 && hh.exit(0),
    });
    await runGoverned(base(h, { notice: (m: string, l: string) => notices.push([l, m]) }));
    expect(notices).toEqual([['warn', expect.stringContaining('running ungoverned')]]);
  });

  it('a queue admission and a nested run are progress (info)', async () => {
    const queued: Array<[string, string]> = [];
    const q = harness({
      admissions: ['deny', 'grant'],
      onSample: (n, hh) => n === 3 && hh.exit(0),
    });
    await runGoverned(
      base(q, {
        wait: true,
        queuePollMs: 1000,
        timeoutMs: 60_000,
        notice: (m: string, l: string) => queued.push([l, m]),
      }),
    );
    expect(queued).toEqual([['info', expect.stringContaining('admitted after')]]);

    writeRunJob(
      { ...olderJob(), id: 'outer', childPid: 777, childStart: 'start-777' },
      join(dir, 'jobs'),
    );
    const nested: Array<[string, string]> = [];
    const h = harness({ groupOf: () => 777, onSample: (n, hh) => n === 2 && hh.exit(0) });
    await runGoverned(base(h, { notice: (m: string, l: string) => nested.push([l, m]) }));
    expect(nested).toEqual([['info', expect.stringContaining('nested in a running')]]);
  });
});

describe('a SIGKILLed runner whose child still runs keeps its slot (T12963)', () => {
  const CHILD = 4_000_020;
  const GONE_RUNNER = 4_000_021;
  const savedHome = process.env.CLEO_HOME;

  beforeEach(() => {
    process.env.CLEO_HOME = mkdtempSync(join(tmpdir(), 'cleo-run-governed-home-'));
    _resetGovernorStateForTest();
    _resetToolGroupsForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const home = process.env.CLEO_HOME;
    if (savedHome === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = savedHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    _resetGovernorStateForTest();
    _resetToolGroupsForTest();
  });

  it("lists the child's group on the slot; a verify's lockSlot does not reap it while the group lives", async () => {
    // process.kill is stubbed: this process and the groups in `live` answer
    // alive, everything else ESRCH. Nothing real is ever signalled.
    const live = new Set<number>();
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
      if (pid === process.pid || (pid < 0 && live.has(-pid))) return true;
      const err: NodeJS.ErrnoException = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    const gov = new ResourceGovernor();
    const slot = join(governorSlotDir('db-heavy'), 'slot-0.lock');
    let check: Promise<void> | null = null;
    const seen: { groups?: readonly number[]; whileLive?: unknown; onceGone?: string } = {};
    const h = harness({
      childPid: CHILD,
      onSample: (n, hh) => {
        if (n !== 2 || check !== null) return;
        check = (async () => {
          const record = readGovernorHolder(slot);
          seen.groups = record?.toolGroups;
          if (record === null) throw new Error('no holder record while the job runs');
          // What a SIGKILL of the runner leaves: the record names a dead pid.
          writeHolderRecord(slot, { ...record, pid: GONE_RUNNER });
          live.add(CHILD);
          seen.whileLive = await lockSlot(slot, 'db-heavy');
          live.delete(CHILD);
          seen.onceGone = assessGovernorHolder(readGovernorHolder(slot), slot);
          hh.exit(0);
        })();
      },
    });

    const r = await runGoverned(
      base(h, {
        argv: ['pnpm', 'run', 'db:migrate'],
        cls: 'db-heavy',
        deps: {
          ...h.deps,
          tryAcquire: (cls: ResourceClass, sample: ResourceSample) =>
            gov.tryAcquire(cls, { sample }),
        },
      }),
    );
    await check;

    expect(r).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(h.spawned[0]?.detached).toBe(true);
    expect(seen.groups).toEqual([CHILD]);
    expect(seen.whileLive).toBeNull();
    expect(seen.onceGone).toBe('dead');
  });
});
