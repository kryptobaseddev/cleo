/**
 * Memory patterns API endpoint.
 *
 * GET /api/memory/patterns
 *   Query params (all optional):
 *     - type: 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization'
 *     - limit
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * @remarks
 * The CORE `getPatterns` API supports `type` and `limit` filtering.
 * The `impact`, `min_quality`, `sort`, and `offset` parameters are not
 * yet exposed in the CORE public API — they are documented as a follow-up
 * (see T9616 notes). Client-side filtering can be applied until CORE
 * exposes these options.
 */

// T9766 — `PatternRecord` is now centralized in `@cleocode/contracts`.
import type { PatternRecord } from '@cleocode/contracts';
import { getPatterns } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { PatternRecord };

/** Response shape for GET /api/memory/patterns. */
export interface BrainPatternsResponse {
  patterns: PatternRecord[];
  total: number;
  filtered: number;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const patternType = url.searchParams.get('type') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? '50', 10) || 50));

  try {
    const result = await getPatterns({
      patternType,
      limit,
      projectPath: locals.projectCtx.projectPath,
    });
    return json({
      patterns: result.patterns,
      total: result.patterns.length,
      filtered: result.patterns.length,
    } satisfies BrainPatternsResponse);
  } catch {
    return json({ patterns: [], total: 0, filtered: 0 } satisfies BrainPatternsResponse);
  }
};
