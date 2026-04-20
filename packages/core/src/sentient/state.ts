/**
 * Sentient Loop State — Persistent state for the Tier-1 autonomous daemon.
 *
 * Stored in `.cleo/sentient-state.json` (plain JSON, not SQLite) to avoid
 * SQLite WAL conflicts between the long-running daemon process and the
 * main CLEO CLI process. Human-readable for debugging.
 *
 * The file is gitignored (see .gitignore §.cleo/ section) and survives
 * restarts. Only `killSwitch`, `pid`, and `stats` fields are load-bearing
 * across process boundaries.
 *
 * @see ADR-054 — Sentient Loop Tier-1 (autonomous task execution)
 * @task T946
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Tier2Stats } from '@cleocode/contracts';

/** Schema version for sentient-state.json. Bump on breaking field changes. */
export const SENTIENT_STATE_SCHEMA_VERSION = '1.0' as const;

/**
 * Per-task failure/backoff tracking for stuck detection.
 * Keyed by task id in {@link SentientState.stuckTasks}.
 */
export interface StuckTaskRecord {
  /** Number of consecutive failed spawn attempts for this task. */
  attempts: number;
  /** ISO-8601 timestamp of the most recent failure. */
  lastFailureAt: string;
  /** Unix epoch ms when the next retry becomes eligible. */
  nextRetryAt: number;
  /** Last captured failure reason (truncated to 500 chars). */
  lastReason: string;
}

/**
 * Rolling counters persisted across daemon restarts.
 */
export interface SentientStats {
  /** Total tasks picked by the loop since creation. */
  tasksPicked: number;
  /** Total tasks that completed successfully. */
  tasksCompleted: number;
  /** Total tasks whose spawn exited non-zero. */
  tasksFailed: number;
  /** Total ticks executed (including no-op ticks). */
  ticksExecuted: number;
  /** Total ticks aborted early because kill switch was active. */
  ticksKilled: number;
}

/**
 * Persistent sentient daemon state.
 *
 * Design principles:
 * - `killSwitch` is the single load-bearing kill signal — the daemon re-checks
 *   it between every step of a tick, not just at tick start (Round 2 audit).
 * - `stuckTasks` keys are task ids; values encode backoff + failure counts.
 * - `stuckTimestamps` is a rolling 1-hour window used for the self-pause rule
 *   (5 stucks in 1 hour → killSwitch=true).
 * - `stats` fields are monotonic counters that only ever increase.
 */
export interface SentientState {
  /** JSON schema version for forward-compatibility checks. */
  schemaVersion: typeof SENTIENT_STATE_SCHEMA_VERSION;
  /** PID of the currently running daemon process. null = daemon not running. */
  pid: number | null;
  /** ISO-8601 timestamp when the daemon was last started. */
  startedAt: string | null;
  /** ISO-8601 timestamp of the last completed tick (any outcome). */
  lastTickAt: string | null;
  /**
   * Kill-switch flag. When true, the daemon re-checks at every step of a tick
   * and exits cleanly without picking or spawning a task.
   */
  killSwitch: boolean;
  /** Reason supplied when killSwitch was last set (diagnostic only). */
  killSwitchReason: string | null;
  /** Rolling counters; see {@link SentientStats}. */
  stats: SentientStats;
  /** Per-task backoff + failure metadata for retry/stuck detection. */
  stuckTasks: Record<string, StuckTaskRecord>;
  /**
   * Unix-epoch-ms timestamps of `stuck` events within the last hour.
   * When length ≥ 5 the daemon self-pauses (killSwitch=true).
   */
  stuckTimestamps: number[];
  /**
   * Currently-active task id (set while a spawn is in-flight, cleared afterward).
   * Enables `status` to show the in-progress task during a long-running tick.
   */
  activeTaskId: string | null;
  /**
   * Tier-2 proposal queue enabled flag.
   *
   * Default: `false` — Tier 2 is OFF by default to prevent surprise proposal
   * floods on first daemon start. Owner enables via `cleo sentient propose enable`
   * (patches this flag). See ADR-054 §Tier-2.
   *
   * @task T1008
   */
  tier2Enabled: boolean;
  /**
   * Rolling counters for Tier-2 proposal activity.
   *
   * @task T1008
   */
  tier2Stats: Tier2Stats;
}

/** Default (empty) sentient state for fresh initialisation. */
export const DEFAULT_SENTIENT_STATE: SentientState = {
  schemaVersion: SENTIENT_STATE_SCHEMA_VERSION,
  pid: null,
  startedAt: null,
  lastTickAt: null,
  killSwitch: false,
  killSwitchReason: null,
  stats: {
    tasksPicked: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    ticksExecuted: 0,
    ticksKilled: 0,
  },
  stuckTasks: {},
  stuckTimestamps: [],
  activeTaskId: null,
  tier2Enabled: false,
  tier2Stats: {
    proposalsGenerated: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
  },
};

/**
 * Read the sentient state from disk.
 *
 * Returns the default state if the file does not exist or is malformed.
 * Never throws — absence is not an error.
 *
 * @param statePath - Absolute path to sentient-state.json
 */
export async function readSentientState(statePath: string): Promise<SentientState> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SentientState>;
    return {
      ...DEFAULT_SENTIENT_STATE,
      ...parsed,
      stats: { ...DEFAULT_SENTIENT_STATE.stats, ...(parsed.stats ?? {}) },
      stuckTasks: parsed.stuckTasks ?? {},
      stuckTimestamps: parsed.stuckTimestamps ?? [],
      tier2Enabled: parsed.tier2Enabled ?? false,
      tier2Stats: { ...DEFAULT_SENTIENT_STATE.tier2Stats, ...(parsed.tier2Stats ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SENTIENT_STATE };
  }
}

/**
 * Write the sentient state to disk atomically via tmp-then-rename.
 *
 * Atomic write prevents partial reads if the daemon crashes mid-write.
 *
 * @param statePath - Absolute path to sentient-state.json
 * @param state - State to persist
 */
export async function writeSentientState(statePath: string, state: SentientState): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.sentient-state-${process.pid}.tmp`);
  const json = JSON.stringify(state, null, 2);

  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, statePath);
}

/**
 * Patch a subset of fields in the sentient state file.
 *
 * Reads current state, merges patch, writes back. Nested `stats` merges
 * with existing stats (never clobbered wholesale).
 *
 * @param statePath - Absolute path to sentient-state.json
 * @param patch - Partial state to merge over the existing state
 * @returns The merged state that was written to disk.
 */
export async function patchSentientState(
  statePath: string,
  patch: Partial<SentientState>,
): Promise<SentientState> {
  const current = await readSentientState(statePath);
  const updated: SentientState = {
    ...current,
    ...patch,
    stats: { ...current.stats, ...(patch.stats ?? {}) },
  };
  await writeSentientState(statePath, updated);
  return updated;
}

/**
 * Increment stats counters atomically.
 *
 * @param statePath - Absolute path to sentient-state.json
 * @param delta - Partial stats to add to current counters
 */
export async function incrementStats(
  statePath: string,
  delta: Partial<SentientStats>,
): Promise<SentientState> {
  const current = await readSentientState(statePath);
  const nextStats: SentientStats = {
    tasksPicked: current.stats.tasksPicked + (delta.tasksPicked ?? 0),
    tasksCompleted: current.stats.tasksCompleted + (delta.tasksCompleted ?? 0),
    tasksFailed: current.stats.tasksFailed + (delta.tasksFailed ?? 0),
    ticksExecuted: current.stats.ticksExecuted + (delta.ticksExecuted ?? 0),
    ticksKilled: current.stats.ticksKilled + (delta.ticksKilled ?? 0),
  };
  const updated: SentientState = { ...current, stats: nextStats };
  await writeSentientState(statePath, updated);
  return updated;
}
