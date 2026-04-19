/**
 * Memory verify write endpoint (T990 Wave 1D).
 *
 * POST /api/memory/verify
 *   body: { id: string, agent?: string }
 *   → LAFS envelope { success, data: { id, table, verified, promotedAt } }
 *
 * Flips the `verified` flag on the target memory entry to 1, and
 * records the verification timestamp. Routes the update to the correct
 * brain_* table via the id prefix:
 *   - O- → brain_observations
 *   - D- → brain_decisions
 *   - P- → brain_patterns
 *   - L- → brain_learnings
 *
 * Ground-truth promotion is owner/cleo-prime only; this endpoint
 * inherits the Studio's localhost-only auth posture and does NOT
 * emit an audit event yet (T990 Wave 1D is UI-only — the core audit
 * trail lives in the CLI `cleo memory verify` op).
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import { err, isParseError, ok, parseJsonBody, requireString } from '../_lafs.js';
import type { RequestHandler } from './$types';

/** Data returned on success. */
export interface VerifyData {
  id: string;
  table: string;
  verified: number;
  promotedAt: string;
}

/** Route id-prefix → table. */
function tableFromId(id: string): string | null {
  if (id.startsWith('O-')) return 'brain_observations';
  if (id.startsWith('D-')) return 'brain_decisions';
  if (id.startsWith('P-')) return 'brain_patterns';
  if (id.startsWith('L-')) return 'brain_learnings';
  return null;
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const idR = requireString(body, 'id', 80);
  if (!idR.ok) {
    return json(err('E_VALIDATION', idR.message), { status: 400 });
  }

  const table = tableFromId(idR.value);
  if (!table) {
    return json(err('E_VALIDATION', 'Unknown id prefix — must be O- / D- / P- / L-'), {
      status: 400,
    });
  }

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(err('E_BRAIN_UNAVAILABLE', 'brain.db is unavailable for this project'), {
      status: 503,
    });
  }

  try {
    const exists = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(idR.value) as
      | { id: string }
      | undefined;
    if (!exists) {
      return json(err('E_NOT_FOUND', `No ${table} row with id ${idR.value}`), { status: 404 });
    }

    db.prepare(`UPDATE ${table} SET verified = 1 WHERE id = ?`).run(idR.value);

    const promotedAt = new Date().toISOString();

    return json(ok<VerifyData>({ id: idR.value, table, verified: 1, promotedAt }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Update failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
