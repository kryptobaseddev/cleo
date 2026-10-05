/**
 * The memory gate: heavy work is refused, not merely narrowed, while the
 * machine is short of memory (T13127).
 *
 * Budgets alone can only narrow: the governor's heavy classes floored at one
 * slot, so under any pressure one more test suite or build was always
 * admitted, however full swap was. This gate refuses heavy work (everything
 * the admission ledger admits, `admission-ledger.ts`) while memory pressure is
 * above {@link MEMORY_GATE_REFUSE_ABOVE}. Callers that wait (`cleo run
 * --wait`, evidence runs) report "waiting: memory pressure" with the readings
 * and start when it falls.
 *
 * ## One signal on every platform
 *
 * The gate reads the memory `some`/`full avg10` of a {@link ResourceSample}:
 * PSI on Linux, the PSI-equivalent the darwin backend derives from the
 * kernel pressure level, RAM squeeze and swap on macOS. CPU saturation is
 * never a reason to refuse: a busy CPU slows work down, an exhausted memory
 * takes the machine down.
 *
 * ## Hysteresis, machine-wide
 *
 * Once refusing, the gate admits again only at or below
 * {@link MEMORY_GATE_RESUME_AT_OR_BELOW}, so admission does not flap at the
 * threshold (the T12995 rule: distinct enter and exit thresholds). The
 * "refusing" state is a small latch file under the CLEO home shared by every
 * process, so a newcomer cannot slip in while waiters are held: everyone sees
 * one gate. A latch nobody has refreshed for {@link MEMORY_GATE_LATCH_TTL_MS}
 * expires.
 *
 * ## Failing open
 *
 * A sample without a memory signal (no PSI, a failed `sysctl`, a sampling
 * error) never refuses and never touches the latch. An unreadable or
 * unwritable latch degrades to point evaluation. A real, lasting pressure
 * blocks only until the caller's own timeout, which then reports the
 * readings.
 *
 * @module resources/pressure-gate
 * @task T13127
 * @epic T13121
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MemoryPressureReading } from '@cleocode/contracts';
import { getCleoHome } from '../paths.js';
import type { ResourceSample } from './backend.js';

/** Heavy work is refused while memory `some avg10` is above this (the governor's floor threshold). */
export const MEMORY_GATE_REFUSE_ABOVE = 25;

/** A refusing gate admits again once memory `some avg10` is at or below this. */
export const MEMORY_GATE_RESUME_AT_OR_BELOW = 15;

/** Heavy work is also refused while memory `full avg10` is above this. */
export const MEMORY_GATE_FULL_REFUSE_ABOVE = 10;

/** A refusing gate needs memory `full avg10` at or below this as well. */
export const MEMORY_GATE_FULL_RESUME_AT_OR_BELOW = 5;

/** A refusing latch nobody refreshed for this long expires. */
export const MEMORY_GATE_LATCH_TTL_MS = 60_000;

/** A refusing latch is rewritten when it is this old, so active waiters keep it alive. */
const LATCH_REFRESH_MS = 10_000;

/** Back-off hint on a memory-pressure deferral: pressure does not clear in seconds. */
export const MEMORY_GATE_RETRY_AFTER_MS = 10_000;

/** A waiter repeats its "waiting: memory pressure" notice at most this often. */
export const MEMORY_GATE_NOTICE_INTERVAL_MS = 60_000;

/** The gate's decision for one sample. */
export interface MemoryGateVerdict {
  /** `true` when heavy work must not start now. */
  readonly refuse: boolean;
  /** The readings, or `null` when the sample carried no memory signal. */
  readonly reading: MemoryPressureReading | null;
}

function finite(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) ? n : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function bytes(n: number): string {
  const gib = n / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`;
}

const LEVEL_NAMES: Readonly<Record<number, string>> = { 1: 'normal', 2: 'warning', 4: 'critical' };

/**
 * The memory signals of a sample in one line: kernel level, squeeze, swap and
 * compressor on macOS; PSI and MemAvailable elsewhere.
 *
 * @param sample - a backend sample.
 *
 * @example
 * ```ts
 * describeMemoryPressure(darwinSample);
 * // → 'kernel level warning; 59% of RAM wired or compressed; swap 11.4 GiB used of 13.0 GiB (24% of RAM)'
 * ```
 */
export function describeMemoryPressure(sample: ResourceSample): string {
  const d = sample.darwinMemory;
  if (d) {
    const parts: string[] = [];
    if (d.pressureLevel !== null) {
      parts.push(`kernel level ${LEVEL_NAMES[d.pressureLevel] ?? String(d.pressureLevel)}`);
    }
    if (d.availablePercent !== null) {
      parts.push(`${100 - d.availablePercent}% of RAM wired or compressed`);
    }
    if (d.compressorBytes !== null) parts.push(`compressor ${bytes(d.compressorBytes)}`);
    if (d.reclaimableBytes != null) parts.push(`${bytes(d.reclaimableBytes)} reclaimable`);
    if (d.swapUsedBytes !== null) {
      const total = d.swapTotalBytes !== null ? ` of ${bytes(d.swapTotalBytes)}` : '';
      const share =
        d.totalBytes > 0 ? ` (${Math.round((100 * d.swapUsedBytes) / d.totalBytes)}% of RAM)` : '';
      parts.push(`swap ${bytes(d.swapUsedBytes)} used${total}${share}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  const mem = sample.globalPressure ?? sample.slicePressure;
  const parts: string[] = [];
  if (mem) {
    parts.push(
      `memory PSI some avg10 ${finite(mem.some.avg10).toFixed(1)}%, full avg10 ${finite(mem.full?.avg10).toFixed(1)}%`,
    );
  }
  if (sample.memAvailableBytes !== null) {
    parts.push(`${bytes(sample.memAvailableBytes)} available`);
  }
  return parts.length > 0 ? parts.join('; ') : 'no memory signal';
}

/**
 * The gate's decision for one sample, given whether it is already refusing.
 * Pure. A sample without a memory signal never refuses.
 *
 * @param sample - a backend sample.
 * @param latched - `true` when the gate is already refusing: the resume
 *   thresholds apply instead of the refuse thresholds.
 *
 * @example
 * ```ts
 * evaluateMemoryGate(someAt(20), false).refuse; // false: not above 25
 * evaluateMemoryGate(someAt(20), true).refuse;  // true: not yet down to 15
 * ```
 */
export function evaluateMemoryGate(sample: ResourceSample, latched: boolean): MemoryGateVerdict {
  const mem = sample.globalPressure ?? sample.slicePressure;
  if (!sample.pressureAvailable || !mem) return { refuse: false, reading: null };
  const some = finite(mem.some.avg10);
  const full = finite(mem.full?.avg10);
  const refuse = latched
    ? some > MEMORY_GATE_RESUME_AT_OR_BELOW || full > MEMORY_GATE_FULL_RESUME_AT_OR_BELOW
    : some > MEMORY_GATE_REFUSE_ABOVE || full > MEMORY_GATE_FULL_REFUSE_ABOVE;
  return {
    refuse,
    reading: {
      score: round1(some),
      fullStall: round1(full),
      refuseAbove: MEMORY_GATE_REFUSE_ABOVE,
      resumeAtOrBelow: MEMORY_GATE_RESUME_AT_OR_BELOW,
      latched,
      memAvailableBytes: sample.memAvailableBytes,
      summary: describeMemoryPressure(sample),
    },
  };
}

/** The machine-wide latch record. */
interface GateLatch {
  readonly refusing: boolean;
  readonly updatedAtMs: number;
}

/**
 * Path of the machine-wide gate latch, beside the governor's slot locks.
 *
 * @param cleoHome - the CLEO home. @defaultValue {@link getCleoHome}
 */
export function memoryGatePath(cleoHome: string = getCleoHome()): string {
  return join(cleoHome, 'locks', 'memory-gate.json');
}

function readLatch(path: string): GateLatch | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateLatch>;
    if (typeof raw.refusing !== 'boolean' || typeof raw.updatedAtMs !== 'number') return null;
    return { refusing: raw.refusing, updatedAtMs: raw.updatedAtMs };
  } catch {
    return null;
  }
}

function writeLatch(path: string, latch: GateLatch): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(latch), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // Best effort: without the latch the gate is point-evaluated.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do.
    }
  }
}

/** Options for {@link checkMemoryGate}. */
export interface CheckMemoryGateOptions {
  /** Clock. @defaultValue Date.now */
  readonly now?: () => number;
  /** Latch file. @defaultValue {@link memoryGatePath} */
  readonly path?: string;
}

/**
 * The gate's decision for one sample, with machine-wide hysteresis: reads
 * the shared latch, evaluates, and records a change (or refreshes a refusing
 * latch). Never throws. A sample without a memory signal neither refuses nor
 * touches the latch.
 *
 * @param sample - a backend sample.
 * @param opts - clock and latch path (tests).
 */
export function checkMemoryGate(
  sample: ResourceSample,
  opts: CheckMemoryGateOptions = {},
): MemoryGateVerdict {
  const now = (opts.now ?? Date.now)();
  let path: string | null;
  try {
    path = opts.path ?? memoryGatePath();
  } catch {
    path = null;
  }
  const prev = path === null ? null : readLatch(path);
  const age = prev === null ? Number.POSITIVE_INFINITY : now - prev.updatedAtMs;
  const latched = prev?.refusing === true && age >= 0 && age < MEMORY_GATE_LATCH_TTL_MS;
  const verdict = evaluateMemoryGate(sample, latched);
  if (verdict.reading === null || path === null) return verdict;
  const changed = verdict.refuse !== latched || (prev?.refusing === true && !latched);
  if (changed || (verdict.refuse && age >= LATCH_REFRESH_MS)) {
    writeLatch(path, { refusing: verdict.refuse, updatedAtMs: now });
  }
  return verdict;
}

/** Remove the latch (tests). @internal */
export function _resetMemoryGateForTest(path?: string): void {
  try {
    rmSync(path ?? memoryGatePath(), { force: true });
  } catch {
    // Absent already, or no CLEO home to clean.
  }
}

// ---------------------------------------------------------------------------
// Reporting a wait
// ---------------------------------------------------------------------------

/** Reports a wait on the gate. */
export interface MemoryGateReporter {
  /**
   * The gate refused: report it at once, then at most every
   * {@link MEMORY_GATE_NOTICE_INTERVAL_MS} with fresh readings.
   */
  waiting(reading: MemoryPressureReading, waitedMs: number): void;
  /** Admitted: say so when a wait was reported. `score` is the latest reading, when known. */
  admitted(waitedMs: number, score: number | null): void;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * One "waiting: memory pressure" line.
 *
 * @param reading - the gate's readings.
 * @param subject - what is waiting, e.g. `test run`.
 * @param waitedMs - how long it has waited so far.
 */
export function memoryGateWaitingLine(
  reading: MemoryPressureReading,
  subject: string,
  waitedMs: number,
): string {
  return (
    `waiting: memory pressure ${reading.score} (refused above ${reading.refuseAbove}, ` +
    `resumes at ${reading.resumeAtOrBelow} or below): ${reading.summary}. ` +
    `The ${subject} starts when pressure falls; waited ${duration(waitedMs)}. ` +
    '(CLEO_RESOURCES_MODE=off turns admission off.)'
  );
}

/**
 * A {@link MemoryGateReporter} that emits one-line notices.
 *
 * @param emit - where a line goes (stderr in the CLI, a `cleo run` notice).
 * @param subject - what is waiting, e.g. `test run`.
 * @param opts - clock and repeat interval (tests).
 */
export function memoryGateReporter(
  emit: (line: string) => void,
  subject: string,
  opts: { readonly now?: () => number; readonly intervalMs?: number } = {},
): MemoryGateReporter {
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? MEMORY_GATE_NOTICE_INTERVAL_MS;
  let lastAt: number | null = null;
  return {
    waiting(reading, waitedMs) {
      const t = now();
      if (lastAt !== null && t - lastAt < interval) return;
      lastAt = t;
      emit(memoryGateWaitingLine(reading, subject, waitedMs));
    },
    admitted(waitedMs, score) {
      if (lastAt === null) return;
      lastAt = null;
      const fell = score === null ? '' : ` (now ${round1(score)})`;
      emit(
        `memory pressure fell${fell} after waiting ${duration(waitedMs)}: admitting the ${subject}.`,
      );
    },
  };
}
