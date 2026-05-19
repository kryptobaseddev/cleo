/**
 * Memory pending-verify queue API endpoint.
 *
 * GET /api/memory/pending-verify?minCitations=<n>&limit=<n>
 *
 * Surfaces unverified-but-cited entries across all four brain tables so
 * the owner can promote the highest-leverage memory to verified status.
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler. LAFS envelope: `{ success, data, error?, meta }`.
 */

import {
  getPendingVerify,
  type PendingVerifyEntry,
  type PendingVerifyResult,
} from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { PendingVerifyEntry, PendingVerifyResult };

/** LAFS envelope helpers. */
function lafsOk(data: PendingVerifyResult): Record<string, unknown> {
  return {
    success: true,
    data,
    meta: { at: new Date().toISOString() },
  };
}

function lafsErr(message: string): Record<string, unknown> {
  return {
    success: false,
    error: { code: 'E_MEMORY_PENDING_VERIFY', message },
    meta: { at: new Date().toISOString() },
  };
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const minRaw = url.searchParams.get('minCitations');
  const limRaw = url.searchParams.get('limit');
  const minCitations = Math.max(1, Number.parseInt(minRaw ?? '5', 10) || 5);
  const limit = Math.max(1, Math.min(200, Number.parseInt(limRaw ?? '50', 10) || 50));

  try {
    const result = await getPendingVerify(locals.projectCtx.projectPath, { minCitations, limit });
    return json(lafsOk(result));
  } catch (e) {
    return json(lafsErr(e instanceof Error ? e.message : 'Query failed'), { status: 500 });
  }
};
