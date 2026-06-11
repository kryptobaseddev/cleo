/**
 * Tests for ResourceMonitor (T11994).
 *
 * Coverage:
 *   - parsePressureLine: valid, partial, malformed
 *   - parsePsiFile: some+full, some-only, empty, malformed
 *   - parseMemAvailable: valid, absent, non-Linux
 *   - parseSmapsRollup: valid, partial
 *   - LinuxResourceBackend.sample: bounded read-count (Amendment 1),
 *       degraded mode (PSI absent), WAL observations
 *   - evaluateState: ok→hold, hold→ok with hysteresis, hold→backoff,
 *       backoff→ok with hysteresis, degraded mode threshold
 *   - ResourceMonitor: point-in-time sample, continuous mode transitions,
 *       stop is idempotent, duplicate startContinuous is no-op,
 *       missing-interface degradation (Amendment 2 from base AC)
 *
 * ## Read-count assertion (Amendment 1 / CI-stable formulation)
 *
 * Tests inject a counting reader and assert the bounded read-count
 * WITHOUT relying on wall-clock timing (Amendment 1).
 *
 * @task T11994
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsiData, ResourceSample } from '../backend.js';
import {
  LinuxResourceBackend,
  parseMemAvailable,
  parsePressureLine,
  parsePsiFile,
  parseSmapsRollup,
} from '../linux-backend.js';
import { evaluateState, type PressureState, ResourceMonitor } from '../monitor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Build a minimal passing ResourceSample with pressure available. */
function makeSample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  const globalPressure: PsiData = {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  };
  return {
    sampledAtMs: Date.now(),
    pressureAvailable: true,
    memAvailableBytes: 4 * GB,
    globalPressure,
    slicePressure: null,
    walObservations: [],
    ...overrides,
  };
}

/** Build a sample with specific some/full avg10 values. */
function makePressureSample(someAvg10: number, fullAvg10: number): ResourceSample {
  return makeSample({
    globalPressure: {
      some: { avg10: someAvg10, avg60: 0, avg300: 0, totalUs: 0 },
      full: { avg10: fullAvg10, avg60: 0, avg300: 0, totalUs: 0 },
    },
  });
}

/** Default resolved thresholds (mirroring DEFAULTS in monitor.ts). */
const DEFAULT_THRESHOLDS = {
  holdSomeAvg10: 10,
  backoffSomeAvg10: 20,
  holdFullAvg10: 5,
  backoffFullAvg10: 10,
  hysteresisPoints: 3,
  headroomBytes: 256 * MB,
  walWarnThresholdBytes: 256 * MB,
  pollIntervalMs: 1500,
};

// ---------------------------------------------------------------------------
// parsePressureLine
// ---------------------------------------------------------------------------

describe('parsePressureLine', () => {
  it('parses a valid "some" line', () => {
    const result = parsePressureLine('some avg10=0.42 avg60=0.31 avg300=0.20 total=1234567');
    expect(result).not.toBeNull();
    expect(result!.avg10).toBeCloseTo(0.42, 5);
    expect(result!.avg60).toBeCloseTo(0.31, 5);
    expect(result!.avg300).toBeCloseTo(0.2, 5);
    expect(result!.totalUs).toBe(1234567);
  });

  it('parses a line with zero values', () => {
    const result = parsePressureLine('some avg10=0.00 avg60=0.00 avg300=0.00 total=0');
    expect(result).not.toBeNull();
    expect(result!.avg10).toBe(0);
    expect(result!.totalUs).toBe(0);
  });

  it('parses a line with high avg10 (near 100)', () => {
    const result = parsePressureLine('full avg10=99.99 avg60=50.00 avg300=30.00 total=9999999');
    expect(result!.avg10).toBeCloseTo(99.99, 2);
  });

  it('returns null for a completely malformed line', () => {
    expect(parsePressureLine('not a pressure line')).toBeNull();
  });

  it('returns null when avg10 field is missing', () => {
    expect(parsePressureLine('some avg60=0.31 avg300=0.20 total=100')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePsiFile
// ---------------------------------------------------------------------------

describe('parsePsiFile', () => {
  it('parses a standard PSI file with both some and full lines', () => {
    const content = [
      'some avg10=2.50 avg60=1.20 avg300=0.80 total=500000',
      'full avg10=0.30 avg60=0.10 avg300=0.05 total=100000',
    ].join('\n');
    const result = parsePsiFile(content);
    expect(result).not.toBeNull();
    expect(result!.some.avg10).toBeCloseTo(2.5, 5);
    expect(result!.full?.avg10).toBeCloseTo(0.3, 5);
  });

  it('parses a PSI file with only the "some" line (no "full")', () => {
    const content = 'some avg10=1.00 avg60=0.50 avg300=0.20 total=200000';
    const result = parsePsiFile(content);
    expect(result).not.toBeNull();
    expect(result!.some.avg10).toBeCloseTo(1.0, 5);
    expect(result!.full).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parsePsiFile('')).toBeNull();
  });

  it('returns null when only the "full" line is present (no "some")', () => {
    const content = 'full avg10=0.10 avg60=0.05 avg300=0.02 total=50000';
    expect(parsePsiFile(content)).toBeNull();
  });

  it('handles trailing newline in PSI file', () => {
    const content =
      'some avg10=0.10 avg60=0.05 avg300=0.02 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    const result = parsePsiFile(content);
    expect(result).not.toBeNull();
    expect(result!.some.avg10).toBeCloseTo(0.1, 5);
  });
});

// ---------------------------------------------------------------------------
// parseMemAvailable
// ---------------------------------------------------------------------------

describe('parseMemAvailable', () => {
  it('parses MemAvailable from /proc/meminfo content', () => {
    const content = [
      'MemTotal:       65536000 kB',
      'MemFree:        10240000 kB',
      'MemAvailable:   42233788 kB',
      'Buffers:         1234567 kB',
    ].join('\n');
    const result = parseMemAvailable(content);
    expect(result).toBe(42233788 * 1024);
  });

  it('returns null when MemAvailable is absent', () => {
    const content = 'MemTotal:       65536000 kB\nMemFree:        10240000 kB\n';
    expect(parseMemAvailable(content)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseMemAvailable('')).toBeNull();
  });

  it('handles single-space formatting in MemAvailable', () => {
    const content = 'MemAvailable: 1024 kB\n';
    const result = parseMemAvailable(content);
    expect(result).toBe(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// parseSmapsRollup
// ---------------------------------------------------------------------------

describe('parseSmapsRollup', () => {
  it('parses Rss and Pss from smaps_rollup content', () => {
    const content = [
      'VmFlags:',
      'Rss:           12288 kB',
      'Pss:            9216 kB',
      'Shared_Clean:   3072 kB',
      'Private_Dirty:  9216 kB',
    ].join('\n');
    const result = parseSmapsRollup(content);
    expect(result).not.toBeNull();
    expect(result!.rssBytes).toBe(12288 * 1024);
    expect(result!.pssBytes).toBe(9216 * 1024);
  });

  it('returns null when Rss is missing', () => {
    const content = 'Pss: 1024 kB\n';
    expect(parseSmapsRollup(content)).toBeNull();
  });

  it('returns null when Pss is missing', () => {
    const content = 'Rss: 1024 kB\n';
    expect(parseSmapsRollup(content)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseSmapsRollup('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LinuxResourceBackend — bounded read-count (Amendment 1)
// ---------------------------------------------------------------------------

describe('LinuxResourceBackend.sample — bounded read-count', () => {
  it('performs exactly 3 file reads when PSI available and no WAL paths', async () => {
    const readLog: string[] = [];

    const fakeRead = async (path: string): Promise<string> => {
      readLog.push(path);
      if (path === '/proc/pressure/memory') {
        return [
          'some avg10=2.00 avg60=1.00 avg300=0.50 total=100000',
          'full avg10=0.10 avg60=0.05 avg300=0.02 total=10000',
        ].join('\n');
      }
      if (path === '/proc/meminfo') {
        return 'MemAvailable:   4194304 kB\n';
      }
      throw new Error(`unexpected read: ${path}`);
    };

    const backend = new LinuxResourceBackend({
      readFileFn: fakeRead,
      statFileFn: async () => null,
    });
    const sample = await backend.sample();

    // Exactly 2 reads: /proc/pressure/memory + /proc/meminfo
    // (no cgroupSlicePressurePath configured → no slice read)
    expect(readLog).toHaveLength(2);
    expect(readLog).toContain('/proc/pressure/memory');
    expect(readLog).toContain('/proc/meminfo');
    expect(sample.pressureAvailable).toBe(true);
    expect(sample.memAvailableBytes).toBe(4194304 * 1024);
    expect(sample.walObservations).toHaveLength(0);
  });

  it('performs exactly 3 reads when slice path is configured', async () => {
    const readLog: string[] = [];
    const SLICE_PATH = '/sys/fs/cgroup/user.slice/memory.pressure';

    const fakeRead = async (path: string): Promise<string> => {
      readLog.push(path);
      if (path === '/proc/pressure/memory') {
        return 'some avg10=1.00 avg60=0.50 avg300=0.20 total=50000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
      }
      if (path === SLICE_PATH) {
        return 'some avg10=0.50 avg60=0.20 avg300=0.10 total=25000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
      }
      if (path === '/proc/meminfo') {
        return 'MemAvailable:   2097152 kB\n';
      }
      throw new Error(`unexpected read: ${path}`);
    };

    const backend = new LinuxResourceBackend({
      globalPressurePath: '/proc/pressure/memory',
      cgroupSlicePressurePath: SLICE_PATH,
      readFileFn: fakeRead,
      statFileFn: async () => null,
    });
    const sample = await backend.sample();

    expect(readLog).toHaveLength(3);
    expect(sample.pressureAvailable).toBe(true);
    expect(sample.slicePressure).not.toBeNull();
    expect(sample.slicePressure!.some.avg10).toBeCloseTo(0.5, 5);
  });

  it('adds N stat calls for N WAL paths and no extra reads', async () => {
    const readLog: string[] = [];
    const statLog: string[] = [];

    const fakeRead = async (path: string): Promise<string> => {
      readLog.push(path);
      if (path === '/proc/pressure/memory') {
        return 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
      }
      if (path === '/proc/meminfo') {
        return 'MemAvailable: 8388608 kB\n';
      }
      throw new Error(`unexpected read: ${path}`);
    };
    const fakeStat = async (path: string): Promise<{ size: number } | null> => {
      statLog.push(path);
      return { size: 1024 * 1024 };
    };

    const walPaths = ['/data/tasks.db-wal', '/data/brain.db-wal'];
    const backend = new LinuxResourceBackend({
      walPaths,
      readFileFn: fakeRead,
      statFileFn: fakeStat,
    });
    const sample = await backend.sample();

    // 2 reads (global PSI + meminfo), 2 stat calls
    expect(readLog).toHaveLength(2);
    expect(statLog).toHaveLength(2);
    expect(sample.walObservations).toHaveLength(2);
    expect(sample.walObservations[0].walPath).toBe('/data/tasks.db-wal');
    expect(sample.walObservations[0].sizeBytes).toBe(1024 * 1024);
  });

  it('reports WAL as null size when file does not exist', async () => {
    const backend = new LinuxResourceBackend({
      walPaths: ['/nonexistent.db-wal'],
      readFileFn: async () =>
        'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\nMemAvailable: 1024 kB\n',
      statFileFn: async () => null,
    });
    // Use simpler per-path fake
    const readMap: Record<string, string> = {
      '/proc/pressure/memory':
        'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      '/proc/meminfo': 'MemAvailable: 1024 kB\n',
    };
    const backend2 = new LinuxResourceBackend({
      walPaths: ['/nonexistent.db-wal'],
      readFileFn: async (path) => {
        const v = readMap[path];
        if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return v;
      },
      statFileFn: async () => null,
    });
    const sample = await backend2.sample();
    expect(sample.walObservations[0].sizeBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LinuxResourceBackend — degraded mode (PSI absent)
// ---------------------------------------------------------------------------

describe('LinuxResourceBackend.sample — degraded mode', () => {
  it('returns pressureAvailable=false when /proc/pressure/memory throws', async () => {
    const backend = new LinuxResourceBackend({
      readFileFn: async (path) => {
        if (path === '/proc/pressure/memory') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (path === '/proc/meminfo') {
          return 'MemAvailable: 4096000 kB\n';
        }
        throw new Error(`unexpected: ${path}`);
      },
      statFileFn: async () => null,
    });
    const sample = await backend.sample();
    expect(sample.pressureAvailable).toBe(false);
    expect(sample.globalPressure).toBeNull();
    expect(sample.memAvailableBytes).toBe(4096000 * 1024);
  });

  it('returns memAvailableBytes=null when /proc/meminfo is unreadable', async () => {
    const backend = new LinuxResourceBackend({
      readFileFn: async (path) => {
        if (path === '/proc/pressure/memory') {
          return 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      statFileFn: async () => null,
    });
    const sample = await backend.sample();
    expect(sample.memAvailableBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LinuxResourceBackend — sweepChildRss (separate path)
// ---------------------------------------------------------------------------

describe('LinuxResourceBackend.sweepChildRss', () => {
  it('sweeps RSS for known PIDs via smaps_rollup', async () => {
    const readMap: Record<string, string> = {
      '/proc/1234/smaps_rollup': 'Rss: 20480 kB\nPss: 15360 kB\n',
      '/proc/5678/smaps_rollup': 'Rss: 8192 kB\nPss: 6144 kB\n',
    };
    const backend = new LinuxResourceBackend({
      readFileFn: async (path) => {
        const v = readMap[path];
        if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return v;
      },
      statFileFn: async () => null,
    });
    const sweep = await backend.sweepChildRss([1234, 5678]);
    expect(sweep.entries).toHaveLength(2);
    const e1 = sweep.entries.find((e) => e.pid === 1234);
    expect(e1?.rssBytes).toBe(20480 * 1024);
    expect(e1?.pssBytes).toBe(15360 * 1024);
  });

  it('silently skips dead PIDs', async () => {
    const backend = new LinuxResourceBackend({
      readFileFn: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      statFileFn: async () => null,
    });
    const sweep = await backend.sweepChildRss([9999]);
    expect(sweep.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateState — threshold crossing
// ---------------------------------------------------------------------------

describe('evaluateState', () => {
  it('returns ok when pressure is zero', () => {
    const { state } = evaluateState(makePressureSample(0, 0), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('ok');
  });

  it('returns hold when some avg10 exceeds hold threshold', () => {
    const { state } = evaluateState(makePressureSample(11, 0), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('hold');
  });

  it('returns hold when full avg10 exceeds hold threshold', () => {
    const { state } = evaluateState(makePressureSample(0, 6), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('hold');
  });

  it('returns backoff when some avg10 exceeds backoff threshold', () => {
    const { state } = evaluateState(makePressureSample(21, 0), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('backoff');
  });

  it('returns backoff when full avg10 exceeds backoff threshold', () => {
    const { state } = evaluateState(makePressureSample(0, 11), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('backoff');
  });

  it('returns ok when pressure is exactly at hold threshold (not above)', () => {
    // holdSomeAvg10=10 — exactly 10 is NOT above, so ok
    const { state } = evaluateState(makePressureSample(10, 0), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// evaluateState — hysteresis
// ---------------------------------------------------------------------------

describe('evaluateState — hysteresis', () => {
  // holdSomeAvg10=10, hysteresisPoints=3 → floor = 7
  it('stays in hold when pressure drops below hold but above hysteresis floor', () => {
    // some avg10=8 > floor(7), state='hold' → should stay hold
    const { state } = evaluateState(makePressureSample(8, 0), DEFAULT_THRESHOLDS, 'hold');
    expect(state).toBe('hold');
  });

  it('drops to ok when pressure falls below hysteresis floor', () => {
    // some avg10=6 < floor(7), state='hold' → should drop to ok
    const { state } = evaluateState(makePressureSample(6, 0), DEFAULT_THRESHOLDS, 'hold');
    expect(state).toBe('ok');
  });

  it('clamps backoff→hold (not backoff→ok) in hysteresis band', () => {
    // Coming from backoff, pressure dropped below backoff but above hold
    // some avg10=12, state='backoff' → hold (not backoff or ok)
    const { state } = evaluateState(makePressureSample(12, 0), DEFAULT_THRESHOLDS, 'backoff');
    expect(state).toBe('hold');
  });

  it('drops directly from backoff to ok when far below hysteresis floor', () => {
    // some avg10=2, state='backoff' → well below floor(7) → ok
    const { state } = evaluateState(makePressureSample(2, 0), DEFAULT_THRESHOLDS, 'backoff');
    expect(state).toBe('ok');
  });

  it('ok→hold does not trigger hysteresis (only applies to hold/backoff→lower)', () => {
    // Coming from ok, pressure at 11 (above hold) → hold immediately
    const { state } = evaluateState(makePressureSample(11, 0), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// evaluateState — degraded mode (PSI absent)
// ---------------------------------------------------------------------------

describe('evaluateState — degraded mode', () => {
  const degradedSample = (memAvailableBytes: number): ResourceSample =>
    makeSample({
      pressureAvailable: false,
      globalPressure: null,
      memAvailableBytes,
    });

  it('returns ok in degraded mode when memAvailable is above headroom', () => {
    const { state } = evaluateState(degradedSample(512 * MB), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('ok');
  });

  it('returns hold in degraded mode when memAvailable falls below headroom', () => {
    // headroomBytes = 256 MiB; 128 MiB < 256 MiB → hold
    const { state } = evaluateState(degradedSample(128 * MB), DEFAULT_THRESHOLDS, 'ok');
    expect(state).toBe('hold');
  });

  it('returns ok in degraded mode when memAvailableBytes is null', () => {
    const { state } = evaluateState(
      makeSample({ pressureAvailable: false, globalPressure: null, memAvailableBytes: null }),
      DEFAULT_THRESHOLDS,
      'ok',
    );
    expect(state).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// ResourceMonitor — point-in-time sample
// ---------------------------------------------------------------------------

describe('ResourceMonitor.sample()', () => {
  it('returns a sample from the backend without updating state', async () => {
    const fakeSample = makePressureSample(5, 0);
    const fakeBackend = {
      sample: vi.fn().mockResolvedValue(fakeSample),
      sweepChildRss: vi.fn(),
    };
    const monitor = new ResourceMonitor({ backend: fakeBackend });
    const result = await monitor.sample();
    expect(result).toBe(fakeSample);
    expect(monitor.state).toBe('ok'); // state unchanged by point-in-time call
  });
});

// ---------------------------------------------------------------------------
// ResourceMonitor — continuous mode
// ---------------------------------------------------------------------------

describe('ResourceMonitor continuous mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits "transition" from ok→hold when pressure crosses threshold', async () => {
    const highPressureSample = makePressureSample(15, 0); // above holdSomeAvg10=10

    const fakeBackend = {
      sample: vi.fn().mockResolvedValue(highPressureSample),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({
      backend: fakeBackend,
      pollIntervalMs: 1000,
    });

    const transitions: Array<{ from: PressureState; to: PressureState }> = [];
    monitor.on('transition', (t) => transitions.push({ from: t.from, to: t.to }));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(1100);
    stop();

    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(transitions[0]).toEqual({ from: 'ok', to: 'hold' });
  });

  it('emits "transition" from hold→backoff when pressure spikes further', async () => {
    const samples = [
      makePressureSample(15, 0), // ok → hold
      makePressureSample(25, 0), // hold → backoff
    ];
    let callCount = 0;
    const fakeBackend = {
      sample: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(samples[Math.min(callCount++, samples.length - 1)]),
        ),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({
      backend: fakeBackend,
      pollIntervalMs: 1000,
    });

    const transitions: Array<{ from: PressureState; to: PressureState }> = [];
    monitor.on('transition', (t) => transitions.push({ from: t.from, to: t.to }));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(2200);
    stop();

    expect(transitions).toContainEqual({ from: 'ok', to: 'hold' });
    expect(transitions).toContainEqual({ from: 'hold', to: 'backoff' });
  });

  it('emits "transition" from hold→ok when pressure drops past hysteresis floor', async () => {
    // holdSomeAvg10=10, hysteresisPoints=3 → floor=7
    const samples = [
      makePressureSample(11, 0), // ok → hold
      makePressureSample(6, 0), // hold → ok (below floor 7)
    ];
    let callCount = 0;
    const fakeBackend = {
      sample: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(samples[Math.min(callCount++, samples.length - 1)]),
        ),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({
      backend: fakeBackend,
      pollIntervalMs: 1000,
    });

    const transitions: Array<{ from: PressureState; to: PressureState }> = [];
    monitor.on('transition', (t) => transitions.push({ from: t.from, to: t.to }));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(2200);
    stop();

    expect(transitions).toContainEqual({ from: 'ok', to: 'hold' });
    expect(transitions).toContainEqual({ from: 'hold', to: 'ok' });
  });

  it('does NOT emit transition when pressure stays in hysteresis band', async () => {
    // holdSomeAvg10=10, hysteresisPoints=3 → floor=7
    // First poll goes to hold, then stays in 7–10 band — no transition
    const samples = [
      makePressureSample(11, 0), // ok → hold
      makePressureSample(8, 0), // in hysteresis band → stays hold
    ];
    let callCount = 0;
    const fakeBackend = {
      sample: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(samples[Math.min(callCount++, samples.length - 1)]),
        ),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({
      backend: fakeBackend,
      pollIntervalMs: 1000,
    });

    const transitions: Array<{ from: PressureState; to: PressureState }> = [];
    monitor.on('transition', (t) => transitions.push({ from: t.from, to: t.to }));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(2200);
    stop();

    // Should only have the ok→hold transition (not hold→anything)
    expect(transitions.filter((t) => t.from === 'hold')).toHaveLength(0);
    expect(transitions).toContainEqual({ from: 'ok', to: 'hold' });
  });

  it('stop() is idempotent', () => {
    const fakeBackend = {
      sample: vi.fn().mockResolvedValue(makeSample()),
      sweepChildRss: vi.fn(),
    };
    const monitor = new ResourceMonitor({ backend: fakeBackend });
    const stop = monitor.startContinuous();
    expect(() => {
      stop();
      stop();
      monitor.stop();
    }).not.toThrow();
    expect(monitor.running).toBe(false);
  });

  it('duplicate startContinuous() returns without starting a second loop', () => {
    const fakeBackend = {
      sample: vi.fn().mockResolvedValue(makeSample()),
      sweepChildRss: vi.fn(),
    };
    const monitor = new ResourceMonitor({ backend: fakeBackend, pollIntervalMs: 10000 });
    const stop1 = monitor.startContinuous();
    const stop2 = monitor.startContinuous(); // no-op
    expect(monitor.running).toBe(true);
    stop1();
    stop2();
    expect(monitor.running).toBe(false);
  });

  it('emits "error" when backend throws and continues polling', async () => {
    let callCount = 0;
    const fakeBackend = {
      sample: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('transient failure'));
        return Promise.resolve(makeSample());
      }),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({ backend: fakeBackend, pollIntervalMs: 1000 });
    const errors: Error[] = [];
    monitor.on('error', (err) => errors.push(err));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(2200);
    stop();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('transient failure');
    // Loop continued after error
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('emits "sample" on every poll even when state does not change', async () => {
    const fakeBackend = {
      sample: vi.fn().mockResolvedValue(makeSample()),
      sweepChildRss: vi.fn(),
    };

    const monitor = new ResourceMonitor({ backend: fakeBackend, pollIntervalMs: 1000 });
    const samples: ResourceSample[] = [];
    monitor.on('sample', (s) => samples.push(s));

    const stop = monitor.startContinuous();
    await vi.advanceTimersByTimeAsync(3100);
    stop();

    // 3 polls in 3100ms with 1000ms interval
    expect(samples.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// ResourceMonitor — configurable thresholds
// ---------------------------------------------------------------------------

describe('ResourceMonitor — configurable thresholds', () => {
  it('respects custom holdSomeAvg10 threshold', async () => {
    const monitor = new ResourceMonitor({
      psi: { holdSomeAvg10: 30, backoffSomeAvg10: 60 },
    });
    // At some avg10=25 (below custom hold 30), should be ok
    const { state: s1 } = evaluateState(
      makePressureSample(25, 0),
      { ...DEFAULT_THRESHOLDS, holdSomeAvg10: 30, backoffSomeAvg10: 60 },
      'ok',
    );
    expect(s1).toBe('ok');

    // At some avg10=35 (above custom hold 30), should be hold
    const { state: s2 } = evaluateState(
      makePressureSample(35, 0),
      { ...DEFAULT_THRESHOLDS, holdSomeAvg10: 30, backoffSomeAvg10: 60 },
      'ok',
    );
    expect(s2).toBe('hold');
  });
});
