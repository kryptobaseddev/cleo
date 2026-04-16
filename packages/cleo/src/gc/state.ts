/**
 * GC State — Persistent crash-recovery state for the autonomous GC daemon.
 *
 * Stored in `.cleo/gc-state.json` (plain JSON, not SQLite) to avoid
 * SQLite WAL conflicts between the long-running daemon process and the
 * main CLEO CLI process. Human-readable for debugging.
 *
 * The file is gitignored (see .gitignore §.cleo/ section) and created empty
 * by `cleo init`. It is NOT included in `cleo backup restore` scope because
 * it is ephemeral operational state — only the `daemonPid` and `lastRunAt`
 * fields survive between process restarts.
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @epic T726
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Schema version for gc-state.json. Bump on breaking field changes. */
export const GC_STATE_SCHEMA_VERSION = '1.0' as const;

/**
 * Persistent GC daemon state written to `.cleo/gc-state.json`.
 *
 * Design principles:
 * - `pendingPrune` enables idempotent crash recovery: populate BEFORE deletion,
 *   clear each entry AFTER successful deletion, clear entirely when job completes.
 * - `diskThresholdBreached` is a sticky flag: cleared only when disk drops
 *   below the WATCH tier (70%).
 * - `escalationNeeded` is set by the daemon when disk is in WARN/URGENT range;
 *   cleared by the CLI after displaying the escalation banner.
 */
export interface GCState {
  /** JSON schema version for forward-compatibility checks. */
  schemaVersion: typeof GC_STATE_SCHEMA_VERSION;
  /** ISO-8601 timestamp of last COMPLETED GC run. null = never run. */
  lastRunAt: string | null;
  /** Outcome of the last GC run. */
  lastRunResult: 'success' | 'partial' | 'failed' | null;
  /** Bytes freed in the last completed GC run. */
  lastRunBytesFreed: number;
  /**
   * Paths queued for deletion but not yet deleted.
   * Written BEFORE starting deletion; cleared entry-by-entry on success.
   * Enables idempotent crash recovery on daemon restart.
   */
  pendingPrune: string[] | null;
  /** Number of consecutive GC failures. Triggers escalation banner after 3. */
  consecutiveFailures: number;
  /** Sticky flag: true when disk is ≥ WATCH tier (70%). Cleared when disk < 70%. */
  diskThresholdBreached: boolean;
  /** Current disk usage percentage (0–100) from the last GC run. */
  lastDiskUsedPct: number | null;
  /**
   * Escalation banner flag. Set by daemon when disk is in WARN+ range.
   * Cleared by CLI after displaying the banner to the user.
   */
  escalationNeeded: boolean;
  /** Escalation reason shown in the CLI banner. */
  escalationReason: string | null;
  /** PID of the currently running daemon process. null = daemon not running. */
  daemonPid: number | null;
  /** ISO-8601 timestamp when the daemon was last started. */
  daemonStartedAt: string | null;
}

/** Default (empty) GC state for fresh initialisation. */
export const DEFAULT_GC_STATE: GCState = {
  schemaVersion: GC_STATE_SCHEMA_VERSION,
  lastRunAt: null,
  lastRunResult: null,
  lastRunBytesFreed: 0,
  pendingPrune: null,
  consecutiveFailures: 0,
  diskThresholdBreached: false,
  lastDiskUsedPct: null,
  escalationNeeded: false,
  escalationReason: null,
  daemonPid: null,
  daemonStartedAt: null,
};

/**
 * Read the GC state from disk.
 *
 * Returns the default state if the file does not exist or is malformed.
 * Never throws — GC state file absence is not an error condition.
 *
 * @param statePath - Absolute path to gc-state.json
 * @returns Parsed GC state, merged with defaults for any missing fields
 */
export async function readGCState(statePath: string): Promise<GCState> {
  try {
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GCState>;
    // Merge with defaults so new fields added in future schema versions
    // don't cause undefined access on old state files.
    return { ...DEFAULT_GC_STATE, ...parsed };
  } catch {
    // ENOENT (file not yet created) or JSON parse error → use defaults
    return { ...DEFAULT_GC_STATE };
  }
}

/**
 * Write the GC state to disk atomically via tmp-then-rename.
 *
 * Atomic write prevents partial reads if the daemon crashes mid-write.
 * Idempotent: safe to call multiple times.
 *
 * @param statePath - Absolute path to gc-state.json
 * @param state - GC state to persist
 */
export async function writeGCState(statePath: string, state: GCState): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.gc-state-${process.pid}.tmp`);
  const json = JSON.stringify(state, null, 2);

  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, statePath);
}

/**
 * Patch a subset of fields in the GC state file.
 *
 * Convenience wrapper: reads current state, merges patch, writes back.
 *
 * @param statePath - Absolute path to gc-state.json
 * @param patch - Partial state to merge over the existing state
 */
export async function patchGCState(statePath: string, patch: Partial<GCState>): Promise<GCState> {
  const current = await readGCState(statePath);
  const updated: GCState = { ...current, ...patch };
  await writeGCState(statePath, updated);
  return updated;
}
