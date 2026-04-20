/**
 * Kill-switch checker for Tier-3 merge-ritual steps.
 *
 * Provides a lightweight, fs.watch-backed cache of the `killSwitch` field in
 * `.cleo/sentient-state.json`. Every Tier-3 step-transition calls
 * {@link checkKillSwitch} to abort the ritual immediately if the operator has
 * activated the kill switch.
 *
 * Design notes:
 * - A module-level cache (`cachedKillSwitch`) is updated by the watcher so that
 *   synchronous read pressure on the state file is near-zero during a running
 *   ritual. The watcher fires on file change events and re-reads the JSON.
 * - Debounce of 100 ms is applied so rapid successive writes (e.g. atomic
 *   tmp-rename) don't cause thundering re-reads.
 * - `startKillSwitchWatcher` is idempotent — calling it multiple times
 *   replaces the previous watcher. The returned function closes the watcher.
 * - `__setKillSwitchForTest` bypasses disk entirely for unit tests.
 *
 * State-file shape:
 * ```json
 * {
 *   "killSwitch": true,
 *   "activatedAt": "2026-04-20T00:00:00.000Z",  // optional
 *   "activatedBy": "operator"                    // optional
 * }
 * ```
 *
 * @see ADR-054 — Sentient Loop Tier-1/Tier-3
 * @task T1027
 */

import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Labels for each transition point in the Tier-3 10-step merge ritual.
 *
 * The ritual steps are:
 *   1. pre-pick      — before cherry-pick selection
 *   2. post-pick     — after cherry-pick selection
 *   3. pre-spawn     — before worker agent is spawned
 *   4. post-spawn    — after worker agent completes
 *   5. pre-verify    — before evidence gates are checked
 *   6. post-verify   — after all gates pass
 *   7. pre-sign      — before Ed25519 receipt is signed
 *   8. post-sign     — after signing completes
 *   9. pre-merge     — before `git merge --ff-only`
 *  10. post-merge    — after merge succeeds (operator must manually revert if
 *                      the kill switch fires here)
 */
export type StepLabel =
  | 'pre-pick'
  | 'post-pick'
  | 'pre-spawn'
  | 'post-spawn'
  | 'pre-verify'
  | 'post-verify'
  | 'pre-sign'
  | 'post-sign'
  | 'pre-merge'
  | 'post-merge';

/**
 * Minimal shape read from `.cleo/sentient-state.json` by the kill-switch watcher.
 *
 * Only `killSwitch` is load-bearing; the optional fields are stored for
 * diagnostic purposes in {@link KillSwitchActivatedError}.
 */
interface KillSwitchStateSlice {
  /** True when the operator has activated the kill switch. */
  killSwitch: boolean;
  /** ISO-8601 timestamp when the switch was activated (optional). */
  activatedAt?: string;
  /** Identifier of who/what activated the switch (optional). */
  activatedBy?: string;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link checkKillSwitch} when the kill switch is active.
 *
 * Callers in the Tier-3 ritual should propagate this error up to the ritual
 * runner, which logs the abort and exits cleanly.
 */
export class KillSwitchActivatedError extends Error {
  /** The step at which the kill switch was detected. */
  readonly step: StepLabel;
  /** ISO-8601 timestamp at which the kill was detected (now). */
  readonly killedAt: string;

  /**
   * @param step - The ritual step where the kill switch was detected.
   * @param killedAt - ISO-8601 timestamp of detection.
   */
  constructor(step: StepLabel, killedAt: string) {
    super(`Kill switch activated at step "${step}" on ${killedAt}`);
    this.name = 'KillSwitchActivatedError';
    this.step = step;
    this.killedAt = killedAt;
  }
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/**
 * Cached kill-switch value — updated by the watcher or by
 * {@link __setKillSwitchForTest}. `undefined` means the watcher has not yet
 * read the file; in that case {@link checkKillSwitch} falls back to a
 * synchronous file read.
 */
let cachedKillSwitch: boolean | undefined;

/**
 * Active debounce timer handle for the file watcher.
 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Default state file path relative to the project root.
 */
const DEFAULT_STATE_FILE_REL = '.cleo/sentient-state.json' as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the kill-switch slice from the state file.
 *
 * Returns `{ killSwitch: false }` if the file is absent or unparseable —
 * absence is not an error (daemon may not be running).
 *
 * @param stateFile - Absolute path to `sentient-state.json`.
 */
async function readKillSwitchFromFile(stateFile: string): Promise<KillSwitchStateSlice> {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<KillSwitchStateSlice>;
    return {
      killSwitch: parsed.killSwitch === true,
      activatedAt: parsed.activatedAt,
      activatedBy: parsed.activatedBy,
    };
  } catch {
    return { killSwitch: false };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the kill switch at a ritual step boundary.
 *
 * Reads the cached value set by the watcher. If no watcher is running (cache
 * is `undefined`), falls back to a one-shot file read. Throws
 * {@link KillSwitchActivatedError} immediately if the flag is `true`.
 *
 * Call this at EVERY step-transition in the Tier-3 merge ritual.
 *
 * @param step - The ritual step at which the check is performed.
 * @param stateFile - Optional absolute path to `sentient-state.json`.
 *   Defaults to `<cwd>/.cleo/sentient-state.json`.
 * @throws {KillSwitchActivatedError} When the kill switch is active.
 */
export async function checkKillSwitch(step: StepLabel, stateFile?: string): Promise<void> {
  let active: boolean;

  if (cachedKillSwitch !== undefined) {
    active = cachedKillSwitch;
  } else {
    // No watcher active — read directly from disk.
    const resolvedFile = stateFile ?? join(process.cwd(), DEFAULT_STATE_FILE_REL);
    const slice = await readKillSwitchFromFile(resolvedFile);
    active = slice.killSwitch;
    // Seed the cache so subsequent checks within the same process are fast.
    cachedKillSwitch = active;
  }

  if (active) {
    throw new KillSwitchActivatedError(step, new Date().toISOString());
  }
}

/**
 * Start the fs.watch singleton watcher on `sentient-state.json`.
 *
 * The watcher keeps {@link cachedKillSwitch} up to date so that
 * {@link checkKillSwitch} never needs to hit the disk mid-ritual. Changes
 * are debounced by 100 ms to handle atomic tmp-then-rename writes.
 *
 * Calling this function replaces any previously registered watcher (the old
 * watcher is closed first).
 *
 * @param stateFile - Absolute path to `sentient-state.json`.
 *   Defaults to `<cwd>/.cleo/sentient-state.json`.
 * @returns An unsubscribe function that closes the watcher and resets the
 *   cache. Call this during process shutdown or test teardown.
 */
export function startKillSwitchWatcher(stateFile?: string): () => void {
  const resolvedFile = stateFile ?? join(process.cwd(), DEFAULT_STATE_FILE_REL);

  // Clear existing debounce timer from a previous watcher.
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Seed cache with an immediate read so the first checkKillSwitch call after
  // startKillSwitchWatcher() does not need to hit disk.
  void readKillSwitchFromFile(resolvedFile).then((slice) => {
    cachedKillSwitch = slice.killSwitch;
  });

  let closed = false;

  let fsWatcher: ReturnType<typeof watch> | null = null;
  try {
    fsWatcher = watch(resolvedFile, { persistent: false }, (_eventType) => {
      if (closed) return;
      // Debounce: cancel any pending re-read and reschedule.
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void readKillSwitchFromFile(resolvedFile).then((slice) => {
          cachedKillSwitch = slice.killSwitch;
        });
      }, 100);
    });
  } catch {
    // File does not exist yet — watcher cannot be established. The fallback
    // in checkKillSwitch will handle the missing file case.
    fsWatcher = null;
  }

  return function stopWatcher(): void {
    if (closed) return;
    closed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      fsWatcher?.close();
    } catch {
      // ignore
    }
    // Reset cache so the next startKillSwitchWatcher call starts fresh.
    cachedKillSwitch = undefined;
  };
}

/**
 * Override the cached kill-switch value for unit tests.
 *
 * Bypasses disk I/O and the fs.watch watcher entirely. Call with `false`
 * in `afterEach` to restore a clean state between test cases.
 *
 * @param value - The kill-switch value to inject into the cache.
 *
 * @internal
 */
export function __setKillSwitchForTest(value: boolean): void {
  cachedKillSwitch = value;
}

/**
 * Reset the module-level kill-switch cache to `undefined`.
 *
 * Used in test teardown when tests exercise the disk-read fallback path and
 * need to ensure subsequent tests start with a clean (uncached) state.
 * Distinct from {@link __setKillSwitchForTest} which sets a concrete value.
 *
 * @internal
 */
export function __resetKillSwitchCacheForTest(): void {
  cachedKillSwitch = undefined;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
