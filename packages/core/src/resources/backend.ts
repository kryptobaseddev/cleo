/**
 * ResourceMonitor platform backend interface.
 *
 * Concrete implementations read OS-level pressure/memory data.
 * The Linux backend is complete; other platforms register here for parity.
 *
 * ## Sampling discipline
 *
 * The {@link ResourceBackend.sample} call MUST:
 * - Spawn NO child process
 * - Perform a BOUNDED number of file reads (PSI + meminfo + slice-pressure only)
 * - Return quickly — callers validate read-count via injected readers in tests
 *
 * Per-child `/proc/<pid>/smaps_rollup` PSS sweeps are ms-scale per multi-GB
 * process and MUST NEVER appear in this interface. See {@link ResourceBackend.sweepChildRss}
 * for the separate low-frequency telemetry surface.
 *
 * @module resources/backend
 * @task T11994
 * @epic T11992
 */

// ---------------------------------------------------------------------------
// Raw sample types
// ---------------------------------------------------------------------------

/**
 * A single PSI pressure line parsed from `/proc/pressure/memory` or a
 * cgroup `memory.pressure` file.
 *
 * PSI line format example:
 *   `some avg10=0.42 avg60=0.31 avg300=0.20 total=1234567`
 */
export interface PressureLine {
  /** 10-second exponential moving average (0–100). */
  readonly avg10: number;
  /** 60-second exponential moving average (0–100). */
  readonly avg60: number;
  /** 300-second exponential moving average (0–100). */
  readonly avg300: number;
  /** Cumulative stall time in microseconds. */
  readonly totalUs: number;
}

/**
 * Parsed PSI data from a single pressure file (some + full lines).
 *
 * `full` is `null` when the kernel omits it (e.g. some older kernels or
 * non-memory cgroups).
 */
export interface PsiData {
  readonly some: PressureLine;
  readonly full: PressureLine | null;
}

/**
 * WAL sidecar size observation.
 *
 * Addresses the DHQ-050 multi-GB WAL class: a throttled reader holding a
 * read-mark can starve checkpoints, causing unbounded WAL growth.
 * The monitor surfaces this as a pressure/starvation input signal.
 */
export interface WalSizeObservation {
  /** Absolute path to the `-wal` file. */
  readonly walPath: string;
  /** Current file size in bytes, or `null` if the file does not exist. */
  readonly sizeBytes: number | null;
}

/**
 * A complete point-in-time resource sample.
 *
 * Produced by {@link ResourceBackend.sample} on every poll interval.
 * The sample NEVER includes per-child RSS data — see {@link ChildRssSweep}.
 */
export interface ResourceSample {
  /** Monotonic timestamp (ms) when the sample was taken. */
  readonly sampledAtMs: number;

  /**
   * `true` when the PSI interface was reachable.
   * `false` triggers degraded mode — only `memAvailableBytes` is meaningful.
   */
  readonly pressureAvailable: boolean;

  /**
   * MemAvailable from `/proc/meminfo` in bytes, or `null` on non-Linux /
   * read error.
   */
  readonly memAvailableBytes: number | null;

  /**
   * Global memory pressure from `/proc/pressure/memory`.
   * `null` when {@link pressureAvailable} is `false`.
   */
  readonly globalPressure: PsiData | null;

  /**
   * cleo.slice scoped memory pressure (from the slice's `memory.pressure`).
   * `null` when the cgroup v2 slice path is absent or unreadable.
   */
  readonly slicePressure: PsiData | null;

  /**
   * WAL sidecar size observations for configured DB paths.
   * Empty array when no WAL paths are configured.
   */
  readonly walObservations: readonly WalSizeObservation[];
}

// ---------------------------------------------------------------------------
// Per-child RSS sweep (separate low-frequency surface — NEVER in sample path)
// ---------------------------------------------------------------------------

/**
 * RSS telemetry for a single child process, read from
 * `/proc/<pid>/smaps_rollup`.
 *
 * **IMPORTANT**: smaps_rollup reads are ms-scale per multi-GB process.
 * This type is produced by {@link ResourceBackend.sweepChildRss}, which
 * exists on a SEPARATE low-frequency cadence and MUST NOT be called from
 * the hot sampling path.
 */
export interface ChildRssEntry {
  readonly pid: number;
  /** PSS (proportional set size) in bytes. */
  readonly pssBytes: number;
  /** RSS in bytes. */
  readonly rssBytes: number;
}

/**
 * Result of a per-child RSS sweep.
 */
export interface ChildRssSweep {
  readonly sampledAtMs: number;
  readonly entries: readonly ChildRssEntry[];
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * ResourceMonitor platform backend.
 *
 * Implement this interface to add support for a new platform (e.g. macOS).
 * The Linux implementation (`LinuxResourceBackend`) is complete.
 *
 * ### Read-count contract (Amendment 1 / CI-stable sampling)
 *
 * `sample()` reads AT MOST:
 *   1. `/proc/pressure/memory` (global PSI)
 *   2. One cgroup `memory.pressure` file (slice PSI)
 *   3. `/proc/meminfo` (MemAvailable)
 *   4. One `-wal` size stat per configured WAL path
 *
 * The injected `readFileFn` and `statFileFn` let tests assert read-count
 * without relying on wall-clock timing.
 */
export interface ResourceBackend {
  /**
   * Take a bounded point-in-time resource sample.
   *
   * Spawns NO child process. Bounded file reads only (see class-level doc).
   */
  sample(): Promise<ResourceSample>;

  /**
   * Sweep per-child RSS via `/proc/<pid>/smaps_rollup`.
   *
   * **LOW-FREQUENCY ONLY** — never call from the sampling hot path.
   * Suitable for periodic telemetry (e.g. every 60s) or triggered by a
   * backoff→hold state transition.
   *
   * @param pids - PIDs to sweep. Unknown/dead PIDs are silently skipped.
   */
  sweepChildRss(pids: readonly number[]): Promise<ChildRssSweep>;
}
