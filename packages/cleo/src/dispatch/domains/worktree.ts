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
 *   (none yet — pending T9547 prune + force-unlock work)
 *
 * The `list` operation wraps the SDK primitive {@link listWorktrees} so the
 * canonical EngineResult shape (LAFS envelope) is preserved on both the CLI
 * and the typed SDK surface.
 *
 * @task T9546
 * @epic T9515 — worktree-lifecycle bug-fix epic (2 of 5)
 */

import type {
  ListWorktreesOpts,
  ListWorktreesResult,
  WorktreeStatusCategory,
} from '@cleocode/contracts';
import { getLogger, getProjectRoot, listWorktrees } from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

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
 * Dispatch domain handler for read-only worktree operations.
 *
 * Registered under the `worktree` domain key in {@link createDomainHandlers}.
 *
 * @task T9546
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
   * Worktree mutations (prune / unlock) are reserved for T9547 — this handler
   * accepts no mutate operations today.
   *
   * @param operation - Operation name (always returns unsupported).
   * @returns DispatchResponse with E_INVALID_OPERATION.
   */
  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    return unsupportedOp('mutate', 'worktree', operation, startTime);
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
      mutate: [],
    };
  }
}

// Re-export the listing result type so dispatch callers that import the
// handler don't also have to reach into @cleocode/contracts.
export type { ListWorktreesResult };
