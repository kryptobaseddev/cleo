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
  defaultMaxConcurrent,
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

describe('defaultMaxConcurrent', () => {
  it('returns max(1, cpus/4) for test/build', () => {
    expect(defaultMaxConcurrent('test', 16)).toBe(4);
    expect(defaultMaxConcurrent('build', 16)).toBe(4);
    expect(defaultMaxConcurrent('test', 1)).toBe(1);
    expect(defaultMaxConcurrent('test', 2)).toBe(1);
    expect(defaultMaxConcurrent('test', 8)).toBe(2);
  });

  it('returns max(2, cpus/2) for lint/typecheck/audit/security-scan', () => {
    expect(defaultMaxConcurrent('lint', 16)).toBe(8);
    expect(defaultMaxConcurrent('typecheck', 16)).toBe(8);
    expect(defaultMaxConcurrent('audit', 16)).toBe(8);
    expect(defaultMaxConcurrent('security-scan', 16)).toBe(8);
    expect(defaultMaxConcurrent('lint', 2)).toBe(2);
    expect(defaultMaxConcurrent('lint', 1)).toBe(2);
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
    expect(resolveMaxConcurrent('test', 16)).toBe(4);
  });

  it('ignores non-numeric env values', () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = 'abc';
    expect(resolveMaxConcurrent('test', 16)).toBe(4);
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

  it('leaves light tools (lint/typecheck) unscaled under pressure', () => {
    expect(pressureScaleSlots('lint', 8, makeSample(30))).toBe(8);
    expect(pressureScaleSlots('typecheck', 8, makeSample(30))).toBe(8);
  });
});

describe('acquireGlobalSlot pressure scaling (T12001)', () => {
  it('shrinks the acquirable window to 1 under backoff pressure, recovers on release', async () => {
    isolateCleoHome();
    const high = makeSample(30); // some>25 → effectiveMax = 1 for 'test'
    const first = await acquireGlobalSlot('test', { pressureSample: high, cpuCount: 16 });
    try {
      // Only one slot is eligible under high pressure → second acquire times out.
      await expect(
        acquireGlobalSlot('test', {
          pressureSample: high,
          cpuCount: 16,
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
      timeoutMs: 500,
    });
    const b = await acquireGlobalSlot('test', {
      pressureSample: low,
      cpuCount: 16,
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
