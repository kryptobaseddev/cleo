/**
 * Append-only audit log for worktree-lifecycle commands (T9547).
 *
 * Provides {@link appendWorktreeAuditEntry} — the single chokepoint for every
 * write to `.cleo/audit/worktree-lifecycle.jsonl`. Used by:
 *
 *  - `cleo worktree prune --orphaned` (this task T9547)
 *  - `cleo worktree force-unlock <taskId>` (this task T9547)
 *  - Any future worktree-lifecycle mutation (T9548 auto-invoke, T9549 dashboard)
 *
 * Design follows the same append-only JSONL pattern as
 * `.cleo/audit/force-bypass.jsonl` (ADR-039) and
 * `.cleo/audit/contract-violations.jsonl` (T1261 PSYCHE E4):
 *
 *  - One JSON object per line, no surrounding array.
 *  - Atomic single-call `appendFileSync` keeps multi-process writes from
 *    interleaving partial lines.
 *  - `mkdirSync(..., { recursive: true })` ensures the audit directory exists
 *    on first write of a fresh project.
 *  - Errors are swallowed so audit writes never block the operation that
 *    triggered them — the action still succeeds visually even if the disk is
 *    full or the path is read-only.
 *
 * @task T9547
 * @epic T9515
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeLifecycleAuditEntry } from '@cleocode/contracts';
import { getLogger } from '../logger.js';

const log = getLogger('worktree:audit');

/** Relative path within project root for worktree lifecycle audit log. */
export const WORKTREE_LIFECYCLE_AUDIT_FILE = '.cleo/audit/worktree-lifecycle.jsonl';

/**
 * Append a {@link WorktreeLifecycleAuditEntry} to the project's worktree
 * lifecycle audit log at `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * The function is best-effort — any error during the write is logged at
 * warn level and swallowed so the calling command (prune / force-unlock /
 * future lifecycle mutation) never fails because of an audit hiccup.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param entry - The audit record to append. The `timestamp` is filled in
 *                automatically when omitted.
 * @param auditLogPathOverride - Optional override path (testing). When set,
 *                               the entry is written there instead of the
 *                               canonical `<projectRoot>/.cleo/audit/...` path.
 *
 * @example
 * ```ts
 * appendWorktreeAuditEntry('/my/project', {
 *   actor: 'cleo-prime',
 *   action: 'prune',
 *   target: '/wt/T9547',
 *   branch: 'task/T9547',
 *   taskId: 'T9547',
 *   reason: 'orphaned-merged',
 *   success: true,
 * });
 * ```
 */
export function appendWorktreeAuditEntry(
  projectRoot: string,
  entry: Omit<WorktreeLifecycleAuditEntry, 'timestamp'> & { timestamp?: string },
  auditLogPathOverride?: string,
): void {
  try {
    const filePath =
      auditLogPathOverride !== undefined
        ? auditLogPathOverride
        : join(projectRoot, WORKTREE_LIFECYCLE_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    const record: WorktreeLifecycleAuditEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      success: entry.success,
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
  } catch (err) {
    // Audit writes must never block the operation. Surface at warn so it's
    // visible during tests / debug but invisible at INFO and above.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to append worktree lifecycle audit entry',
    );
  }
}

/**
 * Resolve the canonical actor string used in audit-log writes when the caller
 * does not supply an explicit override.
 *
 * Mirrors the resolution rule used by `pruneWorktree` in
 * `packages/core/src/spawn/branch-lock.ts` — checks `CLEO_AGENT_ID` first
 * and falls back to `'cleo'`. Centralising the rule here means there is one
 * place to update if the actor-id contract ever changes.
 *
 * @returns The resolved actor string.
 */
export function resolveWorktreeAuditActor(): string {
  return process.env['CLEO_AGENT_ID'] ?? 'cleo';
}
