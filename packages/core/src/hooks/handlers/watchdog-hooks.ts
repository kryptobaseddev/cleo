/**
 * Watchdog Scheduler Hook Handlers
 *
 * Starts a periodic health-check timer when a session begins and stops it when
 * the session ends. One watchdog per project root, enforced by a module-level
 * Map keyed on the resolved project root.
 *
 * Each 60-second tick:
 * 1. Detects agents with a stale heartbeat (> STALE_THRESHOLD_MS)
 * 2. Records each crash as a learning event in brain.db
 * 3. Attempts recovery (status reset to 'starting') for all crashed agents
 * 4. Fires the `onPatrol` hook for observability
 *
 * Best-effort contract: the watchdog NEVER crashes or throws. Any tick failure
 * is swallowed so the timer continues. Any error in the start/stop handlers is
 * also swallowed so it never blocks session operations.
 *
 * Gated behind `brain.autoCapture` config — the watchdog does NOT start unless
 * auto-capture is enabled.
 *
 * Auto-registers on module load.
 *
 * @task T549
 * @epic T5149
 */

import { hooks } from '../registry.js';
import type { OnPatrolPayload, SessionEndPayload, SessionStartPayload } from '../types.js';
import { isAutoCaptureEnabled, isMissingBrainSchemaError } from './handler-helpers.js';

// ---------------------------------------------------------------------------
// Module-level watchdog state
// ---------------------------------------------------------------------------

/** One active timer per project root (resolved path). */
const activeWatchdogs = new Map<string, ReturnType<typeof setInterval>>();

/** Interval between watchdog ticks in milliseconds. */
const WATCHDOG_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Watchdog tick
// ---------------------------------------------------------------------------

/**
 * Execute one watchdog patrol tick.
 *
 * Steps:
 * 1. detectCrashedAgents — find and mark stale agents as 'crashed'
 * 2. processAgentLifecycleEvent — write failure events to brain.db for each
 * 3. recoverCrashedAgents — reset crashed agents to 'starting'
 * 4. hooks.dispatch('onPatrol') — emit observability event
 *
 * Any thrown error is caught and logged as a warning; the timer continues.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
async function runWatchdogTick(projectRoot: string): Promise<void> {
  try {
    const { detectCrashedAgents, STALE_THRESHOLD_MS } = await import(
      '../../agents/health-monitor.js'
    );
    const { recoverCrashedAgents } = await import('../../agents/retry.js');
    const { processAgentLifecycleEvent } = await import('../../agents/execution-learning.js');

    // Step 1: Detect and mark crashed agents
    const crashed = await detectCrashedAgents(STALE_THRESHOLD_MS, projectRoot);

    // Step 2: Record each crash as a brain learning event
    for (const agent of crashed) {
      try {
        await processAgentLifecycleEvent(
          {
            agentId: agent.id,
            agentType:
              (agent.agentType as import('../../agents/agent-schema.js').AgentType) ?? 'custom',
            taskId: agent.taskId ?? 'unknown',
            taskType: 'unknown',
            outcome: 'failure',
            errorMessage: 'Heartbeat timeout — agent presumed crashed',
            errorType: 'retriable',
            sessionId: agent.sessionId ?? undefined,
          },
          projectRoot,
        );
      } catch (err) {
        if (!isMissingBrainSchemaError(err)) {
          console.warn('[watchdog] Failed to record agent crash event:', err);
        }
      }
    }

    // Step 3: Attempt recovery for all crashed agents
    if (crashed.length > 0) {
      await recoverCrashedAgents(STALE_THRESHOLD_MS, projectRoot);
    }

    // Step 4: Fire onPatrol for observability
    const patrolPayload: OnPatrolPayload = {
      timestamp: new Date().toISOString(),
      watcherId: 'health-watchdog',
      patrolType: 'health',
      scope: `crashed=${crashed.length}`,
    };
    await hooks.dispatch('onPatrol', projectRoot, patrolPayload);
  } catch (err) {
    // Best-effort — never crash the watchdog timer
    console.warn('[watchdog] Tick failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Handle SessionStart — start the watchdog timer for this project root.
 *
 * Idempotent: if a watchdog is already running for this root (e.g. a second
 * session in the same process), the existing timer is reused.
 *
 * Gated behind `brain.autoCapture` — watchdog does not start unless auto-capture
 * is enabled. This aligns with all other brain-capture hooks.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param _payload - SessionStart payload (unused).
 */
export async function handleWatchdogStart(
  projectRoot: string,
  _payload: SessionStartPayload,
): Promise<void> {
  try {
    if (!(await isAutoCaptureEnabled(projectRoot))) return;

    // Idempotency guard — one watchdog per project root
    if (activeWatchdogs.has(projectRoot)) return;

    const timer = setInterval(() => {
      void runWatchdogTick(projectRoot);
    }, WATCHDOG_INTERVAL_MS);

    activeWatchdogs.set(projectRoot, timer);
  } catch {
    // Never block session start on watchdog errors
  }
}

/**
 * Handle SessionEnd — stop the watchdog timer for this project root.
 *
 * Safe to call when no watchdog is running (no-op).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param _payload - SessionEnd payload (unused).
 */
export async function handleWatchdogStop(
  projectRoot: string,
  _payload: SessionEndPayload,
): Promise<void> {
  try {
    const timer = activeWatchdogs.get(projectRoot);
    if (timer) {
      clearInterval(timer);
      activeWatchdogs.delete(projectRoot);
    }
  } catch {
    // Never block session end on watchdog errors
  }
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

hooks.register({
  id: 'watchdog-session-start',
  event: 'SessionStart',
  handler: handleWatchdogStart,
  priority: 50,
});

hooks.register({
  id: 'watchdog-session-end',
  event: 'SessionEnd',
  handler: handleWatchdogStop,
  priority: 50,
});
