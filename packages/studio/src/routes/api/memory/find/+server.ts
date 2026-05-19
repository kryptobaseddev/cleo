/**
 * Memory cross-table search API endpoint.
 *
 * GET /api/memory/find?q=<query>&tables=<csv>&limit=<n>
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * Response shape is a flat, uniformly-typed hit list so the Svelte
 * search page can group by table without knowing the underlying schema.
 */

import { findMemoryEntries, type MemorySearchHit } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { MemorySearchHit };

/** Response shape for GET /api/memory/find. */
export interface MemoryFindResponse {
  query: string;
  hits: MemorySearchHit[];
  total: number;
}

const ALLOWED_TABLES = ['observations', 'decisions', 'patterns', 'learnings'] as const;
type Table = (typeof ALLOWED_TABLES)[number];

export const GET: RequestHandler = async ({ locals, url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  const tablesParam = url.searchParams.get('tables');
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw ?? '25', 10) || 25));

  const tables: Table[] = tablesParam
    ? (tablesParam
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is Table => (ALLOWED_TABLES as readonly string[]).includes(t)) as Table[])
    : [...ALLOWED_TABLES];

  if (!q) {
    return json({ query: '', hits: [], total: 0 } satisfies MemoryFindResponse);
  }

  try {
    const result = await findMemoryEntries({
      query: q,
      tables,
      limit,
      projectPath: locals.projectCtx.projectPath,
    });
    return json({
      query: result.query,
      hits: result.hits,
      total: result.total,
    } satisfies MemoryFindResponse);
  } catch {
    return json({ query: q, hits: [], total: 0 } satisfies MemoryFindResponse);
  }
};
