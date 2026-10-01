/**
 * Tests for `cleo run` admission (T12979, T12980).
 *
 * Coverage:
 *   - resolveRunClass: explicit aliases, unknown class, inference
 *   - looksHeavy: hook-side detection
 *   - redactCommand: secrets masked, truncation
 *   - job registry: register/list/remove, dead-process pruning, torn files
 *   - decidePause: below backoff runs; oldest runs; younger pauses; starvation cap
 *   - buildRunDeferral: details shape and alternatives
 *
 * @task T12979
 * @task T12980
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRunDeferral,
  decidePause,
  listRunJobs,
  looksHeavy,
  MAX_PAUSE_MS,
  type RunJob,
  redactCommand,
  registerRunJob,
  removeRunJob,
  resolveRunClass,
} from '../run-admission.js';

describe('resolveRunClass', () => {
  it('honours explicit aliases', () => {
    expect(resolveRunClass('test', ['anything'])).toBe('test-run');
    expect(resolveRunClass('typecheck', ['npx', 'vitest'])).toBe('scoped-build');
    expect(resolveRunClass('full-build', ['pnpm', 'build'])).toBe('full-build');
    expect(resolveRunClass('db', ['x'])).toBe('db-heavy');
  });

  it('rejects an unknown class', () => {
    expect(() => resolveRunClass('everything', ['x'])).toThrow(/unknown --class/);
  });

  it('infers test runs', () => {
    expect(resolveRunClass(undefined, ['npx', 'vitest', 'run', 'a.test.ts'])).toBe('test-run');
    expect(resolveRunClass(undefined, ['./node_modules/.bin/jest'])).toBe('test-run');
    expect(resolveRunClass(undefined, ['pnpm', 'test'])).toBe('test-run');
    expect(resolveRunClass(undefined, ['npm', 'run', 'test:unit'])).toBe('test-run');
    expect(resolveRunClass(undefined, ['pnpm', '--filter', '@x/api', 'test'])).toBe('test-run');
    expect(resolveRunClass(undefined, ['cargo', 'test'])).toBe('test-run');
  });

  it('defaults everything else to scoped-build', () => {
    expect(resolveRunClass(undefined, ['npx', 'tsc', '-b'])).toBe('scoped-build');
    expect(resolveRunClass(undefined, ['pnpm', 'install'])).toBe('scoped-build');
    expect(resolveRunClass(undefined, ['pnpm', 'run', 'latest-tests-report'])).toBe('scoped-build');
  });
});

describe('looksHeavy', () => {
  it('flags runners, compilers, builds and installs', () => {
    expect(looksHeavy(['npx', 'vitest', 'run'])).toBe(true);
    expect(looksHeavy(['npx', 'tsc', '-b'])).toBe(true);
    expect(looksHeavy(['pnpm', 'install'])).toBe(true);
    expect(looksHeavy(['npm', 'ci'])).toBe(true);
    expect(looksHeavy(['pnpm', 'build'])).toBe(true);
    expect(looksHeavy(['cargo', 'build'])).toBe(true);
  });

  it('leaves light commands alone', () => {
    expect(looksHeavy(['git', 'status'])).toBe(false);
    expect(looksHeavy(['ls', '-la'])).toBe(false);
    expect(looksHeavy(['pnpm', 'list'])).toBe(false);
    expect(looksHeavy(['cleo', 'show', 'T1'])).toBe(false);
  });
});

describe('redactCommand', () => {
  it('masks secret-looking assignments', () => {
    const line = redactCommand([
      'env',
      'API_TOKEN=abc123',
      'DB_PASSWORD=hunter2',
      'MODE=fast',
      'run',
    ]);
    expect(line).toBe('env API_TOKEN=*** DB_PASSWORD=*** MODE=fast run');
  });

  it('truncates long command lines', () => {
    const line = redactCommand(['x'.repeat(400)]);
    expect(line.length).toBe(160);
    expect(line.endsWith('...')).toBe(true);
  });
});

describe('job registry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-run-jobs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    class: 'test-run' as const,
    command: 'npx vitest run',
    cwd: '/repo',
    sessionId: null,
  };

  it('registers, lists oldest first, and removes', () => {
    const b = registerRunJob({ ...base, pid: 200, startedAtMs: 2000 }, dir);
    const a = registerRunJob({ ...base, pid: 100, startedAtMs: 1000 }, dir);
    const jobs = listRunJobs(dir, () => true);
    expect(jobs.map((j) => j.id)).toEqual([a.id, b.id]);
    removeRunJob(a.id, dir);
    expect(listRunJobs(dir, () => true).map((j) => j.id)).toEqual([b.id]);
  });

  it('prunes records whose runner process is gone', () => {
    registerRunJob({ ...base, pid: 100, startedAtMs: 1000 }, dir);
    const live = registerRunJob({ ...base, pid: 200, startedAtMs: 2000 }, dir);
    expect(listRunJobs(dir, (pid) => pid === 200).map((j) => j.id)).toEqual([live.id]);
    // The dead record is deleted, not just filtered.
    expect(listRunJobs(dir, () => true).map((j) => j.id)).toEqual([live.id]);
  });

  it('skips torn or junk files and survives a missing directory', () => {
    writeFileSync(join(dir, 'junk.json'), '{not json');
    registerRunJob({ ...base, pid: 1, startedAtMs: 1 }, dir);
    expect(listRunJobs(dir, () => true)).toHaveLength(1);
    expect(listRunJobs(join(dir, 'nope'), () => true)).toEqual([]);
  });

  it('really detects the current process as alive', () => {
    registerRunJob({ ...base, pid: process.pid, startedAtMs: 1 }, dir);
    expect(listRunJobs(dir)).toHaveLength(1);
  });
});

function job(id: string, startedAtMs: number): RunJob {
  return {
    id,
    pid: startedAtMs,
    childPid: null,
    class: 'test-run',
    command: 'x',
    cwd: '/',
    startedAtMs,
    sessionId: null,
    pausedAtMs: null,
  };
}

describe('decidePause', () => {
  const jobs = [job('old', 1), job('mid', 2), job('new', 3)];

  it('never pauses below backoff', () => {
    expect(decidePause({ state: 'ok', selfId: 'new', jobs, nowMs: 10 })).toBe('run');
    expect(decidePause({ state: 'hold', selfId: 'new', jobs, nowMs: 10 })).toBe('run');
  });

  it('at backoff the oldest runs and younger jobs pause', () => {
    expect(decidePause({ state: 'backoff', selfId: 'old', jobs, nowMs: 10 })).toBe('run');
    expect(decidePause({ state: 'backoff', selfId: 'mid', jobs, nowMs: 10 })).toBe('pause');
    expect(decidePause({ state: 'backoff', selfId: 'new', jobs, nowMs: 10 })).toBe('pause');
  });

  it('a lone job always runs', () => {
    expect(decidePause({ state: 'backoff', selfId: 'solo', jobs: [], nowMs: 10 })).toBe('run');
  });

  it('a job paused for the cap resumes even under backoff', () => {
    expect(
      decidePause({
        state: 'backoff',
        selfId: 'new',
        jobs,
        nowMs: MAX_PAUSE_MS + 5,
        pausedAtMs: 5,
      }),
    ).toBe('run');
    expect(
      decidePause({
        state: 'backoff',
        selfId: 'new',
        jobs,
        nowMs: MAX_PAUSE_MS + 4,
        pausedAtMs: 5,
      }),
    ).toBe('pause');
  });
});

describe('buildRunDeferral', () => {
  const pressure = {
    state: 'hold' as const,
    score: 15,
    reason: 'kernel warning',
    memAvailableBytes: 1,
  };

  it('offers CI, a narrower run, retry and --wait for tests', () => {
    const { details, alternatives, fix } = buildRunDeferral({
      cls: 'test-run',
      argv: ['npx', 'vitest', 'run', 'a b.test.ts'],
      reason: 'no slot free',
      retryAfterMs: 2000,
      pressure,
      running: [job('old', 1)],
    });
    expect(details.class).toBe('test-run');
    expect(details.running).toEqual([
      {
        class: 'test-run',
        command: 'x',
        cwd: '/',
        startedAtMs: 1,
        sessionId: null,
        pausedAtMs: null,
      },
    ]);
    const commands = alternatives.map((a) => a.command);
    expect(commands[0]).toContain('ci:<pr>');
    expect(commands).toContain("cleo run --wait -- npx vitest run 'a b.test.ts'");
    expect(fix).toContain('--wait');
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
