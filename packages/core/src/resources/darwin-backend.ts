/**
 * macOS ResourceMonitor backend.
 *
 * macOS has no PSI. This backend maps the kernel's own signals onto the
 * PSI-shaped {@link ResourceSample}, so `evaluateState`, the slot scaling and
 * the memory gate work unchanged:
 *
 *   - `kern.memorystatus_vm_pressure_level` — the kernel's memory pressure
 *     verdict (1 normal, 2 warning, 4 critical), the signal jetsam acts on
 *   - `kern.memorystatus_level` — the share of RAM that is neither wired nor
 *     held by the compressor (active + inactive + free + speculative pages).
 *     Unlike `os.freemem()`, which reads near zero on a healthy Mac, it falls
 *     only as memory is wired or compressed
 *   - `vm.compressor_bytes_used` — RAM the compressor occupies (the
 *     "Compressed" figure of Activity Monitor and vm_stat, read here without a
 *     `vm_stat` spawn)
 *   - `vm.swapusage` — swap in use
 *   - `vm.loadavg` + `hw.perflevel{0,1}.logicalcpu` (or `hw.ncpu`) —
 *     run-queue length per effective core (CPU saturation)
 *
 * ## Sampling discipline (darwin amendment)
 *
 * Node has no sysctl binding, so `sample()` runs ONE `/usr/sbin/sysctl` exec
 * (≈4 ms) for all names, and caches its output for `cacheTtlMs` (default 2 s)
 * across every backend instance in the process. A poll loop or a burst of
 * admissions therefore spawns at most one child per TTL. No other process or
 * file read happens on the sample path; `sweepChildRss` (low frequency) uses
 * `ps`.
 *
 * ## Memory mapping (T13127)
 *
 * `some avg10` is the higher of two scores:
 *
 * - **Kernel level**: warning 15, critical 40. With the monitor's thresholds
 *   (hold 10, backoff 20) and the memory gate's (refuse above 25), a kernel
 *   warning alone holds and a critical refuses heavy work.
 * - **Squeeze**: `q` is the share of RAM wired or compressed
 *   (`1 − memorystatus_level`, or the compressor's share when that is
 *   larger or the level is unreadable). Swap counts on top of `q` in
 *   proportion as `q` rises from {@link DARWIN_SWAP_RAMP} `[0.30, 0.50]`:
 *   swapped pages linger long after pressure has gone (idle apps keep them),
 *   so swap alone, on a machine with RAM to spare, is history, not pressure.
 *   The score is `100 × (q + weight × swap/RAM − 0.40)`, clamped at 0: a box
 *   with 60% of RAM wired or compressed scores 20 (backoff) before any swap.
 *
 * Calibration: real `sysctl` output captured on a 48 GiB Mac under load
 * (kernel warning, 41% neither wired nor compressed, 11.4 GiB swapped) scores
 * 43 and is refused. Before T13127 it scored 15 (hold), so the governor kept
 * admitting heavy work into the 2026-10-03 incident (13.6 of 15.4 GB swap
 * used, 15 GB compressed). An idle Mac (10% wired or compressed) and a laptop
 * carrying old swap with RAM to spare both score 0.
 *
 * `full avg10` is 15 when the kernel reports critical. Memory is instantaneous
 * in all three windows.
 *
 * ## CPU mapping
 *
 * Effective cores are performance cores plus half the efficiency cores (a
 * 6P+12E machine counts as 12; `hw.ncpu` when the split is unknown). With
 * `r = load / cores`, `some = 100 × (r − 1) / r` once `r > 1`: the share of
 * runnable work that is waiting for a core. A box running twice its cores
 * scores 50. avg10/avg60/avg300 come from the 1/5/15 minute load averages.
 *
 * @module resources/darwin-backend
 * @task T12981
 * @task T13127
 * @epic T12978
 */

import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import type {
  ChildRssEntry,
  ChildRssSweep,
  DarwinMemorySignals,
  PressureLine,
  PsiData,
  ResourceBackend,
  ResourceSample,
  WalSizeObservation,
} from './backend.js';
import type { StatFileFn } from './linux-backend.js';

/** The sysctl names one sample reads, in one exec. */
export const DARWIN_SYSCTL_NAMES = [
  'kern.memorystatus_vm_pressure_level',
  'kern.memorystatus_level',
  'vm.compressor_bytes_used',
  'vm.swapusage',
  'vm.loadavg',
  'hw.ncpu',
  'hw.perflevel0.logicalcpu',
  'hw.perflevel1.logicalcpu',
] as const;

/**
 * Injectable sysctl reader: raw `name: value` output for the given names.
 * Defaults to one `/usr/sbin/sysctl` exec. A name the kernel does not know is
 * simply absent from the output.
 */
export type SysctlFn = (names: readonly string[]) => Promise<string>;

/** Injectable per-pid RSS reader for {@link DarwinResourceBackend.sweepChildRss}. */
export type PsRssFn = (pids: readonly number[]) => Promise<string>;

/** Parsed darwin signals; every field is `null` when its sysctl was absent. */
export interface DarwinSignals {
  /** 1 normal, 2 warning, 4 critical. */
  readonly pressureLevel: number | null;
  /**
   * `kern.memorystatus_level`: share of RAM (0–100) that is neither wired nor
   * compressed. (Named for the kernel's "free percentage"; it counts active
   * and inactive pages as well as free ones.)
   */
  readonly freePercent: number | null;
  /** RAM the compressor occupies, in bytes (`vm.compressor_bytes_used`). */
  readonly compressorBytes: number | null;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  /** 1, 5 and 15 minute load averages. */
  readonly loadAvg: readonly [number, number, number] | null;
  readonly ncpu: number | null;
  /** Performance-core logical CPUs (`hw.perflevel0`), when reported. */
  readonly perfCores: number | null;
  /** Efficiency-core logical CPUs (`hw.perflevel1`), when reported. */
  readonly efficiencyCores: number | null;
}

const MIB = 1024 * 1024;

function parseSize(value: string): number | null {
  const m = /^([\d.]+)([KMGT])?$/.exec(value.trim());
  if (!m?.[1]) return null;
  const n = Number.parseFloat(m[1]);
  const unit = { K: 1024, M: MIB, G: 1024 * MIB, T: 1024 * 1024 * MIB }[m[2] ?? ''] ?? 1;
  return Number.isFinite(n) ? n * unit : null;
}

/**
 * Parse `sysctl <names>` output (`name: value` per line).
 *
 * @example
 * ```ts
 * parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 2\nhw.ncpu: 18\n');
 * // → { pressureLevel: 2, ncpu: 18, freePercent: null, ... }
 * ```
 */
export function parseDarwinSysctl(output: string): DarwinSignals {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    values.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const int = (name: string): number | null => {
    const raw = values.get(name);
    if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
    return Number.parseInt(raw, 10);
  };

  let swapTotalBytes: number | null = null;
  let swapUsedBytes: number | null = null;
  const swap = values.get('vm.swapusage');
  if (swap) {
    swapTotalBytes = parseSize(/total = (\S+)/.exec(swap)?.[1] ?? '');
    swapUsedBytes = parseSize(/used = (\S+)/.exec(swap)?.[1] ?? '');
  }

  let loadAvg: [number, number, number] | null = null;
  const load = values.get('vm.loadavg');
  if (load) {
    const nums = load
      .replace(/[{}]/g, ' ')
      .trim()
      .split(/\s+/)
      .map((s) => Number.parseFloat(s));
    if (nums.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) {
      loadAvg = [nums[0] as number, nums[1] as number, nums[2] as number];
    }
  }

  return {
    pressureLevel: int('kern.memorystatus_vm_pressure_level'),
    freePercent: int('kern.memorystatus_level'),
    compressorBytes: int('vm.compressor_bytes_used'),
    swapTotalBytes,
    swapUsedBytes,
    loadAvg,
    ncpu: int('hw.ncpu'),
    perfCores: int('hw.perflevel0.logicalcpu'),
    efficiencyCores: int('hw.perflevel1.logicalcpu'),
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Kernel pressure-level scores on the PSI `some avg10` scale (warning, critical). */
export const DARWIN_LEVEL_SCORES = Object.freeze({ warning: 15, critical: 40 });

/**
 * Share of RAM wired or compressed above which memory starts to score (0.40:
 * 60% of RAM is still neither wired nor compressed).
 */
export const DARWIN_SQUEEZE_KNEE = 0.4;

/**
 * Squeeze range over which swap starts to count, from not at all to in full.
 * Below 30% wired or compressed the machine has RAM to spare and swapped pages
 * are old; from 50% they are part of the squeeze.
 */
export const DARWIN_SWAP_RAMP: readonly [number, number] = [0.3, 0.5];

/**
 * Share of RAM (0–1) that is wired or compressed: `1 − memorystatus_level`,
 * or the compressor's share when that is larger or the level is unreadable.
 * `null` when neither is known.
 *
 * @param s - parsed signals.
 * @param totalBytes - physical RAM in bytes.
 */
export function darwinSqueeze(s: DarwinSignals, totalBytes: number): number | null {
  const fromLevel = s.freePercent === null ? null : 1 - clamp(s.freePercent) / 100;
  const fromCompressor =
    s.compressorBytes === null || totalBytes <= 0
      ? null
      : Math.min(1, Math.max(0, s.compressorBytes / totalBytes));
  if (fromLevel === null) return fromCompressor;
  return fromCompressor === null ? fromLevel : Math.max(fromLevel, fromCompressor);
}

/**
 * Memory pressure score (PSI `some`-equivalent, 0–100) from darwin signals:
 * the higher of the kernel-level score and the squeeze score (see the module
 * doc). Returns `null` when neither the kernel level nor the squeeze is
 * readable.
 *
 * @param s - parsed signals.
 * @param totalBytes - physical RAM in bytes (for the swap and compressor shares).
 *
 * @example
 * ```ts
 * // kernel warning, 41% neither wired nor compressed, 11.4 GiB swap on 48 GiB
 * darwinMemorySome(signals, 48 * 1024 ** 3); // → 42.7: refused
 * ```
 */
export function darwinMemorySome(s: DarwinSignals, totalBytes: number): number | null {
  const squeeze = darwinSqueeze(s, totalBytes);
  if (s.pressureLevel === null && squeeze === null) return null;
  const levelScore =
    s.pressureLevel === 4
      ? DARWIN_LEVEL_SCORES.critical
      : s.pressureLevel === 2
        ? DARWIN_LEVEL_SCORES.warning
        : 0;
  let squeezeScore = 0;
  if (squeeze !== null) {
    const [from, full] = DARWIN_SWAP_RAMP;
    const weight = Math.max(0, Math.min(1, (squeeze - from) / (full - from)));
    const swapShare =
      s.swapUsedBytes === null || totalBytes <= 0 ? 0 : Math.max(0, s.swapUsedBytes / totalBytes);
    squeezeScore = 100 * Math.max(0, squeeze + weight * swapShare - DARWIN_SQUEEZE_KNEE);
  }
  return clamp(Math.max(levelScore, squeezeScore));
}

/**
 * Cores that absorb load: performance cores plus half the efficiency cores,
 * else `hw.ncpu`. `null` when neither is known.
 */
export function effectiveCores(s: DarwinSignals): number | null {
  if (s.perfCores !== null && s.perfCores > 0) {
    return s.perfCores + (s.efficiencyCores ?? 0) / 2;
  }
  return s.ncpu;
}

/** CPU waiting share (0–100) for a load average on `ncpu` cores. */
export function cpuSomeFromLoad(load: number, ncpu: number): number {
  const r = load / Math.max(1, ncpu);
  return r <= 1 ? 0 : clamp((100 * (r - 1)) / r);
}

function line(avg10: number, avg60: number, avg300: number): PressureLine {
  return { avg10, avg60, avg300, totalUs: 0 };
}

/**
 * Build the memory and CPU PSI-equivalents from parsed signals.
 *
 * @param s - parsed signals.
 * @param totalBytes - physical RAM in bytes.
 */
export function darwinPressure(
  s: DarwinSignals,
  totalBytes: number,
): {
  memory: PsiData | null;
  cpu: PsiData | null;
} {
  const some = darwinMemorySome(s, totalBytes);
  const memory: PsiData | null =
    some === null
      ? null
      : {
          some: line(some, some, some),
          full: s.pressureLevel === 4 ? line(15, 15, 15) : line(0, 0, 0),
        };
  let cpu: PsiData | null = null;
  const cores = effectiveCores(s);
  if (s.loadAvg && cores) {
    const [l1, l5, l15] = s.loadAvg;
    cpu = {
      some: line(
        cpuSomeFromLoad(l1, cores),
        cpuSomeFromLoad(l5, cores),
        cpuSomeFromLoad(l15, cores),
      ),
      full: null,
    };
  }
  return { memory, cpu };
}

/** The memory half of the parsed signals, as carried on the sample. */
function darwinMemorySignals(s: DarwinSignals, totalBytes: number): DarwinMemorySignals {
  return {
    pressureLevel: s.pressureLevel,
    availablePercent: s.freePercent,
    compressorBytes: s.compressorBytes,
    swapUsedBytes: s.swapUsedBytes,
    swapTotalBytes: s.swapTotalBytes,
    totalBytes,
  };
}

const defaultSysctl: SysctlFn = (names) =>
  new Promise((resolve, reject) => {
    execFile('/usr/sbin/sysctl', [...names], { timeout: 2000 }, (err, stdout) => {
      // sysctl exits non-zero when ONE name is unknown but still prints the
      // others; keep whatever it printed.
      if (stdout) resolve(stdout);
      else reject(err ?? new Error('sysctl produced no output'));
    });
  });

const defaultPsRss: PsRssFn = (pids) =>
  new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', 'pid=,rss=', '-p', pids.join(',')],
      { timeout: 2000 },
      (_err, stdout) => resolve(stdout ?? ''),
    );
  });

const defaultStat: StatFileFn = async (path) => {
  const { stat } = await import('node:fs/promises');
  try {
    return { size: (await stat(path)).size };
  } catch {
    return null;
  }
};

/** Options for {@link DarwinResourceBackend}. */
export interface DarwinBackendOptions {
  /** SQLite `-wal` sidecars to watch (same role as on Linux). */
  readonly walPaths?: readonly string[];
  /** How long one sysctl read is reused. @defaultValue 2000 */
  readonly cacheTtlMs?: number;
  /** Injectable sysctl reader (tests). Injected readers bypass the shared cache. */
  readonly sysctlFn?: SysctlFn;
  /** Injectable `ps` reader (tests). */
  readonly psRssFn?: PsRssFn;
  /** Injectable stat (tests). */
  readonly statFileFn?: StatFileFn;
  /** Total RAM in bytes, for `memAvailableBytes`. @defaultValue os.totalmem() */
  readonly totalMemBytes?: number;
  /** Clock (tests). @defaultValue Date.now */
  readonly now?: () => number;
}

/** Process-wide cache of the default sysctl read. */
let sharedRead: { at: number; output: Promise<string> } | null = null;

/** Reset the process-wide sysctl cache (tests). @internal */
export function resetDarwinSysctlCache(): void {
  sharedRead = null;
}

/**
 * macOS implementation of {@link ResourceBackend}.
 *
 * `pressureAvailable` is `true` when the kernel memory signals were readable,
 * so `evaluateState` uses the PSI path rather than degraded mode.
 */
export class DarwinResourceBackend implements ResourceBackend {
  private readonly walPaths: readonly string[];
  private readonly cacheTtlMs: number;
  private readonly sysctlFn: SysctlFn | null;
  private readonly psRssFn: PsRssFn;
  private readonly statFileFn: StatFileFn;
  private readonly totalMemBytes: number;
  private readonly now: () => number;
  private local: { at: number; output: Promise<string> } | null = null;

  constructor(opts: DarwinBackendOptions = {}) {
    this.walPaths = opts.walPaths ?? [];
    this.cacheTtlMs = opts.cacheTtlMs ?? 2000;
    this.sysctlFn = opts.sysctlFn ?? null;
    this.psRssFn = opts.psRssFn ?? defaultPsRss;
    this.statFileFn = opts.statFileFn ?? defaultStat;
    this.totalMemBytes = opts.totalMemBytes ?? totalmem();
    this.now = opts.now ?? Date.now;
  }

  /** At most one sysctl exec per TTL; on failure the sample is degraded. */
  async sample(): Promise<ResourceSample> {
    const sampledAtMs = this.now();
    let signals: DarwinSignals | null = null;
    try {
      signals = parseDarwinSysctl(await this.readSysctl(sampledAtMs));
    } catch {
      signals = null;
    }
    const { memory, cpu } = signals
      ? darwinPressure(signals, this.totalMemBytes)
      : { memory: null, cpu: null };
    const memAvailableBytes =
      signals?.freePercent != null
        ? Math.round((signals.freePercent / 100) * this.totalMemBytes)
        : null;
    const walObservations: WalSizeObservation[] = [];
    for (const walPath of this.walPaths) {
      const info = await this.statFileFn(walPath);
      walObservations.push({ walPath, sizeBytes: info?.size ?? null });
    }
    return {
      sampledAtMs,
      pressureAvailable: memory !== null,
      memAvailableBytes,
      globalPressure: memory,
      slicePressure: null,
      cpuPressure: cpu,
      darwinMemory: signals ? darwinMemorySignals(signals, this.totalMemBytes) : null,
      walObservations,
    };
  }

  /** RSS via one `ps` exec (no PSS on macOS: `pssBytes` mirrors RSS). */
  async sweepChildRss(pids: readonly number[]): Promise<ChildRssSweep> {
    const sampledAtMs = this.now();
    const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (wanted.length === 0) return { sampledAtMs, entries: [] };
    const entries: ChildRssEntry[] = [];
    for (const row of (await this.psRssFn(wanted)).split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
      if (!m?.[1] || !m[2]) continue;
      const rssBytes = Number.parseInt(m[2], 10) * 1024;
      entries.push({ pid: Number.parseInt(m[1], 10), rssBytes, pssBytes: rssBytes });
    }
    return { sampledAtMs, entries };
  }

  private readSysctl(at: number): Promise<string> {
    const fresh = (c: { at: number } | null): boolean =>
      c !== null && at - c.at < this.cacheTtlMs && at >= c.at;
    if (this.sysctlFn) {
      if (!fresh(this.local)) this.local = { at, output: this.sysctlFn(DARWIN_SYSCTL_NAMES) };
      return (this.local as { output: Promise<string> }).output;
    }
    if (!fresh(sharedRead)) {
      const output = defaultSysctl(DARWIN_SYSCTL_NAMES);
      // A failed read must not be cached for the whole TTL.
      output.catch(() => {
        if (sharedRead?.output === output) sharedRead = null;
      });
      sharedRead = { at, output };
    }
    return (sharedRead as { output: Promise<string> }).output;
  }
}
