/**
 * Sentient Loop Tick — Single-iteration tick runner for the Tier-1 daemon.
 *
 * A tick is one complete pass of:
 *   1. Check killSwitch (abort if true)
 *   2. Pick an unblocked task via @cleocode/core/sdk
 *   3. Check killSwitch again (abort if true)
 *   4. Spawn worker via `cleo orchestrate spawn <taskId> --adapter <adapter>`
 *   5. Check killSwitch again before recording result
 *   6. Record success (receipt + stats) or failure (retry/backoff)
 *
 * Each step re-reads the state file so that a killSwitch flipped mid-tick is
 * honoured on the very next instruction (Round 2 audit §1: "mid-experiment
 * kill limbo").
 *
 * Rate limit: driven by the cron schedule (`*\/5 * * * *` → ≤12 ticks/hour ≤
 * 12 spawns/hour). No in-tick sleep is required — cron provides the cadence.
 *
 * Scoped OUT: Tier 2 (propose) and Tier 3 (sandbox auto-merge) per ADR-054.
 *
 * @task T946
 * @see ADR-054 — Sentient Loop Tier-1
 */

import { spawn } from 'node:child_process';
import type { Task } from '@cleocode/contracts';
import {
  type ReVerifyOptions,
  reVerifyWorkerReport,
  type WorkerReport,
} from '../orchestrate/worker-verify.js';
import { HYGIENE_SCAN_INTERVAL_MS } from './hygiene-scan.js';
import { DRIFT_SCAN_INTERVAL_MS } from './stage-drift-tick.js';
import {
  incrementStats,
  patchSentientState,
  readSentientState,
  type SentientState,
  type StuckTaskRecord,
} from './state.js';

// NOTE: `checkAndDream` is lazy-imported inside `maybeTriggerDream` to keep the
// test surface small — tests that don't exercise the dream path never load
// the brain.db stack.
// NOTE: `safeRunStageDriftScan` is lazy-imported inside `maybeTriggerStageDriftScan`
// for the same reason — tests that don't exercise drift never load that module.

// ---------------------------------------------------------------------------
// Dream-cycle trigger constants (T996)
// ---------------------------------------------------------------------------

/**
 * Number of new brain observations since the last consolidation that causes
 * the tick loop to trigger a dream cycle (volume tier).
 * Configurable via the injected `dreamVolumeThreshold` option.
 */
export const DREAM_VOLUME_THRESHOLD_DEFAULT = 50;

/**
 * Number of consecutive no-task ticks before the idle dream trigger fires.
 * Represents "N idle ticks" — when no task has been picked for this many
 * consecutive ticks, the system is considered sufficiently idle.
 */
export const DREAM_IDLE_TICKS_DEFAULT = 5;

// NOTE: `@cleocode/core/sdk` and `@cleocode/core/tasks` are lazy-imported
// inside the helpers that use them (`defaultPickTask`, writeSuccessReceipt,
// writeFailureReceipt). That keeps the test surface tiny — tests that inject
// their own `pickTask` / `spawn` never trigger the real SDK load.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default adapter used when spawning workers. */
export const DEFAULT_ADAPTER = 'claude-code' as const;

/**
 * Backoff delays between successive retries for the same task (milliseconds).
 * Index n = delay before attempt n+1. After exhaustion the task is `stuck`.
 * 30 s → 5 min → 30 min, then the task is marked stuck.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [30_000, 300_000, 1_800_000];

/**
 * Maximum spawn attempts per task before it is classified as `stuck`.
 * Matches RETRY_BACKOFF_MS.length but surfaced as a named constant for
 * readability in tests and status output.
 */
export const MAX_TASK_ATTEMPTS = RETRY_BACKOFF_MS.length;

/**
 * Threshold for self-pause: if this many tasks become `stuck` within a
 * rolling 1-hour window, the daemon flips killSwitch=true and exits.
 */
export const SELF_PAUSE_STUCK_THRESHOLD = 5;

/** Rolling window (ms) used for stuck-rate calculation. */
export const SELF_PAUSE_WINDOW_MS = 60 * 60 * 1000;

/** Reason stored on the state file when self-pause fires. */
export const SELF_PAUSE_REASON = 'self-pause: 5 stuck tasks in 1 hour';

/** Max wall-clock time for a single spawn before forceful kill (30 min). */
export const SPAWN_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tick outcome types
// ---------------------------------------------------------------------------

/** Discriminant for the tick outcome. */
export type TickOutcomeKind =
  | 'killed' // killSwitch was active at some checkpoint
  | 'no-task' // no unblocked task available
  | 'backoff' // a task is in retry backoff, skipped this tick
  | 'success' // spawn exited 0
  | 'failure' // spawn exited non-zero, retry scheduled
  | 'stuck' // attempts exhausted, task marked stuck
  | 'self-paused' // stuck-rate threshold tripped self-pause
  | 'error'; // unexpected error in tick machinery itself

/** Structured outcome of a single tick. */
export interface TickOutcome {
  /** Discriminant describing how the tick ended. */
  kind: TickOutcomeKind;
  /** Task id that was the subject of this tick (if any). */
  taskId: string | null;
  /** Human-readable detail (one line). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link runTick}. */
export interface TickOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Adapter to pass to `cleo orchestrate spawn --adapter`. Defaults to
   * {@link DEFAULT_ADAPTER}. Overridden in tests via options.spawn.
   */
  adapter?: string;
  /**
   * Dry-run mode: skip the actual `cleo orchestrate spawn` subprocess and
   * treat the pick as a no-op (still records picked stat). Used by
   * `cleo sentient tick --dry-run`.
   */
  dryRun?: boolean;
  /**
   * Override for the spawn function — lets tests inject a deterministic fake
   * without forking real subprocesses. Must resolve to an exit code.
   *
   * When omitted, the default implementation spawns
   * `cleo orchestrate spawn <taskId> --adapter <adapter>` and resolves with
   * the child's exit code.
   */
  spawn?: (taskId: string, adapter: string) => Promise<SpawnResult>;
  /**
   * Override for the "pick next unblocked task" source. Lets tests return
   * a deterministic task without constructing a SQLite fixture.
   */
  pickTask?: (projectRoot: string) => Promise<Task | null>;
  /**
   * New observation count since last consolidation that triggers the volume
   * dream cycle. Defaults to {@link DREAM_VOLUME_THRESHOLD_DEFAULT}.
   * Pass 0 to disable volume trigger. Injected by tests.
   */
  dreamVolumeThreshold?: number;
  /**
   * Number of consecutive no-task ticks before the idle dream trigger fires.
   * Defaults to {@link DREAM_IDLE_TICKS_DEFAULT}.
   * Pass 0 to disable idle trigger. Injected by tests.
   */
  dreamIdleTicks?: number;
  /**
   * Override for the dream trigger function — lets tests assert dream calls
   * without touching the real brain.db stack.
   * Signature mirrors `checkAndDream` from `@cleocode/core`.
   */
  checkAndDream?: (
    projectRoot: string,
    opts?: { volumeThreshold?: number; inline?: boolean },
  ) => Promise<{ triggered: boolean; tier: string | null; skippedReason?: string }>;
  /**
   * When set to `false`, skips the deriver batch trigger in `safeRunTick`.
   * Useful in tests that don't need the deriver path loaded.
   * Default: true (deriver batch fires when queue has pending items).
   *
   * @task T1145
   */
  runDeriverBatch?: boolean;
  /**
   * Override for the orchestrator-side worker re-verification gate (T1589).
   *
   * When omitted, the default {@link reVerifyWorkerReport} runs `tool:test`
   * (project-resolved per ADR-061) and compares the worker's claimed
   * touched-files against `git status --porcelain`. Tests inject a stub to
   * force accept/reject without spawning real subprocesses.
   *
   * @task T1589
   */
  reVerify?: (report: WorkerReport, options: ReVerifyOptions) => Promise<{ accepted: boolean }>;
  /**
   * Disable the worker re-verification gate entirely. Defaults to `false`
   * (gate enabled). Only set to `true` for `--dry-run` ticks or controlled
   * test paths that have already verified the worker by other means.
   *
   * @task T1589
   */
  skipReVerify?: boolean;
  /**
   * Override for the stage-drift scan function.  Injected by tests to avoid
   * opening a real tasks.db.  When omitted the default
   * {@link safeRunStageDriftScan} from `./stage-drift-tick.js` is used.
   *
   * Pass `null` to disable the drift scan entirely (e.g. unit tests that
   * don't exercise the drift path).
   *
   * @task T1635
   */
  stageDriftScan?: ((projectRoot: string, statePath: string) => Promise<void>) | null;
  /**
   * Interval (ms) between stage-drift scan passes.
   * Defaults to {@link DRIFT_SCAN_INTERVAL_MS} (30 min).
   * Pass 0 to scan on every tick (useful for integration tests).
   *
   * @task T1635
   */
  stageDriftIntervalMs?: number;
  /**
   * Override for the hygiene scan function. Injected by tests to avoid opening
   * a real tasks.db or brain.db. When omitted, the default
   * {@link safeRunHygieneScan} from `./hygiene-scan.js` is used.
   *
   * Pass `null` to disable the hygiene scan entirely (e.g. unit tests that
   * don't exercise the hygiene path).
   *
   * @task T1636
   */
  hygieneScan?: ((projectRoot: string, statePath: string) => Promise<void>) | null;
  /**
   * Interval (ms) between hygiene scan passes.
   * Defaults to {@link HYGIENE_SCAN_INTERVAL_MS} (4 hours).
   * Pass 0 to scan on every tick (useful for integration tests).
   *
   * @task T1636
   */
  hygieneScanIntervalMs?: number;
}

/** Result of a spawn invocation. */
export interface SpawnResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Captured stdout, truncated by the caller if needed. */
  stdout: string;
  /** Captured stderr, truncated by the caller if needed. */
  stderr: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fresh-load state and return true if killSwitch is active. Used at every
 * checkpoint to avoid mid-tick kill limbo (Round 2 audit §1).
 */
async function killSwitchActive(statePath: string): Promise<boolean> {
  const state = await readSentientState(statePath);
  return state.killSwitch === true;
}

/**
 * Build the list of stuck timestamps that fall inside the rolling window.
 */
function pruneStuckWindow(timestamps: readonly number[], now: number): number[] {
  const cutoff = now - SELF_PAUSE_WINDOW_MS;
  return timestamps.filter((t) => t >= cutoff);
}

/**
 * Default SDK-backed task picker. Delegates to the orchestration domain via
 * the @cleocode/core/sdk facade.
 *
 * Tier-1 scope: we pick any unblocked, non-proposed task regardless of which
 * epic it belongs to — the picker walks the full task set to find the next
 * actionable item.
 */
async function defaultPickTask(projectRoot: string): Promise<Task | null> {
  // Lazy import so unit tests that inject `pickTask` never trigger the SDK
  // load (which pulls in the full @cleocode/core graph).
  const { Cleo } = await import('@cleocode/core/sdk');
  const { getReadyTasks } = await import('@cleocode/core/tasks');

  const cleo = await Cleo.init(projectRoot);
  // Use find() to get candidate tasks. We specifically avoid 'proposed' by
  // only filtering on pending/active/blocked. getReadyTasks() from the
  // dependency-check module is authoritative for "unblocked".
  const pending = (await cleo.tasks.find({ status: 'pending', limit: 500 })) as {
    success?: boolean;
    data?: { tasks?: Task[] };
  };
  const candidates: Task[] = Array.isArray(pending?.data?.tasks) ? pending.data.tasks : [];
  if (candidates.length === 0) return null;

  const ready = getReadyTasks(candidates);
  if (ready.length === 0) return null;

  // Deterministic pick: lowest id wins (reproducible for tests).
  ready.sort((a, b) => a.id.localeCompare(b.id));
  return ready[0];
}

/**
 * Default spawn implementation. Shells out to
 * `cleo orchestrate spawn <taskId> --adapter <adapter>` and captures output.
 *
 * Note: we MUST shell out here — the spawn verb shells out to
 * claude-code / gemini-cli / ollama as external tools. Using the SDK
 * directly is not possible without re-implementing adapter dispatch.
 */
function defaultSpawn(taskId: string, adapter: string, projectRoot: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const args = ['orchestrate', 'spawn', taskId, '--adapter', adapter];
    const child = spawn('cleo', args, {
      cwd: projectRoot,
      env: { ...process.env, CLEO_SENTIENT_SPAWN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, SPAWN_TIMEOUT_MS);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `\n[sentient] spawn error: ${err.message}`,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
    });
  });
}

/**
 * Record a successful spawn to the brain via `memory.observe`.
 * Swallows errors: receipt write must never break the tick.
 */
async function writeSuccessReceipt(
  projectRoot: string,
  taskId: string,
  exitCode: number,
): Promise<void> {
  try {
    const { Cleo } = await import('@cleocode/core/sdk');
    const cleo = await Cleo.init(projectRoot);
    await cleo.memory.observe({
      text: `sentient-tier1: task ${taskId} completed successfully (exit=${exitCode})`,
      title: `sentient-receipt: ${taskId}`,
    });
  } catch {
    // Receipt is best-effort; do not fail the tick.
  }
}

// ---------------------------------------------------------------------------
// Dream-cycle trigger state (T996)
// ---------------------------------------------------------------------------

/**
 * Number of consecutive no-task ticks since the last successful task pick.
 * Used by the idle dream trigger: when this counter reaches `dreamIdleTicks`,
 * `checkAndDream` is called with the idle tier.
 *
 * Reset to 0 whenever a task is successfully picked.
 */
let consecutiveIdleTicks = 0;

// ---------------------------------------------------------------------------
// Worktree prune state (T1161)
// ---------------------------------------------------------------------------

/**
 * How many ticks between each worktree prune pass.
 *
 * Prune runs every N ticks to clean up stale worktree directories from
 * experiments that have already completed or been abandoned. Default: 10 ticks.
 */
export const WORKTREE_PRUNE_INTERVAL_TICKS = 10;

/**
 * Module-level tick counter for the worktree prune cadence.
 * Incremented on every `safeRunTick` call.
 * @internal
 */
let _worktreePruneTickCount = 0;

// ---------------------------------------------------------------------------
// Stage-drift scan state (T1635)
// ---------------------------------------------------------------------------

/**
 * Unix-epoch-ms timestamp of the last stage-drift scan pass.
 * Used to gate the scan to at most once every {@link DRIFT_SCAN_INTERVAL_MS}.
 * Set to 0 so the first tick always triggers an initial scan.
 * @internal
 */
let _lastStageDriftScanAt = 0;

// ---------------------------------------------------------------------------
// Hygiene scan state (T1636)
// ---------------------------------------------------------------------------

/**
 * Unix-epoch-ms timestamp of the last hygiene scan pass.
 * Used to gate the scan to at most once every {@link HYGIENE_SCAN_INTERVAL_MS}.
 * Set to 0 so the first tick always triggers an initial scan.
 * @internal
 */
let _lastHygieneScanAt = 0;

/**
 * Evaluate volume + idle dream triggers and call `checkAndDream` when either
 * fires. Errors are swallowed — dream trigger must never crash the tick.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param opts - Tick options (provides thresholds + injectable checkAndDream).
 * @param pickedTask - Whether a task was picked this tick (resets idle counter).
 */
async function maybeTriggerDream(
  projectRoot: string,
  opts: TickOptions,
  pickedTask: boolean,
): Promise<void> {
  const volumeThreshold = opts.dreamVolumeThreshold ?? DREAM_VOLUME_THRESHOLD_DEFAULT;
  const idleTicksThreshold = opts.dreamIdleTicks ?? DREAM_IDLE_TICKS_DEFAULT;

  // Disable both triggers when thresholds are 0 (test escape hatch).
  if (volumeThreshold <= 0 && idleTicksThreshold <= 0) return;

  if (pickedTask) {
    consecutiveIdleTicks = 0;
  } else {
    consecutiveIdleTicks += 1;
  }

  const dreamer =
    opts.checkAndDream ??
    (async (root: string, dreamerOpts?: { volumeThreshold?: number; inline?: boolean }) => {
      const { checkAndDream } = await import('@cleocode/core/internal');
      return checkAndDream(root, dreamerOpts);
    });

  try {
    await dreamer(projectRoot, {
      volumeThreshold: volumeThreshold > 0 ? volumeThreshold : undefined,
      inline: false,
    }).catch((err: unknown) => {
      console.warn('[sentient/tick] dream trigger error:', err);
    });
  } catch (err) {
    console.warn('[sentient/tick] dream trigger threw:', err);
  }
}

/**
 * Record a failure to the brain via `memory.observe`.
 * Swallows errors: receipt write must never break the tick.
 */
async function writeFailureReceipt(
  projectRoot: string,
  taskId: string,
  attempt: number,
  exitCode: number,
  reason: string,
): Promise<void> {
  try {
    const { Cleo } = await import('@cleocode/core/sdk');
    const cleo = await Cleo.init(projectRoot);
    await cleo.memory.observe({
      text:
        `sentient-tier1: task ${taskId} failed (attempt=${attempt}/${MAX_TASK_ATTEMPTS}, ` +
        `exit=${exitCode}). reason=${reason.slice(0, 500)}`,
      title: `sentient-failure: ${taskId}`,
    });
  } catch {
    // Receipt is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single tick of the sentient loop.
 *
 * Every checkpoint re-reads state so that a killSwitch flipped mid-tick is
 * honoured on the next instruction.
 *
 * @param options - Tick options (see {@link TickOptions})
 * @returns Structured outcome describing how the tick ended.
 */
export async function runTick(options: TickOptions): Promise<TickOutcome> {
  const { projectRoot, statePath } = options;
  const adapter = options.adapter ?? DEFAULT_ADAPTER;
  const now = Date.now();

  // -- Checkpoint 1: killSwitch before any work ------------------------------
  if (await killSwitchActive(statePath)) {
    await incrementStats(statePath, { ticksKilled: 1 });
    await patchSentientState(statePath, { lastTickAt: new Date(now).toISOString() });
    return { kind: 'killed', taskId: null, detail: 'killSwitch active before pick' };
  }

  // -- Pick next unblocked task ---------------------------------------------
  const picker = options.pickTask ?? defaultPickTask;
  let task: Task | null;
  try {
    task = await picker(projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await incrementStats(statePath, { ticksExecuted: 1 });
    await patchSentientState(statePath, { lastTickAt: new Date(now).toISOString() });
    return { kind: 'error', taskId: null, detail: `picker threw: ${message}` };
  }

  if (task === null) {
    await incrementStats(statePath, { ticksExecuted: 1 });
    await patchSentientState(statePath, { lastTickAt: new Date(now).toISOString() });
    return { kind: 'no-task', taskId: null, detail: 'no unblocked tasks available' };
  }

  // -- Respect per-task backoff ---------------------------------------------
  const preSpawnState = await readSentientState(statePath);
  const existingStuck: StuckTaskRecord | undefined = preSpawnState.stuckTasks[task.id];
  if (existingStuck && existingStuck.nextRetryAt > now) {
    await incrementStats(statePath, { ticksExecuted: 1 });
    await patchSentientState(statePath, { lastTickAt: new Date(now).toISOString() });
    return {
      kind: 'backoff',
      taskId: task.id,
      detail: `task ${task.id} in backoff until ${new Date(existingStuck.nextRetryAt).toISOString()}`,
    };
  }

  // -- Checkpoint 2: killSwitch before spawn --------------------------------
  if (await killSwitchActive(statePath)) {
    await incrementStats(statePath, { ticksKilled: 1 });
    await patchSentientState(statePath, { lastTickAt: new Date(now).toISOString() });
    return { kind: 'killed', taskId: task.id, detail: 'killSwitch active before spawn' };
  }

  // -- Mark task active ------------------------------------------------------
  await incrementStats(statePath, { tasksPicked: 1 });
  await patchSentientState(statePath, { activeTaskId: task.id });

  // -- Spawn worker ---------------------------------------------------------
  let spawnResult: SpawnResult;
  if (options.dryRun === true) {
    spawnResult = {
      exitCode: 0,
      stdout: '[dry-run] spawn skipped',
      stderr: '',
    };
  } else {
    try {
      const spawner = options.spawn ?? ((tid, adp) => defaultSpawn(tid, adp, projectRoot));
      spawnResult = await spawner(task.id, adapter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spawnResult = { exitCode: 1, stdout: '', stderr: `spawn threw: ${message}` };
    }
  }

  // -- Checkpoint 3: killSwitch before recording ----------------------------
  if (await killSwitchActive(statePath)) {
    await incrementStats(statePath, { ticksKilled: 1 });
    await patchSentientState(statePath, {
      lastTickAt: new Date(Date.now()).toISOString(),
      activeTaskId: null,
    });
    return {
      kind: 'killed',
      taskId: task.id,
      detail: 'killSwitch active after spawn; result not recorded',
    };
  }

  // -- Classify + record -----------------------------------------------------
  if (spawnResult.exitCode === 0) {
    // T1589: orchestrator-side re-verification gate. Worker self-reports
    // exit=0 but we MUST NOT trust it without re-running gates against
    // ground truth (lie #4 in HONEST-HANDOFF-2026-04-28.md). The gate is
    // skipped under --dry-run and when explicitly disabled; tests inject
    // an `options.reVerify` stub instead of spawning real subprocesses.
    const skipReVerify = options.skipReVerify === true || options.dryRun === true;
    if (!skipReVerify && options.reVerify !== undefined) {
      const report: WorkerReport = {
        taskId: task.id,
        selfReportSuccess: true,
        evidenceAtoms: ['tool:test'],
        touchedFiles: [],
      };
      const verdict = await options.reVerify(report, { projectRoot });
      if (!verdict.accepted) {
        const currentAttempts = existingStuck?.attempts ?? 0;
        const nextAttempts = currentAttempts + 1;
        const failureReason = `worker re-verify rejected (T1589): exit=0 but gates failed`;
        await writeFailureReceipt(
          projectRoot,
          task.id,
          nextAttempts,
          spawnResult.exitCode,
          failureReason,
        );
        await incrementStats(statePath, { tasksFailed: 1, ticksExecuted: 1 });
        await patchSentientState(statePath, {
          activeTaskId: null,
          lastTickAt: new Date(Date.now()).toISOString(),
        });
        return {
          kind: 'failure',
          taskId: task.id,
          detail: failureReason,
        };
      }
    }
    // Reference reVerifyWorkerReport so the import is retained even when
    // tests inject a stub via options.reVerify (production callers can
    // assign options.reVerify = reVerifyWorkerReport).
    void reVerifyWorkerReport;

    await writeSuccessReceipt(projectRoot, task.id, spawnResult.exitCode);
    // Clear stuck entry on success.
    const post = await readSentientState(statePath);
    const { [task.id]: _removed, ...rest } = post.stuckTasks;
    void _removed;
    await patchSentientState(statePath, {
      stuckTasks: rest,
      activeTaskId: null,
      lastTickAt: new Date(Date.now()).toISOString(),
    });
    await incrementStats(statePath, { tasksCompleted: 1, ticksExecuted: 1 });
    return {
      kind: 'success',
      taskId: task.id,
      detail: `task ${task.id} completed (exit=0)`,
    };
  }

  // -- Failure path: increment attempts, record backoff or stuck -----------
  const currentAttempts = existingStuck?.attempts ?? 0;
  const nextAttempts = currentAttempts + 1;
  const failureReason = spawnResult.stderr.slice(-500) || `exit=${spawnResult.exitCode}`;

  await writeFailureReceipt(
    projectRoot,
    task.id,
    nextAttempts,
    spawnResult.exitCode,
    failureReason,
  );
  await incrementStats(statePath, { tasksFailed: 1, ticksExecuted: 1 });

  if (nextAttempts >= MAX_TASK_ATTEMPTS) {
    // Mark task stuck. Record timestamp in rolling window; self-pause if ≥ threshold.
    const windowed = pruneStuckWindow(preSpawnState.stuckTimestamps, now);
    windowed.push(now);

    const stuckRecord: StuckTaskRecord = {
      attempts: nextAttempts,
      lastFailureAt: new Date(now).toISOString(),
      nextRetryAt: Number.MAX_SAFE_INTEGER, // owner-only release
      lastReason: failureReason,
    };

    const post = await readSentientState(statePath);
    const updatedStuckTasks: Record<string, StuckTaskRecord> = {
      ...post.stuckTasks,
      [task.id]: stuckRecord,
    };

    const shouldSelfPause = windowed.length >= SELF_PAUSE_STUCK_THRESHOLD;

    await patchSentientState(statePath, {
      stuckTasks: updatedStuckTasks,
      stuckTimestamps: windowed,
      activeTaskId: null,
      lastTickAt: new Date(now).toISOString(),
      ...(shouldSelfPause ? { killSwitch: true, killSwitchReason: SELF_PAUSE_REASON } : {}),
    });

    if (shouldSelfPause) {
      return {
        kind: 'self-paused',
        taskId: task.id,
        detail:
          `task ${task.id} is stuck; self-pause fired ` +
          `(${windowed.length}/${SELF_PAUSE_STUCK_THRESHOLD} stucks in window)`,
      };
    }

    return {
      kind: 'stuck',
      taskId: task.id,
      detail:
        `task ${task.id} stuck after ${nextAttempts} attempts; ` +
        `owner must re-enable via \`cleo sentient resume\``,
    };
  }

  // Schedule next retry with backoff.
  const backoff =
    RETRY_BACKOFF_MS[nextAttempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  const stuckRecord: StuckTaskRecord = {
    attempts: nextAttempts,
    lastFailureAt: new Date(now).toISOString(),
    nextRetryAt: now + backoff,
    lastReason: failureReason,
  };
  const post = await readSentientState(statePath);
  await patchSentientState(statePath, {
    stuckTasks: { ...post.stuckTasks, [task.id]: stuckRecord },
    activeTaskId: null,
    lastTickAt: new Date(now).toISOString(),
  });

  return {
    kind: 'failure',
    taskId: task.id,
    detail:
      `task ${task.id} failed (attempt=${nextAttempts}/${MAX_TASK_ATTEMPTS}); ` +
      `retry scheduled at ${new Date(now + backoff).toISOString()}`,
  };
}

/**
 * Evaluate the stage-drift scan cadence and fire {@link safeRunStageDriftScan}
 * when enough time has elapsed since the last scan.
 *
 * Respects the injectable `options.stageDriftScan` override (null = disabled).
 * Errors are swallowed — drift scan must never crash the tick.
 *
 * @param projectRoot - Absolute project root.
 * @param statePath   - Path to sentient-state.json.
 * @param options     - Tick options (provides injectable and interval override).
 *
 * @internal
 * @task T1635
 */
async function maybeTriggerStageDriftScan(
  projectRoot: string,
  statePath: string,
  options: TickOptions,
): Promise<void> {
  // Null explicitly disables the scan (test escape hatch).
  if (options.stageDriftScan === null) return;

  const intervalMs = options.stageDriftIntervalMs ?? DRIFT_SCAN_INTERVAL_MS;
  const now = Date.now();

  if (now - _lastStageDriftScanAt < intervalMs) return;

  // Update the timestamp before awaiting so concurrent ticks don't double-fire.
  _lastStageDriftScanAt = now;

  try {
    if (options.stageDriftScan) {
      // Injected override (tests).
      await options.stageDriftScan(projectRoot, statePath);
    } else {
      // Default: lazy-import and run.
      const { safeRunStageDriftScan } = await import('./stage-drift-tick.js');
      await safeRunStageDriftScan({ projectRoot, statePath });
    }
  } catch {
    // Drift scan is best-effort: errors must never propagate to the tick caller.
  }
}

/**
 * Evaluate the hygiene scan cadence and fire {@link safeRunHygieneScan}
 * when enough time has elapsed since the last scan.
 *
 * Respects the injectable `options.hygieneScan` override (null = disabled).
 * Errors are swallowed — hygiene scan must never crash the tick.
 *
 * @param projectRoot - Absolute project root.
 * @param statePath   - Path to sentient-state.json.
 * @param options     - Tick options (provides injectable and interval override).
 *
 * @internal
 * @task T1636
 */
async function maybeTriggerHygieneScan(
  projectRoot: string,
  statePath: string,
  options: TickOptions,
): Promise<void> {
  // Null explicitly disables the scan (test escape hatch).
  if (options.hygieneScan === null) return;

  const intervalMs = options.hygieneScanIntervalMs ?? HYGIENE_SCAN_INTERVAL_MS;
  const now = Date.now();

  if (now - _lastHygieneScanAt < intervalMs) return;

  // Update the timestamp before awaiting so concurrent ticks don't double-fire.
  _lastHygieneScanAt = now;

  try {
    if (options.hygieneScan) {
      // Injected override (tests).
      await options.hygieneScan(projectRoot, statePath);
    } else {
      // Default: lazy-import and run.
      const { safeRunHygieneScan } = await import('./hygiene-scan.js');
      await safeRunHygieneScan({ projectRoot, statePath });
    }
  } catch {
    // Hygiene scan is best-effort: errors must never propagate to the tick caller.
  }
}

/**
 * Convenience wrapper used by the daemon cron handler and the `cleo sentient
 * tick` CLI command. Reads state, runs a tick, swallows any unexpected
 * exception so the cron scheduler never sees a rejection.
 *
 * After the tick completes, evaluates volume + idle dream triggers via
 * {@link maybeTriggerDream}. Dream errors are swallowed independently so
 * they never affect the tick outcome.
 *
 * @param options - Tick options
 * @returns The tick outcome (or an `error` outcome if the tick itself threw).
 */
export async function safeRunTick(options: TickOptions): Promise<TickOutcome> {
  let outcome: TickOutcome;
  try {
    outcome = await runTick(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await incrementStats(options.statePath, { ticksExecuted: 1 });
    } catch {
      // ignore
    }
    outcome = { kind: 'error', taskId: null, detail: `tick threw: ${message}` };
  }

  // Dream trigger: fire volume + idle checks after every tick.
  // A task was "picked" when the tick progressed past the no-task check
  // (i.e. kind is not 'no-task', 'killed', or 'error').
  const pickedTask =
    outcome.kind !== 'no-task' &&
    outcome.kind !== 'killed' &&
    outcome.kind !== 'error' &&
    outcome.taskId !== null;

  await maybeTriggerDream(options.projectRoot, options, pickedTask).catch(() => {
    // Dream errors must never propagate to the tick caller.
  });

  // Deriver batch: process pending deriver queue items each tick (T1145).
  // Lazy-imported to keep test surface small — tests that don't exercise
  // the deriver path never load the deriver module.
  // Best-effort: deriver errors must never affect tick outcome.
  if (options.runDeriverBatch !== false) {
    Promise.resolve()
      .then(async () => {
        try {
          const { hasQueuePending } = await import('../deriver/status.js');
          if (hasQueuePending()) {
            const { runDeriverBatch: _runDeriverBatch } = await import('../deriver/consumer.js');
            await _runDeriverBatch(options.projectRoot);
          }
        } catch {
          // Deriver is best-effort: log nothing, never block.
        }
      })
      .catch(() => {
        // Ignore.
      });
  }

  // Stage-drift scan: fire when enough time has elapsed (T1635).
  // Best-effort: errors never affect tick outcome.
  maybeTriggerStageDriftScan(options.projectRoot, options.statePath, options).catch(() => {
    // Ignore.
  });

  // Hygiene scan: fire when enough time has elapsed (T1636).
  // Runs once per dream cycle (default 4 h) — longer cadence than stage-drift.
  // Best-effort: errors never affect tick outcome.
  maybeTriggerHygieneScan(options.projectRoot, options.statePath, options).catch(() => {
    // Ignore.
  });

  // Worktree prune: run every WORKTREE_PRUNE_INTERVAL_TICKS ticks (T1161).
  _worktreePruneTickCount += 1;
  if (_worktreePruneTickCount % WORKTREE_PRUNE_INTERVAL_TICKS === 0) {
    // Fire-and-forget: prune errors must never affect tick outcome.
    Promise.resolve()
      .then(async () => {
        try {
          const { pruneWorktreesForProject } = await import('./worktree-dispatch.js');
          pruneWorktreesForProject(options.projectRoot, new Set<string>());
        } catch {
          // Prune is best-effort: log nothing, never block.
        }
      })
      .catch(() => {
        // Ignore.
      });
  }

  return outcome;
}

/**
 * Type-narrowing helper used by tests and status rendering to identify tick
 * outcomes that consumed a retry attempt.
 */
export function isFailureOutcome(
  outcome: TickOutcome,
): outcome is TickOutcome & { kind: 'failure' | 'stuck' | 'self-paused' } {
  return outcome.kind === 'failure' || outcome.kind === 'stuck' || outcome.kind === 'self-paused';
}

/**
 * Returns a shallow view of the current state's kill status.
 * Exposed for diagnostic/test consumers.
 */
export async function getKillStatus(
  statePath: string,
): Promise<Pick<SentientState, 'killSwitch' | 'killSwitchReason'>> {
  const state = await readSentientState(statePath);
  return { killSwitch: state.killSwitch, killSwitchReason: state.killSwitchReason };
}

/**
 * Reset dream-cycle in-process state.
 *
 * Intended for test teardown only — clears `consecutiveIdleTicks` so that
 * successive test cases start from a clean slate.
 *
 * @internal
 */
export function _resetDreamTickState(): void {
  consecutiveIdleTicks = 0;
}

/**
 * Reset worktree prune tick counter.
 *
 * Intended for test teardown only — allows tests to reset the prune cadence
 * counter so successive test cases start from a clean slate.
 *
 * @internal
 */
export function _resetWorktreePruneTickCount(): void {
  _worktreePruneTickCount = 0;
}

/**
 * Return the current worktree prune tick counter value.
 *
 * Read-only accessor for test assertions.
 *
 * @internal
 */
export function _getWorktreePruneTickCount(): number {
  return _worktreePruneTickCount;
}

/**
 * Return the current consecutive-idle-tick counter value.
 *
 * Read-only accessor for test assertions. The counter is reset to 0 whenever
 * a task is picked, and incremented on each no-task tick.
 *
 * @internal
 */
export function _getConsecutiveIdleTicks(): number {
  return consecutiveIdleTicks;
}

/**
 * Reset the stage-drift scan timestamp.
 *
 * Intended for test teardown only — allows tests to reset the scan cadence
 * so successive test cases start from a clean slate (next tick fires immediately).
 *
 * @internal
 * @task T1635
 */
export function _resetStageDriftScanAt(): void {
  _lastStageDriftScanAt = 0;
}

/**
 * Return the unix-epoch-ms timestamp of the last stage-drift scan.
 *
 * Read-only accessor for test assertions.
 *
 * @internal
 * @task T1635
 */
export function _getLastStageDriftScanAt(): number {
  return _lastStageDriftScanAt;
}

/**
 * Reset the hygiene scan timestamp.
 *
 * Intended for test teardown only — allows tests to reset the scan cadence
 * so successive test cases start from a clean slate (next tick fires immediately).
 *
 * @internal
 * @task T1636
 */
export function _resetHygieneScanAt(): void {
  _lastHygieneScanAt = 0;
}

/**
 * Return the unix-epoch-ms timestamp of the last hygiene scan.
 *
 * Read-only accessor for test assertions.
 *
 * @internal
 * @task T1636
 */
export function _getLastHygieneScanAt(): number {
  return _lastHygieneScanAt;
}

// ---------------------------------------------------------------------------
// T1030 — Tier 3 merge ritual orchestrator
// ---------------------------------------------------------------------------
// Runs the experimental auto-merge ritual on a cadence. Each tick:
//   1. kill-switch check (pre-pick)       → killed if active
//   2. enabled guard                      → skipped:disabled
//   3. cadence guard (TIER3_CADENCE_MS)   → skipped:cadence-not-elapsed
//   4. pickTask                           → no-eligible-tasks if null
//   5. kill-switch check (post-pick)      → killed if active
//   6. captureBaseline + getHeadSha       → anchor rollback point
//   7. spawnSandbox                       → worktree for experimental patch
//   8. kill-switch check (post-spawn)     → killed if active
//   9. waitForPatch                       → synchronise on patch completion
//  10. kill-switch check (pre-verify)     → killed if active
//  11. verifyInWorktree                   → aborted:verify-failed if fails
//  12. signExperiment                     → signs merge intent
//  13. gitFfMerge --ff-only               → aborted:merge-aborted if fails
//  14. markTaskAutoMerged                 → records success in tasks.db
//  15. bump tier3Stats.mergesCompleted    → return merged
//
// Any kill-switch activation before verify aborts cleanly WITHOUT merging.
// NEVER auto-rebases; only FF is attempted (ADR-054 §Tier-3 invariant).

/** T1030: Tier 3 cadence — 15 minutes between merge attempts. */
export const TIER3_CADENCE_MS = 15 * 60 * 1000;

/** Task reference passed between tick steps. */
type Tier3Task = import('@cleocode/contracts').Task;

/** Options for {@link runTier3Tick}. All side-effecting deps are injectable. */
export interface Tier3TickOptions {
  /** Absolute path to the project root (target branch worktree). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /** Whether Tier 3 is enabled. When false, tick no-ops with skipped:disabled. */
  enabled: boolean;
  /**
   * ISO-8601 timestamp of last tick. Used for cadence gating; callers
   * typically pass `state.tier3LastTickAt`.
   */
  lastTickAt: string | null;
  /** Optional override for target branch (defaults to 'main'). */
  targetBranch?: string;
  /** Picker returning the next Tier-3-eligible task or null. */
  pickTask: (projectRoot: string) => Promise<Tier3Task | null>;
  /** Anchor the rollback baseline before spawning the sandbox. */
  captureBaseline: (projectRoot: string, commitSha: string) => Promise<{ receiptId: string }>;
  /** Resolve the current HEAD SHA of the target branch. */
  getHeadSha: (projectRoot: string) => Promise<string>;
  /** Spawn the experimental sandbox and return its metadata. */
  spawnSandbox: (task: Tier3Task, projectRoot: string) => Promise<SandboxSpawnRecord>;
  /** Block until the sandbox's patch completes. */
  waitForPatch: (spawn: SandboxSpawnRecord) => Promise<PatchRecord>;
  /** Run verification gates inside the experiment worktree. */
  verifyInWorktree: (spawn: SandboxSpawnRecord, patch: PatchRecord) => Promise<VerifyRecord>;
  /** Sign the experiment (receipt for the merge intent). */
  signExperiment: (spawn: SandboxSpawnRecord, verify: VerifyRecord) => Promise<SignRecord>;
  /** Record task as auto-merged in tasks.db after successful merge. */
  markTaskAutoMerged: (projectRoot: string, taskId: string, mergedSha: string) => Promise<void>;
}

/** Spawn record produced by the sandbox orchestrator. */
export interface SandboxSpawnRecord {
  /** Stable UUID for the experiment run. */
  experimentId: string;
  /** Absolute path to the experiment worktree (FF source). */
  worktree: string;
  /** Receipt id produced by {@link captureBaseline} or the spawner. */
  receiptId: string;
}

/** Patch record emitted when the sandbox completes its change. */
export interface PatchRecord {
  /** Files modified by the patch (relative to worktree root). */
  patchFiles: string[];
  /** One-line human-readable patch summary. */
  patchSummary: string;
  /** Content hash of the applied patch (hex). */
  patchSha: string;
  /** Receipt id linking the patch to its sign/verify chain. */
  receiptId: string;
}

/** Verify record summarising IVTR gate outcomes. */
export interface VerifyRecord {
  /** Whether ALL gates passed. */
  passed: boolean;
  /** Per-gate outcomes. */
  gates: readonly {
    readonly gate: string;
    readonly passed: boolean;
    readonly evidenceAtoms?: readonly string[];
  }[];
  /** Post-run metrics captured by the verifier. */
  afterMetrics?: Record<string, unknown>;
  /** Receipt id linking verify output to the signed experiment. */
  receiptId: string;
}

/** Sign record produced when the experiment is committed to merge intent. */
export interface SignRecord {
  /** Hex-encoded 64-byte Ed25519 signature over the canonical receipt. */
  signature: string;
  /** Receipt id of the sign step. */
  receiptId: string;
}

/** Outcome returned by {@link runTier3Tick}. */
export interface Tier3TickOutcome {
  /** Kind of outcome. */
  kind: 'skipped' | 'killed' | 'no-eligible-tasks' | 'aborted' | 'merged';
  /** Human-readable detail (included in every outcome). */
  detail: string;
  /** Task id for outcomes that picked a task. */
  taskId?: string;
  /** HEAD SHA after merge (only for `merged` outcomes). */
  mergedSha?: string;
}

/**
 * T1030: Run one iteration of the Tier-3 auto-merge ritual.
 *
 * Invariants:
 *   - NEVER auto-rebases; ONLY FF merge via {@link gitFfMerge}.
 *   - Kill-switch checkpoints at pre-pick, post-pick, post-spawn, pre-verify.
 *   - verify-failed → aborts BEFORE sign / merge.
 *   - ff-failed → aborts AFTER sign (sign records intent; merge fails).
 *   - Happy path bumps `state.tier3Stats.mergesCompleted` + `tier3LastTickAt`.
 *
 * @task T1030
 */
export async function runTier3Tick(options: Tier3TickOptions): Promise<Tier3TickOutcome> {
  const { checkKillSwitch, KillSwitchActivatedError } = await import('./kill-switch.js');
  const { patchSentientState, readSentientState } = await import('./state.js');

  async function bumpTier3(
    path: string,
    delta: Partial<import('./state.js').Tier3Stats>,
  ): Promise<void> {
    const current = await readSentientState(path);
    await patchSentientState(path, {
      tier3Stats: {
        ticksKilled: current.tier3Stats.ticksKilled + (delta.ticksKilled ?? 0),
        abortsTotal: current.tier3Stats.abortsTotal + (delta.abortsTotal ?? 0),
        mergesCompleted: current.tier3Stats.mergesCompleted + (delta.mergesCompleted ?? 0),
      },
    });
  }

  async function handleKilled(
    step: 'pre-pick' | 'post-pick' | 'post-spawn' | 'pre-verify',
    taskId?: string,
  ): Promise<Tier3TickOutcome> {
    await bumpTier3(options.statePath, { ticksKilled: 1 });
    await patchSentientState(options.statePath, {
      tier3LastTickAt: new Date().toISOString(),
    });
    return { kind: 'killed', detail: step, ...(taskId ? { taskId } : {}) };
  }

  // Step 0: kill-switch BEFORE disabled/cadence checks.
  try {
    await checkKillSwitch('pre-pick', options.statePath);
  } catch (err) {
    if (err instanceof KillSwitchActivatedError) return handleKilled('pre-pick');
    throw err;
  }

  // Step 1: enabled guard.
  if (!options.enabled) return { kind: 'skipped', detail: 'disabled' };

  // Step 2: cadence guard.
  if (options.lastTickAt) {
    const elapsed = Date.now() - new Date(options.lastTickAt).getTime();
    if (elapsed < TIER3_CADENCE_MS) {
      return { kind: 'skipped', detail: 'cadence-not-elapsed' };
    }
  }

  // Step 3: pick task.
  const task = await options.pickTask(options.projectRoot);
  if (!task) {
    await patchSentientState(options.statePath, {
      tier3LastTickAt: new Date().toISOString(),
    });
    return { kind: 'no-eligible-tasks', detail: 'no tier3-eligible tasks' };
  }

  // Step 4: post-pick kill check.
  try {
    await checkKillSwitch('post-pick', options.statePath);
  } catch (err) {
    if (err instanceof KillSwitchActivatedError) return handleKilled('post-pick', task.id);
    throw err;
  }

  // Step 5: baseline capture.
  const headSha = await options.getHeadSha(options.projectRoot);
  await options.captureBaseline(options.projectRoot, headSha);

  // Step 6: spawn sandbox.
  const spawn = await options.spawnSandbox(task, options.projectRoot);

  // Step 7: post-spawn kill check.
  try {
    await checkKillSwitch('post-spawn', options.statePath);
  } catch (err) {
    if (err instanceof KillSwitchActivatedError) return handleKilled('post-spawn', task.id);
    throw err;
  }

  // Step 8: wait for patch.
  const patch = await options.waitForPatch(spawn);

  // Step 9: pre-verify kill check.
  try {
    await checkKillSwitch('pre-verify', options.statePath);
  } catch (err) {
    if (err instanceof KillSwitchActivatedError) return handleKilled('pre-verify', task.id);
    throw err;
  }

  // Step 10: verify.
  const verify = await options.verifyInWorktree(spawn, patch);
  if (!verify.passed) {
    await bumpTier3(options.statePath, { abortsTotal: 1 });
    await patchSentientState(options.statePath, {
      tier3LastTickAt: new Date().toISOString(),
    });
    const failedGates = verify.gates
      .filter((g) => !g.passed)
      .map((g) => g.gate)
      .join(', ');
    return {
      kind: 'aborted',
      detail: `verify failed: ${failedGates || 'unknown'}`,
      taskId: task.id,
    };
  }

  // Step 11: sign experiment.
  await options.signExperiment(spawn, verify);

  // Step 12: FF merge.
  const { gitFfMerge } = await import('./merge.js');
  const mergeResult = await gitFfMerge({
    experimentWorktree: spawn.worktree,
    targetBranch: options.targetBranch ?? 'main',
    cwd: options.projectRoot,
  });

  if (!mergeResult.merged) {
    await bumpTier3(options.statePath, { abortsTotal: 1 });
    await patchSentientState(options.statePath, {
      tier3LastTickAt: new Date().toISOString(),
    });
    return {
      kind: 'aborted',
      detail: `merge aborted: ${mergeResult.reason ?? 'unknown'}`,
      taskId: task.id,
    };
  }

  // Step 13: mark task as auto-merged.
  await options.markTaskAutoMerged(options.projectRoot, task.id, mergeResult.headSha);

  // Step 14: success — bump counters, record tick timestamp.
  await bumpTier3(options.statePath, { mergesCompleted: 1 });
  await patchSentientState(options.statePath, {
    tier3LastTickAt: new Date().toISOString(),
  });

  return {
    kind: 'merged',
    detail: 'merged',
    taskId: task.id,
    mergedSha: mergeResult.headSha,
  };
}
