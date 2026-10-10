/**
 * Machine-wide heavy-run admission for evidence runs (T12963, T13127, T13133).
 *
 * - Evidence runs and `cleo run` jobs share ONE ledger: a governor-class
 *   admission (what `cleo run` takes) and an evidence run wait for each other,
 *   with no second slot taken in a second order (the T13133 inversion).
 * - There is no darwin one-slot rule: the budget is bytes on every platform.
 * - A run nested in an admitted run's process tree rides its admission: a
 *   `cleo verify` under `cleo run` never waits for the budget its ancestor
 *   holds.
 * - Under memory pressure a run waits, says "waiting: memory pressure" with
 *   the readings, and starts when it falls; lint is never refused by the gate
 *   except through the budget it shares; a 1 ms probe still gets a free share.
 *
 * @task T12963
 * @task T13127
 * @task T13133
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMISSION_ENV,
  admissionCapacityBytes,
  admit,
  GIB,
  readLedger,
} from '../../resources/admission-ledger.js';
import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor } from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import { systemPidProbe } from '../../resources/slot-holder.js';
import { _resetToolSemaphoreForTest, acquireGlobalSlot } from '../tool-semaphore.js';

const MACHINE = { totalRamGib: 48, pollMs: 5 } as const;

function sampleAt(memSome: number): ResourceSample {
  const line = { avg10: memSome, avg60: memSome, avg300: memSome, totalUs: 0 };
  return {
    sampledAtMs: 1,
    pressureAvailable: true,
    memAvailableBytes: 32 * GIB,
    globalPressure: { some: line, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
    slicePressure: null,
    walObservations: [],
  };
}

/** Live samples follow a script of memory `some avg10` values (then stay on the last). */
function scriptPressure(series: readonly number[]): () => number {
  let n = 0;
  vi.spyOn(ResourceMonitor.prototype, 'sample').mockImplementation(async () =>
    sampleAt(series[Math.min(n++, series.length - 1)] ?? 0),
  );
  return () => n;
}

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-home-admission-'));
  process.env.CLEO_HOME = home;
  delete process.env.CLEO_RESOURCES_MODE;
  // These tests script the live sampler (ResourceMonitor), so it must be used.
  delete process.env.CLEO_ADMISSION_PRESSURE;
  delete process.env[ADMISSION_ENV];
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
  _resetGovernorStateForTest();
  _resetToolSemaphoreForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['CLEO_HOME', 'CLEO_RESOURCES_MODE', 'CLEO_ADMISSION_PRESSURE', ADMISSION_ENV]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
  _resetGovernorStateForTest();
});

describe('one ledger for evidence runs and governor classes (T13133)', () => {
  it('a cleo run admission (governor class) and an evidence run wait for each other', async () => {
    scriptPressure([0]);
    // Two heavy runs fill the budget (each plans half of it, T13132).
    const job = await governor.acquire('test-run', { totalMemBytes: 48 * GIB, blocking: false });
    const job2 = await governor.acquire('scoped-build', {
      totalMemBytes: 48 * GIB,
      blocking: false,
    });
    expect(job.deferred).toBe(false);
    expect(job2.deferred).toBe(false);
    try {
      await expect(acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 60 })).rejects.toThrow(
        /class:test-run pid \d+/,
      );
    } finally {
      if (!job.deferred) await job.release();
      if (!job2.deferred) await job2.release();
    }
    const release = await acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 1_000 });
    const release2 = await acquireGlobalSlot('build', { ...MACHINE, timeoutMs: 1_000 });
    const blocked = await governor.acquire('scoped-build', {
      totalMemBytes: 48 * GIB,
      blocking: false,
    });
    expect(blocked.deferred).toBe(true);
    await release();
    await release2();
  });

  it('no darwin one-slot rule: a machine with room admits two heavy runs', async () => {
    scriptPressure([0]);
    const a = await acquireGlobalSlot('test', { totalRamGib: 256, pollMs: 5 });
    const b = await acquireGlobalSlot('build', { totalRamGib: 256, pollMs: 5, timeoutMs: 1_000 });
    expect(readLedger().filter((e) => e.state === 'admitted')).toHaveLength(2);
    await a();
    await b();
  });

  it('T13237: an evidence build takes the machine-wide full-build slot; a second one waits', async () => {
    scriptPressure([0]);
    const a = await acquireGlobalSlot('build', { totalRamGib: 256, pollMs: 5 });
    expect(readLedger().find((e) => e.state === 'admitted')?.exclusive).toBe(true);
    await expect(
      acquireGlobalSlot('build', { totalRamGib: 256, pollMs: 5, timeoutMs: 200 }),
    ).rejects.toThrow(/full-build slot/);
    await a();
  });
});

describe('a run nested in an admitted run rides it (T13133)', () => {
  it("an evidence run under our parent's admission is admitted at once, with no entry of its own", async () => {
    scriptPressure([0]);
    // Our parent process holds the whole budget (as a cleo run job would).
    const parentStart = systemPidProbe.startedAt(process.ppid);
    const outer = await admit(
      { label: 'run:test-run', footprintBytes: 99 * GIB, command: 'cleo run -- cleo verify' },
      {
        wait: false,
        pid: process.ppid,
        capacityBytes: admissionCapacityBytes(48 * GIB),
        facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => parentStart },
        env: {},
      },
    );
    if (!outer.admitted) throw new Error('expected the planted holder to be admitted');
    process.env[ADMISSION_ENV] = outer.grant.token;
    const release = await acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 1_000 });
    expect(release.admission).toBe(outer.grant.token);
    expect(readLedger()).toHaveLength(1);
    await release();
  });

  it('a forged token (not a descendant of its holder) grants nothing', async () => {
    scriptPressure([0]);
    const outer = await admit(
      { label: 'run:test-run', footprintBytes: 99 * GIB },
      {
        wait: false,
        pid: 4_000_003,
        capacityBytes: admissionCapacityBytes(48 * GIB),
        facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => null },
        env: {},
        probe: { liveness: () => 'alive', startedAt: () => null, groupLiveness: () => 'gone' },
      },
    );
    if (!outer.admitted) throw new Error('expected the planted holder to be admitted');
    process.env[ADMISSION_ENV] = outer.grant.token;
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
      return true; // every holder alive: the planted one keeps the budget
    });
    await expect(acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 60 })).rejects.toThrow(
      /Timed out/,
    );
  });
});

describe('evidence runs wait out memory pressure (T13127)', () => {
  it('a test run waits, saying so with the readings, and starts when pressure falls', async () => {
    scriptPressure([40, 40, 30, 20, 10]);
    const lines: string[] = [];
    const release = await acquireGlobalSlot('test', {
      ...MACHINE,
      timeoutMs: 20_000,
      notice: (l) => lines.push(l),
    });
    await release();
    expect(lines[0]).toMatch(
      /^waiting: memory pressure 40 \(refused above 25, resumes at 15 or below\): /,
    );
    expect(lines[0]).toContain("The 'test' run starts when pressure falls");
    expect(lines.at(-1)).toMatch(
      /^memory pressure fell after waiting \d+s: admitting the 'test' run\.$/,
    );
  }, 30_000);

  it('a test run under lasting pressure gives up with the readings, holding nothing', async () => {
    scriptPressure([50]);
    await expect(
      acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 80, notice: () => {} }),
    ).rejects.toThrow(
      /admission of a 'test' run: memory pressure 50 \(refused above 25, resumes at 15 or below\): memory PSI some avg10 50\.0%/,
    );
    expect(readLedger()).toEqual([]);
  });

  it('typecheck and lint are refused by the gate as well: everything in the ledger is heavy work', async () => {
    scriptPressure([50]);
    await expect(
      acquireGlobalSlot('typecheck', { ...MACHINE, timeoutMs: 60, notice: () => {} }),
    ).rejects.toThrow(/memory pressure 50/);
  });

  it('a 1 ms probe still takes a free share after a slow sample (listVitestProjects)', async () => {
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return sampleAt(0);
    });
    const release = await acquireGlobalSlot('test', {
      ...MACHINE,
      footprintBytes: GIB,
      timeoutMs: 1,
      pollMs: 1,
      notice: () => {},
    });
    await release();
  });
});
