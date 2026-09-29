/**
 * Caller-side claim operations: who is claiming, and the lease lifecycle
 * verbs built on the accessor's claim chokepoint (T12502 · epic T12497).
 *
 * The compare-and-set itself lives in the store (`updateTaskFields` with a
 * `TaskClaimGuard`, reached through `DataAccessor.claimTask` /
 * `unclaimTask`). This module resolves the CALLER's identity — its bound
 * session (never the newest-active guess, T12500) and agent id — and maps the
 * CLI flags to a claim mode.
 *
 * @task T12502
 * @epic T12497
 */

import type { TaskClaim, TaskClaimMode } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveBoundSession } from '../store/session-store.js';
import { leaseExpiresAtFrom, taskClaimLeaseMs } from '../store/task-claim.js';

/** The identity a claim is recorded under. */
export interface Claimant {
  /** The caller's bound session, or `null` when unbound (no lease is taken). */
  sessionId: string | null;
  /** The caller's agent identity, or `null`. */
  agentId: string | null;
}

/** Explicit overrides for a claim that another session holds. */
export interface ClaimOverrideFlags {
  /** Take over a lease that has EXPIRED (`--take-over`). Audited. */
  takeOver?: boolean;
  /** Take over even a LIVE lease (`--force-claim`). Audited. */
  forceClaim?: boolean;
}

/**
 * Resolve the claimant for the calling process.
 *
 * The session is the caller's BOUND session (connection, `CLEO_SESSION_ID`
 * naming a real row, or the terminal binding) — an unbound caller claims as
 * `null` and holds no lease. The agent id is the explicit one, else the bound
 * session's agent identity, else `CLEO_AGENT_ID`.
 *
 * @param cwd - Project root for session resolution.
 * @param agentId - Explicit agent id (`cleo claim --agent`), when given.
 * @returns The claimant.
 * @example
 * ```ts
 * const claimant = await resolveClaimant(projectRoot);
 * ```
 */
export async function resolveClaimant(cwd?: string, agentId?: string | null): Promise<Claimant> {
  const bound = await resolveBoundSession(cwd);
  const session = bound?.session;
  return {
    sessionId: session?.id ?? null,
    agentId:
      agentId ||
      session?.agentIdentifier ||
      session?.agentHandle ||
      process.env['CLEO_AGENT_ID'] ||
      null,
  };
}

/**
 * Map override flags to a claim mode.
 *
 * @param flags - `--take-over` / `--force-claim`.
 * @returns `force`, `take-over` or `acquire`.
 * @example
 * ```ts
 * claimModeFor({ takeOver: true }); // 'take-over'
 * ```
 */
export function claimModeFor(flags: ClaimOverrideFlags): Exclude<TaskClaimMode, 'release'> {
  if (flags.forceClaim) return 'force';
  if (flags.takeOver) return 'take-over';
  return 'acquire';
}

/**
 * Release `taskId`'s lease when `sessionId` holds it; a no-op otherwise
 * (unclaimed, or held by another session — never an error).
 *
 * @param acc - Task accessor (may be inside a transaction).
 * @param taskId - The task.
 * @param sessionId - The caller's session.
 * @returns `true` when a lease was released.
 * @example
 * ```ts
 * await releaseOwnClaim(acc, 'T1', claimant.sessionId);
 * ```
 */
export async function releaseOwnClaim(
  acc: DataAccessor,
  taskId: string,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) return false;
  const task = await acc.loadSingleTask(taskId);
  if (task?.claim?.sessionId !== sessionId) return false;
  return acc.unclaimTask(taskId, { sessionId });
}

/**
 * Heartbeat: extend every lease the session holds by one lease length.
 *
 * @param acc - Task accessor.
 * @param sessionId - The holder session.
 * @param now - Clock override (ISO-8601 UTC) for tests.
 * @returns Number of leases renewed.
 * @example
 * ```ts
 * await renewClaimsForSession(acc, req.sessionId);
 * ```
 */
export async function renewClaimsForSession(
  acc: DataAccessor,
  sessionId: string,
  now: string = new Date().toISOString(),
): Promise<number> {
  return acc.renewSessionClaims(sessionId, leaseExpiresAtFrom(now, taskClaimLeaseMs()));
}

/**
 * Activity heartbeat for a project (T12502): extend every lease `sessionId`
 * holds there. The CLI dispatcher calls it after each successful mutation by
 * a bound session, so an agent that keeps working keeps its claims.
 *
 * @param projectRoot - Project root.
 * @param sessionId - The session that just did work.
 * @returns Number of leases renewed.
 * @example
 * ```ts
 * await renewProjectSessionClaims(projectRoot, req.sessionId);
 * ```
 */
export async function renewProjectSessionClaims(
  projectRoot: string,
  sessionId: string,
): Promise<number> {
  return renewClaimsForSession(await getTaskAccessor(projectRoot), sessionId);
}

/**
 * Renew one task's lease for its holder (`cleo claim <id> --renew`).
 *
 * @param acc - Task accessor.
 * @param taskId - The task.
 * @param claimant - The caller; must be the holder.
 * @returns The renewed lease.
 * @throws CleoError `E_TASK_CLAIMED` when another session holds it, or
 *   `E_NOT_FOUND` when the caller holds no lease on it.
 * @example
 * ```ts
 * await renewTaskClaim(acc, 'T1', claimant);
 * ```
 */
export async function renewTaskClaim(
  acc: DataAccessor,
  taskId: string,
  claimant: Claimant,
): Promise<TaskClaim | null> {
  return acc.claimTask(taskId, { ...claimant, mode: 'renew' });
}

/**
 * Claim a task for the agent a spawn is about to start (T12502).
 *
 * The spawned agent's own session takes the lease. When the ORCHESTRATOR's
 * bound session holds it (it ran `cleo start` or `cleo claim` first), the
 * lease is handed to the spawned session (audited as a hand-off); any other
 * live or expired holder refuses the spawn with `E_TASK_CLAIMED`. A re-spawn
 * reuses the same per-agent session, so it renews its own lease. A task that
 * does not exist is left to the spawn's own validation.
 *
 * @param projectRoot - Project root.
 * @param taskId - The task being spawned.
 * @param identity - The spawned agent's session and agent id.
 * @returns The lease, or `null` when the task does not exist.
 * @throws CleoError `E_TASK_CLAIMED` when another session holds the task.
 * @example
 * ```ts
 * await claimSpawnedTask(root, 'T1', { sessionId: spawn.sessionId, agentId: spawn.agentId });
 * ```
 */
export async function claimSpawnedTask(
  projectRoot: string,
  taskId: string,
  identity: { sessionId: string; agentId: string | null },
): Promise<TaskClaim | null> {
  const acc = await getTaskAccessor(projectRoot);
  if (!(await acc.loadSingleTask(taskId))) return null;
  const orchestrator = await resolveBoundSession(projectRoot);
  return acc.claimTask(taskId, {
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    mode: 'acquire',
    handoffFrom: orchestrator?.session.id ?? null,
  });
}
