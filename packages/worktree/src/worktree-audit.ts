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
import { canonicalizePath } from '@cleocode/paths';

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
  /** Base ref the branch was created from, as the caller named it (T14027). */
  baseRef?: string;
  /** Commit {@link baseRef} resolved to when the branch was created (T14027). */
  baseSha?: string;
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
    const ts = payload.timestamp ?? new Date().toISOString();
    const agentId = payload.agentId ?? process.env['CLEO_AGENT_ID'] ?? 'cleo';
    // T10861: `timestamp`, `actor` and `target` are the contract's
    // WorktreeLifecycleAuditEntry fields, which core's writer emits; they sit
    // beside this writer's legacy `ts`, `agentId` and `xdgPath`, so every row
    // in the shared log satisfies the contract and existing readers still work.
    const record = {
      ts,
      timestamp: ts,
      actor: agentId,
      action: payload.action,
      target: payload.xdgPath,
      xdgPath: payload.xdgPath,
      ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
      agentId,
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.baseRef !== undefined ? { baseRef: payload.baseRef } : {}),
      ...(payload.baseSha !== undefined ? { baseSha: payload.baseSha } : {}),
      success: payload.success,
      ...(payload.error !== undefined ? { error: payload.error } : {}),
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
  } catch {
    // Intentionally swallowed — audit writes must never block lifecycle ops.
  }
}

/**
 * The newest successful lifecycle-audit row for `taskId` at `xdgPath` whose
 * action is one of `actions`, or `null` (none, or an unreadable log).
 */
function findWorktreeAuditRow(
  projectRoot: string,
  taskId: string,
  xdgPath: string,
  actions: readonly WorktreeLifecycleAction[],
): Partial<Record<'action' | 'taskId' | 'xdgPath' | 'target' | 'baseSha', string>> | null {
  let lines: string[];
  try {
    lines = readFileSync(join(projectRoot, WORKTREE_LIFECYCLE_AUDIT_FILE), 'utf-8').split('\n');
  } catch {
    return null;
  }
  const wanted = canonicalizePath(xdgPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes(taskId) || !actions.some((a) => line.includes(`"${a}"`))) continue;
    try {
      const row = JSON.parse(line) as Partial<
        Record<'action' | 'taskId' | 'xdgPath' | 'target' | 'baseSha', string>
      > & { success?: boolean };
      // `cleo worktree adopt` (core audit writer) records the path as `target`.
      // Compared by realpath: a row recorded through a symlink (/tmp vs
      // /private/tmp, a symlinked CLEO home) names the same worktree (T14054).
      const rowPath = row.xdgPath ?? row.target;
      if (
        actions.includes(row.action as WorktreeLifecycleAction) &&
        row.taskId === taskId &&
        rowPath !== undefined &&
        canonicalizePath(rowPath) === wanted &&
        row.success !== false
      ) {
        return row;
      }
    } catch {
      // A torn line is skipped; older entries still count.
    }
  }
  return null;
}

/**
 * The base commit recorded when a task's worktree branch was created: the
 * `baseSha` of the newest `create` entry for `taskId` at `xdgPath` in the
 * lifecycle audit log (T14027). `null` when none was recorded (a worktree
 * created before bases were recorded, or an unreadable log).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param taskId - Task whose worktree is looked up.
 * @param xdgPath - The task's canonical worktree path.
 * @returns The recorded base sha, or `null`.
 *
 * @task T14027
 */
export function readRecordedWorktreeBase(
  projectRoot: string,
  taskId: string,
  xdgPath: string,
): string | null {
  return findWorktreeAuditRow(projectRoot, taskId, xdgPath, ['create'])?.baseSha ?? null;
}

/**
 * How CLEO provisioned the task's worktree at `xdgPath`: the action of the
 * newest successful `create` or `adopt` lifecycle row, or `null` when there is
 * none (T10871).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param taskId - Task whose worktree is looked up.
 * @param xdgPath - The task's worktree path.
 * @returns `'create'`, `'adopt'` or `null`.
 *
 * @task T10871
 */
export function readWorktreeProvisioning(
  projectRoot: string,
  taskId: string,
  xdgPath: string,
): 'create' | 'adopt' | null {
  const action = findWorktreeAuditRow(projectRoot, taskId, xdgPath, ['create', 'adopt'])?.action;
  return action === 'create' || action === 'adopt' ? action : null;
}

/**
 * Whether CLEO provisioned the task's worktree at `xdgPath`: the lifecycle
 * audit log records a `create` (new branch), or an `adopt` (an existing
 * branch reused at spawn, or `cleo worktree adopt <path> --task-id <id>`) for
 * it. A `task/<id>` branch made by hand has no such row, so completion never
 * merges it (T14053).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param taskId - Task whose worktree is looked up.
 * @param xdgPath - The task's canonical worktree path.
 * @returns `true` when a provisioning row exists.
 *
 * @task T14053
 */
export function isCleoProvisionedWorktree(
  projectRoot: string,
  taskId: string,
  xdgPath: string,
): boolean {
  return findWorktreeAuditRow(projectRoot, taskId, xdgPath, ['create', 'adopt']) !== null;
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
