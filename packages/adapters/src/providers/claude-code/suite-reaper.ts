/**
 * Agent suite reaper — session-end cleanup for the per-session containment epic (T11998).
 *
 * Provides a single {@link reapAgentSuite} function that kills an agent's
 * entire process tree (including indirectly-spawned MCP grandchildren) using
 * whatever containment handle was recorded at spawn time.
 *
 * ## Reap strategy
 *
 * | mode     | primary kill                          | fallback                  |
 * |----------|---------------------------------------|---------------------------|
 * | systemd  | `systemctl --user stop <unitName>`    | negative-pgid SIGKILL     |
 * | pgid     | `kill(-pgid, SIGTERM)` → grace → KILL | none (best-effort)        |
 * | none     | no-op (janitor T11995 is backstop)    | —                         |
 *
 * All operations are idempotent: ESRCH, no-such-unit, and already-stopped
 * conditions are treated as success (no-op).
 *
 * @module suite-reaper
 * @task T11998
 * @epic T11992
 */

import { spawnSync } from 'node:child_process';
import type { AgentSuiteOwnership } from '@cleocode/contracts';

/**
 * Grace period in milliseconds between SIGTERM and SIGKILL in the pgid path.
 *
 * 3 s is sufficient for graceful MCP server shutdown and avoids the risk
 * of SIGKILL mid-write.
 */
const SIGTERM_GRACE_MS = 3_000;

/**
 * Reap an agent process suite.
 *
 * Stops the entire tree of processes associated with a spawned agent session:
 * the root claude CLI process AND all MCP children that reparented under it.
 *
 * This function is called on:
 *   - Normal session end (user runs `cleo session end`)
 *   - `terminate(instanceId)` on the spawn provider
 *   - Watchdog-declared death (future T11995 janitor call-back)
 *
 * @param ownership - The containment handle recorded at spawn time.
 * @returns A promise that resolves when the reap attempt is complete.
 *
 * @task T11998
 */
export async function reapAgentSuite(ownership: AgentSuiteOwnership): Promise<void> {
  switch (ownership.mode) {
    case 'systemd':
      await reapSystemdScope(ownership);
      break;
    case 'pgid':
      await reapPgidGroup(ownership);
      break;
    case 'none':
      // No containment recorded — the janitor (T11995) is the sole backstop.
      // Log at debug level for observability but do not throw.
      process.stderr.write(
        '[cleo:suite-reaper] containment mode=none — no reap performed; ' +
          'janitor (T11995) is the backstop\n',
      );
      break;
    default: {
      // Exhaustiveness guard — should never be reached.
      const _exhaustive: never = ownership.mode;
      void _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Systemd path
// ---------------------------------------------------------------------------

/**
 * Stop a transient systemd scope and reset its failed-unit state.
 *
 * 1. `systemctl --user stop <unitName>` — graceful scope stop.
 * 2. `systemctl --user reset-failed <unitName>` — clear the failed ledger
 *    if the scope exited non-zero (idempotent, best-effort).
 * 3. pgid fallback if systemctl is unavailable or the stop failed.
 *
 * @internal
 */
async function reapSystemdScope(ownership: AgentSuiteOwnership): Promise<void> {
  const { unitName, pgid } = ownership;

  if (unitName) {
    const stopResult = spawnSync('systemctl', ['--user', 'stop', unitName], {
      stdio: 'ignore',
      timeout: 10_000,
    });

    if (stopResult.error) {
      // systemctl not available — fall through to pgid.
      process.stderr.write(
        `[cleo:suite-reaper] systemctl stop failed (${stopResult.error.message}); ` +
          'falling back to pgid kill\n',
      );
    } else if (stopResult.status !== 0) {
      // Non-zero exit may mean "unit not found" (already gone) or "not started".
      // Both are acceptable outcomes — unit is gone either way.
      // Attempt reset-failed to clear the ledger, then check pgid.
      spawnSync('systemctl', ['--user', 'reset-failed', unitName], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      // If there is a pgid handle, kill any survivors the scope may have missed.
      if (pgid !== undefined) {
        await killPgidGracefully(pgid);
      }
      return;
    } else {
      // Successful stop — also try reset-failed to keep the ledger clean.
      spawnSync('systemctl', ['--user', 'reset-failed', unitName], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      // A successful scope stop reaps all cgroup members; pgid kill is not needed.
      return;
    }
  }

  // Fallback: pgid kill when unit name is absent or systemctl failed.
  if (pgid !== undefined) {
    await killPgidGracefully(pgid);
  }
}

// ---------------------------------------------------------------------------
// Pgid path
// ---------------------------------------------------------------------------

/**
 * Kill a POSIX process group: SIGTERM → grace period → SIGKILL.
 *
 * Sends SIGTERM to the whole group (negative PID = group leader + all
 * members).  After {@link SIGTERM_GRACE_MS}, checks for survivors and
 * sends SIGKILL if any remain.
 *
 * ESRCH errors (no such process / already gone) are treated as success.
 *
 * @internal
 */
async function reapPgidGroup(ownership: AgentSuiteOwnership): Promise<void> {
  const { pgid } = ownership;
  if (pgid === undefined) return;
  await killPgidGracefully(pgid);
}

/**
 * Send SIGTERM to a process group, wait for grace period, then SIGKILL survivors.
 *
 * @param pgid - Positive process-group ID.
 * @internal
 */
async function killPgidGracefully(pgid: number): Promise<void> {
  // Step 1: SIGTERM
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (err) {
    // ESRCH = group already gone — treat as success.
    if (isEsrch(err)) return;
    // Other errors: log and proceed to SIGKILL attempt.
    process.stderr.write(`[cleo:suite-reaper] SIGTERM to pgid=${pgid} failed: ${String(err)}\n`);
  }

  // Step 2: Grace period — give MCP servers time to flush and exit.
  await sleep(SIGTERM_GRACE_MS);

  // Step 3: SIGKILL survivors.
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (err) {
    // ESRCH after grace = all processes exited cleanly — ideal outcome.
    if (isEsrch(err)) return;
    process.stderr.write(`[cleo:suite-reaper] SIGKILL to pgid=${pgid} failed: ${String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if an error is ESRCH (no such process).
 *
 * @internal
 */
function isEsrch(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const code = (err as Record<string, unknown>)['code'];
    return code === 'ESRCH';
  }
  return false;
}

/**
 * Promise-based sleep.
 *
 * @param ms - Duration in milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
