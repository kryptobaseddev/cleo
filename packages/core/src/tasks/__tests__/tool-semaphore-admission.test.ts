/**
 * Machine-wide heavy-run admission (T12963).
 *
 * - On darwin (no PSI) `test`/`build` default to ONE slot machine-wide.
 * - A heavy tool slot also takes a slot of the governor class (`test` →
 *   `test-run`, `build` → `scoped-build`), released with the tool slot.
 * - `CLEO_TOOL_CONCURRENCY_*` overrides still decide the count and skip the
 *   governor, whose budget would otherwise cap them.
 *
 * @task T12963
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor } from '../../resources/governor.js';
import {
  acquireGlobalSlot,
  defaultMaxConcurrent,
  governorClassFor,
  resolveMaxConcurrent,
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
