/**
 * Leased agent claims on tasks — lease arithmetic and the typed refusal (T12502).
 *
 * A claim is four columns on `tasks_tasks` (`claimed_by_session`,
 * `claimed_by_agent`, `claimed_at`, `lease_expires_at`), separate from the
 * human `assignee`. It is written ONLY through the T12503 field chokepoint
 * (`updateTaskFields`) with a `TaskClaimGuard`, which turns the claim into a
 * compare-and-set in the UPDATE's WHERE clause (see
 * `sqlite-data-accessor.ts#claimPredicate`). This module holds what the
 * chokepoint and its callers share:
 *
 *  - the lease TTL ({@link taskClaimLeaseMs}) and expiry
 *    ({@link leaseExpiresAtFrom});
 *  - the row → {@link TaskClaim} mapping ({@link claimFromColumns});
 *  - the `E_TASK_CLAIMED` error ({@link taskClaimedError}), which names the
 *    holder, the lease expiry and the one explicit, audited override.
 *
 * Lifecycle: taken by `cleo start` / `cleo claim` / spawn; renewed by the
 * holder session's mutations (dispatch heartbeat) or `cleo claim --renew`;
 * released by `cleo stop`, `cleo unclaim`, and — via SQL triggers — by the
 * task reaching done / cancelled / archived and by the holder session ending
 * or being deleted. An expired lease is never taken silently: `--take-over`.
 *
 * @task T12502
 * @epic T12497
 */

import {
  ExitCode,
  type TaskClaim,
  type TaskClaimedDetails,
  type TaskClaimMode,
} from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Default claim lease: 30 minutes, renewed by the holder's activity. */
export const DEFAULT_TASK_CLAIM_LEASE_MS = 30 * 60 * 1000;

/**
 * Environment override for the lease length, in whole minutes. Values that
 * are not positive integers are ignored.
 */
export const TASK_CLAIM_LEASE_ENV = 'CLEO_CLAIM_LEASE_MINUTES';

/**
 * Resolve the claim lease length in milliseconds.
 *
 * @returns `CLEO_CLAIM_LEASE_MINUTES` in ms when set to a positive integer,
 *   else {@link DEFAULT_TASK_CLAIM_LEASE_MS}.
 * @example
 * ```ts
 * const expires = leaseExpiresAtFrom(now, taskClaimLeaseMs());
 * ```
 */
export function taskClaimLeaseMs(): number {
  const raw = process.env[TASK_CLAIM_LEASE_ENV];
  if (raw && /^\d+$/.test(raw)) {
    const minutes = Number(raw);
    if (minutes > 0) return minutes * 60 * 1000;
  }
  return DEFAULT_TASK_CLAIM_LEASE_MS;
}

/**
 * Compute a lease expiry.
 *
 * @param now - ISO-8601 UTC instant the lease starts or is renewed.
 * @param leaseMs - Lease length in milliseconds.
 * @returns The ISO-8601 UTC expiry instant.
 * @example
 * ```ts
 * leaseExpiresAtFrom('2026-09-29T00:00:00.000Z', 60_000); // '2026-09-29T00:01:00.000Z'
 * ```
 */
export function leaseExpiresAtFrom(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

/** The claim columns as stored on a task row. */
export interface TaskClaimColumns {
  /** `claimed_by_session`. */
  claimedBySession: string | null;
  /** `claimed_by_agent`. */
  claimedByAgent: string | null;
  /** `claimed_at`. */
  claimedAt: string | null;
  /** `lease_expires_at`. */
  leaseExpiresAt: string | null;
}

/**
 * Map stored claim columns to a {@link TaskClaim}.
 *
 * @param row - The claim columns of a task row.
 * @returns The lease, or `undefined` when the task is unclaimed.
 * @example
 * ```ts
 * const claim = claimFromColumns(row); // undefined for an unclaimed task
 * ```
 */
export function claimFromColumns(row: TaskClaimColumns): TaskClaim | undefined {
  if (!row.claimedBySession) return undefined;
  return {
    sessionId: row.claimedBySession,
    agentId: row.claimedByAgent,
    claimedAt: row.claimedAt ?? '',
    leaseExpiresAt: row.leaseExpiresAt ?? '',
  };
}

/**
 * Whether a lease has lapsed at `now`. A lease with no recorded expiry
 * counts as lapsed (it can never be renewed into validity by its holder
 * anyway, and must not block forever).
 *
 * @param claim - The stored lease.
 * @param now - ISO-8601 UTC instant to compare against.
 * @returns `true` when `leaseExpiresAt <= now`.
 * @example
 * ```ts
 * isClaimExpired(holder, new Date().toISOString());
 * ```
 */
export function isClaimExpired(claim: TaskClaim, now: string): boolean {
  return claim.leaseExpiresAt === '' || claim.leaseExpiresAt <= now;
}

/**
 * Whether a claim write in `mode` by `sessionId` may replace the stored lease.
 * This is the JavaScript mirror of the SQL predicate; the chokepoint uses the
 * SQL form for the write and this form only to explain a refusal.
 *
 * @param stored - The lease on the row, or `undefined` when unclaimed.
 * @param mode - The claim mode.
 * @param sessionId - The caller's session (`null` when unbound).
 * @param now - ISO-8601 UTC instant for the expiry comparison.
 * @param handoffFrom - A session whose live lease `acquire` may take.
 * @returns `true` when the write is allowed.
 * @example
 * ```ts
 * claimAllows(stored, 'acquire', 'ses_a', now); // false when ses_b holds it
 * ```
 */
export function claimAllows(
  stored: TaskClaim | undefined,
  mode: TaskClaimMode,
  sessionId: string | null,
  now: string,
  handoffFrom?: string | null,
): boolean {
  if (mode === 'force') return true;
  if (mode === 'renew' || mode === 'release') {
    return stored !== undefined && sessionId !== null && stored.sessionId === sessionId;
  }
  if (!stored) return true;
  if (sessionId !== null && stored.sessionId === sessionId) return true;
  if (handoffFrom && stored.sessionId === handoffFrom) return true;
  return mode === 'take-over' && isClaimExpired(stored, now);
}

/**
 * Build the `E_TASK_CLAIMED` refusal.
 *
 * @param taskId - The claimed task.
 * @param holder - The lease stored on the task.
 * @param requester - The refused caller.
 * @param now - ISO-8601 UTC instant used for the expiry comparison.
 * @param verb - The refused command, for the fix hint (`start`, `claim`, …).
 * @returns A {@link CleoError} with `ExitCode.TASK_CLAIMED` (LAFS
 *   `E_TASK_CLAIMED`) and {@link TaskClaimedDetails} as `details`.
 * @example
 * ```ts
 * throw taskClaimedError('T1', holder, { sessionId: 'ses_b', agentId: null }, now);
 * ```
 */
export function taskClaimedError(
  taskId: string,
  holder: TaskClaim,
  requester: { sessionId: string | null; agentId: string | null },
  now: string,
  verb = 'start',
): CleoError {
  const expired = isClaimExpired(holder, now);
  const override = expired ? '--take-over' : '--force-claim';
  const details: TaskClaimedDetails = {
    field: 'claimedBySession',
    taskId,
    holder,
    expired,
    requester,
    override,
  };
  const who = holder.agentId
    ? `session ${holder.sessionId} (agent ${holder.agentId})`
    : `session ${holder.sessionId}`;
  const lease = expired
    ? `its lease expired at ${holder.leaseExpiresAt}`
    : `lease expires ${holder.leaseExpiresAt}`;
  const fix = expired
    ? `The holder stopped renewing its lease. Take the task over explicitly (audited): cleo ${verb} ${taskId} --take-over`
    : `Pick another task (cleo next), wait for the lease to expire at ${holder.leaseExpiresAt}, or override the live lease (audited): cleo ${verb} ${taskId} --force-claim`;
  return new CleoError(ExitCode.TASK_CLAIMED, `Task ${taskId} is claimed by ${who}; ${lease}.`, {
    fix,
    details: { ...details },
  });
}
