/**
 * Linux ResourceMonitor backend.
 *
 * Reads:
 *   - `/proc/pressure/memory` — global PSI (some + full)
 *   - `<cgroupSlicePath>/memory.pressure` — cleo.slice scoped PSI
 *   - `/proc/meminfo` — MemAvailable
 *   - `<walPath>` size stat — WAL growth signal (DHQ-050 starvation class)
 *   - `/proc/<pid>/smaps_rollup` — per-child RSS (SEPARATE low-frequency path)
 *
 * ## Read-count discipline (Amendment 1)
 *
 * `sample()` calls the injected reader at most:
 *   - 1× for `/proc/pressure/memory`
 *   - 1× for the slice `memory.pressure` (if configured)
 *   - 1× for `/proc/meminfo`
 *   - N× stat calls for N configured WAL paths
 *
 * smaps_rollup reads are on a SEPARATE `sweepChildRss()` method and are
 * structurally impossible to reach from the `sample()` hot path.
 *
 * ## oomd threshold facts (Amendment 4)
 *
 * systemd-oomd on Fedora defaults to 80%/20s on user@1000.service.
 * Our hold/backoff thresholds (some avg10 >10% / full avg10 >5%) sit far
 * below that line, ensuring cleo always throttles before oomd kills.
 *
 * @module resources/linux-backend
 * @task T11994
 * @epic T11992
 */

import { readFile, stat } from 'node:fs/promises';
import type {
  ChildRssEntry,
  ChildRssSweep,
  PressureLine,
  PsiData,
  ResourceBackend,
  ResourceSample,
  WalSizeObservation,
} from './backend.js';

// ---------------------------------------------------------------------------
// Injected reader types (allow tests to count and fake reads)
// ---------------------------------------------------------------------------

/**
 * Injectable file-read function. Defaults to `fs/promises.readFile`.
 *
 * Tests inject a counting wrapper to assert bounded read-count without
 * relying on wall-clock timing (Amendment 1 — CI-stable formulation).
 */
export type ReadFileFn = (path: string, encoding: 'utf-8') => Promise<string>;

/**
 * Injectable stat function. Defaults to `fs/promises.stat`.
 *
 * Returns `null` when the file does not exist (ENOENT) or is unreadable.
 */
export type StatFileFn = (path: string) => Promise<{ size: number } | null>;

// ---------------------------------------------------------------------------
// Parsing helpers (tested in isolation)
// ---------------------------------------------------------------------------

/**
 * Parse a single PSI line.
 *
 * Format: `some avg10=0.42 avg60=0.31 avg300=0.20 total=1234567`
 *
 * Returns `null` when the line does not match the expected format.
 */
export function parsePressureLine(line: string): PressureLine | null {
  const avg10Match = /avg10=([\d.]+)/.exec(line);
  const avg60Match = /avg60=([\d.]+)/.exec(line);
  const avg300Match = /avg300=([\d.]+)/.exec(line);
  const totalMatch = /total=(\d+)/.exec(line);

  if (!avg10Match?.[1] || !avg60Match?.[1] || !avg300Match?.[1] || !totalMatch?.[1]) {
    return null;
  }

  return {
    avg10: parseFloat(avg10Match[1]),
    avg60: parseFloat(avg60Match[1]),
    avg300: parseFloat(avg300Match[1]),
    totalUs: parseInt(totalMatch[1], 10),
  };
}

/**
 * Parse a PSI file (two lines: `some ...` and `full ...`).
 *
 * Returns `null` when the content is unreadable / unparseable — callers
 * treat this as "pressure interface absent" (degraded mode).
 */
export function parsePsiFile(content: string): PsiData | null {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let some: PressureLine | null = null;
  let full: PressureLine | null = null;

  for (const line of lines) {
    if (line.startsWith('some ')) {
      some = parsePressureLine(line);
    } else if (line.startsWith('full ')) {
      full = parsePressureLine(line);
    }
  }

  if (!some) {
    return null;
  }

  return { some, full };
}

/**
 * Parse `MemAvailable` from `/proc/meminfo`.
 *
 * Format: `MemAvailable:   42233788 kB`
 *
 * Returns `null` when the field is absent (non-Linux / old kernel).
 * Reuses the same parsing pattern as `packages/core/src/llm/local-model-fit.ts:269`.
 */
export function parseMemAvailable(content: string): number | null {
  for (const line of content.split('\n')) {
    if (line.startsWith('MemAvailable:')) {
      // Format: "MemAvailable:   42233788 kB"
      const match = /MemAvailable:\s+(\d+)\s+kB/.exec(line);
      if (match?.[1]) {
        return parseInt(match[1], 10) * 1024;
      }
    }
  }
  return null;
}

/**
 * Parse a `/proc/<pid>/smaps_rollup` file for RSS and PSS.
 *
 * Relevant fields:
 *   `Rss:       12345 kB`
 *   `Pss:        9876 kB`
 *
 * Returns `null` when either field is absent.
 */
export function parseSmapsRollup(content: string): { rssBytes: number; pssBytes: number } | null {
  let rssKb: number | null = null;
  let pssKb: number | null = null;

  for (const line of content.split('\n')) {
    if (line.startsWith('Rss:')) {
      const m = /Rss:\s+(\d+)\s+kB/.exec(line);
      if (m?.[1]) rssKb = parseInt(m[1], 10);
    } else if (line.startsWith('Pss:')) {
      const m = /Pss:\s+(\d+)\s+kB/.exec(line);
      if (m?.[1]) pssKb = parseInt(m[1], 10);
    }
  }

  if (rssKb === null || pssKb === null) return null;
  return { rssBytes: rssKb * 1024, pssBytes: pssKb * 1024 };
}

// ---------------------------------------------------------------------------
// Linux backend configuration
// ---------------------------------------------------------------------------

/**
 * Options for {@link LinuxResourceBackend}.
 */
export interface LinuxBackendOptions {
  /**
   * Path to the global PSI memory pressure file.
   * @defaultValue '/proc/pressure/memory'
   */
  readonly globalPressurePath?: string;

  /**
   * Path to the cleo.slice cgroup v2 `memory.pressure` file.
   *
   * Common paths:
   *   `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cleo.slice/memory.pressure`
   *
   * Set to `null` to disable slice-scoped sampling.
   * @defaultValue undefined (auto-detect disabled; callers supply the path)
   */
  readonly cgroupSlicePressurePath?: string | null;

  /**
   * Absolute paths to SQLite `-wal` sidecar files to watch.
   *
   * WAL growth is a starvation signal (DHQ-050 class): a throttled reader
   * holding a read-mark prevents checkpoint → WAL regrows unboundedly.
   * Monitoring WAL size lets the governor correlate write-stall with
   * memory pressure.
   *
   * @defaultValue []
   */
  readonly walPaths?: readonly string[];

  /**
   * Injectable file-read function (for testing).
   * @defaultValue fs/promises.readFile
   */
  readonly readFileFn?: ReadFileFn;

  /**
   * Injectable stat function (for testing).
   * @defaultValue fs/promises.stat (ENOENT → null)
   */
  readonly statFileFn?: StatFileFn;
}

// ---------------------------------------------------------------------------
// Default injectable implementations
// ---------------------------------------------------------------------------

const defaultReadFile: ReadFileFn = (path, encoding) => readFile(path, encoding);

const defaultStat: StatFileFn = async (path) => {
  try {
    const s = await stat(path);
    return { size: s.size };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Linux backend
// ---------------------------------------------------------------------------

/**
 * Linux implementation of {@link ResourceBackend}.
 *
 * Uses injected `readFileFn` / `statFileFn` so unit tests can:
 *   1. Fake file contents (threshold-crossing, degraded mode)
 *   2. Count reads to assert the bounded-read contract (Amendment 1)
 */
export class LinuxResourceBackend implements ResourceBackend {
  private readonly globalPressurePath: string;
  private readonly cgroupSlicePressurePath: string | null;
  private readonly walPaths: readonly string[];
  private readonly readFileFn: ReadFileFn;
  private readonly statFileFn: StatFileFn;

  constructor(opts: LinuxBackendOptions = {}) {
    this.globalPressurePath = opts.globalPressurePath ?? '/proc/pressure/memory';
    this.cgroupSlicePressurePath = opts.cgroupSlicePressurePath ?? null;
    this.walPaths = opts.walPaths ?? [];
    this.readFileFn = opts.readFileFn ?? defaultReadFile;
    this.statFileFn = opts.statFileFn ?? defaultStat;
  }

  /**
   * Take a bounded point-in-time resource sample.
   *
   * Read-count (bounded by Amendment 1):
   *   - 1 read: `/proc/pressure/memory`
   *   - 0–1 reads: slice `memory.pressure` (if configured)
   *   - 1 read: `/proc/meminfo`
   *   - N stat calls: one per WAL path in `walPaths`
   *
   * Never spawns a child process.
   */
  async sample(): Promise<ResourceSample> {
    const sampledAtMs = Date.now();

    // Read 1: global PSI
    const globalPressure = await this._readPsi(this.globalPressurePath);
    const pressureAvailable = globalPressure !== null;

    // Read 2 (optional): slice PSI
    let slicePressure: PsiData | null = null;
    if (this.cgroupSlicePressurePath) {
      slicePressure = await this._readPsi(this.cgroupSlicePressurePath);
    }

    // Read 3: MemAvailable
    const memAvailableBytes = await this._readMemAvailable();

    // Read N: WAL stat observations
    const walObservations = await this._readWalObservations();

    return {
      sampledAtMs,
      pressureAvailable,
      memAvailableBytes,
      globalPressure,
      slicePressure,
      walObservations,
    };
  }

  /**
   * Sweep per-child RSS via `/proc/<pid>/smaps_rollup`.
   *
   * **STRUCTURALLY SEPARATED from sample()** — smaps_rollup reads are
   * ms-scale per multi-GB process and must never appear in the hot path.
   * Call on a separate low-frequency cadence (e.g. every 60s or on
   * backoff→hold state transition).
   *
   * @param pids - PIDs to sweep. Dead/unknown PIDs are silently skipped.
   */
  async sweepChildRss(pids: readonly number[]): Promise<ChildRssSweep> {
    const sampledAtMs = Date.now();
    const entries: ChildRssEntry[] = [];

    for (const pid of pids) {
      try {
        const content = await this.readFileFn(`/proc/${pid}/smaps_rollup`, 'utf-8');
        const parsed = parseSmapsRollup(content);
        if (parsed) {
          entries.push({ pid, ...parsed });
        }
      } catch {
        // Dead or inaccessible PID — skip silently
      }
    }

    return { sampledAtMs, entries };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _readPsi(path: string): Promise<PsiData | null> {
    try {
      const content = await this.readFileFn(path, 'utf-8');
      return parsePsiFile(content);
    } catch {
      return null;
    }
  }

  private async _readMemAvailable(): Promise<number | null> {
    try {
      const content = await this.readFileFn('/proc/meminfo', 'utf-8');
      return parseMemAvailable(content);
    } catch {
      return null;
    }
  }

  private async _readWalObservations(): Promise<WalSizeObservation[]> {
    const results: WalSizeObservation[] = [];
    for (const walPath of this.walPaths) {
      const info = await this.statFileFn(walPath);
      results.push({ walPath, sizeBytes: info?.size ?? null });
    }
    return results;
  }
}
