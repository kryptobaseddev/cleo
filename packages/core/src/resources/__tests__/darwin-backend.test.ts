/**
 * Tests for the macOS ResourceMonitor backend (T12981).
 *
 * Coverage:
 *   - parseDarwinSysctl: full output, unknown names, malformed values,
 *     compressor occupancy
 *   - darwinMemorySome / cpuSomeFromLoad: the PSI-equivalent mapping and the
 *     monitor's verdict on every sampled shape: normal, warning, critical, the
 *     incident, a cold compressor with old swap, laptops and wired local-model
 *     weights at a normal kernel level, headroom running out, no signal (T13127)
 *   - DarwinResourceBackend.sample: shape, one sysctl per TTL, degraded on
 *     failure, memAvailable from free%, the readings carried on the sample
 *   - sweepChildRss: ps parsing
 *   - evaluateState: CPU saturation alone holds/backs off; the worse of
 *     memory and CPU wins; CPU hysteresis
 *   - defaultResourceBackend: platform selection
 *
 * @task T12981
 * @task T13127
 */

import { describe, expect, it } from 'vitest';
import type { PsiData, ResourceSample } from '../backend.js';
import {
  cpuSomeFromLoad,
  DarwinResourceBackend,
  darwinHeadroomFloorBytes,
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
  it('parses the compressor occupancy', () => {
    expect(parseDarwinSysctl('vm.compressor_bytes_used: 2018082816\n').compressorBytes).toBe(
      2018082816,
    );
    expect(parseDarwinSysctl(LOADED).compressorBytes).toBeNull();
  });

  it('parses every signal from real output', () => {
    const s = parseDarwinSysctl(LOADED);
    expect(s.pressureLevel).toBe(2);
    expect(s.freePercent).toBe(41);
    expect(s.swapTotalBytes).toBe(13312 * MB);
    expect(s.swapUsedBytes).toBe(Math.round(11625.69 * MB));
    expect(
      Number.isInteger(
        parseDarwinSysctl('vm.swapusage: total = 2.00M  used = 1.88M  free = 0.12M\n')
          .swapUsedBytes,
      ),
    ).toBe(true);
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
  const RAM8 = 8 * GB;
  const RAM16 = 16 * GB;
  const RAM48 = 48 * GB;
  const RAM64 = 64 * GB;
  const some = (out: string, ram = RAM48): number | null =>
    darwinMemorySome(parseDarwinSysctl(out), ram);
  /** A sample built the way the backend builds one, for the monitor's verdict. */
  const stateOf = (out: string, ram = RAM48) => {
    const { memory, cpu } = darwinPressure(parseDarwinSysctl(out), ram);
    const s: ResourceSample = {
      sampledAtMs: 0,
      pressureAvailable: memory !== null,
      memAvailableBytes: 1,
      globalPressure: memory,
      slicePressure: null,
      cpuPressure: cpu,
      walObservations: [],
    };
    return classifyPressure(s).state;
  };
  const swap = (usedGib: number, totalGib = usedGib + 1) =>
    `vm.swapusage: total = ${totalGib * 1024}.00M  used = ${usedGib * 1024}.00M  free = ${(totalGib - usedGib) * 1024}.00M  (encrypted)\n`;
  const normal = (level: number) =>
    `kern.memorystatus_vm_pressure_level: 1\nkern.memorystatus_level: ${level}\n`;
  const warning = (level: number) =>
    `kern.memorystatus_vm_pressure_level: 2\nkern.memorystatus_level: ${level}\n`;

  it('normal: an idle Mac (89% neither wired nor compressed, no swap) scores zero', () => {
    expect(some(`${normal(89)}vm.compressor_bytes_used: 2018082816\n${swap(0, 0)}`, RAM64)).toBe(0);
    expect(some(CALM)).toBe(0);
  });

  it('warning: the kernel warning alone holds', () => {
    const s = some('kern.memorystatus_vm_pressure_level: 2\n');
    expect(s).toBe(15);
    expect(stateOf('kern.memorystatus_vm_pressure_level: 2\n')).toBe('hold');
  });

  it('critical: the kernel critical level backs off', () => {
    expect(some('kern.memorystatus_vm_pressure_level: 4\n')).toBeGreaterThan(
      THRESHOLDS.backoffSomeAvg10,
    );
    expect(stateOf('kern.memorystatus_vm_pressure_level: 4\n')).toBe('backoff');
  });

  it('the 2026-10-03 incident shape backs off (it scored 15, hold, before T13127)', () => {
    const out = `${warning(41)}vm.compressor_bytes_used: ${15 * GB}\n${swap(13.6, 15.4)}`;
    // 15 + (0.59 − 0.50) × 100 + 50 × 13.6/48
    expect(some(out)).toBeCloseTo(15 + 9 + 50 * (13.6 / 48), 6);
    expect(stateOf(out)).toBe('backoff');
  });

  it('the loaded capture (kernel warning, 41% free, 11.4 GiB swap) backs off too', () => {
    expect(some(LOADED)).toBeCloseTo(15 + 9 + 50 * ((11625.69 * MB) / RAM48), 6);
    expect(stateOf(LOADED)).toBe('backoff');
  });

  it('a kernel warning with a cold compressor and old swap only holds', () => {
    // 35% wired or compressed: swap counts at a quarter weight.
    const out = `${warning(65)}${swap(13)}`;
    expect(some(out)).toBeCloseTo(15 + 50 * 0.25 * (13 / 48), 6);
    expect(stateOf(out)).toBe('hold');
  });

  describe('a normal kernel level is never pressure from old swap or a big wired share (review MED 1)', () => {
    it('16 GiB laptop, 44% wired or compressed, 6 GiB of old swap', () => {
      expect(some(`${normal(56)}${swap(6, 7)}`, RAM16)).toBe(0);
    });
    it('16 GiB laptop, 42% wired or compressed, 4 GiB of old swap', () => {
      expect(some(`${normal(58)}${swap(4, 5)}`, RAM16)).toBe(0);
    });
    it('8 GiB Air, 44% wired or compressed, 3 GiB of swap', () => {
      expect(some(`${normal(56)}${swap(3, 4)}`, RAM8)).toBe(0);
    });
    it('64 GiB Mac, 40 GiB of wired model weights, 21 GiB left', () => {
      expect(some(normal(33), RAM64)).toBe(0);
    });
    it('128 GiB Mac, 80 GiB wired, 45 GiB left', () => {
      expect(some(normal(35), 128 * GB)).toBe(0);
    });
    it('even swap nearly full on the swapfiles allocated so far', () => {
      expect(some(`${normal(70)}${swap(6.9, 7)}`, RAM16)).toBe(0);
    });
  });

  it('headroom running out scores at any kernel level, in bytes against one worker', () => {
    // 48 GiB: floor 6 GiB. 92% wired or compressed leaves 3.84 GiB.
    expect(some(normal(8))).toBeCloseTo(30 * (1 - (0.08 * RAM48) / (6 * GB)), 6);
    // 8 GiB Air: floor 2 GiB. 95% leaves 0.4 GiB: backoff.
    expect(some(normal(5), RAM8)).toBeCloseTo(30 * (1 - (0.05 * RAM8) / (2 * GB)), 6);
    expect(stateOf(normal(5), RAM8)).toBe('backoff');
    expect(darwinHeadroomFloorBytes(RAM48)).toBe(6 * GB);
    expect(darwinHeadroomFloorBytes(RAM8)).toBe(2 * GB);
  });

  it('the compressor share counts when the kernel level is unreadable, or larger', () => {
    // 47 GiB compressed on 48 GiB, no memorystatus_level: 1 GiB headroom left
    expect(some(`vm.compressor_bytes_used: ${47 * GB}\n`)).toBeCloseTo(30 * (1 - 1 / 6), 6);
    // the larger of the two wins
    expect(some(`kern.memorystatus_level: 70\nvm.compressor_bytes_used: ${47 * GB}\n`)).toBeCloseTo(
      30 * (1 - 1 / 6),
      6,
    );
  });

  it('returns null when no memory signal is readable; swap alone is not a signal', () => {
    expect(some('hw.ncpu: 4\n')).toBeNull();
    expect(some(swap(2, 2))).toBeNull();
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
    expect(darwinPressure(loaded, 48 * GB).cpu?.some.avg10).toBe(50);
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
    expect(s.globalPressure?.some.avg10).toBeCloseTo(
      15 + 9 + 50 * ((11625.69 * MB) / (48 * GB)),
      6,
    );
    expect(s.slicePressure).toBeNull();
    // The readings travel with the sample, so status and reports can show them.
    expect(s.darwinMemory).toEqual({
      pressureLevel: 2,
      availablePercent: 41,
      compressorBytes: null,
      swapUsedBytes: Math.round(11625.69 * MB),
      swapTotalBytes: 13312 * MB,
      totalBytes: 48 * GB,
    });
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
    expect(s.darwinMemory).toBeNull();
    // sysctl unavailable: no memory signal, so the monitor runs in degraded mode.
    expect(classifyPressure(s).state).toBe('ok');
  });

  it('reads the compressor in the same single sysctl exec (no vm_stat spawn)', async () => {
    const asked: string[][] = [];
    const backend = new DarwinResourceBackend({
      sysctlFn: async (names) => {
        asked.push([...names]);
        return `${LOADED}vm.compressor_bytes_used: ${20 * GB}\n`;
      },
      totalMemBytes: 48 * GB,
    });
    const s = await backend.sample();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('vm.compressor_bytes_used');
    expect(asked[0]).toContain('vm.swapusage');
    expect(asked[0]).toContain('kern.memorystatus_vm_pressure_level');
    expect(s.darwinMemory?.compressorBytes).toBe(20 * GB);
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
  const opts = { cpuCount: 18, totalMemBytes: 256 * GB };
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
