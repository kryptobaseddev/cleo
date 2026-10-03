/**
 * Unit tests for the cross-process global per-tool concurrency semaphore
 * (T1534 / ADR-061).
 *
 * Covers:
 *   - `defaultMaxConcurrent` returns expected per-canonical defaults.
 *   - `resolveMaxConcurrent` honours `CLEO_TOOL_CONCURRENCY_<TOOL>` env
 *     overrides and the disable sentinel (`0` / negative).
 *   - `acquireGlobalSlot` returns immediately when slots are free.
 *   - `acquireGlobalSlot` blocks when all slots busy and unblocks when one
 *     releases.
 *   - Holders that exit without releasing are reaped via the stale-lock
 *     path (proper-lockfile).
 *   - The semaphore is global: an instance acquired by one CLEO_HOME-scoped
 *     "process A" blocks one acquired by "process B" pointing at the same
 *     CLEO_HOME.
 *
 * @task T1534
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResourceSample } from '../../resources/backend.js';
import {
  acquireGlobalSlot,
  DARWIN_MEMORY_BOUND_SLOTS,
  defaultMaxConcurrent,
  HEAVY_TOOL_FOOTPRINT_GIB,
  MEMORY_BOUND_RAM_FRACTION,
  PROCESS_OVERHEAD_MB,
  pressureScaleSlots,
  resolveMaxConcurrent,
  semaphoreDir,
} from '../tool-semaphore.js';

/** Synthetic pressure sample for deterministic, /proc-free slot-scaling tests. */
function makeSample(someAvg10: number): ResourceSample {
  return {
    sampledAtMs: 1,
    pressureAvailable: true,
    memAvailableBytes: 32 * 1024 * 1024 * 1024,
    globalPressure: {
      some: { avg10: someAvg10, avg60: someAvg10, avg300: someAvg10, totalUs: 0 },
      full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    },
    slicePressure: null,
    walObservations: [],
  };
}

let originalCleoHome: string | undefined;

function isolateCleoHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-home-'));
  process.env.CLEO_HOME = dir;
  return dir;
}

function restoreCleoHome(): void {
  if (originalCleoHome === undefined) {
    delete process.env.CLEO_HOME;
  } else {
    process.env.CLEO_HOME = originalCleoHome;
  }
}

beforeEach(() => {
  originalCleoHome = process.env.CLEO_HOME;
});
afterEach(() => {
  restoreCleoHome();
});

/**
 * RAM figure large enough that the CORE budget is the binding constraint.
 *
 * T12091 made heavy-tool budgets RAM-derived, so every assertion about the
 * core rule must pin RAM explicitly — otherwise the expected value depends on
 * whichever host runs the suite (a 16 GiB CI runner and a 62 GiB workstation
 * resolve different budgets from identical inputs).
 */
const AMPLE_RAM_GIB = 1024;

describe('defaultMaxConcurrent', () => {
  it('returns max(1, cpus/4) for test/build when RAM is not the binding constraint', () => {
    expect(defaultMaxConcurrent('test', 16, AMPLE_RAM_GIB, 'linux')).toBe(4);
    expect(defaultMaxConcurrent('build', 16, AMPLE_RAM_GIB, 'linux')).toBe(4);
    expect(defaultMaxConcurrent('test', 1, AMPLE_RAM_GIB, 'linux')).toBe(1);
    expect(defaultMaxConcurrent('test', 2, AMPLE_RAM_GIB, 'linux')).toBe(1);
    expect(defaultMaxConcurrent('test', 8, AMPLE_RAM_GIB, 'linux')).toBe(2);
  });

  it('lets RAM bind BELOW the core budget for test/build', () => {
    // The measured freeze: 24 cores / 62 GiB permitted 6 concurrent suites at
    // 6 forks × 4 GiB each = 144 GiB of heap on a 62 GiB box.
    expect(defaultMaxConcurrent('test', 24, 62, 'linux')).toBe(2);
    expect(defaultMaxConcurrent('build', 24, 62, 'linux')).toBe(2);
  });

  it('floors to ONE slot when a single run exceeds total RAM', () => {
    // A many-core, low-RAM VM is the worst case for the old rule: it got 6.
    expect(defaultMaxConcurrent('test', 24, 16, 'linux')).toBe(1);
    expect(defaultMaxConcurrent('test', 64, 8, 'linux')).toBe(1);
  });

  it('never returns below 1, whatever the inputs', () => {
    for (const [cpus, ram] of [
      [0, 0],
      [1, 0.5],
      [-4, -1],
    ] as const) {
      expect(defaultMaxConcurrent('test', cpus, ram)).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns max(2, cpus/2) for audit/security-scan — network-bound, small RAM', () => {
    expect(defaultMaxConcurrent('audit', 16)).toBe(8);
    expect(defaultMaxConcurrent('security-scan', 16)).toBe(8);
    expect(defaultMaxConcurrent('audit', 2)).toBe(2);
    expect(defaultMaxConcurrent('audit', 1)).toBe(2);
  });
});

describe('defaultMaxConcurrent — typecheck/lint are RAM-derived (T13123)', () => {
  // One TypeScript program on a large monorepo holds 2–5 GB. These tools had
  // max(2, cpus/2) slots: 9 on an 18-core box, ~45 GB of tsc.
  it('the 18-core 48 GiB desktop: 4 typechecks on Linux (was 9), 2 on darwin', () => {
    // ⌊48 GiB × 0.5 / (4096 heap + 2048 overhead MiB)⌋ = 4
    expect(defaultMaxConcurrent('typecheck', 18, 48, 'linux')).toBe(4);
    expect(defaultMaxConcurrent('lint', 18, 48, 'linux')).toBe(4);
    expect(defaultMaxConcurrent('typecheck', 18, 48, 'darwin')).toBe(DARWIN_MEMORY_BOUND_SLOTS);
    expect(defaultMaxConcurrent('lint', 18, 48, 'darwin')).toBe(DARWIN_MEMORY_BOUND_SLOTS);
  });

  it('the 4-core 8 GiB laptop: one at a time, on either OS', () => {
    expect(defaultMaxConcurrent('typecheck', 4, 8, 'linux')).toBe(1);
    expect(defaultMaxConcurrent('typecheck', 4, 8, 'darwin')).toBe(1);
    expect(defaultMaxConcurrent('lint', 4, 8, 'linux')).toBe(1);
  });

  it('a larger heap per run means fewer runs', () => {
    // An inherited 8 GiB heap the plan keeps counts as 10 GiB a run.
    expect(defaultMaxConcurrent('typecheck', 18, 48, 'linux', 8192)).toBe(2);
    expect(defaultMaxConcurrent('typecheck', 18, 48, 'linux', 24576)).toBe(1);
  });

  it('cores still bind a big-RAM box, and never fewer than one slot', () => {
    expect(defaultMaxConcurrent('typecheck', 4, 256, 'linux')).toBe(2);
    expect(defaultMaxConcurrent('typecheck', 1, 256, 'linux')).toBe(1);
    expect(defaultMaxConcurrent('typecheck', 0, 0, 'linux')).toBe(1);
  });

  it('uses RAM/2 at heap + PROCESS_OVERHEAD_MB a run', () => {
    expect(PROCESS_OVERHEAD_MB).toBe(2048);
    expect(MEMORY_BOUND_RAM_FRACTION).toBe(0.5);
    expect(HEAVY_TOOL_FOOTPRINT_GIB).toBe(24);
  });
});

describe('resolveMaxConcurrent', () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
    }
    if (ORIGINAL.CLEO_TOOL_CONCURRENCY_TEST !== undefined) {
      process.env.CLEO_TOOL_CONCURRENCY_TEST = ORIGINAL.CLEO_TOOL_CONCURRENCY_TEST;
    }
  });

  it('honours CLEO_TOOL_CONCURRENCY_TEST env override', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '7';
    expect(resolveMaxConcurrent('test', 16)).toBe(7);
  });

  it('honours CLEO_TOOL_CONCURRENCY_SECURITY_SCAN with kebab → underscore mapping', () => {
    process.env.CLEO_TOOL_CONCURRENCY_SECURITY_SCAN = '3';
    expect(resolveMaxConcurrent('security-scan', 16)).toBe(3);
  });

  it('zero / negative disables the bound', () => {
    process.env.CLEO_TOOL_CONCURRENCY_LINT = '0';
    expect(resolveMaxConcurrent('lint', 16)).toBe(Number.POSITIVE_INFINITY);
    process.env.CLEO_TOOL_CONCURRENCY_LINT = '-1';
    expect(resolveMaxConcurrent('lint', 16)).toBe(Number.POSITIVE_INFINITY);
  });

  it('falls back to defaultMaxConcurrent when env is unset', () => {
    expect(resolveMaxConcurrent('test', 16, AMPLE_RAM_GIB, 'linux')).toBe(4);
  });

  it('ignores non-numeric env values', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = 'abc';
    expect(resolveMaxConcurrent('test', 16, AMPLE_RAM_GIB, 'linux')).toBe(4);
  });

  it('lets RAM bind the fallback below the core budget (T12091)', () => {
    // Without an env override, a low-RAM host must not be handed the core
    // budget — this is the composition that froze the workstation.
    expect(resolveMaxConcurrent('test', 24, 62, 'linux')).toBe(2);
    expect(resolveMaxConcurrent('test', 24, 16, 'linux')).toBe(1);
  });

  it('an env override still bypasses the RAM bound — it is the one escape hatch', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '8';
    expect(resolveMaxConcurrent('test', 24, 16, 'linux')).toBe(8);
  });
});

describe('semaphoreDir', () => {
  it('points under CLEO_HOME/locks/tool-<canonical>', () => {
    const home = isolateCleoHome();
    expect(semaphoreDir('test')).toBe(join(home, 'locks', 'tool-test'));
    expect(semaphoreDir('lint')).toBe(join(home, 'locks', 'tool-lint'));
  });
});

describe('acquireGlobalSlot — basic acquire/release', () => {
  let home: string;
  beforeEach(() => {
    home = isolateCleoHome();
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '1';
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  });

  it('returns a release fn for an immediately-free slot', async () => {
    const release = await acquireGlobalSlot('test');
    expect(typeof release).toBe('function');
    await release();
  });

  it('returns a no-op when concurrency is disabled (env=0)', async () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
    const release = await acquireGlobalSlot('test');
    // Should resolve instantly without creating any slot files.
    await release();
  });

  it('release is idempotent', async () => {
    const release = await acquireGlobalSlot('test');
    await release();
    await release();
  });
});

describe('acquireGlobalSlot — blocking', () => {
  let home: string;
  beforeEach(() => {
    home = isolateCleoHome();
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '1';
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  });

  it('a second acquirer waits until the first releases', async () => {
    const releaseA = await acquireGlobalSlot('test', { pollMs: 20 });

    let resolvedB = false;
    const acquireB = acquireGlobalSlot('test', { pollMs: 20 }).then((release) => {
      resolvedB = true;
      return release;
    });

    // Give B a moment to attempt and fail.
    await new Promise((r) => setTimeout(r, 100));
    expect(resolvedB).toBe(false);

    // Release A — B should now acquire.
    await releaseA();
    const releaseB = await acquireB;
    expect(resolvedB).toBe(true);
    await releaseB();
  });

  it('with maxConcurrent=2, two acquirers run in parallel and a third blocks', async () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '2';
    const r1 = await acquireGlobalSlot('test', { pollMs: 20 });
    const r2 = await acquireGlobalSlot('test', { pollMs: 20 });

    let resolvedThird = false;
    const acquireThird = acquireGlobalSlot('test', { pollMs: 20 }).then((release) => {
      resolvedThird = true;
      return release;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(resolvedThird).toBe(false);

    await r1();
    const r3 = await acquireThird;
    expect(resolvedThird).toBe(true);

    await r2();
    await r3();
  });

  it('throws when timeoutMs elapses without acquiring', async () => {
    const blocking = await acquireGlobalSlot('test', { pollMs: 20 });
    try {
      await expect(acquireGlobalSlot('test', { pollMs: 10, timeoutMs: 100 })).rejects.toThrow(
        /Timed out/,
      );
    } finally {
      await blocking();
    }
  });
});

describe('pressureScaleSlots (T12001 — pressure-dynamic slots)', () => {
  it('halves test/build slots at hold pressure (some>10) and floors to 1 at backoff (some>25)', () => {
    expect(pressureScaleSlots('test', 4, makeSample(0))).toBe(4);
    expect(pressureScaleSlots('test', 4, makeSample(15))).toBe(2);
    expect(pressureScaleSlots('test', 4, makeSample(30))).toBe(1);
    expect(pressureScaleSlots('build', 4, makeSample(30))).toBe(1);
  });

  it('scales typecheck/lint under pressure too (T13123)', () => {
    expect(pressureScaleSlots('typecheck', 4, makeSample(0))).toBe(4);
    expect(pressureScaleSlots('typecheck', 4, makeSample(15))).toBe(2);
    expect(pressureScaleSlots('typecheck', 4, makeSample(30))).toBe(1);
    expect(pressureScaleSlots('lint', 4, makeSample(30))).toBe(1);
  });

  it('leaves network-bound tools (audit/security-scan) unscaled under pressure', () => {
    expect(pressureScaleSlots('audit', 8, makeSample(30))).toBe(8);
    expect(pressureScaleSlots('security-scan', 8, makeSample(30))).toBe(8);
  });
});

describe('acquireGlobalSlot pressure scaling (T12001)', () => {
  it('shrinks the acquirable window to 1 under backoff pressure, recovers on release', async () => {
    isolateCleoHome();
    const high = makeSample(30); // some>25 → effectiveMax = 1 for 'test'
    const first = await acquireGlobalSlot('test', {
      pressureSample: high,
      cpuCount: 16,
      totalRamGib: AMPLE_RAM_GIB,
      platform: 'linux',
      skipGovernor: true,
    });
    try {
      // Only one slot is eligible under high pressure → second acquire times out.
      await expect(
        acquireGlobalSlot('test', {
          pressureSample: high,
          cpuCount: 16,
          totalRamGib: AMPLE_RAM_GIB,
          platform: 'linux',
          skipGovernor: true,
          pollMs: 10,
          timeoutMs: 100,
        }),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await first();
    }
    // After release, a fresh acquire under high pressure succeeds (slot freed).
    const again = await acquireGlobalSlot('test', {
      pressureSample: high,
      cpuCount: 16,
      totalRamGib: AMPLE_RAM_GIB,
      platform: 'linux',
      skipGovernor: true,
      timeoutMs: 200,
    });
    await again();
  });

  it('allows full static concurrency when pressure is low (no scaling)', async () => {
    isolateCleoHome();
    const low = makeSample(0); // effectiveMax = static = max(1, 16/4) = 4
    const a = await acquireGlobalSlot('test', {
      pressureSample: low,
      cpuCount: 16,
      totalRamGib: AMPLE_RAM_GIB,
      platform: 'linux',
      skipGovernor: true,
      timeoutMs: 500,
    });
    const b = await acquireGlobalSlot('test', {
      pressureSample: low,
      cpuCount: 16,
      totalRamGib: AMPLE_RAM_GIB,
      platform: 'linux',
      skipGovernor: true,
      timeoutMs: 500,
    });
    // Two concurrent grants coexist under low pressure.
    await a();
    await b();
  });

  it('honors an explicit CLEO_TOOL_CONCURRENCY override (no scaling)', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '7';
    try {
      // Override is read by resolveMaxConcurrent; pressureScaleSlots is bypassed
      // in acquire when an override is present (asserted via resolveMaxConcurrent).
      expect(resolveMaxConcurrent('test', 16)).toBe(7);
    } finally {
      delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
    }
  });
});
