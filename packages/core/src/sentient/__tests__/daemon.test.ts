/**
 * Tests for the sentient Tier-1 daemon — state, lock, and tick behaviour.
 *
 * Covers:
 *   - State file read/write/patch + stats increments
 *   - Advisory lock: first acquire succeeds, second is rejected while alive,
 *     stale lockfiles are reclaimed
 *   - Kill switch aborts tick at every checkpoint
 *   - State transitions: picked → spawning → completed
 *   - Retry backoff + stuck detection after MAX_TASK_ATTEMPTS
 *   - Self-pause when stuck-rate ≥ SELF_PAUSE_STUCK_THRESHOLD
 *   - Resume + getSentientDaemonStatus snapshots
 *
 * Uses real temp directories (mkdtemp). Subprocess spawns are replaced by an
 * injected `spawn` fake so we never fork the real CLI.
 *
 * @task T946
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  getSentientDaemonStatus,
  releaseLock,
  resumeSentientDaemon,
  SENTIENT_STATE_FILE,
  stopSentientDaemon,
} from '../daemon.js';
import {
  DEFAULT_SENTIENT_STATE,
  incrementStats,
  patchSentientState,
  readSentientState,
  writeSentientState,
} from '../state.js';
import {
  MAX_TASK_ATTEMPTS,
  RETRY_BACKOFF_MS,
  runTick,
  SELF_PAUSE_REASON,
  SELF_PAUSE_STUCK_THRESHOLD,
  type SpawnResult,
  safeRunTick,
  type TickOptions,
} from '../tick.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function mkTickOptions(projectRoot: string, overrides: Partial<TickOptions> = {}): TickOptions {
  return {
    projectRoot,
    statePath: join(projectRoot, SENTIENT_STATE_FILE),
    pickTask: async () => null,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

describe('sentient state', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-state-'));
    statePath = join(root, SENTIENT_STATE_FILE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns default state when file missing', async () => {
    const s = await readSentientState(statePath);
    expect(s).toEqual(DEFAULT_SENTIENT_STATE);
  });

  it('writes and reads state atomically', async () => {
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      pid: 1234,
      killSwitch: true,
      killSwitchReason: 'test',
    });
    const s = await readSentientState(statePath);
    expect(s.pid).toBe(1234);
    expect(s.killSwitch).toBe(true);
    expect(s.killSwitchReason).toBe('test');
  });

  it('patchSentientState merges nested stats without clobbering', async () => {
    await patchSentientState(statePath, {
      stats: {
        tasksPicked: 3,
        tasksCompleted: 0,
        tasksFailed: 0,
        ticksExecuted: 0,
        ticksKilled: 0,
      },
    });
    await patchSentientState(statePath, {
      stats: { ...(await readSentientState(statePath)).stats, tasksCompleted: 2 },
    });
    const s = await readSentientState(statePath);
    expect(s.stats.tasksPicked).toBe(3);
    expect(s.stats.tasksCompleted).toBe(2);
  });

  it('incrementStats is monotonic across calls', async () => {
    await incrementStats(statePath, { tasksPicked: 1 });
    await incrementStats(statePath, { tasksPicked: 2, tasksCompleted: 1 });
    const s = await readSentientState(statePath);
    expect(s.stats.tasksPicked).toBe(3);
    expect(s.stats.tasksCompleted).toBe(1);
  });

  it('malformed JSON falls back to defaults', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.cleo'), { recursive: true });
    await writeFile(statePath, '{{{ not json', 'utf-8');
    const s = await readSentientState(statePath);
    expect(s).toEqual(DEFAULT_SENTIENT_STATE);
  });
});

describe('sentient advisory lock', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-lock-'));
    lockPath = join(root, '.cleo', 'sentient.lock');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first acquire succeeds', async () => {
    const h = await acquireLock(lockPath);
    expect(h).not.toBeNull();
    const body = await readFile(lockPath, 'utf-8');
    expect(Number.parseInt(body, 10)).toBe(process.pid);
    if (h) await releaseLock(h);
  });

  it('second acquire is rejected while the first is live', async () => {
    const first = await acquireLock(lockPath);
    expect(first).not.toBeNull();
    // Simulate another process by writing a different live pid into the file
    // AFTER we have the lock, then attempt re-acquisition. Since our process
    // is alive, acquireLock must refuse.
    if (first) {
      // Already holds pid = our own process. Re-acquire should return null
      // because our pid is alive.
      const second = await acquireLock(lockPath);
      expect(second).toBeNull();
      await releaseLock(first);
    }
  });

  it('stale lockfile (dead pid) is reclaimed', async () => {
    // Pick a pid that is very unlikely to be live — PID 999999 is typically
    // beyond the kernel's max pid. If it happens to be live, the test will
    // see acquireLock return null; allow both outcomes (this is defensive).
    const deadPid = '999999';
    await writeFile(join(root, '.cleo', 'sentient.lock'), deadPid, 'utf-8').catch(async () => {
      // ensure the directory exists first
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, '.cleo'), { recursive: true });
      await writeFile(join(root, '.cleo', 'sentient.lock'), deadPid, 'utf-8');
    });

    const h = await acquireLock(lockPath);
    if (h === null) {
      // Pid 999999 happens to be live on this system — acceptable.
      return;
    }
    const body = await readFile(lockPath, 'utf-8');
    expect(Number.parseInt(body, 10)).toBe(process.pid);
    await releaseLock(h);
  });
});

describe('sentient tick — kill switch', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-tick-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    // Seed an empty state so patch calls work.
    await writeSentientState(statePath, DEFAULT_SENTIENT_STATE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('aborts immediately when killSwitch is true at tick start', async () => {
    await patchSentientState(statePath, { killSwitch: true });
    const picked: string[] = [];
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => {
          picked.push('called');
          return makeTask('T001');
        },
      }),
    );
    expect(outcome.kind).toBe('killed');
    expect(picked).toHaveLength(0); // picker must not be called
    const s = await readSentientState(statePath);
    expect(s.stats.ticksKilled).toBe(1);
  });

  it('aborts after picking when killSwitch flipped mid-tick', async () => {
    const spawned: string[] = [];
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => {
          // Flip killSwitch between pick and spawn
          await patchSentientState(statePath, { killSwitch: true });
          return makeTask('T002');
        },
        spawn: async (taskId) => {
          spawned.push(taskId);
          return { exitCode: 0, stdout: '', stderr: '' } satisfies SpawnResult;
        },
      }),
    );
    expect(outcome.kind).toBe('killed');
    expect(outcome.taskId).toBe('T002');
    expect(spawned).toHaveLength(0); // spawn must not run
  });

  it('aborts after spawn when killSwitch flipped before recording', async () => {
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T003'),
        spawn: async () => {
          await patchSentientState(statePath, { killSwitch: true });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    );
    expect(outcome.kind).toBe('killed');
    expect(outcome.taskId).toBe('T003');
    // Stats: tasksPicked increments (we marked it active), but NOT completed
    const s = await readSentientState(statePath);
    expect(s.stats.tasksCompleted).toBe(0);
    expect(s.stats.tasksPicked).toBe(1);
  });
});

describe('sentient tick — state transitions', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-transitions-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, DEFAULT_SENTIENT_STATE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('no-task outcome when picker returns null', async () => {
    const outcome = await runTick(mkTickOptions(root));
    expect(outcome.kind).toBe('no-task');
    const s = await readSentientState(statePath);
    expect(s.stats.ticksExecuted).toBe(1);
    expect(s.stats.tasksPicked).toBe(0);
  });

  it('success: picked → spawn=0 → tasksCompleted increments + receipt cleared', async () => {
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T100'),
        spawn: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
      }),
    );
    expect(outcome.kind).toBe('success');
    expect(outcome.taskId).toBe('T100');
    const s = await readSentientState(statePath);
    expect(s.stats.tasksPicked).toBe(1);
    expect(s.stats.tasksCompleted).toBe(1);
    expect(s.stats.tasksFailed).toBe(0);
    expect(s.activeTaskId).toBeNull(); // cleared after success
    expect(s.stuckTasks['T100']).toBeUndefined();
  });

  it('failure: spawn exit != 0 schedules backoff for attempt 1', async () => {
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T200'),
        spawn: async () => ({ exitCode: 7, stdout: '', stderr: 'boom' }),
      }),
    );
    expect(outcome.kind).toBe('failure');
    const s = await readSentientState(statePath);
    expect(s.stats.tasksFailed).toBe(1);
    expect(s.stuckTasks['T200']).toBeDefined();
    expect(s.stuckTasks['T200'].attempts).toBe(1);
    expect(s.stuckTasks['T200'].nextRetryAt).toBeGreaterThan(Date.now());
    expect(s.stuckTasks['T200'].nextRetryAt).toBeLessThan(Date.now() + RETRY_BACKOFF_MS[0] + 1_000);
  });

  it('backoff: task in nextRetryAt window is skipped', async () => {
    // Seed a stuck record with a future retry time
    await patchSentientState(statePath, {
      stuckTasks: {
        T300: {
          attempts: 1,
          lastFailureAt: new Date().toISOString(),
          nextRetryAt: Date.now() + 60_000,
          lastReason: 'earlier',
        },
      },
    });
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T300'),
        spawn: async () => {
          throw new Error('spawn must not be called during backoff');
        },
      }),
    );
    expect(outcome.kind).toBe('backoff');
    expect(outcome.taskId).toBe('T300');
  });
});

describe('sentient tick — stuck + self-pause', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-stuck-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, DEFAULT_SENTIENT_STATE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(`stuck: MAX_TASK_ATTEMPTS (${MAX_TASK_ATTEMPTS}) failures marks task stuck`, async () => {
    // Seed a record at attempts = MAX - 1 so next failure triggers stuck.
    const priorAttempts = MAX_TASK_ATTEMPTS - 1;
    await patchSentientState(statePath, {
      stuckTasks: {
        T400: {
          attempts: priorAttempts,
          lastFailureAt: new Date().toISOString(),
          nextRetryAt: 0, // eligible immediately
          lastReason: 'prior',
        },
      },
    });
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T400'),
        spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'still failing' }),
      }),
    );
    expect(outcome.kind).toBe('stuck');
    const s = await readSentientState(statePath);
    expect(s.stuckTasks['T400'].attempts).toBe(MAX_TASK_ATTEMPTS);
    expect(s.stuckTasks['T400'].nextRetryAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('self-pause when stuck-rate crosses SELF_PAUSE_STUCK_THRESHOLD', async () => {
    // Pre-populate the rolling stuck-timestamp window with THRESHOLD-1 entries
    // so the next stuck trips self-pause.
    const now = Date.now();
    const priorStucks: number[] = [];
    for (let i = 0; i < SELF_PAUSE_STUCK_THRESHOLD - 1; i++) {
      priorStucks.push(now - 1000 - i * 100);
    }
    await patchSentientState(statePath, {
      stuckTimestamps: priorStucks,
      stuckTasks: {
        T500: {
          attempts: MAX_TASK_ATTEMPTS - 1,
          lastFailureAt: new Date().toISOString(),
          nextRetryAt: 0,
          lastReason: 'prior',
        },
      },
    });
    const outcome = await runTick(
      mkTickOptions(root, {
        pickTask: async () => makeTask('T500'),
        spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'still failing' }),
      }),
    );
    expect(outcome.kind).toBe('self-paused');
    const s = await readSentientState(statePath);
    expect(s.killSwitch).toBe(true);
    expect(s.killSwitchReason).toBe(SELF_PAUSE_REASON);
  });
});

describe('sentient daemon — status + resume', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-sentient-daemon-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('getSentientDaemonStatus reports stopped when no pid recorded', async () => {
    const status = await getSentientDaemonStatus(root);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.killSwitch).toBe(false);
  });

  it('stopSentientDaemon flips killSwitch even when no pid recorded', async () => {
    const result = await stopSentientDaemon(root, 'test stop');
    expect(result.stopped).toBe(false);
    expect(result.pid).toBeNull();
    const s = await readSentientState(join(root, SENTIENT_STATE_FILE));
    expect(s.killSwitch).toBe(true);
    expect(s.killSwitchReason).toBe('test stop');
  });

  it('resumeSentientDaemon clears killSwitch', async () => {
    await patchSentientState(join(root, SENTIENT_STATE_FILE), {
      killSwitch: true,
      killSwitchReason: 'test',
    });
    const after = await resumeSentientDaemon(root);
    expect(after.killSwitch).toBe(false);
    expect(after.killSwitchReason).toBeNull();
  });

  it('safeRunTick swallows picker exceptions into error outcome', async () => {
    const outcome = await safeRunTick({
      projectRoot: root,
      statePath: join(root, SENTIENT_STATE_FILE),
      pickTask: async () => {
        throw new Error('simulated picker failure');
      },
    });
    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toContain('simulated picker failure');
  });
});
