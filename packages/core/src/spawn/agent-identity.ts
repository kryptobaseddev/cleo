/**
 * Per-agent spawn identity allocation (T11343 · Epic T11284 · SG-COGNITIVE-SUBSTRATE).
 *
 * FOUNDATION primitive that dissolves BOTH multi-agent session-bleed AND
 * memory scope-leakage. Before this module, every spawn threaded the
 * orchestrator's `getActiveSession()` id into the subagent prompt + isolation
 * shell, so every short-lived `cleo` call inside a worktree collapsed onto
 * "whoever touched the DB last". This module gives each spawned agent its OWN
 * session bound to a deterministic `agentHandle`, so `resolveSessionIdFromEnv()`
 * (the env-first resolver) returns the agent's own identity.
 *
 * The handle is derived deterministically from the task id so re-spawning the
 * same task (e.g. `--resume`) reuses the existing per-agent session rather than
 * leaking a fresh session row on every spawn.
 *
 * @task T11343
 * @epic T11284
 */

import type { Session } from '@cleocode/contracts';
import { generateSessionId } from '../sessions/session-id.js';
import { getTaskAccessor } from '../store/data-accessor.js';

/**
 * Resolved per-agent spawn identity returned by {@link allocateSpawnSession}.
 *
 * @task T11343
 */
export interface SpawnAgentIdentity {
  /** The per-agent CLEO session id to inject as `CLEO_SESSION_ID`. */
  sessionId: string;
  /** The per-agent identity handle to inject as `CLEO_AGENT_ID`. */
  agentId: string;
  /** The deterministic agent handle bound to the session row. */
  agentHandle: string;
  /**
   * `true` when an existing same-handle active session was reused, `false`
   * when a fresh per-agent session row was created.
   */
  reused: boolean;
}

/**
 * Derive a deterministic agent handle for a spawned task.
 *
 * The handle is stable across re-spawns of the same task so the per-agent
 * session is reused rather than re-created. Lower-cased to match the
 * `cleo-agent-<task>` peer-id convention used elsewhere in the spawn pipeline.
 *
 * @param taskId - The task being spawned (e.g. `"T1234"`).
 * @returns Deterministic handle (e.g. `"agent-t1234"`).
 * @task T11343
 */
export function deriveAgentHandle(taskId: string): string {
  return `agent-${taskId.toLowerCase()}`;
}

/**
 * Allocate (or reuse) a per-agent session for a spawned task.
 *
 * Resolution order:
 * 1. If an active session already carries the derived `agentHandle`, reuse it
 *    (idempotent across `--resume` / re-spawn). `reused: true`.
 * 2. Otherwise create a fresh `active` session row bound to the handle and
 *    return its id. `reused: false`.
 *
 * The orchestrator's own session is NEVER returned — that is the bleed the
 * Epic exists to eliminate. The returned `sessionId` is what the spawn pipeline
 * injects as `CLEO_SESSION_ID` into the isolation shell.
 *
 * Best-effort: callers should treat a thrown error as "no per-agent session
 * allocated" and degrade to the orchestrator's session (legacy behaviour).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId      - The task being spawned.
 * @param opts.scope  - Session scope string (defaults to `"global"`).
 * @returns The allocated/reused per-agent identity.
 * @task T11343
 */
export async function allocateSpawnSession(
  projectRoot: string,
  taskId: string,
  opts: { scope?: string } = {},
): Promise<SpawnAgentIdentity> {
  const agentHandle = deriveAgentHandle(taskId);
  const accessor = await getTaskAccessor(projectRoot);

  // (1) Reuse an existing active session for this exact handle.
  const sessions = await accessor.loadSessions();
  const existing = sessions.find(
    (s: Session) => s.status === 'active' && s.agentHandle === agentHandle,
  );
  if (existing) {
    return { sessionId: existing.id, agentId: agentHandle, agentHandle, reused: true };
  }

  // (2) Create a fresh per-agent session row bound to the handle.
  const now = new Date().toISOString();
  const sessionId = generateSessionId();
  const session: Session = {
    id: sessionId,
    name: `spawn-${agentHandle}`,
    status: 'active',
    scope: { type: opts.scope === 'global' || !opts.scope ? 'global' : opts.scope },
    taskWork: { taskId, setAt: now },
    startedAt: now,
    lastActivity: now,
    agentHandle,
    agentIdentifier: agentHandle,
    scopeKind: 'global',
    scopeId: null,
    resumeCount: 0,
  };
  await accessor.upsertSingleSession(session);

  return { sessionId, agentId: agentHandle, agentHandle, reused: false };
}
