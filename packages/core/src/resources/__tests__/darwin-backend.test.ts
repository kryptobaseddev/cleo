/**
 * Tests for the macOS ResourceMonitor backend (T12981).
 *
 * Coverage:
 *   - parseDarwinSysctl: full output, unknown names, malformed values
 *   - darwinMemorySome / cpuSomeFromLoad: the PSI-equivalent mapping
 *   - DarwinResourceBackend.sample: shape, one sysctl per TTL, degraded on
 *     failure, memAvailable from free%
 *   - sweepChildRss: ps parsing
 *   - evaluateState: CPU saturation alone holds/backs off; the worse of
 *     memory and CPU wins; CPU hysteresis
 *   - defaultResourceBackend: platform selection
 *
 * @task T12981
 */

import { describe, expect, it } from 'vitest';
import type { PsiData, ResourceSample } from '../backend.js';
import {
  cpuSomeFromLoad,
  DarwinResourceBackend,
  darwinMemorySome,
  darwinPressure,
  effectiveCores,
  parseDarwinSysctl,
} from '../darwin-backend.js';
import { computeClassBudget } from '../governor.js';
import { LinuxResourceBackend } from '../linux-backend.js';
import {
  classifyPressure,
  defaultResourceBackend,
  evaluateState,
  pressureScore,
} from '../monitor.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

const THRESHOLDS = {
  holdSomeAvg10: 10,
  backoffSomeAvg10: 20,
  holdFullAvg10: 5,
  backoffFullAvg10: 10,
  hysteresisPoints: 3,
  holdCpuSomeAvg10: 33,
  backoffCpuSomeAvg10: 50,
  headroomBytes: 256 * MB,
  walWarnThresholdBytes: 256 * MB,
  pollIntervalMs: 1500,
};

/** Real `sysctl` output captured on a 48 GiB / 18-core Mac under load. */
const LOADED = [
  'kern.memorystatus_vm_pressure_level: 2',
  'kern.memorystatus_level: 41',
  'vm.swapusage: total = 13312.00M  used = 11625.69M  free = 1686.31M  (encrypted)',
  'vm.loadavg: { 21.53 26.57 41.30 }',
  'hw.ncpu: 18',
  '',
].join('\n');

const CALM = [
  'kern.memorystatus_vm_pressure_level: 1',
  'kern.memorystatus_level: 70',
  'vm.swapusage: total = 2048.00M  used = 100.00M  free = 1948.00M  (encrypted)',
  'vm.loadavg: { 3.10 2.90 2.50 }',
  'hw.ncpu: 18',
].join('\n');

function psi(some: number, full = 0): PsiData {
  return {
    some: { avg10: some, avg60: some, avg300: some, totalUs: 0 },
    full: { avg10: full, avg60: full, avg300: full, totalUs: 0 },
  };
}

function sample(memSome: number, cpuSome: number | null): ResourceSample {
  return {
    sampledAtMs: 0,
    pressureAvailable: true,
    memAvailableBytes: 8 * GB,
    globalPressure: psi(memSome),
    slicePressure: null,
    cpuPressure: cpuSome === null ? null : { some: psi(cpuSome).some, full: null },
    walObservations: [],
  };
}

describe('parseDarwinSysctl', () => {
  it('parses every signal from real output', () => {
    const s = parseDarwinSysctl(LOADED);
    expect(s.pressureLevel).toBe(2);
    expect(s.freePercent).toBe(41);
    expect(s.swapTotalBytes).toBe(13312 * MB);
    expect(s.swapUsedBytes).toBeCloseTo(11625.69 * MB, 0);
    expect(s.loadAvg).toEqual([21.53, 26.57, 41.3]);
    expect(s.ncpu).toBe(18);
  });

  it('leaves unknown or malformed names null', () => {
    const s = parseDarwinSysctl('hw.ncpu: 8\nkern.memorystatus_level: lots\nvm.loadavg: { x }\n');
    expect(s.ncpu).toBe(8);
    expect(s.freePercent).toBeNull();
    expect(s.pressureLevel).toBeNull();
    expect(s.loadAvg).toBeNull();
    expect(s.swapTotalBytes).toBeNull();
  });
});

describe('PSI-equivalent mapping', () => {
  it('kernel warning alone crosses the memory hold threshold', () => {
    const some = darwinMemorySome(parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 2\n'));
    expect(some).toBeGreaterThan(THRESHOLDS.holdSomeAvg10);
    expect(some).toBeLessThanOrEqual(THRESHOLDS.backoffSomeAvg10);
  });

  it('kernel critical crosses backoff', () => {
    const some = darwinMemorySome(parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 4\n'));
    expect(some).toBeGreaterThan(THRESHOLDS.backoffSomeAvg10);
  });

  it('a calm box scores zero', () => {
    expect(darwinMemorySome(parseDarwinSysctl(CALM))).toBe(0);
  });

  it('low free memory scores even when the kernel still says normal', () => {
    const some = darwinMemorySome(
      parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 1\nkern.memorystatus_level: 8\n'),
    );
    expect(some).toBe(24);
  });

  it('swap is reported but not scored (macOS grows swapfiles on demand)', () => {
    const base = darwinMemorySome(parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 2\n'));
    expect(darwinMemorySome(parseDarwinSysctl(LOADED))).toBe(base);
    expect(base).toBe(15);
  });

  it('the loaded fixture is exactly hold, not backoff (kernel warning, 41% free, swap 87%)', () => {
    const s = parseDarwinSysctl(LOADED);
    const { memory, cpu } = darwinPressure(s);
    const sampleOf: ResourceSample = {
      sampledAtMs: 0,
      pressureAvailable: true,
      memAvailableBytes: 1,
      globalPressure: memory,
      slicePressure: null,
      cpuPressure: cpu,
      walObservations: [],
    };
    expect(classifyPressure(sampleOf).state).toBe('hold');
  });

  it('effective cores: performance plus half the efficiency cores', () => {
    const split = parseDarwinSysctl(
      'hw.ncpu: 18\nhw.perflevel0.logicalcpu: 6\nhw.perflevel1.logicalcpu: 12\n',
    );
    expect(effectiveCores(split)).toBe(12);
    expect(effectiveCores(parseDarwinSysctl('hw.ncpu: 18\n'))).toBe(18);
    expect(effectiveCores(parseDarwinSysctl('vm.loadavg: { 1 1 1 }\n'))).toBeNull();
    // Load 24 on 6P+12E is 2x the effective cores: cpu backoff territory.
    const loaded = parseDarwinSysctl(
      'vm.loadavg: { 24.0 24.0 24.0 }\nhw.ncpu: 18\nhw.perflevel0.logicalcpu: 6\nhw.perflevel1.logicalcpu: 12\n',
    );
    expect(darwinPressure(loaded).cpu?.some.avg10).toBe(50);
  });

  it('returns null when no memory signal is readable', () => {
    expect(darwinMemorySome(parseDarwinSysctl('hw.ncpu: 4\n'))).toBeNull();
  });

  it('cpu: idle and exactly-saturated score 0; 2x cores scores 50', () => {
    expect(cpuSomeFromLoad(3, 18)).toBe(0);
    expect(cpuSomeFromLoad(18, 18)).toBe(0);
    expect(cpuSomeFromLoad(36, 18)).toBe(50);
    // The 2026-10-01 meltdown: load 62 on 18 cores.
    expect(cpuSomeFromLoad(62, 18)).toBeGreaterThan(THRESHOLDS.backoffCpuSomeAvg10);
  });
});

describe('DarwinResourceBackend.sample', () => {
  it('maps a loaded box onto the PSI shape', async () => {
    const backend = new DarwinResourceBackend({
      sysctlFn: async () => LOADED,
      totalMemBytes: 48 * GB,
    });
    const s = await backend.sample();
    expect(s.pressureAvailable).toBe(true);
    expect(s.memAvailableBytes).toBe(Math.round(0.41 * 48 * GB));
    expect(s.globalPressure?.some.avg10).toBe(15);
    expect(s.slicePressure).toBeNull();
    expect(s.cpuPressure?.some.avg10).toBeCloseTo((100 * (21.53 / 18 - 1)) / (21.53 / 18), 5);
    expect(s.cpuPressure?.some.avg300).toBeGreaterThan(s.cpuPressure?.some.avg10 ?? 0);
  });

  it('runs at most one sysctl per TTL', async () => {
    let calls = 0;
    let t = 1000;
    const backend = new DarwinResourceBackend({
      sysctlFn: async () => {
        calls++;
        return CALM;
      },
      cacheTtlMs: 2000,
      now: () => t,
    });
    await Promise.all([backend.sample(), backend.sample(), backend.sample()]);
    t += 1999;
    await backend.sample();
    expect(calls).toBe(1);
    t += 1;
    await backend.sample();
    expect(calls).toBe(2);
  });

  it('degrades (pressureAvailable false, no throw) when sysctl fails', async () => {
    const backend = new DarwinResourceBackend({
      sysctlFn: async () => {
        throw new Error('no sysctl');
      },
    });
    const s = await backend.sample();
    expect(s.pressureAvailable).toBe(false);
    expect(s.globalPressure).toBeNull();
    expect(s.cpuPressure).toBeNull();
    expect(s.memAvailableBytes).toBeNull();
  });

  it('reports WAL sizes through the injected stat', async () => {
    const backend = new DarwinResourceBackend({
      sysctlFn: async () => CALM,
      walPaths: ['/a-wal', '/b-wal'],
      statFileFn: async (p) => (p === '/a-wal' ? { size: 42 } : null),
    });
    const s = await backend.sample();
    expect(s.walObservations).toEqual([
      { walPath: '/a-wal', sizeBytes: 42 },
      { walPath: '/b-wal', sizeBytes: null },
    ]);
  });
});

describe('DarwinResourceBackend.sweepChildRss', () => {
  it('parses ps output and skips junk', async () => {
    const backend = new DarwinResourceBackend({
      psRssFn: async () => '  101  2048\n 102 4096\ngarbage\n',
    });
    const sweep = await backend.sweepChildRss([101, 102, 103]);
    expect(sweep.entries).toEqual([
      { pid: 101, rssBytes: 2048 * 1024, pssBytes: 2048 * 1024 },
      { pid: 102, rssBytes: 4096 * 1024, pssBytes: 4096 * 1024 },
    ]);
  });

  it('spawns nothing for an empty pid list', async () => {
    let called = false;
    const backend = new DarwinResourceBackend({
      psRssFn: async () => {
        called = true;
        return '';
      },
    });
    expect((await backend.sweepChildRss([])).entries).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('evaluateState with cpuPressure', () => {
  it('cpu saturation alone holds and backs off', () => {
    expect(evaluateState(sample(0, 40), THRESHOLDS, 'ok').state).toBe('hold');
    expect(evaluateState(sample(0, 60), THRESHOLDS, 'ok').state).toBe('backoff');
    expect(evaluateState(sample(0, 20), THRESHOLDS, 'ok').state).toBe('ok');
  });

  it('the worse of memory and cpu wins', () => {
    expect(evaluateState(sample(25, 40), THRESHOLDS, 'ok').state).toBe('backoff');
    expect(evaluateState(sample(12, 60), THRESHOLDS, 'ok').state).toBe('backoff');
    expect(evaluateState(sample(12, 0), THRESHOLDS, 'ok').state).toBe('hold');
  });

  it('cpu leaves hold only below the hysteresis floor', () => {
    expect(evaluateState(sample(0, 31), THRESHOLDS, 'hold').state).toBe('hold');
    expect(evaluateState(sample(0, 29), THRESHOLDS, 'hold').state).toBe('ok');
  });

  it('no cpu signal leaves the memory verdict untouched', () => {
    expect(evaluateState(sample(0, null), THRESHOLDS, 'ok').state).toBe('ok');
  });

  it('cpu still counts when memory is in degraded mode', () => {
    const s = { ...sample(0, 60), pressureAvailable: false, globalPressure: null };
    expect(evaluateState(s, THRESHOLDS, 'ok').state).toBe('backoff');
  });
});

describe('defaultResourceBackend', () => {
  it('picks the backend by platform', () => {
    expect(defaultResourceBackend('darwin')).toBeInstanceOf(DarwinResourceBackend);
    expect(defaultResourceBackend('linux')).toBeInstanceOf(LinuxResourceBackend);
    expect(defaultResourceBackend('win32')).toBeInstanceOf(LinuxResourceBackend);
  });
});

describe('pressureScore (memory scale)', () => {
  it('equals memory when there is no cpu signal', () => {
    expect(pressureScore(sample(7, null))).toBe(7);
  });

  it('maps the cpu thresholds onto the memory ones, continuously', () => {
    expect(pressureScore(sample(0, 33))).toBeCloseTo(10, 6);
    expect(pressureScore(sample(0, 50))).toBeCloseTo(25, 6);
    expect(pressureScore(sample(0, 50.0001))).toBeCloseTo(25, 3);
    expect(pressureScore(sample(0, 60))).toBe(35);
  });

  it('takes the worse of the two', () => {
    expect(pressureScore(sample(30, 40))).toBe(30);
    expect(pressureScore(sample(2, 60))).toBe(35);
  });
});

describe('governor budgets react to cpu saturation', () => {
  const opts = { cpuCount: 18, totalMemBytes: 256 * GB, testRunEstRamMb: 1024 };
  it('test-run narrows to 1 when cores are 2.5x oversubscribed', () => {
    const calm = computeClassBudget('test-run', sample(0, 0), opts);
    expect(calm).toBeGreaterThan(1);
    expect(computeClassBudget('test-run', sample(0, 60), opts)).toBe(1);
  });

  it('db-heavy is budgeted on memory alone: cpu backoff never refuses it (T13170)', () => {
    expect(computeClassBudget('db-heavy', sample(0, 0), opts)).toBe(1);
    expect(computeClassBudget('db-heavy', sample(0, 60), opts)).toBe(1);
  });
});
