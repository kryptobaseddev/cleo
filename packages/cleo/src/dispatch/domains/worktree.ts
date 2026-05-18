/**
 * Worktree Domain Handler (Dispatch Layer)
 *
 * Handles `cleo worktree <operation>` dispatch operations:
 *
 * QUERY operations:
 *   list — structured enumeration of every git worktree attached to the
 *          project with status classification (active|stale|merged|orphan|locked).
 *
 * MUTATE operations:
 *   prune       — remove orphaned + merged worktrees (T9547). Non-interactive;
 *                 the CLI handles per-orphan Y/N prompts and passes the
 *                 confirmed `paths` subset through `params`.
 *   forceUnlock — clear wedged worktree locks (`.git/index.lock` +
 *                 `git worktree unlock`) for a single task ID (T9547).
 *
 * All mutate ops route through SDK primitives in
 * `packages/core/src/worktree/{prune,force-unlock}.ts` and append
 * audit entries to `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * @task T9546
 * @task T9547
 * @epic T9515 — worktree-lifecycle bug-fix epic
 */

import type {
  ForceUnlockWorktreeOpts,
  ForceUnlockWorktreeResult,
  ListWorktreesOpts,
  ListWorktreesResult,
  PruneOrphanedWorktreesOpts,
  PruneOrphanedWorktreesResult,
  WorktreeStatusCategory,
} from '@cleocode/contracts';
import {
  forceUnlockWorktree,
  getLogger,
  getProjectRoot,
  listWorktrees,
  pruneOrphanedWorktreesByStatus,
} from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:worktree');

const ALL_CATEGORIES: readonly WorktreeStatusCategory[] = [
  'active',
  'stale',
  'merged',
  'orphan',
  'locked',
];

/**
 * Narrow a raw dispatch `params.statusFilter` value into a typed list of
 * {@link WorktreeStatusCategory} values. Accepts either a single string or
 * a string array; unknown categories are silently dropped to keep the
 * dispatch surface forward-compatible.
 *
 * @internal
 */
function coerceStatusFilter(value: unknown): WorktreeStatusCategory[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? value.split(',').map((s) => s.trim())
      : [];
  const out = raw.filter((s): s is WorktreeStatusCategory =>
    (ALL_CATEGORIES as readonly string[]).includes(s),
  );
  return out.length > 0 ? out : undefined;
}

/**
 * Narrow `params.paths` into a `string[]`. The CLI passes the user-confirmed
 * subset of orphan paths here; non-string entries are dropped.
 *
 * @internal
 */
function coerceStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string');
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

/**
 * Dispatch domain handler for worktree lifecycle operations.
 *
 * Registered under the `worktree` domain key in {@link createDomainHandlers}.
 *
 * @task T9546
 * @task T9547
 */
export class WorktreeHandler implements DomainHandler {
  /**
   * Handle read-only worktree queries.
   *
   * Supported operations:
   *  - `list` — return a structured listing of every worktree with status
   *             classification. Params: `{ statusFilter?, staleDays? }`.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'list': {
          const opts: ListWorktreesOpts = {
            projectRoot: getProjectRoot(),
            statusFilter: coerceStatusFilter(params?.['statusFilter']),
            staleDays:
              typeof params?.['staleDays'] === 'number'
                ? (params['staleDays'] as number)
                : undefined,
          };
          const result = await listWorktrees(opts);
          return wrapResult(
            result as Parameters<typeof wrapResult>[0],
            'query',
            'worktree',
            operation,
            startTime,
          );
        }
        default:
          return unsupportedOp('query', 'worktree', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'WorktreeHandler query error');
      return handleErrorResult('query', 'worktree', operation, err, startTime);
    }
  }

  /**
   * Handle worktree mutations.
   *
   * Supported operations:
   *  - `prune` — remove orphan/merged worktrees. Params:
   *              `{ dryRun?, staleDays?, paths?, actor? }`. Returns a
   *              {@link PruneOrphanedWorktreesResult} envelope.
   *  - `forceUnlock` — clear wedge state for a single worktree. Params:
   *              `{ taskId, actor? }`. Returns a {@link ForceUnlockWorktreeResult}.
   *
   * @task T9547
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'prune': {
          const opts: PruneOrphanedWorktreesOpts = {
            projectRoot: getProjectRoot(),
            dryRun: params?.['dryRun'] === true,
            ...(typeof params?.['staleDays'] === 'number'
              ? { staleDays: params['staleDays'] as number }
              : {}),
            ...(coerceStringList(params?.['paths']) !== undefined
              ? { paths: coerceStringList(params?.['paths']) as string[] }
              : {}),
            ...(typeof params?.['actor'] === 'string' && params['actor'].length > 0
              ? { actor: params['actor'] as string }
              : {}),
          };
          const result = await pruneOrphanedWorktreesByStatus(opts);
          return wrapResult(
            result as Parameters<typeof wrapResult>[0],
            'mutate',
            'worktree',
            operation,
            startTime,
          );
        }
        case 'forceUnlock': {
          const taskId = params?.['taskId'];
          if (typeof taskId !== 'string' || taskId.length === 0) {
            return errorResult(
              'mutate',
              'worktree',
              operation,
              'E_VALIDATION',
              'Missing required param: taskId (pass --task-id T####).',
              startTime,
            );
          }
          const opts: ForceUnlockWorktreeOpts = {
            projectRoot: getProjectRoot(),
            taskId,
            ...(typeof params?.['actor'] === 'string' && params['actor'].length > 0
              ? { actor: params['actor'] as string }
              : {}),
          };
          const result = await forceUnlockWorktree(opts);
          return wrapResult(
            result as Parameters<typeof wrapResult>[0],
            'mutate',
            'worktree',
            operation,
            startTime,
          );
        }
        default:
          return unsupportedOp('mutate', 'worktree', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'WorktreeHandler mutate error');
      return handleErrorResult('mutate', 'worktree', operation, err, startTime);
    }
  }

  /**
   * Declare the operations this domain supports — feeds dispatch introspection
   * and the `cleo --help` rendering pipeline.
   *
   * @returns Query/mutate operation lists.
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list'],
      mutate: ['prune', 'forceUnlock'],
    };
  }
}

// Re-export the result types so dispatch callers that import the handler don't
// also have to reach into @cleocode/contracts.
export type { ForceUnlockWorktreeResult, ListWorktreesResult, PruneOrphanedWorktreesResult };
