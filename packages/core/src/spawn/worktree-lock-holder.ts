/**
 * Holder identity for the per-task worktree lock (T12506 · epic T12498).
 *
 * `@cleocode/worktree` takes an atomic per-task lock before `git worktree add`
 * and records who holds it. It cannot import core, so the spawn pipeline
 * resolves the identity here — the spawned agent's own session + agent id, the
 * stable device id, and the long-lived OWNER process (the agent harness above
 * the short-lived `cleo` + shell) with its `ps` start time — and passes it in
 * `CreateWorktreeOptions.holder`.
 *
 * The owner pid is usually the agent harness (codex, claude), which hosts many
 * sessions in turn, so the lock's liveness also consults the holder SESSION:
 * session end releases the session's locks, and an ended holder session is
 * reclaimable by a successor's spawn or `--resume`, audited (T13425).
 *
 * @module spawn/worktree-lock-holder
 * @task T12506
 * @task T13425
 */

import type {
  WorktreeLockAcquisition,
  WorktreeLockHolder,
  WorktreeLockRecord,
  WorktreeLockSessionProbe,
  WorktreeLockSessionState,
} from '@cleocode/contracts';
import { computeProjectHash } from '@cleocode/paths';
import { readWorktreeTaskLock, releaseWorktreeTaskLocksForSession } from '@cleocode/worktree';
import { getStableDeviceId } from '../llm/stable-device-id.js';
import { type ProcessAncestor, resolveOwnerProcess } from '../sessions/terminal-identity.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from '../worktree/audit.js';

/** Inputs for {@link resolveSpawnLockHolder}. */
export interface SpawnLockHolderInput {
  /** The spawned agent's per-agent session id. */
  sessionId?: string | null;
  /** The spawned agent's agent id. */
  agentId?: string | null;
  /** Owner-process resolver (tests inject fakes). */
  resolveOwner?: () => ProcessAncestor | null;
  /** Device-id reader (tests inject fakes). */
  deviceId?: () => string;
}

/**
 * Build the {@link WorktreeLockHolder} for a spawn.
 *
 * Falls back to the current process (pid + start probed by the worktree
 * package) when the owner chain cannot be read, e.g. on Windows.
 *
 * @param input - Session/agent identity and test seams.
 * @returns The holder identity to record in the lock.
 */
export function resolveSpawnLockHolder(input: SpawnLockHolderInput = {}): WorktreeLockHolder {
  const owner = (input.resolveOwner ?? resolveOwnerProcess)();
  let deviceId: string | null = null;
  try {
    deviceId = (input.deviceId ?? getStableDeviceId)();
  } catch {
    deviceId = null;
  }
  return {
    sessionId: input.sessionId ?? null,
    agentId: input.agentId ?? null,
    deviceId,
    ...(owner ? { pid: owner.pid, processStartedAt: owner.startedAt } : {}),
  };
}

/** Session store lookup; tests inject fakes. */
export type SessionStatusLookup = (
  sessionId: string,
  projectRoot: string,
) => Promise<{ status: string } | null>;

/**
 * Map a session row to a lock-liveness state: an active or suspended session
 * keeps its locks (a suspended one may resume). Any other status releases them:
 * `ended`, or `orphaned`, which the idle sweep sets on a session idle past its
 * max age with no live claim. A missing session releases them too, including
 * a live session absent from an older snapshot after `cleo restore backup`.
 *
 * @param session - The session row, or `null` when none exists.
 * @returns The lock-liveness state.
 */
export function lockSessionState(session: { status: string } | null): WorktreeLockSessionState {
  if (session === null) return 'ended';
  return session.status === 'active' || session.status === 'suspended' ? 'active' : 'ended';
}

/**
 * Build the session probe for acquiring `taskId`'s worktree lock (T13425).
 *
 * The lock module is synchronous and cannot read the session store, so the
 * current holder's session is looked up here first. The probe answers for that
 * session only; any other id (the lock changed hands in between) is `unknown`,
 * which leaves the verdict to the pid and heartbeat checks.
 *
 * @param projectRoot - Project root (the session store).
 * @param taskId - Task whose lock is about to be acquired.
 * @param lookup - Session lookup (tests inject fakes).
 * @returns The probe to pass as `sessionProbe`.
 */
export async function resolveLockSessionProbe(
  projectRoot: string,
  taskId: string,
  lookup?: SessionStatusLookup,
): Promise<WorktreeLockSessionProbe> {
  const holderSession = readWorktreeTaskLock(computeProjectHash(projectRoot), taskId)?.sessionId;
  if (!holderSession) return () => 'unknown';
  let state: WorktreeLockSessionState = 'unknown';
  try {
    // Loaded on demand: the session store (drizzle) stays off the static
    // graph of every module that reaches branch-lock (gate 39).
    const find = lookup ?? (await import('../store/session-store.js')).getSession;
    state = lockSessionState(await find(holderSession, projectRoot));
  } catch {
    state = 'unknown';
  }
  return (sessionId) => (sessionId === holderSession ? state : 'unknown');
}

/** Describe a lock holder for an audit line. */
function describeHolder(record: WorktreeLockRecord): string {
  return [
    record.sessionId ? `session ${record.sessionId}` : null,
    record.agentId ? `agent ${record.agentId}` : null,
    `pid ${record.pid}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Audit a reclaimed worktree lock (T13425): which holder lost it and why. A
 * fresh or re-entered acquisition writes nothing.
 *
 * @param projectRoot - Project root (the audit log).
 * @param taskId - Task the lock guards.
 * @param worktreePath - The worktree the lock guards.
 * @param acquisition - The acquisition result.
 */
export function auditWorktreeLockReclaim(
  projectRoot: string,
  taskId: string,
  worktreePath: string,
  acquisition: WorktreeLockAcquisition | undefined,
): void {
  if (acquisition?.status !== 'reclaimed') return;
  const from = acquisition.reclaimedFrom;
  appendWorktreeAuditEntry(projectRoot, {
    actor: resolveWorktreeAuditActor(),
    action: 'lock-reclaim',
    target: worktreePath,
    taskId,
    reason: `${acquisition.reclaimReason ?? 'reclaimed'}${from ? ` from ${describeHolder(from)}` : ''}`,
    success: true,
  });
}

/**
 * Release every worktree lock held by `sessionId` in this project and audit
 * each (T13425). Called when the session ends. Never throws: a failure here
 * must not fail session end, and an unreleased lock is still reclaimable once
 * the session reads as ended.
 *
 * @param projectRoot - Project root.
 * @param sessionId - The ending session.
 * @returns The task ids whose locks were released.
 */
export function releaseSessionWorktreeLocks(projectRoot: string, sessionId: string): string[] {
  try {
    const released = releaseWorktreeTaskLocksForSession(computeProjectHash(projectRoot), sessionId);
    for (const record of released) {
      appendWorktreeAuditEntry(projectRoot, {
        actor: resolveWorktreeAuditActor(),
        action: 'lock-release',
        target: record.taskId,
        taskId: record.taskId,
        reason: `session-end: ${describeHolder(record)}`,
        success: true,
      });
    }
    return released.map((r) => r.taskId);
  } catch {
    return [];
  }
}
