/**
 * Shared audit-log helper for `@cleocode/worktree` lifecycle operations (T9805).
 *
 * Provides {@link appendWorktreeAuditLog} — the single DRY chokepoint for every
 * write to `<projectRoot>/.cleo/audit/worktree-lifecycle.jsonl` from within the
 * `@cleocode/worktree` package. This mirrors the pattern in
 * `packages/core/src/worktree/audit.ts` but lives in the `worktree` package so
 * that `worktree-create.ts`, `worktree-destroy.ts`, and `worktree-prune.ts` do
 * not depend on `@cleocode/core` (which would create a circular dependency).
 *
 * Also provides {@link resolveWorktreeIndexPath} — canonical path to the
 * per-repo sentinel index `<gitRoot>/.cleo/worktrees.json` used by council
 * verdict D009 (T9805).
 *
 * @task T9805
 * @epic T9800
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeLifecycleAction } from '@cleocode/contracts';

/** Relative path within the project root for the worktree lifecycle audit log. */
export const WORKTREE_LIFECYCLE_AUDIT_FILE = '.cleo/audit/worktree-lifecycle.jsonl';

/**
 * Relative path within the git repository root for the worktree sentinel index.
 *
 * The sentinel index is a JSON file that tracks every active worktree registered
 * by `cleo orchestrate spawn`. When a worktree is destroyed or pruned the entry
 * is removed so external tooling can read a single file to enumerate all live
 * worktrees without scanning the XDG data directory.
 *
 * Per council verdict D009 (T9805): destroy and prune MUST update this file.
 */
export const WORKTREE_INDEX_RELATIVE_PATH = '.cleo/worktrees.json';

/**
 * Payload for a single worktree lifecycle audit entry.
 *
 * Mirrors {@link import('@cleocode/contracts').WorktreeLifecycleAuditEntry} but
 * keeps `timestamp` optional so callers only need to provide the fields they
 * know about — the helper auto-fills `timestamp` when absent.
 */
export interface WorktreeAuditPayload {
  /** Action that was performed. */
  action: WorktreeLifecycleAction;
  /** Absolute path to the worktree directory. */
  xdgPath: string;
  /** Task ID the worktree belongs to (e.g. `T9805`). */
  taskId?: string;
  /** Branch name (e.g. `task/T9805`). */
  branch?: string;
  /** Agent ID — defaults to `CLEO_AGENT_ID` env var or `'cleo'`. */
  agentId?: string;
  /** Free-form reason string (e.g. `pr-merged`, `idle-timeout`, `manual`). */
  reason?: string;
  /** Whether the action succeeded. */
  success: boolean;
  /** Error message when {@link success} is false. */
  error?: string;
  /** ISO-8601 timestamp — auto-filled when absent. */
  timestamp?: string;
}

/**
 * Resolve the absolute path to the per-repo worktree sentinel index.
 *
 * The sentinel index lives at `<gitRoot>/.cleo/worktrees.json` and tracks
 * every active worktree registered by `cleo orchestrate spawn`. Destroying
 * or pruning a worktree MUST remove the entry from this file per council
 * verdict D009.
 *
 * @param gitRoot - Absolute path to the git repository root.
 * @returns Absolute path to `<gitRoot>/.cleo/worktrees.json`.
 *
 * @task T9805
 */
export function resolveWorktreeIndexPath(gitRoot: string): string {
  return join(gitRoot, WORKTREE_INDEX_RELATIVE_PATH);
}

/**
 * Append a single JSONL entry to the worktree lifecycle audit log.
 *
 * The function is best-effort: any I/O error is swallowed so an audit
 * failure never blocks the underlying operation. The log directory is
 * created if it does not yet exist.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param payload - Audit entry fields (timestamp auto-filled when absent).
 * @param auditLogPathOverride - Optional override for the log file path (testing).
 *
 * @task T9805
 */
export function appendWorktreeAuditLog(
  projectRoot: string,
  payload: WorktreeAuditPayload,
  auditLogPathOverride?: string,
): void {
  try {
    const filePath =
      auditLogPathOverride !== undefined
        ? auditLogPathOverride
        : join(projectRoot, WORKTREE_LIFECYCLE_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    const record = {
      ts: payload.timestamp ?? new Date().toISOString(),
      action: payload.action,
      xdgPath: payload.xdgPath,
      ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
      agentId: payload.agentId ?? process.env['CLEO_AGENT_ID'] ?? 'cleo',
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      success: payload.success,
      ...(payload.error !== undefined ? { error: payload.error } : {}),
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
  } catch {
    // Intentionally swallowed — audit writes must never block lifecycle ops.
  }
}

/**
 * Remove a worktree entry from the sentinel index at
 * `<gitRoot>/.cleo/worktrees.json`.
 *
 * Per council verdict D009 (T9805): every destroy and prune operation MUST
 * call this helper to keep the sentinel index in sync. Errors are swallowed
 * so a stale index file never blocks a cleanup path.
 *
 * The index is a JSON object keyed by task ID:
 * ```json
 * {
 *   "T9805": { "path": "/xdg/path/T9805", "branch": "task/T9805", "createdAt": "..." }
 * }
 * ```
 *
 * @param gitRoot - Absolute path to the git repository root (where `.cleo/worktrees.json` lives).
 * @param taskId - The task ID to remove from the index.
 * @param indexPathOverride - Optional override for the index file path (testing).
 *
 * @task T9805
 */
export function removeWorktreeFromSentinelIndex(
  gitRoot: string,
  taskId: string,
  indexPathOverride?: string,
): void {
  try {
    const indexPath = indexPathOverride ?? resolveWorktreeIndexPath(gitRoot);
    let index: Record<string, unknown> = {};
    try {
      const raw = readFileSync(indexPath, { encoding: 'utf-8' });
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        index = parsed as Record<string, unknown>;
      }
    } catch {
      // File does not exist or is corrupt — nothing to remove.
      return;
    }
    if (!(taskId in index)) return; // entry not present, no-op
    delete index[taskId];
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf-8' });
  } catch {
    // Intentionally swallowed — index update failures must not block cleanup.
  }
}

/**
 * Add or update a worktree entry in the sentinel index at
 * `<gitRoot>/.cleo/worktrees.json`.
 *
 * Called by `worktree-create.ts` immediately after the worktree is created.
 * Errors are swallowed so index update failures never block spawn.
 *
 * @param gitRoot - Absolute path to the git repository root.
 * @param taskId - The task ID being registered.
 * @param entry - Metadata to store in the index for this task.
 * @param indexPathOverride - Optional override for the index file path (testing).
 *
 * @task T9805
 */
export function addWorktreeToSentinelIndex(
  gitRoot: string,
  taskId: string,
  entry: { path: string; branch: string; createdAt: string },
  indexPathOverride?: string,
): void {
  try {
    const indexPath = indexPathOverride ?? resolveWorktreeIndexPath(gitRoot);
    let index: Record<string, unknown> = {};
    try {
      const raw = readFileSync(indexPath, { encoding: 'utf-8' });
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        index = parsed as Record<string, unknown>;
      }
    } catch {
      // File does not exist or is corrupt — start fresh.
    }
    index[taskId] = entry;
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf-8' });
  } catch {
    // Intentionally swallowed — index update failures must not block spawn.
  }
}
