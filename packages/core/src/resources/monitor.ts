/**
 * ResourceMonitor — PSI + MemAvailable sensing, daemon-off capable.
 *
 * Two operational modes:
 *
 * 1. **Point-in-time sample** (`ResourceMonitor.sample()`): used inside the
 *    governor acquire path when the daemon is off. Single call, bounded reads.
 *
 * 2. **Continuous loop** (`ResourceMonitor.startContinuous()`): used by the
 *    daemon/supervisor. Polls at `pollIntervalMs` and emits `ok` → `hold` →
 *    `backoff` state transitions with hysteresis.
 *
 * ## State machine
 *
 *   ok  ──── pressure > holdThreshold ──────→  hold
 *   hold ─── pressure < holdThreshold - hyst ─→ ok
 *   hold ─── pressure > backoffThreshold ─────→ backoff
 *   backoff ─ pressure < holdThreshold - hyst ─→ ok
 *
 * Default thresholds (far below systemd-oomd's Fedora 80%/20s kill line):
 *   - hold:    some avg10 > 10% OR full avg10 > 5%
 *   - backoff: some avg10 > 20% OR full avg10 > 10%
 *   - hysteresis: 3 percentage points (prevents thrash on threshold edge)
 *
 * ## Degraded mode
 *
 * When the PSI interface is absent (non-Linux, locked-down container,
 * unprivileged environment), the monitor falls back to availability-only
 * sampling: `pressureAvailable = false`, `state = 'ok'` unless
 * `memAvailableBytes` is below `headroomMb`.
 *
 * ## oomd facts (Amendment 4)
 *
 * systemd-oomd on Fedora defaults to 80%/20s on user@1000.service (NOT
 * the 50%/20s figure cited in older research). Our hold/backoff thresholds
 * sit far below that line — cleo always throttles before oomd kills.
 *
 * ## WAL growth signal (Amendment 3)
 *
 * The monitor accepts an optional watch on SQLite `-wal` sidecar file sizes.
 * A size above `walWarnThresholdBytes` is surfaced in the sample and can
 * drive governor decisions independently of memory pressure.
 *
 * @module resources/monitor
 * @task T11994
 * @epic T11992
 */

import { EventEmitter } from 'node:events';
import type { ResourceBackend, ResourceSample } from './backend.js';
import { DarwinResourceBackend } from './darwin-backend.js';
import { LinuxResourceBackend } from './linux-backend.js';

/**
 * The backend for this platform: macOS gets {@link DarwinResourceBackend}
 * (kernel pressure level + load), everything else {@link LinuxResourceBackend}
 * (which degrades to availability-only where `/proc` is absent).
 *
 * @task T12981
 */
export function defaultResourceBackend(
  platform: NodeJS.Platform = process.platform,
): ResourceBackend {
  return platform === 'darwin' ? new DarwinResourceBackend() : new LinuxResourceBackend();
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

/**
 * Memory pressure state transitions emitted by the continuous loop.
 *
 * - `ok`:      pressure below hold threshold — normal operation
 * - `hold`:    pressure above hold threshold — slow down, avoid new allocs
 * - `backoff`: pressure above backoff threshold — actively shed load
 */
export type PressureState = 'ok' | 'hold' | 'backoff';

// ---------------------------------------------------------------------------
// Transition event
// ---------------------------------------------------------------------------

/**
 * Emitted by {@link ResourceMonitor} when the pressure state changes.
 */
export interface StateTransition {
  readonly from: PressureState;
  readonly to: PressureState;
  readonly sample: ResourceSample;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Thresholds for the `some avg10` dimension (percentage points, 0–100).
 */
export interface SomePressureThresholds {
  /** Enter `hold` state when `some avg10` exceeds this value. Default: 10. */
  readonly holdSomeAvg10: number;
  /** Enter `backoff` state when `some avg10` exceeds this value. Default: 20. */
  readonly backoffSomeAvg10: number;
}

/**
 * Thresholds for the `full avg10` dimension (percentage points, 0–100).
 */
export interface FullPressureThresholds {
  /** Enter `hold` state when `full avg10` exceeds this value. Default: 5. */
  readonly holdFullAvg10: number;
  /** Enter `backoff` state when `full avg10` exceeds this value. Default: 10. */
  readonly backoffFullAvg10: number;
}

/**
 * Configuration for {@link ResourceMonitor}.
 *
 * All fields are optional — the defaults are calibrated to sit well below
 * systemd-oomd's Fedora kill line of 80%/20s.
 */
export interface ResourceMonitorConfig {
  /**
   * `some avg10` pressure thresholds (percentage points, 0–100).
   *
   * Maps to the `resources.psi` config namespace (Amendment 5).
   */
  readonly psi?: Partial<SomePressureThresholds & FullPressureThresholds>;

  /**
   * Hysteresis band (percentage points).
   *
   * The monitor does NOT drop back to `ok` until pressure falls below
   * `(holdThreshold - hysteresisPoints)` to prevent state thrashing.
   *
   * @defaultValue 3
   */
  readonly hysteresisPoints?: number;

  /**
   * Minimum free memory to consider the system healthy (bytes).
   *
   * Used in degraded mode (PSI absent) as the sole availability signal.
   * Maps to the `resources.headroomMb` config namespace.
   *
   * @defaultValue 256 * 1024 * 1024 (256 MiB)
   */
  readonly headroomBytes?: number;

  /**
   * WAL file size above which a warning observation is surfaced.
   *
   * @defaultValue 256 * 1024 * 1024 (256 MiB)
   */
  readonly walWarnThresholdBytes?: number;

  /**
   * Poll interval for continuous mode (milliseconds).
   *
   * @defaultValue 1500
   */
  readonly pollIntervalMs?: number;

  /**
   * CPU saturation thresholds, applied to `cpuPressure.some.avg10` when the
   * backend reports it. Defaults: hold above 33 (load 1.5× cores), backoff
   * above 50 (2× cores). CPU is looser than memory: a busy box slows down,
   * a memory-starved one swaps and kills processes.
   */
  readonly cpu?: { readonly holdSomeAvg10?: number; readonly backoffSomeAvg10?: number };

  /**
   * Platform backend. Defaults to {@link defaultResourceBackend}.
   *
   * Inject a different backend for macOS parity or test fakes.
   */
  readonly backend?: ResourceBackend;
}

// ---------------------------------------------------------------------------
// Effective (resolved) thresholds
// ---------------------------------------------------------------------------

interface ResolvedThresholds {
  readonly holdSomeAvg10: number;
  readonly backoffSomeAvg10: number;
  readonly holdFullAvg10: number;
  readonly backoffFullAvg10: number;
  readonly hysteresisPoints: number;
  readonly holdCpuSomeAvg10: number;
  readonly backoffCpuSomeAvg10: number;
  readonly headroomBytes: number;
  readonly walWarnThresholdBytes: number;
  readonly pollIntervalMs: number;
}

const DEFAULTS: ResolvedThresholds = {
  holdSomeAvg10: 10,
  backoffSomeAvg10: 20,
  holdFullAvg10: 5,
  backoffFullAvg10: 10,
  hysteresisPoints: 3,
  holdCpuSomeAvg10: 33,
  backoffCpuSomeAvg10: 50,
  headroomBytes: 256 * 1024 * 1024,
  walWarnThresholdBytes: 256 * 1024 * 1024,
  pollIntervalMs: 1500,
};

function resolveThresholds(cfg: ResourceMonitorConfig): ResolvedThresholds {
  return {
    holdSomeAvg10: cfg.psi?.holdSomeAvg10 ?? DEFAULTS.holdSomeAvg10,
    backoffSomeAvg10: cfg.psi?.backoffSomeAvg10 ?? DEFAULTS.backoffSomeAvg10,
    holdFullAvg10: cfg.psi?.holdFullAvg10 ?? DEFAULTS.holdFullAvg10,
    backoffFullAvg10: cfg.psi?.backoffFullAvg10 ?? DEFAULTS.backoffFullAvg10,
    hysteresisPoints: cfg.hysteresisPoints ?? DEFAULTS.hysteresisPoints,
    holdCpuSomeAvg10: cfg.cpu?.holdSomeAvg10 ?? DEFAULTS.holdCpuSomeAvg10,
    backoffCpuSomeAvg10: cfg.cpu?.backoffSomeAvg10 ?? DEFAULTS.backoffCpuSomeAvg10,
    headroomBytes: cfg.headroomBytes ?? DEFAULTS.headroomBytes,
    walWarnThresholdBytes: cfg.walWarnThresholdBytes ?? DEFAULTS.walWarnThresholdBytes,
    pollIntervalMs: cfg.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
  };
}

// ---------------------------------------------------------------------------
// State evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the pressure state given a sample and resolved thresholds.
 *
 * In degraded mode (PSI absent), the state is `hold` only when free memory
 * falls below `headroomBytes`.
 *
 * @internal
 */
export function evaluateState(
  sample: ResourceSample,
  thresholds: ResolvedThresholds,
  currentState: PressureState,
): { state: PressureState; reason: string } {
  const memory = evaluateMemoryState(sample, thresholds, currentState);
  const cpu = evaluateCpuState(sample, thresholds, currentState);
  if (cpu === null || SEVERITY[cpu.state] <= SEVERITY[memory.state]) return memory;
  return cpu;
}

const SEVERITY: Record<PressureState, number> = { ok: 0, hold: 1, backoff: 2 };

/**
 * Classify a sample with the default thresholds (callers that sample once,
 * such as `cleo run`, and do not hold a {@link ResourceMonitor} loop).
 *
 * @param sample - a backend sample.
 * @param currentState - the previous verdict, for hysteresis.
 * @task T12979
 */
export function classifyPressure(
  sample: ResourceSample,
  currentState: PressureState = 'ok',
): { state: PressureState; reason: string } {
  return evaluateState(sample, DEFAULTS, currentState);
}

/**
 * One pressure number on the MEMORY `some avg10` scale, for callers that size
 * budgets from a single value (the governor's class budgets, slot scaling):
 * the worse of memory `some avg10` and CPU `some avg10` rescaled so the CPU
 * hold/backoff defaults (33/50) land on the memory ones (10/25 floor).
 *
 * Linux samples carry no `cpuPressure` today, so this equals the memory value
 * there.
 *
 * @example
 * ```ts
 * pressureScore(sample); // memory 4, cpu 60 (load 2.5× cores) → 35: backoff
 * ```
 *
 * @task T12981
 */
export function pressureScore(sample: ResourceSample): number {
  const mem = (sample.globalPressure?.some ?? sample.slicePressure?.some)?.avg10 ?? 0;
  const cpu = sample.cpuPressure?.some?.avg10;
  if (cpu === undefined) return mem;
  const scaled = cpu <= 33 ? (cpu * 10) / 33 : cpu <= 50 ? 10 + ((cpu - 33) * 15) / 17 : cpu - 25;
  return Math.max(mem, scaled);
}

/**
 * CPU saturation verdict, or `null` when the backend reports no CPU signal.
 * Same hysteresis rule as memory: leaving `hold`/`backoff` needs the signal
 * below the hold threshold minus the hysteresis band.
 *
 * @task T12981
 */
function evaluateCpuState(
  sample: ResourceSample,
  thresholds: ResolvedThresholds,
  currentState: PressureState,
): { state: PressureState; reason: string } | null {
  const some = sample.cpuPressure?.some?.avg10;
  if (some === undefined) return null;
  const tag = `cpu some avg10=${some.toFixed(2)}`;
  if (some > thresholds.backoffCpuSomeAvg10) {
    return { state: 'backoff', reason: `${tag} — above cpu backoff threshold` };
  }
  if (some > thresholds.holdCpuSomeAvg10) {
    return { state: 'hold', reason: `${tag} — above cpu hold threshold` };
  }
  const floor = thresholds.holdCpuSomeAvg10 - thresholds.hysteresisPoints;
  if (currentState !== 'ok' && some > floor) {
    return { state: 'hold', reason: `${tag} — cpu hysteresis hold (floor ${floor})` };
  }
  return { state: 'ok', reason: `${tag} — below cpu thresholds` };
}

function evaluateMemoryState(
  sample: ResourceSample,
  thresholds: ResolvedThresholds,
  currentState: PressureState,
): { state: PressureState; reason: string } {
  if (!sample.pressureAvailable) {
    // Degraded mode — availability-only
    if (sample.memAvailableBytes !== null && sample.memAvailableBytes < thresholds.headroomBytes) {
      return { state: 'hold', reason: 'degraded: memAvailable below headroom' };
    }
    return { state: 'ok', reason: 'degraded: PSI unavailable, memAvailable sufficient' };
  }

  const somePressure = sample.globalPressure?.some ?? sample.slicePressure?.some;
  const fullPressure = sample.globalPressure?.full ?? sample.slicePressure?.full;

  const someAvg10 = somePressure?.avg10 ?? 0;
  const fullAvg10 = fullPressure?.avg10 ?? 0;

  // Backoff threshold (highest severity)
  if (someAvg10 > thresholds.backoffSomeAvg10 || fullAvg10 > thresholds.backoffFullAvg10) {
    return {
      state: 'backoff',
      reason: `some avg10=${someAvg10.toFixed(2)} full avg10=${fullAvg10.toFixed(2)} — above backoff threshold`,
    };
  }

  // Hold threshold
  if (someAvg10 > thresholds.holdSomeAvg10 || fullAvg10 > thresholds.holdFullAvg10) {
    return {
      state: 'hold',
      reason: `some avg10=${someAvg10.toFixed(2)} full avg10=${fullAvg10.toFixed(2)} — above hold threshold`,
    };
  }

  // Hysteresis: only drop to 'ok' if we were already at 'ok', or
  // pressure has fallen below (holdThreshold - hysteresis)
  if (currentState !== 'ok') {
    const hysteresisFloor = thresholds.holdSomeAvg10 - thresholds.hysteresisPoints;
    const fullHysteresisFloor = thresholds.holdFullAvg10 - thresholds.hysteresisPoints;

    if (someAvg10 > hysteresisFloor || fullAvg10 > fullHysteresisFloor) {
      // Still in hysteresis band — stay in current state (clamp to max 'hold')
      const clamped = currentState === 'backoff' ? 'hold' : currentState;
      return {
        state: clamped,
        reason: `some avg10=${someAvg10.toFixed(2)} full avg10=${fullAvg10.toFixed(2)} — hysteresis hold (floor: some ${hysteresisFloor}, full ${fullHysteresisFloor})`,
      };
    }
  }

  return {
    state: 'ok',
    reason: `some avg10=${someAvg10.toFixed(2)} full avg10=${fullAvg10.toFixed(2)} — below thresholds`,
  };
}

// ---------------------------------------------------------------------------
// ResourceMonitor
// ---------------------------------------------------------------------------

/**
 * ResourceMonitor event map for typed EventEmitter usage.
 */
interface ResourceMonitorEvents {
  transition: [transition: StateTransition];
  sample: [sample: ResourceSample];
  error: [err: Error];
}

/**
 * ResourceMonitor — PSI + MemAvailable sensing, daemon-off capable.
 *
 * @example Point-in-time (daemon-off governor acquire):
 * ```ts
 * const monitor = new ResourceMonitor();
 * const sample = await monitor.sample();
 * if (sample.memAvailableBytes !== null && sample.memAvailableBytes < 256 * 1024 * 1024) {
 *   throw new Error('insufficient memory');
 * }
 * ```
 *
 * @example Continuous mode (daemon supervisor):
 * ```ts
 * const monitor = new ResourceMonitor({ pollIntervalMs: 1500 });
 * monitor.on('transition', ({ from, to, reason }) => {
 *   logger.warn(`pressure: ${from} → ${to} (${reason})`);
 * });
 * const stop = monitor.startContinuous();
 * // later:
 * stop();
 * ```
 */
export class ResourceMonitor extends EventEmitter<ResourceMonitorEvents> {
  private readonly thresholds: ResolvedThresholds;
  private readonly backend: ResourceBackend;

  private _state: PressureState = 'ok';
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  constructor(cfg: ResourceMonitorConfig = {}) {
    super();
    this.thresholds = resolveThresholds(cfg);
    this.backend = cfg.backend ?? defaultResourceBackend();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Current pressure state (only meaningful after at least one sample).
   */
  get state(): PressureState {
    return this._state;
  }

  /**
   * `true` while the continuous loop is running.
   */
  get running(): boolean {
    return this._running;
  }

  /**
   * Take a single point-in-time resource sample.
   *
   * Safe to call with the daemon off (no child processes, bounded reads).
   * Does NOT update `this.state` — use {@link startContinuous} for that.
   */
  async sample(): Promise<ResourceSample> {
    return this.backend.sample();
  }

  /**
   * Start the continuous polling loop.
   *
   * Returns a `stop()` function. Calling `stop()` is idempotent.
   *
   * Emits:
   *   - `'sample'` on every poll (even if state did not change)
   *   - `'transition'` when `PressureState` changes
   *   - `'error'` if the backend throws (loop continues regardless)
   */
  startContinuous(): () => void {
    if (this._running) {
      return () => this._stopLoop();
    }
    this._running = true;
    this._scheduleNext();
    return () => this._stopLoop();
  }

  /**
   * Stop the continuous polling loop. Idempotent.
   */
  stop(): void {
    this._stopLoop();
  }

  // -------------------------------------------------------------------------
  // Private loop machinery
  // -------------------------------------------------------------------------

  private _scheduleNext(): void {
    this._timer = setTimeout(() => {
      void this._tick();
    }, this.thresholds.pollIntervalMs);
    // Allow the process to exit if this is the only pending callback
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  private async _tick(): Promise<void> {
    if (!this._running) return;

    try {
      const sample = await this.backend.sample();
      this.emit('sample', sample);

      const { state: newState, reason } = evaluateState(sample, this.thresholds, this._state);

      if (newState !== this._state) {
        const transition: StateTransition = {
          from: this._state,
          to: newState,
          sample,
          reason,
        };
        this._state = newState;
        this.emit('transition', transition);
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    if (this._running) {
      this._scheduleNext();
    }
  }

  private _stopLoop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
