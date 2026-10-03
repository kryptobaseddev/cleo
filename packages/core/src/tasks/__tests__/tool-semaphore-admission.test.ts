/**
 * Machine-wide heavy-run admission (T12963).
 *
 * - On darwin (no PSI) `test`/`build` default to ONE slot machine-wide.
 * - A heavy tool slot also takes a slot of the governor class (`test` →
 *   `test-run`, `build` → `scoped-build`), released with the tool slot.
 * - `CLEO_TOOL_CONCURRENCY_*` overrides still decide the count and skip the
 *   governor, whose budget would otherwise cap them.
 * - A SIGKILLed run leaves both slots held by a dead pid; the next run reaps
 *   both instead of waiting out the governor's 10 min stale timeout.
 * - Under memory pressure a test, build or typecheck evidence run waits, says
 *   "waiting: memory pressure" with the readings, and starts when it falls;
 *   lint never waits; an explicit override skips the gate (T13127).
 *
 * @task T12963
 * @task T13127
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor, governorSlotDir } from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import {
  processGroupOf,
  processStart,
  type RunJob,
  removeRunJob,
  writeRunJob,
} from '../../resources/run-admission.js';
import { currentLockId, writeGovernorHolder } from '../../resources/slot-holder.js';
import {
  acquireGlobalSlot,
  defaultMaxConcurrent,
  governorClassFor,
  resolveMaxConcurrent,
  semaphoreDir,
} from '../tool-semaphore.js';

const GIB = 1024 ** 3;

/** A no-pressure sample with `availGib` of available memory. */
function sample(availGib: number): ResourceSample {
  return {
    sampledAtMs: 1,
    pressureAvailable: false,
    memAvailableBytes: availGib * GIB,
    globalPressure: null,
    slicePressure: null,
    walObservations: [],
  };
}

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-home-admission-'));
  process.env.CLEO_HOME = home;
  delete process.env.CLEO_RESOURCES_MODE;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
  _resetGovernorStateForTest();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ['CLEO_HOME', 'CLEO_RESOURCES_MODE']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
  _resetGovernorStateForTest();
});

describe('darwin heavy-slot default (T12963)', () => {
  it('gives test and build ONE slot on darwin however large the machine', () => {
    expect(defaultMaxConcurrent('test', 16, 1024, 'darwin')).toBe(1);
    expect(defaultMaxConcurrent('build', 16, 1024, 'darwin')).toBe(1);
    expect(defaultMaxConcurrent('test', 16, 1024, 'linux')).toBe(4);
  });

  it('leaves light tools on the core budget on darwin', () => {
    expect(defaultMaxConcurrent('lint', 16, 8, 'darwin')).toBe(8);
    expect(defaultMaxConcurrent('typecheck', 16, 8, 'darwin')).toBe(8);
  });

  it('still honours CLEO_TOOL_CONCURRENCY_TEST on darwin', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '3';
    expect(resolveMaxConcurrent('test', 16, 1024, 'darwin')).toBe(3);
  });

  it('blocks a second darwin test run while the first holds the only slot', async () => {
    const opts = {
      platform: 'darwin' as const,
      cpuCount: 16,
      totalRamGib: 1024,
      skipGovernor: true,
    };
    const first = await acquireGlobalSlot('test', opts);
    try {
      await expect(
        acquireGlobalSlot('test', { ...opts, pollMs: 10, timeoutMs: 100 }),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await first();
    }
    const again = await acquireGlobalSlot('test', { ...opts, timeoutMs: 500 });
    await again();
  });
});

describe('governor admission on the heavy slot (T12963)', () => {
  it('maps heavy tools to governor classes and light tools to none', () => {
    expect(governorClassFor('test')).toBe('test-run');
    expect(governorClassFor('build')).toBe('scoped-build');
    expect(governorClassFor('lint')).toBeNull();
  });

  it('holds one test-run slot while the tool slot is held and frees it on release', async () => {
    const s = sample(64); // governor budget: min(⌊62/24⌋=2, ⌊16/4⌋=4) = 2
    const budget = { cpuCount: 16, sample: s };
    expect(await governor.available('test-run', budget)).toBe(2);

    const release = await acquireGlobalSlot('test', {
      platform: 'linux',
      cpuCount: 16,
      totalRamGib: 1024,
      pressureSample: s,
    });
    expect(await governor.available('test-run', budget)).toBe(1);

    await release();
    expect(await governor.available('test-run', budget)).toBe(2);
  });

  it('a build run takes the scoped-build class, not test-run', async () => {
    const s = sample(64);
    const release = await acquireGlobalSlot('build', {
      platform: 'linux',
      cpuCount: 16,
      totalRamGib: 1024,
      pressureSample: s,
    });
    try {
      expect(await governor.available('scoped-build', { cpuCount: 16, sample: s })).toBe(1);
      expect(await governor.available('test-run', { cpuCount: 16, sample: s })).toBe(2);
    } finally {
      await release();
    }
  });

  it('gives back the tool slot when the governor budget is exhausted', async () => {
    const s = sample(26); // governor budget: ⌊24/24⌋ = 1
    const held = await governor.acquire('test-run', { cpuCount: 16, sample: s });
    expect(held.deferred).toBe(false);
    try {
      await expect(
        acquireGlobalSlot('test', {
          platform: 'linux',
          cpuCount: 16,
          totalRamGib: 1024,
          pressureSample: s,
          pollMs: 10,
          timeoutMs: 150,
        }),
      ).rejects.toThrow(/test-run/);
      // The tool slot was released on the way out: a governor-free acquire succeeds.
      const free = await acquireGlobalSlot('test', {
        platform: 'darwin',
        skipGovernor: true,
        timeoutMs: 200,
      });
      await free();
    } finally {
      if (!held.deferred) await held.release();
    }
  });

  it('skips the governor under an explicit CLEO_TOOL_CONCURRENCY_TEST override', async () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '2';
    const s = sample(26); // governor budget 1 — the override must not be capped by it
    const a = await acquireGlobalSlot('test', { pressureSample: s, cpuCount: 16, timeoutMs: 500 });
    const b = await acquireGlobalSlot('test', { pressureSample: s, cpuCount: 16, timeoutMs: 500 });
    expect(await governor.available('test-run', { cpuCount: 16, sample: s })).toBe(1);
    await a();
    await b();
  });

  it('takes no governor slot for light tools', async () => {
    const s = sample(26);
    const release = await acquireGlobalSlot('lint', { cpuCount: 16, pressureSample: s });
    try {
      expect(await governor.available('test-run', { cpuCount: 16, sample: s })).toBe(1);
    } finally {
      await release();
    }
  });
});

describe('a killed heavy run frees both slots (T12963)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaps the dead holder of the tool slot AND the test-run slot', async () => {
    // What a SIGKILLed `cleo verify tool:test` leaves behind on darwin: the only
    // tool slot and the only test-run slot, both held by a pid that is gone.
    // process.kill is stubbed: the planted pid answers ESRCH, this process
    // answers alive, and the real process.kill is never reached.
    const exited = 4_000_001;
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
      if (pid === process.pid) return true;
      const err: NodeJS.ErrnoException = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });

    const toolDir = semaphoreDir('test');
    mkdirSync(toolDir, { recursive: true });
    const toolSlot = join(toolDir, 'slot-0.lock');
    mkdirSync(`${toolSlot}.lock`);
    writeFileSync(
      `${toolSlot}.holder.json`,
      JSON.stringify({
        pid: exited,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        canonical: 'test',
        slot: toolSlot,
        startedAt: null,
        lockId: currentLockId(toolSlot),
      }),
    );

    const govDir = governorSlotDir('test-run');
    mkdirSync(govDir, { recursive: true });
    const govSlot = join(govDir, 'slot-0.lock');
    mkdirSync(`${govSlot}.lock`);
    writeGovernorHolder(govSlot, {
      pid: exited,
      startedAt: null,
      host: hostname(),
      cls: 'test-run',
      acquiredAtMs: Date.now(),
    });

    const started = Date.now();
    const release = await acquireGlobalSlot('test', {
      platform: 'darwin',
      cpuCount: 16,
      totalRamGib: 1024,
      pressureSample: sample(26), // governor budget: ⌊24/24⌋ = 1
      pollMs: 10,
      timeoutMs: 5_000,
    });
    try {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await governor.available('test-run', { cpuCount: 16, sample: sample(26) })).toBe(0);
    } finally {
      await release();
    }
    expect(await governor.available('test-run', { cpuCount: 16, sample: sample(26) })).toBe(1);
  });
});

describe('evidence runs wait out memory pressure (T13127)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Live samples follow a script of memory `some avg10` values (then stay on the last). */
  function scriptPressure(series: readonly number[]): () => number {
    let n = 0;
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockImplementation(async () => {
      const some = series[Math.min(n++, series.length - 1)] ?? 0;
      const line = { avg10: some, avg60: some, avg300: some, totalUs: 0 };
      return {
        sampledAtMs: 1,
        pressureAvailable: true,
        memAvailableBytes: 128 * GIB,
        globalPressure: { some: line, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
        slicePressure: null,
        walObservations: [],
      };
    });
    return () => n;
  }

  const live = { platform: 'linux' as const, cpuCount: 16, totalRamGib: 1024, pollMs: 5 };

  it('a test run waits, saying so with the readings, and starts when pressure falls', async () => {
    scriptPressure([40, 40, 30, 20, 10]);
    const lines: string[] = [];
    const release = await acquireGlobalSlot('test', {
      ...live,
      timeoutMs: 10_000,
      notice: (l) => lines.push(l),
    });
    try {
      expect(await governor.available('test-run', { cpuCount: 16, sample: sample(128) })).toBe(3);
    } finally {
      await release();
    }
    expect(lines[0]).toMatch(
      /^waiting: memory pressure 40 \(refused above 25, resumes at 15 or below\): /,
    );
    expect(lines[0]).toContain("The 'test' run starts when pressure falls");
    expect(lines.at(-1)).toMatch(
      /^memory pressure fell \(now 10\) after waiting \d+s: admitting the 'test' run\.$/,
    );
  });

  it('a test run under lasting pressure gives up with the readings, holding no slot', async () => {
    scriptPressure([50]);
    await expect(
      acquireGlobalSlot('test', { ...live, timeoutMs: 80, notice: () => {} }),
    ).rejects.toThrow(
      /waiting for memory pressure to fall before a 'test' run: memory pressure 50 \(memory PSI some avg10 50\.0%/,
    );
    vi.restoreAllMocks();
    const free = await acquireGlobalSlot('test', {
      platform: 'darwin',
      skipGovernor: true,
      timeoutMs: 200,
    });
    await free();
  });

  it('a typecheck run waits on the gate too, without taking a governor slot', async () => {
    const samples = scriptPressure([40, 12]);
    const lines: string[] = [];
    const release = await acquireGlobalSlot('typecheck', {
      ...live,
      timeoutMs: 10_000,
      notice: (l) => lines.push(l),
    });
    await release();
    expect(samples()).toBe(2);
    expect(lines[0]).toMatch(/^waiting: memory pressure 40 /);
    expect(lines.at(-1)).toMatch(
      /^memory pressure fell \(now 12\) after waiting \d+s: admitting the 'typecheck' run\.$/,
    );
    expect(existsSync(governorSlotDir('scoped-build'))).toBe(false);
  });

  it('a typecheck run under lasting pressure times out with the readings', async () => {
    scriptPressure([50]);
    await expect(
      acquireGlobalSlot('typecheck', { ...live, timeoutMs: 80, notice: () => {} }),
    ).rejects.toThrow(
      /waiting for memory pressure to fall before a 'typecheck' run: memory pressure 50/,
    );
  });

  it('a 1 ms probe still takes a free slot after the gate has sampled (listVitestProjects)', async () => {
    // A slow sample used to eat the whole budget, so the slot loop never ran
    // and a free slot read as busy.
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return sample(128);
    });
    const release = await acquireGlobalSlot('test', {
      ...live,
      timeoutMs: 1,
      pollMs: 1,
      notice: () => {},
    });
    await release();
  });

  it('lint never waits on memory pressure', async () => {
    const samples = scriptPressure([90]);
    const release = await acquireGlobalSlot('lint', {
      ...live,
      timeoutMs: 1_000,
      notice: () => {},
    });
    await release();
    expect(samples()).toBe(0);
  });

  // Real `ps` for our own group and its leader's start time (read-only).
  const pgid = processGroupOf(process.pid);
  const leaderStart = pgid === null ? null : processStart(pgid);
  it.skipIf(leaderStart === null)(
    'a run nested in an admitted cleo run job never waits on the gate (its job would wait on it)',
    async () => {
      const now = Date.now();
      const record: RunJob = {
        id: `${process.pid}-${now}`,
        pid: process.pid,
        runnerStart: null,
        childPid: pgid,
        childStart: leaderStart,
        class: 'test-run',
        command: 'cleo verify T1 --evidence tool:typecheck',
        cwd: '/',
        startedAtMs: now,
        sessionId: null,
        pausedAtMs: null,
        pausable: true,
        heartbeatAtMs: now,
      };
      writeRunJob(record);
      const saved = process.env.CLEO_RUN_CLASS;
      process.env.CLEO_RUN_CLASS = 'test-run';
      try {
        const samples = scriptPressure([90]);
        const release = await acquireGlobalSlot('typecheck', {
          ...live,
          timeoutMs: 1_000,
          notice: () => {},
        });
        await release();
        expect(samples()).toBe(0);
      } finally {
        if (saved === undefined) delete process.env.CLEO_RUN_CLASS;
        else process.env.CLEO_RUN_CLASS = saved;
        removeRunJob(record.id);
      }
    },
  );

  it('an explicit CLEO_TOOL_CONCURRENCY_TYPECHECK override skips the gate', async () => {
    process.env.CLEO_TOOL_CONCURRENCY_TYPECHECK = '4';
    scriptPressure([90]);
    const release = await acquireGlobalSlot('typecheck', {
      ...live,
      timeoutMs: 1_000,
      notice: () => {},
    });
    await release();
  });
});
