/**
 * Governor slots held by a dead process are reaped at once (T12963).
 *
 * proper-lockfile frees a crashed holder's slot only after its 10 min stale
 * timeout. With a one-slot `test-run` budget a SIGKILLed `cleo verify
 * tool:test` blocked every later heavy run for that long, and the deferral
 * named no one. A dead holder is now reaped; a live, remote or unprovable one
 * never is, and a deferral names who holds the slot.
 *
 * A dead holder is planted on disk the way a SIGKILL leaves it: the lock
 * directory plus the holder record. `process.kill` is stubbed for every test:
 * {@link GONE_PID} answers ESRCH, this process answers alive, and the real
 * `process.kill` is never reached.
 *
 * @task T12963
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isResourceGrant } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProcessEntry } from '../../sessions/terminal-identity.js';
import type { ResourceSample } from '../backend.js';
import { _resetGovernorStateForTest, governorSlotDir, ResourceGovernor } from '../governor.js';
import {
  assessGovernorHolder,
  type GovernorSlotHolder,
  type PidProbe,
  readGovernorHolder,
  writeGovernorHolder,
} from '../slot-holder.js';

/** No pressure: `db-heavy` has a budget of exactly one slot. */
const SAMPLE: ResourceSample = {
  sampledAtMs: 1,
  pressureAvailable: true,
  memAvailableBytes: 32 * 1024 ** 3,
  globalPressure: {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
  slicePressure: null,
  walObservations: [],
};

/** A pid the stubbed `process.kill` reports as gone (ESRCH). */
const GONE_PID = 4_000_001;

/** A start time no live process has. */
const WRONG_START = 'Thu Jan 1 00:00:00 1970';

/** Pids the stubbed `process.kill` was asked about, with their signal. */
let killCalls: Array<[number, string | number | undefined]>;

/** Stub `process.kill`: this process is alive, everything else is gone. */
function stubKill(): void {
  killCalls = [];
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
    if (pid === process.pid) return true;
    const err: NodeJS.ErrnoException = new Error('kill ESRCH');
    err.code = 'ESRCH';
    throw err;
  });
}

/** This process's real start time, as the governor records it. */
function ownStart(): string {
  const start = readProcessEntry(process.pid)?.startedAt;
  if (!start) throw new Error('ps could not read this process start time');
  return start;
}

/**
 * Plant a held `db-heavy` slot 0 with the given holder, as a crash leaves it.
 * `staleLock` ages the lock past the window a live holder's refresh timer
 * keeps it in, but short of proper-lockfile's own 10 min stale recovery. The
 * record is written after aging: APFS moves birthtime back with an older
 * mtime, which changes the lock identity the record carries.
 */
function plantHeldSlot(
  holder: Partial<Omit<GovernorSlotHolder, 'lockId'>> = {},
  staleLock = false,
): string {
  const dir = governorSlotDir('db-heavy');
  mkdirSync(dir, { recursive: true });
  const slot = join(dir, 'slot-0.lock');
  mkdirSync(`${slot}.lock`);
  if (staleLock) {
    const old = new Date(Date.now() - 7 * 60_000);
    utimesSync(`${slot}.lock`, old, old);
  }
  writeGovernorHolder(slot, {
    pid: process.pid,
    startedAt: null,
    host: hostname(),
    cls: 'db-heavy',
    acquiredAtMs: Date.now(),
    ...holder,
  });
  return slot;
}

let home: string;
const savedHome = process.env.CLEO_HOME;
const gov = new ResourceGovernor();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-governor-reap-'));
  process.env.CLEO_HOME = home;
  delete process.env.CLEO_RESOURCES_MODE;
  _resetGovernorStateForTest();
  stubKill();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  _resetGovernorStateForTest();
});

describe('reaping dead governor holders (T12963)', () => {
  it('takes a slot whose holder process is gone without waiting for the stale timeout', async () => {
    plantHeldSlot({ pid: GONE_PID });
    const started = Date.now();
    const r = await gov.acquire('db-heavy', { sample: SAMPLE, timeoutMs: 5_000, pollMs: 20 });
    expect(isResourceGrant(r)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(killCalls).toContainEqual([GONE_PID, 0]);
    if (isResourceGrant(r)) await r.release();
  });

  it('reaps on a non-blocking acquire too, and records the new holder with its start time', async () => {
    const slot = plantHeldSlot({ pid: GONE_PID });
    const r = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
    expect(isResourceGrant(r)).toBe(true);
    const mine = readGovernorHolder(slot);
    expect(mine?.pid).toBe(process.pid);
    expect(mine?.startedAt).toBe(ownStart());
    if (isResourceGrant(r)) await r.release();
    expect(readGovernorHolder(slot)).toBeNull();
  });

  it('reaps a recycled pid: alive, but with a different start time than the record', async () => {
    const slot = plantHeldSlot({ startedAt: WRONG_START }, true);
    const r = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
    expect(isResourceGrant(r)).toBe(true);
    // The recycled record was replaced by this grant's own.
    expect(readGovernorHolder(slot)?.startedAt).toBe(ownStart());
    if (isResourceGrant(r)) await r.release();
  });

  it('available() does not count a slot held by a dead process', async () => {
    plantHeldSlot({ pid: GONE_PID });
    expect(await gov.available('db-heavy', { sample: SAMPLE })).toBe(1);
  });
});

describe('live and unprovable holders keep their slot (T12963)', () => {
  it('never reaps a live holder, and the timeout names it', async () => {
    plantHeldSlot({ startedAt: ownStart() });
    const r = await gov.acquire('db-heavy', { sample: SAMPLE, timeoutMs: 150, pollMs: 20 });
    expect(isResourceGrant(r)).toBe(false);
    if (!isResourceGrant(r)) {
      expect(r.reason).toContain('timed out after 150ms');
      expect(r.reason).toContain(`slot-0.lock: pid ${process.pid} on ${hostname()}`);
      expect(r.reason).toContain('(alive)');
    }
  });

  it('keeps a live holder whose lock refresh has lagged when its start time matches', async () => {
    plantHeldSlot({ startedAt: ownStart() }, true);
    const r = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
    expect(isResourceGrant(r)).toBe(false);
  });

  it('a non-blocking deferral names the holder', async () => {
    const first = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
    expect(isResourceGrant(first)).toBe(true);
    try {
      const second = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
      expect(isResourceGrant(second)).toBe(false);
      if (!isResourceGrant(second)) expect(second.reason).toContain(`pid ${process.pid}`);
    } finally {
      if (isResourceGrant(first)) await first.release();
    }
  });

  it("keeps a slot whose dead holder is another host's pid", async () => {
    plantHeldSlot({ pid: GONE_PID, host: 'some-other-host' });
    const r = await gov.tryAcquire('db-heavy', { sample: SAMPLE });
    expect(isResourceGrant(r)).toBe(false);
    expect(killCalls.some(([pid]) => pid === GONE_PID)).toBe(false);
  });
});

describe('assessGovernorHolder (T12963)', () => {
  const probe = (p: Partial<PidProbe>): PidProbe => ({
    liveness: () => 'alive',
    startedAt: () => null,
    ...p,
  });

  it('a gone pid is dead', () => {
    const slot = plantHeldSlot();
    expect(
      assessGovernorHolder(readGovernorHolder(slot), slot, probe({ liveness: () => 'gone' })),
    ).toBe('dead');
  });

  it('a failed liveness probe is unknown, never dead', () => {
    const slot = plantHeldSlot();
    expect(
      assessGovernorHolder(readGovernorHolder(slot), slot, probe({ liveness: () => 'unknown' })),
    ).toBe('unknown');
  });

  it('an alive pid whose start time cannot be read now is unknown, never dead', () => {
    const slot = plantHeldSlot({ startedAt: WRONG_START }, true);
    expect(assessGovernorHolder(readGovernorHolder(slot), slot, probe({}))).toBe('unknown');
  });

  it('an alive pid whose start time was never recorded stays alive', () => {
    const slot = plantHeldSlot({ startedAt: null }, true);
    const asked = probe({ startedAt: () => WRONG_START });
    expect(assessGovernorHolder(readGovernorHolder(slot), slot, asked)).toBe('alive');
  });

  it('an alive pid with a different start time is a recycled pid; the same start is alive', () => {
    const slot = plantHeldSlot({ startedAt: 'Sat Sep 27 22:07:02 2026' }, true);
    const holder = readGovernorHolder(slot);
    const other = probe({ startedAt: () => 'Wed Oct 1 09:00:00 2026' });
    const same = probe({ startedAt: () => 'Sat Sep 27 22:07:02 2026' });
    expect(assessGovernorHolder(holder, slot, other)).toBe('dead');
    expect(assessGovernorHolder(holder, slot, same)).toBe('alive');
  });

  it('does not ask for the start time while the lock is being refreshed', () => {
    const slot = plantHeldSlot({ startedAt: WRONG_START });
    let asked = false;
    const watching = probe({
      startedAt: () => {
        asked = true;
        return 'Wed Oct 1 09:00:00 2026';
      },
    });
    expect(assessGovernorHolder(readGovernorHolder(slot), slot, watching)).toBe('alive');
    expect(asked).toBe(false);
  });

  it('a record that does not describe the current lock is unknown', () => {
    const slot = plantHeldSlot();
    const holder = readGovernorHolder(slot);
    if (!holder) throw new Error('holder record missing');
    const gone = probe({ liveness: () => 'gone' });
    expect(assessGovernorHolder({ ...holder, lockId: '1:0' }, slot, gone)).toBe('unknown');
    expect(assessGovernorHolder({ ...holder, lockId: null }, slot, gone)).toBe('unknown');
  });

  it('no record, or a pid of 1 or below, is unknown and never probed', () => {
    const slot = plantHeldSlot();
    let probed = false;
    const gone = probe({
      liveness: () => {
        probed = true;
        return 'gone';
      },
    });
    const holder = readGovernorHolder(slot);
    if (!holder) throw new Error('holder record missing');
    expect(assessGovernorHolder(null, slot, gone)).toBe('unknown');
    for (const pid of [1, 0, -1]) {
      expect(assessGovernorHolder({ ...holder, pid }, slot, gone)).toBe('unknown');
    }
    expect(probed).toBe(false);
  });

  it('readGovernorHolder rejects a record whose pid is 1 or below', () => {
    const slot = plantHeldSlot({ pid: 1 });
    expect(readGovernorHolder(slot)).toBeNull();
  });
});
