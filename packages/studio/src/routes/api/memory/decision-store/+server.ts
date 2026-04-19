/**
 * Memory decision-store write endpoint (T990 Wave 1D).
 *
 * POST /api/memory/decision-store
 *   body: {
 *     decision: string,
 *     rationale: string,
 *     alternatives?: string[],
 *     taskId?: string,
 *     contextEpicId?: string,
 *     contextPhase?: string
 *   }
 *   → LAFS envelope { success, data: { id, createdAt } }
 *
 * Inserts a new row into `brain_decisions`. Alternatives are stored as
 * a JSON-encoded TEXT column when the column is present; if the schema
 * pre-dates that addition the field is silently ignored.
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import {
  err,
  isParseError,
  ok,
  optionalString,
  optionalStringArray,
  parseJsonBody,
  requireString,
  shortId,
} from '../_lafs.js';
import type { RequestHandler } from './$types';

/** Data returned on success. */
export interface DecisionStoreData {
  id: string;
  createdAt: string;
}

/** Best-effort alternatives column detection. */
function hasAlternativesColumn(db: ReturnType<typeof getBrainDb>): boolean {
  if (!db) return false;
  try {
    const rows = db.prepare('PRAGMA table_info(brain_decisions)').all() as Array<{ name: string }>;
    return rows.some((r) => r.name === 'alternatives');
  } catch {
    return false;
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const decisionR = requireString(body, 'decision', 2_000);
  if (!decisionR.ok) {
    return json(err('E_VALIDATION', decisionR.message), { status: 400 });
  }
  const rationaleR = requireString(body, 'rationale', 10_000);
  if (!rationaleR.ok) {
    return json(err('E_VALIDATION', rationaleR.message), { status: 400 });
  }

  const alternatives = optionalStringArray(body, 'alternatives');
  const taskId = optionalString(body, 'taskId');
  const contextEpicId = optionalString(body, 'contextEpicId');
  const contextPhase = optionalString(body, 'contextPhase');

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(err('E_BRAIN_UNAVAILABLE', 'brain.db is unavailable for this project'), {
      status: 503,
    });
  }

  try {
    const id = `D-${shortId()}`;
    const createdAt = new Date().toISOString();
    const confidence = 'medium';
    const altsJson = alternatives ? JSON.stringify(alternatives) : null;

    if (hasAlternativesColumn(db)) {
      db.prepare(
        `INSERT INTO brain_decisions
           (id, type, decision, rationale, confidence, alternatives,
            context_epic_id, context_task_id, context_phase,
            memory_tier, verified, prune_candidate, created_at)
         VALUES (?, 'owner', ?, ?, ?, ?,
                 ?, ?, ?,
                 'short', 0, 0, ?)`,
      ).run(
        id,
        decisionR.value,
        rationaleR.value,
        confidence,
        altsJson,
        contextEpicId ?? null,
        taskId ?? null,
        contextPhase ?? null,
        createdAt,
      );
    } else {
      db.prepare(
        `INSERT INTO brain_decisions
           (id, type, decision, rationale, confidence,
            context_epic_id, context_task_id, context_phase,
            memory_tier, verified, prune_candidate, created_at)
         VALUES (?, 'owner', ?, ?, ?,
                 ?, ?, ?,
                 'short', 0, 0, ?)`,
      ).run(
        id,
        decisionR.value,
        rationaleR.value,
        confidence,
        contextEpicId ?? null,
        taskId ?? null,
        contextPhase ?? null,
        createdAt,
      );
    }

    return json(ok<DecisionStoreData>({ id, createdAt }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Insert failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
