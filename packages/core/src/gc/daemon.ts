/**
 * GC Daemon — Sidecar background process for autonomous transcript cleanup.
 *
 * Architecture (Pattern B from T751 §2.2):
 * - Spawned via `cleo daemon start` as a detached Node.js process
 * - All three required flags: `detached: true`, file stdio, `child.unref()`
 * - Persists across CLI invocations
 * - Crash recovery via `.cleo/gc-state.json` startup-check
 * - node-cron v4 for scheduling (zero runtime deps, cross-platform)
 *
 * Startup algorithm (systemd `Persistent=true` semantics in pure Node.js):
 * 1. Read gc-state.json
 * 2. If pendingPrune non-empty → resume deletion (crash recovery)
 * 3. If lastRunAt null OR elapsed > 24h → run GC immediately (missed-run recovery)
 * 4. Schedule future runs via node-cron (daily at 03:00 UTC)
 * 5. Write daemonPid to state
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @see T751 §2.2 for sidecar daemon pattern rationale
 * @task T731
 * @epic T726
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { runGC } from './runner.js';
import { patchGCState, readGCState } from './state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cron expression: daily at 03:00 UTC. */
const GC_CRON_EXPR = '0 3 * * *';

/** Interval for missed-run recovery check (24 hours in ms). */
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Daemon Bootstrap (runs when this module is executed as a standalone script)
// ---------------------------------------------------------------------------

/**
 * Bootstrap the GC daemon process.
 *
 * Performs crash recovery, missed-run recovery, and schedules future GC runs.
 * This function runs in the long-lived daemon process.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 */
export async function bootstrapDaemon(cleoDir: string): Promise<void> {
  const statePath = join(cleoDir, 'gc-state.json');

  // Register daemon PID in state file
  await patchGCState(statePath, {
    daemonPid: process.pid,
    daemonStartedAt: new Date().toISOString(),
  });

  const state = await readGCState(statePath);

  // Step 1: Crash recovery — resume pending prune from prior run
  if (state.pendingPrune && state.pendingPrune.length > 0) {
    try {
      await runGC({ cleoDir, resumeFrom: state.pendingPrune });
    } catch {
      // Crash recovery failure is non-fatal; continue with scheduled runs
    }
  }

  // Step 2: Missed-run recovery — if last run was > 24h ago, run immediately
  const lastRunTs = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  const elapsed = Date.now() - lastRunTs;
  if (elapsed > GC_INTERVAL_MS) {
    try {
      await runGC({ cleoDir });
    } catch {
      // Immediate GC failure is non-fatal; cron will retry next cycle
    }
  }

  // Step 3: Schedule future runs via node-cron
  // noOverlap: true prevents double-runs if a previous run exceeds 24h
  cron.schedule(
    GC_CRON_EXPR,
    async () => {
      try {
        await runGC({ cleoDir });
      } catch {
        // Log failures via stderr (already redirected to gc.log by spawn)
        const state2 = await readGCState(statePath);
        await patchGCState(statePath, {
          consecutiveFailures: state2.consecutiveFailures + 1,
          lastRunResult: 'failed',
          escalationNeeded: state2.consecutiveFailures + 1 >= 3,
          escalationReason:
            state2.consecutiveFailures + 1 >= 3
              ? `GC daemon: ${state2.consecutiveFailures + 1} consecutive failures. Check logs.`
              : state2.escalationReason,
        });
      }
    },
    {
      timezone: 'UTC',
      noOverlap: true,
      name: 'cleo-gc',
    },
  );
}

// ---------------------------------------------------------------------------
// Spawn Helpers (called by `cleo daemon start` in the parent CLI process)
// ---------------------------------------------------------------------------

/**
 * Spawn the GC daemon as a detached background process.
 *
 * All three requirements from T751 §2.2 are met:
 * 1. `detached: true` — process group leader (survives parent exit)
 * 2. File stdio — stdout/stderr redirected to gc.log (not inherited)
 * 3. `child.unref()` — parent CLI exits immediately
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 * @returns PID of the spawned daemon process
 */
export async function spawnGCDaemon(cleoDir: string): Promise<number> {
  const logsDir = join(cleoDir, 'logs');
  await mkdir(logsDir, { recursive: true });

  const logPath = join(logsDir, 'gc.log');
  const errPath = join(logsDir, 'gc.err');

  // File-based stdio: required for detached process to not inherit the TTY
  const outStream = createWriteStream(logPath, { flags: 'a' });
  const errStream = createWriteStream(errPath, { flags: 'a' });

  // Node 24: await stream open before passing to spawn stdio (fd must be valid)
  await Promise.all([once(outStream, 'open'), once(errStream, 'open')]);

  // The daemon entry-point script (compiled alongside this module)
  const daemonEntry = join(fileURLToPath(import.meta.url), '..', 'daemon-entry.js');

  const child = spawn(process.execPath, [daemonEntry, cleoDir], {
    detached: true,
    stdio: ['ignore', outStream, errStream],
    env: { ...process.env, CLEO_GC_DAEMON: '1' },
  });

  // unref() allows the parent CLI process to exit while the daemon continues
  child.unref();

  const pid = child.pid ?? 0;

  // Persist PID so `cleo daemon stop` can find and signal the process
  await patchGCState(join(cleoDir, 'gc-state.json'), {
    daemonPid: pid,
    daemonStartedAt: new Date().toISOString(),
  });

  return pid;
}

/**
 * Stop the GC daemon by sending SIGTERM to its PID.
 *
 * Uses `process.kill(pid, 0)` as a no-throw liveness probe before signalling.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 * @returns `{ stopped: boolean; pid: number | null; reason: string }`
 */
export async function stopGCDaemon(
  cleoDir: string,
): Promise<{ stopped: boolean; pid: number | null; reason: string }> {
  const statePath = join(cleoDir, 'gc-state.json');
  const state = await readGCState(statePath);
  const pid = state.daemonPid;

  if (!pid) {
    return { stopped: false, pid: null, reason: 'Daemon PID not found in gc-state.json' };
  }

  // Liveness probe: process.kill(pid, 0) throws if PID is not running
  try {
    process.kill(pid, 0);
  } catch {
    // Process is not running — clear stale PID from state
    await patchGCState(statePath, { daemonPid: null });
    return {
      stopped: false,
      pid,
      reason: `Daemon PID ${pid} is not running (stale state cleared)`,
    };
  }

  // Send SIGTERM — daemon should clean up and exit gracefully
  try {
    process.kill(pid, 'SIGTERM');
    // Clear PID from state after successful signal
    await patchGCState(statePath, { daemonPid: null });
    return { stopped: true, pid, reason: `SIGTERM sent to PID ${pid}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stopped: false, pid, reason: `Failed to send SIGTERM to PID ${pid}: ${msg}` };
  }
}

/**
 * Check whether the GC daemon is currently running.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 * @returns `{ running: boolean; pid: number | null; startedAt: string | null }`
 */
export async function getGCDaemonStatus(cleoDir: string): Promise<{
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastRunAt: string | null;
  lastDiskUsedPct: number | null;
  escalationNeeded: boolean;
}> {
  const state = await readGCState(join(cleoDir, 'gc-state.json'));
  const pid = state.daemonPid;

  let running = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  return {
    running,
    pid: running ? pid : null,
    startedAt: state.daemonStartedAt,
    lastRunAt: state.lastRunAt,
    lastDiskUsedPct: state.lastDiskUsedPct,
    escalationNeeded: state.escalationNeeded,
  };
}

// ---------------------------------------------------------------------------
// Standalone daemon entry point
// ---------------------------------------------------------------------------

// When this module is executed directly (via `node daemon.js <cleoDir>`),
// bootstrap the daemon. The daemon-entry.js shim calls bootstrapDaemon().
// See src/gc/daemon-entry.ts for the entry script.
