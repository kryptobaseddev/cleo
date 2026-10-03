/**
 * Tests for the memory gate (T13127): heavy work is refused while memory is
 * short, with machine-wide hysteresis, and a missing signal never refuses.
 *
 * Coverage:
 *   - evaluateMemoryGate: refuse/resume thresholds on `some` and `full`, no
 *     signal, CPU saturation never refuses
 *   - checkMemoryGate: the latch is shared through a file (a second process
 *     sees the first one's refusal), expires, is cleared on resume, is never
 *     touched by a sample without a signal, and degrades when unwritable
 *   - describeMemoryPressure: darwin readings and Linux PSI in one line
 *   - memoryGateReporter: first notice at once, repeats throttled, resume line
 *   - waitForMemoryGate: waits and starts when pressure falls; times out with
 *     the readings; a failing sampler admits
 *
 * @task T13127
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DarwinMemorySignals, ResourceSample } from '../backend.js';
import {
  checkMemoryGate,
  describeMemoryPressure,
  evaluateMemoryGate,
  MEMORY_GATE_LATCH_TTL_MS,
  memoryGateReporter,
  waitForMemoryGate,
} from '../pressure-gate.js';

const GIB = 1024 ** 3;

function sampleAt(
  some: number,
  opts: { full?: number; cpu?: number; darwin?: DarwinMemorySignals } = {},
): ResourceSample {
  const line = (v: number) => ({ avg10: v, avg60: v, avg300: v, totalUs: 0 });
  return {
    sampledAtMs: 0,
    pressureAvailable: true,
    memAvailableBytes: 4 * GIB,
    globalPressure: { some: line(some), full: line(opts.full ?? 0) },
    slicePressure: null,
    cpuPressure: opts.cpu === undefined ? null : { some: line(opts.cpu), full: null },
    ...(opts.darwin ? { darwinMemory: opts.darwin } : {}),
    walObservations: [],
  };
}

const NO_SIGNAL: ResourceSample = {
  sampledAtMs: 0,
  pressureAvailable: false,
  memAvailableBytes: null,
  globalPressure: null,
  slicePressure: null,
  walObservations: [],
};

let dir: string;
let latch: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-memory-gate-'));
  latch = join(dir, 'memory-gate.json');
});
afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Already writable.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('evaluateMemoryGate', () => {
  it('refuses above 25 and admits at or below it', () => {
    expect(evaluateMemoryGate(sampleAt(25), false).refuse).toBe(false);
    expect(evaluateMemoryGate(sampleAt(25.1), false).refuse).toBe(true);
  });

  it('once refusing, admits again only at or below 15 (hysteresis)', () => {
    expect(evaluateMemoryGate(sampleAt(20), true).refuse).toBe(true);
    expect(evaluateMemoryGate(sampleAt(15.1), true).refuse).toBe(true);
    expect(evaluateMemoryGate(sampleAt(15), true).refuse).toBe(false);
  });

  it('a full stall refuses above 10 and resumes at or below 5', () => {
    expect(evaluateMemoryGate(sampleAt(0, { full: 10.5 }), false).refuse).toBe(true);
    expect(evaluateMemoryGate(sampleAt(0, { full: 7 }), true).refuse).toBe(true);
    expect(evaluateMemoryGate(sampleAt(0, { full: 5 }), true).refuse).toBe(false);
  });

  it('CPU saturation alone never refuses', () => {
    expect(evaluateMemoryGate(sampleAt(0, { cpu: 95 }), false).refuse).toBe(false);
  });

  it('a sample without a memory signal never refuses, even latched', () => {
    expect(evaluateMemoryGate(NO_SIGNAL, true)).toEqual({ refuse: false, reading: null });
  });

  it('reports the readings and which threshold applied', () => {
    const { reading } = evaluateMemoryGate(sampleAt(31.27, { full: 2 }), true);
    expect(reading).toMatchObject({
      score: 31.3,
      fullStall: 2,
      refuseAbove: 25,
      resumeAtOrBelow: 15,
      latched: true,
      memAvailableBytes: 4 * GIB,
    });
    expect(reading?.summary).toContain('memory PSI some avg10 31.3%');
  });
});

describe('checkMemoryGate (machine-wide latch)', () => {
  it('a refusal is seen by every process: a newcomer in the band waits too', () => {
    const t = 1_000_000;
    expect(checkMemoryGate(sampleAt(30), { path: latch, now: () => t }).refuse).toBe(true);
    expect(JSON.parse(readFileSync(latch, 'utf-8'))).toEqual({ refusing: true, updatedAtMs: t });
    // A different process (same file) at 20: not above 25, but the gate is refusing.
    const later = checkMemoryGate(sampleAt(20), { path: latch, now: () => t + 5_000 });
    expect(later.refuse).toBe(true);
    expect(later.reading?.latched).toBe(true);
  });

  it('resumes at or below 15 and clears the latch for everyone', () => {
    const t = 1_000_000;
    checkMemoryGate(sampleAt(30), { path: latch, now: () => t });
    expect(checkMemoryGate(sampleAt(14), { path: latch, now: () => t + 1 }).refuse).toBe(false);
    expect(JSON.parse(readFileSync(latch, 'utf-8')).refusing).toBe(false);
    expect(checkMemoryGate(sampleAt(20), { path: latch, now: () => t + 2 }).refuse).toBe(false);
  });

  it('does not flap on a series oscillating around the refuse threshold', () => {
    let t = 1_000_000;
    const series = [26, 24, 26, 23, 25.5, 22, 24, 21, 19, 16, 15, 18, 22, 24, 25];
    const verdicts = series.map((v) => {
      t += 1_000;
      return checkMemoryGate(sampleAt(v), { path: latch, now: () => t }).refuse;
    });
    // Refused from the first crossing until it fell to 15, then admitted until it crosses 25 again.
    expect(verdicts).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('a latch nobody refreshed expires', () => {
    const t = 1_000_000;
    checkMemoryGate(sampleAt(30), { path: latch, now: () => t });
    const stale = checkMemoryGate(sampleAt(20), {
      path: latch,
      now: () => t + MEMORY_GATE_LATCH_TTL_MS,
    });
    expect(stale.refuse).toBe(false);
    expect(JSON.parse(readFileSync(latch, 'utf-8')).refusing).toBe(false);
  });

  it('active waiters keep the latch alive past the TTL', () => {
    let t = 1_000_000;
    checkMemoryGate(sampleAt(30), { path: latch, now: () => t });
    for (let i = 0; i < 10; i++) {
      t += 15_000;
      expect(checkMemoryGate(sampleAt(20), { path: latch, now: () => t }).refuse).toBe(true);
    }
  });

  it('a sample without a signal admits and leaves the latch alone', () => {
    const t = 1_000_000;
    checkMemoryGate(sampleAt(30), { path: latch, now: () => t });
    const before = readFileSync(latch, 'utf-8');
    expect(checkMemoryGate(NO_SIGNAL, { path: latch, now: () => t + 1 })).toEqual({
      refuse: false,
      reading: null,
    });
    expect(readFileSync(latch, 'utf-8')).toBe(before);
  });

  it('a corrupt latch is ignored', () => {
    writeFileSync(latch, '{not json');
    expect(checkMemoryGate(sampleAt(20), { path: latch }).refuse).toBe(false);
  });

  // Root ignores directory permissions and Windows ignores the mode bits: the
  // read-only case cannot be staged there.
  const unstageable = process.getuid?.() === 0 || process.platform === 'win32';
  it.skipIf(unstageable)('an unwritable latch degrades to point evaluation, never a throw', () => {
    chmodSync(dir, 0o500);
    expect(checkMemoryGate(sampleAt(30), { path: latch }).refuse).toBe(true);
    expect(checkMemoryGate(sampleAt(20), { path: latch }).refuse).toBe(false);
    expect(existsSync(latch)).toBe(false);
  });
});

describe('describeMemoryPressure', () => {
  it('names the darwin signals with the numbers', () => {
    const line = describeMemoryPressure(
      sampleAt(43, {
        darwin: {
          pressureLevel: 2,
          availablePercent: 41,
          compressorBytes: 20 * GIB,
          swapUsedBytes: 11.4 * GIB,
          swapTotalBytes: 13 * GIB,
          totalBytes: 48 * GIB,
        },
      }),
    );
    expect(line).toBe(
      'kernel level warning; 59% of RAM wired or compressed; compressor 20.0 GiB; ' +
        'swap 11.4 GiB used of 13.0 GiB (24% of RAM)',
    );
  });

  it('names PSI and available memory elsewhere', () => {
    expect(describeMemoryPressure(sampleAt(31, { full: 4 }))).toBe(
      'memory PSI some avg10 31.0%, full avg10 4.0%; 4.0 GiB available',
    );
    expect(describeMemoryPressure(NO_SIGNAL)).toBe('no memory signal');
  });
});

describe('memoryGateReporter', () => {
  it('notices at once, repeats at most once per interval, and says when it starts', () => {
    const lines: string[] = [];
    let t = 0;
    const r = memoryGateReporter((l) => lines.push(l), 'test run', {
      now: () => t,
      intervalMs: 60_000,
    });
    const reading = evaluateMemoryGate(sampleAt(30), false).reading;
    if (reading === null) throw new Error('expected a reading');
    r.admitted(0, 0); // nothing was reported: nothing to say
    r.waiting(reading, 0);
    t = 30_000;
    r.waiting(reading, 30_000);
    t = 60_000;
    r.waiting(reading, 60_000);
    r.admitted(65_000, 12);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^waiting: memory pressure 30 \(refused above 25, resumes at 15 or below\): /,
    );
    expect(lines[0]).toContain('The test run starts when pressure falls; waited 0s.');
    expect(lines[1]).toContain('waited 1m 00s');
    expect(lines[2]).toBe(
      'memory pressure fell (now 12) after waiting 1m 05s: admitting the test run.',
    );
  });
});

describe('waitForMemoryGate', () => {
  function clock() {
    const c = { t: 1_000_000 };
    return {
      c,
      now: () => c.t,
      sleep: async (ms: number) => {
        c.t += ms;
      },
    };
  }

  it('waits while refused and starts when pressure falls, reporting both', async () => {
    const { now, sleep } = clock();
    const series = [40, 30, 20, 12];
    let i = 0;
    const lines: string[] = [];
    const result = await waitForMemoryGate({
      timeoutMs: 60_000,
      sample: async () => sampleAt(series[Math.min(i++, series.length - 1)] ?? 0),
      reporter: memoryGateReporter((l) => lines.push(l), 'typecheck run', {
        now,
        intervalMs: 1_000,
      }),
      now,
      sleep,
      path: latch,
    });
    expect(result).toEqual({ admitted: true, waitedMs: 3_000 });
    expect(lines.filter((l) => l.startsWith('waiting: memory pressure'))).toHaveLength(3);
    expect(lines.at(-1)).toBe(
      'memory pressure fell (now 12) after waiting 3s: admitting the typecheck run.',
    );
  });

  it('gives up at the timeout with the readings', async () => {
    const { now, sleep } = clock();
    const result = await waitForMemoryGate({
      timeoutMs: 5_000,
      sample: async () => sampleAt(50),
      now,
      sleep,
      path: latch,
    });
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.waitedMs).toBe(5_000);
    expect(result.reading.score).toBe(50);
  });

  it('a failing sampler admits at once: a broken signal never blocks work', async () => {
    const { now, sleep } = clock();
    checkMemoryGate(sampleAt(50), { path: latch, now });
    const result = await waitForMemoryGate({
      timeoutMs: 60_000,
      sample: async () => {
        throw new Error('sysctl unavailable');
      },
      now,
      sleep,
      path: latch,
    });
    expect(result).toEqual({ admitted: true, waitedMs: 0 });
  });
});
