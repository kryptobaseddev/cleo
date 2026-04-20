/**
 * Sentient Daemon — Tier-1 autonomous loop sidecar.
 *
 * Runs as a detached Node.js process and executes `runTick()` every 5
 * minutes. Mirrors the gc/daemon.ts sidecar pattern (ADR-047) and honours
 * the worktree protocol — all state lives under the project's `.cleo/`.
 *
 * Scoped IN (this module):
 *   - Tier-1 execution of unblocked tasks via `cleo orchestrate spawn`
 *   - Kill-switch with re-check at every tick checkpoint
 *   - Advisory locking via an OS-level lockfile (two daemons cannot coexist)
 *   - Stuck detection + self-pause on stuck-rate threshold
 *   - fs.watch-based fast kill propagation
 *
 * Scoped OUT (separate epics):
 *   - Tier-2 proposal queue (`cleo propose` / status='proposed' generation)
 *   - Tier-3 sandbox auto-merge (requires agent-in-container infra)
 *   - Ed25519 signing of receipts (handled by Agent B2 llmtxt/identity wiring)
 *
 * @see ADR-054 — Sentient Loop Tier-1
 * @task T946
 */

import { spawn } from 'node:child_process';
import type { FSWatcher } from 'node:fs';
import { createWriteStream, constants as fsConstants, watch } from 'node:fs';
import { type FileHandle, open as fsOpen, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { type ProposeTickOptions, safeRunProposeTick } from './propose-tick.js';
import { patchSentientState, readSentientState, type SentientState } from './state.js';
import { safeRunTick, type TickOptions } from './tick.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative subpath under a project root where sentient state lives. */
export const SENTIENT_STATE_FILE = '.cleo/sentient-state.json' as const;

/** Relative subpath for the daemon lockfile. */
export const SENTIENT_LOCK_FILE = '.cleo/sentient.lock' as const;

/** Cron expression: every 5 minutes (Tier-1 tick). */
export const SENTIENT_CRON_EXPR = '*/5 * * * *';

/**
 * Cron expression: every 2 hours (Tier-2 propose tick).
 *
 * Separate from the Tier-1 cron to avoid proposal flooding.
 * Only fires when `tier2Enabled = true` in sentient-state.json.
 *
 * @task T1008
 */
export const SENTIENT_PROPOSE_CRON_EXPR = '0 */2 * * *';

/** Subdirectory for daemon logs. */
export const SENTIENT_LOG_DIR = '.cleo/logs' as const;

/** Log filename (stdout). */
export const SENTIENT_LOG = 'sentient.log' as const;

/** Log filename (stderr). */
export const SENTIENT_ERR = 'sentient.err' as const;

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/** Handle to an active advisory lock. */
export interface LockHandle {
  /** Absolute path to the lockfile. */
  path: string;
  /** Underlying file handle held exclusively by this process. */
  handle: FileHandle;
}

/**
 * Acquire an exclusive advisory lock on the sentient lockfile.
 *
 * Uses `fs.open` with `O_CREAT | O_EXCL` semantics — if the file already
 * exists AND its recorded pid is alive, acquisition fails. Stale lockfiles
 * (pid dead) are reclaimed automatically.
 *
 * @param lockPath - Absolute path to `.cleo/sentient.lock`
 * @returns Lock handle, or null if lock is held by a live process
 */
export async function acquireLock(lockPath: string): Promise<LockHandle | null> {
  await mkdir(join(lockPath, '..'), { recursive: true });

  // First attempt: atomic create with O_EXCL.
  try {
    const handle = await fsOpen(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o644,
    );
    await handle.writeFile(String(process.pid), 'utf-8');
    return { path: lockPath, handle };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }

  // Lockfile exists. Check if the recorded pid is alive.
  let existing: FileHandle | null = null;
  try {
    existing = await fsOpen(lockPath, fsConstants.O_RDWR);
    const buf = await existing.readFile({ encoding: 'utf-8' });
    const recordedPid = Number.parseInt(buf.trim(), 10);
    if (Number.isFinite(recordedPid) && recordedPid > 0) {
      try {
        process.kill(recordedPid, 0);
        // Process alive — lock is held.
        await existing.close();
        return null;
      } catch {
        // Process dead — fall through to reclaim.
      }
    }
    // Reclaim: truncate, rewind, write our pid, keep the handle.
    await existing.truncate(0);
    const pidBytes = Buffer.from(String(process.pid), 'utf-8');
    await existing.write(pidBytes, 0, pidBytes.length, 0);
    return { path: lockPath, handle: existing };
  } catch (err) {
    if (existing) {
      try {
        await existing.close();
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Release an advisory lock acquired via {@link acquireLock}.
 * Does NOT remove the lockfile — the pid inside is a useful diagnostic.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  try {
    await lock.handle.close();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Daemon bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap the sentient daemon process.
 *
 * Steps:
 *   1. Acquire advisory lock (fail fast if another daemon is running)
 *   2. Persist our pid + startedAt to state.json
 *   3. Watch state.json for killSwitch changes (fast propagation)
 *   4. Register a SIGTERM handler for graceful shutdown
 *   5. Schedule cron with noOverlap so long ticks don't stack
 *
 * @param projectRoot - Absolute path to the project (contains `.cleo/`)
 */
export async function bootstrapDaemon(projectRoot: string): Promise<void> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const lockPath = join(projectRoot, SENTIENT_LOCK_FILE);

  const lock = await acquireLock(lockPath);
  if (!lock) {
    process.stderr.write(`[CLEO SENTIENT] lock acquisition failed — another daemon is running\n`);
    process.exit(2);
  }

  // Reset pid + counters baseline for this run.
  await patchSentientState(statePath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    // Clear killSwitch on boot only if owner did not explicitly leave it set.
    // We preserve it here: re-starting a killed daemon must not silently
    // resume. Owner explicitly clears via `cleo sentient resume`.
  });

  // fs.watch on state file — lets us surface kill very quickly.
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(statePath, { persistent: false }, () => {
      // Just log — actual kill-switch check happens inside each tick. The
      // file watcher exists so that an active tick can notice flipping
      // without waiting for the 5-min cadence. Ticks re-read state at every
      // checkpoint (Round 2 audit §1).
    });
  } catch {
    watcher = null;
  }

  // Graceful shutdown.
  const shutdown = async (reason: string): Promise<void> => {
    try {
      watcher?.close();
    } catch {
      // ignore
    }
    try {
      await patchSentientState(statePath, {
        pid: null,
        killSwitchReason: reason,
      });
    } catch {
      // ignore
    }
    try {
      await releaseLock(lock);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Kick off one tick immediately, then schedule cron.
  const tickOptions: TickOptions = { projectRoot, statePath };
  const outcome = await safeRunTick(tickOptions);
  process.stdout.write(
    `[CLEO SENTIENT] boot tick: ${outcome.kind} ` +
      `(task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}\n`,
  );

  // Tier-1: every 5 minutes
  cron.schedule(
    SENTIENT_CRON_EXPR,
    async () => {
      const result = await safeRunTick(tickOptions);
      process.stdout.write(
        `[CLEO SENTIENT] tick: ${result.kind} ` +
          `(task=${result.taskId ?? 'n/a'}) ${result.detail}\n`,
      );
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-sentient',
    },
  );

  // Tier-2: every 2 hours (only when tier2Enabled = true)
  // Runs under the same advisory lock as the Tier-1 cron — the lock is held
  // for the lifetime of the daemon process, so both crons run inside it.
  const proposeOptions: ProposeTickOptions = { projectRoot, statePath };
  cron.schedule(
    SENTIENT_PROPOSE_CRON_EXPR,
    async () => {
      const state = await readSentientState(statePath);
      if (!state.tier2Enabled) return;
      const result = await safeRunProposeTick(proposeOptions);
      process.stdout.write(
        `[CLEO SENTIENT T2] propose: ${result.kind} ` +
          `(written=${result.written}, count=${result.count}) ${result.detail}\n`,
      );
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-sentient-propose',
    },
  );
}

// ---------------------------------------------------------------------------
// Spawn helpers (parent-process side)
// ---------------------------------------------------------------------------

/** Outcome of {@link spawnSentientDaemon}. */
export interface SpawnDaemonResult {
  /** PID of the spawned daemon. */
  pid: number;
  /** Absolute path to the .cleo/sentient-state.json file. */
  statePath: string;
  /** Absolute path to the log file. */
  logPath: string;
}

/**
 * Spawn the sentient daemon as a detached background process.
 *
 * All three T751 §2.2 requirements:
 *   1. `detached: true` — process-group leader survives parent exit
 *   2. File-based stdio — no TTY inheritance
 *   3. `child.unref()` — parent CLI returns immediately
 *
 * @param projectRoot - Absolute path to the project root (contains `.cleo/`)
 * @returns PID + log paths
 */
export async function spawnSentientDaemon(projectRoot: string): Promise<SpawnDaemonResult> {
  const logsDir = join(projectRoot, SENTIENT_LOG_DIR);
  await mkdir(logsDir, { recursive: true });

  const logPath = join(logsDir, SENTIENT_LOG);
  const errPath = join(logsDir, SENTIENT_ERR);

  const outStream = createWriteStream(logPath, { flags: 'a' });
  const errStream = createWriteStream(errPath, { flags: 'a' });

  // Resolve daemon-entry.js in the compiled output (sibling to this module).
  const daemonEntry = join(fileURLToPath(import.meta.url), '..', 'daemon-entry.js');

  const child = spawn(process.execPath, [daemonEntry, projectRoot], {
    detached: true,
    stdio: ['ignore', outStream, errStream],
    env: { ...process.env, CLEO_SENTIENT_DAEMON: '1' },
  });

  child.unref();

  const pid = child.pid ?? 0;
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);

  // Pre-persist our pid so subsequent `cleo sentient status` calls can find it
  // even before the child writes its own pid.
  await patchSentientState(statePath, {
    pid,
    startedAt: new Date().toISOString(),
  });

  return { pid, statePath, logPath };
}

/** Outcome of {@link stopSentientDaemon}. */
export interface StopDaemonResult {
  /** Whether the stop signal was delivered. */
  stopped: boolean;
  /** Last known pid; null if no pid was recorded. */
  pid: number | null;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Stop the sentient daemon.
 *
 * Flips killSwitch=true FIRST (so an in-flight tick notices on its next
 * checkpoint re-read), then sends SIGTERM. This gives the daemon a fast,
 * graceful shutdown path even during a long-running spawn.
 *
 * @param projectRoot - Absolute path to the project root
 * @param reason - Optional reason stored on state file for diagnostics
 * @returns Stop result
 */
export async function stopSentientDaemon(
  projectRoot: string,
  reason = 'cleo sentient stop',
): Promise<StopDaemonResult> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const state = await readSentientState(statePath);

  // Flip killSwitch before signalling so an in-progress tick exits on the
  // next checkpoint, even if SIGTERM is delayed or lost.
  await patchSentientState(statePath, {
    killSwitch: true,
    killSwitchReason: reason,
  });

  const pid = state.pid;
  if (!pid) {
    return {
      stopped: false,
      pid: null,
      reason: 'killSwitch set; no daemon pid recorded (no active process to signal)',
    };
  }

  try {
    process.kill(pid, 0);
  } catch {
    await patchSentientState(statePath, { pid: null });
    return {
      stopped: true,
      pid,
      reason: `killSwitch set; daemon pid ${pid} was already dead (cleared)`,
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid, reason: `killSwitch set + SIGTERM delivered to pid ${pid}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stopped: false,
      pid,
      reason: `killSwitch set but SIGTERM failed: ${message}`,
    };
  }
}

/**
 * Clear the kill switch so the cron schedule resumes executing ticks.
 *
 * Does NOT restart the daemon process — that is the caller's responsibility
 * via `cleo sentient start` if the process itself exited.
 *
 * @param projectRoot - Absolute path to the project root
 */
export async function resumeSentientDaemon(projectRoot: string): Promise<SentientState> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const current = await readSentientState(statePath);
  // T1074: reject plain-resume when state is paused by revert — owner must
  // provide a valid attestation via `resumeAfterRevert()` instead.
  if (current.pausedByRevert) {
    const { E_OWNER_ATTESTATION_REQUIRED } = await import('./state.js');
    const err = new Error(
      `${E_OWNER_ATTESTATION_REQUIRED}: daemon is paused by revert (receipt ${current.revertReceiptId}); use resumeAfterRevert with owner attestation`,
    ) as NodeJS.ErrnoException;
    err.code = E_OWNER_ATTESTATION_REQUIRED;
    throw err;
  }
  return patchSentientState(statePath, {
    killSwitch: false,
    killSwitchReason: null,
  });
}

/** Status snapshot returned by {@link getSentientDaemonStatus}. */
export interface SentientStatus {
  /** Whether the pid on file is currently alive. */
  running: boolean;
  /** Recorded pid (null when never started or cleared on stop). */
  pid: number | null;
  /** ISO-8601 timestamp of last start. */
  startedAt: string | null;
  /** ISO-8601 timestamp of the last completed tick. */
  lastTickAt: string | null;
  /** Kill-switch state. */
  killSwitch: boolean;
  /** Reason supplied with the last kill. */
  killSwitchReason: string | null;
  /** Rolling stats. */
  stats: SentientState['stats'];
  /** Number of currently-stuck tasks. */
  stuckCount: number;
  /** Currently active task id (set mid-tick). */
  activeTaskId: string | null;
}

/**
 * Return a diagnostic snapshot for `cleo sentient status`.
 *
 * @param projectRoot - Absolute path to the project root
 */
export async function getSentientDaemonStatus(projectRoot: string): Promise<SentientStatus> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const state = await readSentientState(statePath);

  let running = false;
  if (state.pid) {
    try {
      process.kill(state.pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  return {
    running,
    pid: running ? state.pid : null,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    killSwitch: state.killSwitch,
    killSwitchReason: state.killSwitchReason,
    stats: state.stats,
    stuckCount: Object.keys(state.stuckTasks).length,
    activeTaskId: state.activeTaskId,
  };
}
