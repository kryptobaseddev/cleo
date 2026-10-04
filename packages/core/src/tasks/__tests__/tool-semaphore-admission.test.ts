/**
 * Machine-wide heavy-run admission (T12963), and typecheck/lint slots (T13123).
 *
 * - On darwin (no PSI) `test`/`build` default to ONE slot machine-wide.
 * - A heavy tool slot also takes a slot of the governor class (`test` →
 *   `test-run`, `build` → `scoped-build`), released with the tool slot.
 * - `CLEO_TOOL_CONCURRENCY_*` overrides still decide the count and skip the
 *   governor, whose budget would otherwise cap them.
 * - A SIGKILLed run leaves both slots held by a dead pid; the next run reaps
 *   both instead of waiting out the governor's 10 min stale timeout.
 *
 * @task T12963
 * @task T13123
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor, governorSlotDir } from '../../resources/governor.js';
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

  it('leaves network-bound tools on the core budget on darwin', () => {
    expect(defaultMaxConcurrent('audit', 16, 8, 'darwin')).toBe(8);
    expect(defaultMaxConcurrent('security-scan', 16, 8, 'darwin')).toBe(8);
  });

  it('gives typecheck and lint a small fixed number on darwin, never more than RAM allows (T13123)', () => {
    expect(defaultMaxConcurrent('typecheck', 18, 1024, 'darwin')).toBe(2);
    expect(defaultMaxConcurrent('lint', 18, 1024, 'darwin')).toBe(2);
    expect(defaultMaxConcurrent('typecheck', 4, 8, 'darwin')).toBe(1);
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
  it('maps heavy tools to governor classes and the rest to none', () => {
    expect(governorClassFor('test')).toBe('test-run');
    expect(governorClassFor('build')).toBe('scoped-build');
    // T13123: no governor class of their own; the tool semaphore bounds them.
    expect(governorClassFor('typecheck')).toBeNull();
    expect(governorClassFor('lint')).toBeNull();
    expect(governorClassFor('audit')).toBeNull();
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

  it('takes no governor slot for light or single-process tools', async () => {
    const s = sample(26);
    for (const tool of ['lint', 'typecheck', 'audit'] as const) {
      const release = await acquireGlobalSlot(tool, { cpuCount: 16, pressureSample: s });
      try {
        expect(await governor.available('test-run', { cpuCount: 16, sample: s })).toBe(1);
        expect(await governor.available('scoped-build', { cpuCount: 16, sample: s })).toBe(1);
      } finally {
        await release();
      }
    }
  });

  it('a typecheck slot is sized from the heap the run gets (T13123)', async () => {
    // 64 GiB Linux box, 16 cores: ⌊32768 / (24576 + 2048)⌋ = 1 slot at a 24 GiB heap.
    const opts = {
      platform: 'linux' as const,
      cpuCount: 16,
      totalRamGib: 64,
      pressureSample: sample(64),
      heapMb: 24576,
    };
    const first = await acquireGlobalSlot('typecheck', opts);
    try {
      await expect(
        acquireGlobalSlot('typecheck', { ...opts, pollMs: 10, timeoutMs: 100 }),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await first();
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

describe('a probe makes at least one pass (T13127)', () => {
  it('timeoutMs 0 still takes a free slot: the loop tries before it checks the clock', async () => {
    // Deterministic: with a zero budget the deadline has passed before the
    // first pass, so a loop that checks the clock first never tries at all.
    const release = await acquireGlobalSlot('test', {
      platform: 'darwin',
      skipGovernor: true,
      pressureSample: null,
      timeoutMs: 0,
    });
    await release();
  });

  it('timeoutMs 0 on a held slot gives up after that one pass, naming the holder', async () => {
    const held = await acquireGlobalSlot('test', {
      platform: 'darwin',
      skipGovernor: true,
      timeoutMs: 200,
    });
    try {
      await expect(
        acquireGlobalSlot('test', {
          platform: 'darwin',
          skipGovernor: true,
          pressureSample: null,
          timeoutMs: 0,
        }),
      ).rejects.toThrow(
        /Timed out after 0ms waiting for a free 'test' tool slot \(max 1 concurrent\)\. Current holders/,
      );
    } finally {
      await held();
    }
  });
});
