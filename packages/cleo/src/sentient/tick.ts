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
  incrementStats,
  patchSentientState,
  readSentientState,
  type SentientState,
  type StuckTaskRecord,
} from './state.js';

// NOTE: `checkAndDream` is lazy-imported inside `maybeTriggerDream` to keep the
// test surface small — tests that don't exercise the dream path never load
// the brain.db stack.

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
