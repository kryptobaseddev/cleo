/**
 * LAFS-compliant pagination utility for list commands.
 *
 * Wraps result arrays in LAFSPage offset pagination objects.
 * Supports both offset-based and cursor-based pagination modes.
 *
 * @task T4668
 * @epic T4663
 */

import type { LAFSPage, LAFSPageOffset, LAFSPageNone } from '@cleocode/lafs-protocol';

/**
 * Input parameters for paginating a result set.
 *
 * @task T4668
 * @epic T4663
 */
export interface PaginateInput {
  /** Total number of items before pagination. */
  total: number;
  /** Number of items to return per page. */
  limit?: number;
  /** Number of items to skip. */
  offset?: number;
}

/**
 * Default page size when limit is not specified.
 *
 * @task T4668
 */
const DEFAULT_LIMIT = 50;

/**
 * Create an LAFSPage object from pagination parameters.
 *
 * Returns mode:"none" when no pagination is requested (no limit/offset).
 * Returns mode:"offset" with hasMore/total when pagination is active.
 *
 * @task T4668
 * @epic T4663
 */
export function createPage(input: PaginateInput): LAFSPage {
  const { total, limit, offset } = input;

  // No pagination requested
  if (limit === undefined && offset === undefined) {
    return { mode: 'none' } as LAFSPageNone;
  }

  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const effectiveOffset = offset ?? 0;
  const hasMore = effectiveOffset + effectiveLimit < total;

  return {
    mode: 'offset',
    limit: effectiveLimit,
    offset: effectiveOffset,
    hasMore,
    total,
  } as LAFSPageOffset;
}

/**
 * Apply pagination to an array of items and return the sliced result with page metadata.
 *
 * @task T4668
 * @epic T4663
 */
export function paginate<T>(items: T[], limit?: number, offset?: number): { items: T[]; page: LAFSPage } {
  const total = items.length;

  if (limit === undefined && offset === undefined) {
    return { items, page: { mode: 'none' } as LAFSPageNone };
  }

  const effectiveOffset = offset ?? 0;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const sliced = items.slice(effectiveOffset, effectiveOffset + effectiveLimit);

  return {
    items: sliced,
    page: createPage({ total, limit: effectiveLimit, offset: effectiveOffset }),
  };
}
