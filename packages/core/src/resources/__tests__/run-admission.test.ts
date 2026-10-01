/**
 * Tests for `cleo run` admission pieces (T12979, T12980).
 *
 * Coverage:
 *   - resolveRunClass: aliases, unknown class, inference (npm t, root build)
 *   - isPausable / looksHeavy
 *   - redactCommand: assignments, flag values, URL userinfo, bearer tokens
 *   - job registry: heartbeat, dead runners pruned, pid reuse detected,
 *     orphan recovery only for the same child process, junk cleanup
 *   - wait queue: FIFO order, dead/stale tickets dropped
 *   - verify holders: read from the tool semaphore's sidecars
 *   - decidePause: oldest runs, younger pauses, not-pausable, cap + run window
 *   - buildRunDeferral / runningEntries
 *
 * @task T12979
 * @task T12980
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRunDeferral,
  CAP_RUN_WINDOW_MS,
  decidePause,
  isPausable,
  JOB_STALE_MS,
  listQueueTickets,
  listRunJobs,
  listVerifyHolders,
  looksHeavy,
  MAX_PAUSE_MS,
  parentRunJob,
  type RunJob,
  reapOrphans,
  redactCommand,
  resolveRunClass,
  runnerState,
  runningEntries,
  writeQueueTicket,
  writeRunJob,
} from '../run-admission.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-run-admission-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveRunClass', () => {
  it('honours explicit aliases and rejects unknown ones', () => {
    expect(resolveRunClass('test', ['x'], dir)).toBe('test-run');
    expect(resolveRunClass('typecheck', ['npx', 'vitest'], dir)).toBe('scoped-build');
    expect(resolveRunClass('full-build', ['x'], dir)).toBe('full-build');
    expect(resolveRunClass('db', ['x'], dir)).toBe('db-heavy');
    expect(() => resolveRunClass('everything', ['x'], dir)).toThrow(/unknown --class/);
  });

  it('infers test runs, including npm t', () => {
    for (const argv of [
      ['npx', 'vitest', 'run', 'a.test.ts'],
      ['./node_modules/.bin/jest'],
      ['pnpm', 'test'],
      ['npm', 't'],
      ['npm', 'run', 'test:unit'],
      ['pnpm', '--filter', '@x/api', 'test'],
      ['cargo', 'test'],
    ]) {
      expect(resolveRunClass(undefined, argv, dir), argv.join(' ')).toBe('test-run');
    }
  });

  it('an unscoped build at a workspace root is a full build', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveRunClass(undefined, ['pnpm', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['pnpm', 'run', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['pnpm', '--filter', 'x', 'build'], dir)).toBe(
      'scoped-build',
    );
    expect(resolveRunClass(undefined, ['pnpm', '--filter=x', 'build'], dir)).toBe('scoped-build');
  });

  it('a recursive build is a full build anywhere (#1777 R3)', () => {
    expect(resolveRunClass(undefined, ['pnpm', '-r', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['pnpm', '--recursive', 'run', 'build'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['pnpm', '-r', '--filter', 'x', 'build'], dir)).toBe(
      'scoped-build',
    );
  });

  it('defaults everything else to scoped-build', () => {
    expect(resolveRunClass(undefined, ['npx', 'tsc', '-b'], dir)).toBe('scoped-build');
    expect(resolveRunClass(undefined, ['pnpm', 'install'], dir)).toBe('scoped-build');
    expect(resolveRunClass(undefined, ['pnpm', 'build'], dir)).toBe('scoped-build'); // not a root
  });
});

describe('isPausable / looksHeavy', () => {
  it('installs and db-heavy work are never paused', () => {
    expect(isPausable('scoped-build', ['pnpm', 'install'])).toBe(false);
    expect(isPausable('scoped-build', ['npm', 'ci'])).toBe(false);
    expect(isPausable('scoped-build', ['cargo', 'fetch'])).toBe(false);
    expect(isPausable('db-heavy', ['node', 'migrate.js'])).toBe(false);
    expect(isPausable('test-run', ['npx', 'vitest'])).toBe(true);
    expect(isPausable('scoped-build', ['npx', 'tsc', '-b'])).toBe(true);
  });

  it('flags heavy commands and leaves light ones alone', () => {
    expect(looksHeavy(['npx', 'vitest', 'run'])).toBe(true);
    expect(looksHeavy(['npm', 't'])).toBe(true);
    expect(looksHeavy(['pnpm', 'install'])).toBe(true);
    expect(looksHeavy(['cargo', 'build'])).toBe(true);
    expect(looksHeavy(['git', 'status'])).toBe(false);
    expect(looksHeavy(['pnpm', 'list'])).toBe(false);
  });
});

describe('redactCommand', () => {
  it('masks assignments, flag values, URL userinfo and bearer tokens', () => {
    expect(redactCommand(['env', 'API_TOKEN=abc', 'MODE=fast', 'run'])).toBe(
      'env API_TOKEN=*** MODE=fast run',
    );
    expect(redactCommand(['gh', '--token', 'ghp_x', 'pr', 'list'])).toBe('gh --token *** pr list');
    expect(redactCommand(['git', 'clone', 'https://user:pw@host/r.git'])).toBe(
      'git clone https://***@host/r.git',
    );
    expect(redactCommand(['curl', '-H', 'Authorization: Bearer abc.def'])).toBe(
      'curl -H Authorization: Bearer ***',
    );
  });

  it('truncates long command lines', () => {
    const line = redactCommand(['x'.repeat(400)]);
    expect(line.length).toBe(160);
    expect(line.endsWith('...')).toBe(true);
  });
});

function job(over: Partial<RunJob> & { id: string; startedAtMs: number }): RunJob {
  return {
    pid: 1000 + over.startedAtMs,
    runnerStart: 'start-runner',
    childPid: null,
    childStart: null,
    class: 'test-run',
    command: 'x',
    cwd: '/',
    sessionId: null,
    pausedAtMs: null,
    pausable: true,
    heartbeatAtMs: over.startedAtMs,
    ...over,
  };
}

describe('job registry', () => {
  const NOW = 10_000_000;
  const base = {
    alive: () => true,
    start: () => 'start-runner',
    signal: () => true,
    now: () => NOW,
  };
  const recorder = () => {
    const signals: Array<[number, string]> = [];
    return {
      signals,
      signal: (pid: number, sig: NodeJS.Signals) => {
        signals.push([pid, sig]);
        return true;
      },
    };
  };
  const deadRunner = (over: Partial<RunJob> = {}) =>
    writeRunJob(
      job({
        id: 'dead',
        startedAtMs: 1,
        heartbeatAtMs: NOW,
        childPid: 77,
        childStart: 'child-t0',
        ...over,
      }),
      dir,
    );

  it('lists live jobs oldest first', () => {
    writeRunJob(job({ id: 'b', startedAtMs: 2, heartbeatAtMs: NOW }), dir);
    writeRunJob(job({ id: 'a', startedAtMs: 1, heartbeatAtMs: NOW }), dir);
    expect(listRunJobs(dir, base).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('listRunJobs is a pure read: it never signals or deletes (L-4)', () => {
    deadRunner();
    const r = recorder();
    expect(listRunJobs(dir, { ...base, alive: () => false, signal: r.signal })).toEqual([]);
    expect(r.signals).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("reapOrphans resumes and stops a dead runner's child group (same process) and deletes the record", () => {
    deadRunner();
    const r = recorder();
    const n = reapOrphans(dir, {
      ...base,
      alive: (pid) => pid === 77, // runner gone, child still there
      start: (pid) => (pid === 77 ? 'child-t0' : null),
      signal: r.signal,
    });
    expect(n).toBe(1);
    expect(r.signals).toEqual([
      [77, 'SIGCONT'],
      [77, 'SIGTERM'],
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never signals a child pid that now belongs to another process', () => {
    deadRunner();
    const r = recorder();
    reapOrphans(dir, {
      ...base,
      alive: (pid) => pid === 77,
      start: () => 'someone-else',
      signal: r.signal,
    });
    expect(r.signals).toEqual([]);
    expect(readdirSync(dir)).toEqual([]); // nothing of ours left to recover
  });

  it('a paused group whose leader died is still resumed and stopped (#1777 R2)', () => {
    deadRunner({ childPid: 78 });
    const r = recorder();
    reapOrphans(dir, { ...base, alive: () => false, start: () => null, signal: r.signal });
    expect(r.signals).toEqual([
      [78, 'SIGCONT'],
      [78, 'SIGTERM'],
    ]);
  });

  it('a failed ps on a LIVE child is unknown: no signal, record kept for the next reap (H-1)', () => {
    deadRunner();
    const r = recorder();
    const n = reapOrphans(dir, {
      ...base,
      alive: (pid) => pid === 77,
      start: () => null, // ps timed out / could not fork
      signal: r.signal,
    });
    expect(n).toBe(0);
    expect(r.signals).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('a failed ps on a live runner with a stale heartbeat is unknown, never dead (H-1)', () => {
    writeRunJob(
      job({
        id: 'busy',
        startedAtMs: 1,
        heartbeatAtMs: NOW - JOB_STALE_MS - 1,
        childPid: 79,
        childStart: 'c',
      }),
      dir,
    );
    const r = recorder();
    const probes = { ...base, start: () => null, signal: r.signal };
    expect(
      runnerState(job({ id: 'x', startedAtMs: 1, heartbeatAtMs: NOW - JOB_STALE_MS - 1 }), probes),
    ).toBe('unknown');
    expect(reapOrphans(dir, probes)).toBe(0);
    expect(r.signals).toEqual([]);
    expect(listRunJobs(dir, probes)).toEqual([]); // not listed either
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('a stale heartbeat on a reused runner pid counts as dead', () => {
    writeRunJob(job({ id: 'reused', startedAtMs: 1, heartbeatAtMs: NOW - JOB_STALE_MS - 1 }), dir);
    const probes = { ...base, start: () => 'a-different-process' };
    expect(listRunJobs(dir, probes)).toEqual([]);
    expect(reapOrphans(dir, probes)).toBe(1);
  });

  it('a stale heartbeat on the same live runner is skipped, not reaped (suspended machine)', () => {
    writeRunJob(job({ id: 'asleep', startedAtMs: 1, heartbeatAtMs: NOW - JOB_STALE_MS - 1 }), dir);
    expect(listRunJobs(dir, base)).toEqual([]);
    expect(reapOrphans(dir, base)).toBe(0);
    expect(listRunJobs(dir, { ...base, now: () => NOW - JOB_STALE_MS }).map((j) => j.id)).toEqual([
      'asleep',
    ]);
  });

  it('reapOrphans removes old junk files, keeps fresh ones, survives a missing dir', () => {
    writeFileSync(join(dir, 'old.json'), '{not json');
    writeFileSync(join(dir, 'new.json'), '{not json');
    const old = (Date.now() - 2 * JOB_STALE_MS) / 1000;
    utimesSync(join(dir, 'old.json'), old, old);
    reapOrphans(dir, { ...base, now: Date.now });
    expect(reapOrphans(join(dir, 'nope'), base)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['new.json']);
  });

  it('really detects the current process as alive', () => {
    writeRunJob(
      job({ id: 'me', startedAtMs: 1, pid: process.pid, heartbeatAtMs: Date.now() }),
      dir,
    );
    expect(listRunJobs(dir)).toHaveLength(1);
  });
});

describe('parentRunJob (nested runs, M-2)', () => {
  const NOW = 10_000_000;
  const probes = {
    alive: () => true,
    start: (pid: number) => `start-${pid}`,
    signal: () => true,
    now: () => NOW,
  };
  beforeEach(() => {
    writeRunJob(
      job({
        id: 'outer',
        startedAtMs: 1,
        heartbeatAtMs: NOW,
        childPid: 500,
        childStart: 'start-500',
      }),
      dir,
    );
  });

  it("a process in a live job's child group is nested in it", () => {
    expect(parentRunJob({ pid: 9001, jobsDir: dir, probes, groupOf: () => 500 })?.id).toBe('outer');
  });

  it('`cleo run -- cleo run …`: the inner runner IS the outer child and leads its group', () => {
    expect(parentRunJob({ pid: 500, jobsDir: dir, probes, groupOf: () => 500 })?.id).toBe('outer');
  });

  it('a group leader of its own, an unknown group or a reused leader pid is not nested', () => {
    expect(parentRunJob({ pid: 9001, jobsDir: dir, probes, groupOf: () => 9001 })).toBeNull();
    expect(parentRunJob({ pid: 9001, jobsDir: dir, probes, groupOf: () => null })).toBeNull();
    expect(parentRunJob({ pid: 9001, jobsDir: dir, probes, groupOf: () => 600 })).toBeNull();
    expect(
      parentRunJob({
        pid: 9001,
        jobsDir: dir,
        probes: { ...probes, start: () => 'reused' },
        groupOf: () => 500,
      }),
    ).toBeNull();
    expect(
      parentRunJob({
        pid: 9001,
        jobsDir: dir,
        probes: { ...probes, start: () => null },
        groupOf: () => 500,
      }),
    ).toBeNull();
  });
});

describe('wait queue', () => {
  const NOW = 5_000_000;
  const ticket = (id: string, enqueuedAtMs: number, heartbeatAtMs = NOW) => ({
    id,
    pid: 1,
    runnerStart: null,
    enqueuedAtMs,
    heartbeatAtMs,
    command: 'x',
  });

  it('is FIFO and drops stale tickets', () => {
    writeQueueTicket(ticket('late', 20), dir);
    writeQueueTicket(ticket('early', 10), dir);
    writeQueueTicket(ticket('stale', 5, NOW - JOB_STALE_MS - 1), dir);
    const q = listQueueTickets(dir, { alive: () => true, now: () => NOW });
    expect(q.map((t) => t.id)).toEqual(['early', 'late']);
  });

  it('drops invalid and future-dated tickets so none can block a class forever (L-2)', () => {
    writeQueueTicket(ticket('ok', 10), dir);
    writeQueueTicket(ticket('future', 1, NOW + JOB_STALE_MS + 1), dir);
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', pid: 1, enqueuedAtMs: 0, heartbeatAtMs: 'soon' }),
    );
    const q = listQueueTickets(dir, { alive: () => true, now: () => NOW });
    expect(q.map((t) => t.id)).toEqual(['ok']);
    expect(readdirSync(dir).sort()).toEqual(['ok.json']);
  });
});

describe('listVerifyHolders', () => {
  it('reads live holders of held tool slots on this host only', () => {
    const tool = join(dir, 'locks', 'tool-test');
    mkdirSync(join(tool, 'slot-0.lock'), { recursive: true });
    writeFileSync(
      join(tool, 'slot-0.holder.json'),
      JSON.stringify({ pid: 42, host: hostname(), acquiredAt: '2026-10-01T00:00:00Z' }),
    );
    // Released slot (no .lock dir) and another host's holder are ignored.
    writeFileSync(
      join(tool, 'slot-1.holder.json'),
      JSON.stringify({ pid: 43, host: hostname(), acquiredAt: '2026-10-01T00:00:01Z' }),
    );
    mkdirSync(join(tool, 'slot-2.lock'));
    writeFileSync(
      join(tool, 'slot-2.holder.json'),
      JSON.stringify({ pid: 44, host: 'elsewhere', acquiredAt: '2026-10-01T00:00:02Z' }),
    );
    expect(listVerifyHolders(dir, () => true)).toEqual([
      { tool: 'test', pid: 42, acquiredAtMs: Date.parse('2026-10-01T00:00:00Z') },
    ]);
    expect(listVerifyHolders(dir, () => false)).toEqual([]);
  });
});

describe('decidePause', () => {
  const jobs = [{ id: 'old' }, { id: 'mid' }, { id: 'new' }];
  const self = (id: string, pausable = true) => ({ id, pausable });

  it('never pauses below backoff or a job that may not pause', () => {
    expect(decidePause({ state: 'hold', self: self('new'), jobs, nowMs: 1 }).decision).toBe('run');
    expect(decidePause({ state: 'backoff', self: self('new', false), jobs, nowMs: 1 })).toEqual({
      decision: 'run',
      reason: 'not-pausable',
    });
  });

  it('at backoff the oldest runs and younger jobs pause', () => {
    expect(decidePause({ state: 'backoff', self: self('old'), jobs, nowMs: 1 }).decision).toBe(
      'run',
    );
    expect(decidePause({ state: 'backoff', self: self('mid'), jobs, nowMs: 1 }).decision).toBe(
      'pause',
    );
    expect(decidePause({ state: 'backoff', self: self('solo'), jobs: [], nowMs: 1 }).decision).toBe(
      'run',
    );
  });

  it('the starvation cap gives a real run window, then the job can pause again', () => {
    let pausedAtMs: number | null = 0;
    let capResumedAtMs: number | null = null;
    const at = (nowMs: number) =>
      decidePause({ state: 'backoff', self: self('new'), jobs, nowMs, pausedAtMs, capResumedAtMs });

    expect(at(MAX_PAUSE_MS - 1).decision).toBe('pause');
    const cap = at(MAX_PAUSE_MS);
    expect(cap).toEqual({ decision: 'run', reason: 'cap' });
    // The runner records the resume the way runGoverned does.
    pausedAtMs = null;
    capResumedAtMs = MAX_PAUSE_MS;
    // Every 5 s poll inside the window keeps it running.
    for (let t = MAX_PAUSE_MS + 5_000; t < MAX_PAUSE_MS + CAP_RUN_WINDOW_MS; t += 5_000) {
      expect(at(t), `t=${t}`).toEqual({ decision: 'run', reason: 'run-window' });
    }
    expect(at(MAX_PAUSE_MS + CAP_RUN_WINDOW_MS).decision).toBe('pause');
  });
});

describe('buildRunDeferral / runningEntries', () => {
  const pressure = {
    state: 'hold' as const,
    score: 15,
    reason: 'kernel warning',
    memAvailableBytes: 1,
  };

  it('lists cleo run jobs and verify slots together, oldest first', () => {
    const entries = runningEntries(
      [job({ id: 'r', startedAtMs: 20, command: 'npx vitest run' })],
      [{ tool: 'test', pid: 9, acquiredAtMs: 10 }],
    );
    expect(entries.map((e) => [e.source, e.class, e.command])).toEqual([
      ['verify', 'tool:test', 'cleo verify (test)'],
      ['run', 'test-run', 'npx vitest run'],
    ]);
  });

  it('offers CI, a narrower run, retry and the FIFO queue for tests', () => {
    const { details, alternatives, fix } = buildRunDeferral({
      cls: 'test-run',
      argv: ['npx', 'vitest', 'run', 'a b.test.ts'],
      reason: 'no slot free',
      retryAfterMs: 2000,
      queuePosition: 3,
      pressure,
      running: [],
    });
    expect(details.queuePosition).toBe(3);
    const commands = alternatives.map((a) => a.command);
    expect(commands[0]).toContain('ci:<pr>');
    expect(commands).toContain("cleo run --wait --timeout 1800 -- npx vitest run 'a b.test.ts'");
    expect(fix).toContain('nothing was started');
  });

  it('suggests narrowing the build for build classes', () => {
    const { alternatives } = buildRunDeferral({
      cls: 'scoped-build',
      argv: ['pnpm', 'build'],
      reason: 'r',
      retryAfterMs: 1,
      pressure,
      running: [],
    });
    expect(alternatives[0]?.command).toContain('--filter');
    expect(alternatives.some((a) => a.command.includes('ci:'))).toBe(false);
  });
});
