/**
 * macOS ResourceMonitor backend.
 *
 * macOS has no PSI. This backend maps the kernel's own signals onto the
 * PSI-shaped {@link ResourceSample}, so `evaluateState` and the slot scaling
 * work unchanged:
 *
 *   - `kern.memorystatus_vm_pressure_level` — the kernel's memory pressure
 *     verdict (1 normal, 2 warning, 4 critical), the signal jetsam acts on
 *   - `kern.memorystatus_level` — free memory as a percentage of RAM, counting
 *     reclaimable pages (unlike `os.freemem()`, which reports only the free
 *     page list and reads near zero on a healthy Mac)
 *   - `vm.swapusage` — swap in use
 *   - `vm.loadavg` + `hw.ncpu` — run-queue length per core (CPU saturation)
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
 * ## Mapping
 *
 * Memory (`globalPressure`): `some avg10` is the higher of a kernel-level score
 * (warning 15, critical 40) and a free-memory score (`2 × (20 − free%)`,
 * clamped at 0) plus a swap term once swap is over 80% full. `full avg10` is
 * 15 when the kernel reports critical. With the monitor's default thresholds
 * (hold 10 / backoff 20), a kernel warning holds and critical backs off.
 *
 * CPU (`cpuPressure`): with `r = load / cores`, `some = 100 × (r − 1) / r`
 * once `r > 1`: the share of runnable work that is waiting for a core. A box
 * running twice its cores scores 50. avg10/avg60/avg300 come from the 1/5/15
 * minute load averages. Memory is instantaneous in all three windows.
 *
 * @module resources/darwin-backend
 * @task T12981
 * @epic T12978
 */

import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import type {
  ChildRssEntry,
  ChildRssSweep,
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
  'vm.swapusage',
  'vm.loadavg',
  'hw.ncpu',
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
  /** Free memory as a percentage of RAM (0–100). */
  readonly freePercent: number | null;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  /** 1, 5 and 15 minute load averages. */
  readonly loadAvg: readonly [number, number, number] | null;
  readonly ncpu: number | null;
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
    swapTotalBytes,
    swapUsedBytes,
    loadAvg,
    ncpu: int('hw.ncpu'),
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Memory pressure score (PSI `some`-equivalent, 0–100) from darwin signals.
 * Returns `null` when neither the kernel level nor free% is readable.
 */
export function darwinMemorySome(s: DarwinSignals): number | null {
  if (s.pressureLevel === null && s.freePercent === null) return null;
  const levelScore = s.pressureLevel === 4 ? 40 : s.pressureLevel === 2 ? 15 : 0;
  const freeScore = s.freePercent === null ? 0 : Math.max(0, 2 * (20 - s.freePercent));
  let swapScore = 0;
  if (s.swapTotalBytes && s.swapUsedBytes !== null && s.swapTotalBytes > 0) {
    const used = s.swapUsedBytes / s.swapTotalBytes;
    // Swap nearly full means the compressor and swap are both exhausted soon.
    if (used > 0.8) swapScore = (used - 0.8) * 100;
  }
  return clamp(Math.max(levelScore, freeScore) + swapScore);
}

/** CPU waiting share (0–100) for a load average on `ncpu` cores. */
export function cpuSomeFromLoad(load: number, ncpu: number): number {
  const r = load / Math.max(1, ncpu);
  return r <= 1 ? 0 : clamp((100 * (r - 1)) / r);
}

function line(avg10: number, avg60: number, avg300: number): PressureLine {
  return { avg10, avg60, avg300, totalUs: 0 };
}

/** Build the memory and CPU PSI-equivalents from parsed signals. */
export function darwinPressure(s: DarwinSignals): {
  memory: PsiData | null;
  cpu: PsiData | null;
} {
  const some = darwinMemorySome(s);
  const memory: PsiData | null =
    some === null
      ? null
      : {
          some: line(some, some, some),
          full: s.pressureLevel === 4 ? line(15, 15, 15) : line(0, 0, 0),
        };
  let cpu: PsiData | null = null;
  if (s.loadAvg && s.ncpu) {
    const [l1, l5, l15] = s.loadAvg;
    cpu = {
      some: line(
        cpuSomeFromLoad(l1, s.ncpu),
        cpuSomeFromLoad(l5, s.ncpu),
        cpuSomeFromLoad(l15, s.ncpu),
      ),
      full: null,
    };
  }
  return { memory, cpu };
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
    const { memory, cpu } = signals ? darwinPressure(signals) : { memory: null, cpu: null };
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
