/**
 * Memory learning-store write endpoint (T990 Wave 1D).
 *
 * POST /api/memory/learning-store
 *   body: {
 *     insight: string,
 *     source: string,
 *     confidence?: number (0..1),
 *     actionable?: boolean,
 *     application?: string,
 *     applicableTypes?: string[]
 *   }
 *   → LAFS envelope { success, data: { id, deduplicated, createdAt } }
 *
 * Inserts a new row into `brain_learnings`. Dedup matches on lowered
 * insight — if a match is found, the confidence is averaged with the
 * existing value and `deduplicated: true` is returned.
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
  optionalBool,
  optionalString,
  optionalStringArray,
  optionalUnit,
  parseJsonBody,
  requireString,
  shortId,
} from '../_lafs.js';
import type { RequestHandler } from './$types';

/** Data returned on success. */
export interface LearningStoreData {
  id: string;
  deduplicated: boolean;
  createdAt: string;
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const insightR = requireString(body, 'insight', 2_000);
  if (!insightR.ok) {
    return json(err('E_VALIDATION', insightR.message), { status: 400 });
  }
  const sourceR = requireString(body, 'source', 500);
  if (!sourceR.ok) {
    return json(err('E_VALIDATION', sourceR.message), { status: 400 });
  }

  const confidence = optionalUnit(body, 'confidence') ?? 0.5;
  const actionable = optionalBool(body, 'actionable') ?? false;
  const application = optionalString(body, 'application');
  const applicableTypes = optionalStringArray(body, 'applicableTypes');

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(err('E_BRAIN_UNAVAILABLE', 'brain.db is unavailable for this project'), {
      status: 503,
    });
  }

  try {
    const dupe = db
      .prepare(
        `SELECT id, confidence FROM brain_learnings
         WHERE LOWER(insight) = LOWER(?)
         LIMIT 1`,
      )
      .get(insightR.value) as { id: string; confidence: number | null } | undefined;

    const createdAt = new Date().toISOString();

    if (dupe) {
      const base = typeof dupe.confidence === 'number' ? dupe.confidence : 0.5;
      const merged = Math.max(0, Math.min(1, (base + confidence) / 2));
      db.prepare('UPDATE brain_learnings SET confidence = ? WHERE id = ?').run(merged, dupe.id);
      return json(ok<LearningStoreData>({ id: dupe.id, deduplicated: true, createdAt }));
    }

    const id = `L-${shortId()}`;

    db.prepare(
      `INSERT INTO brain_learnings
         (id, insight, source, confidence, actionable, application, applicable_types,
          memory_tier, verified, prune_candidate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               'short', 0, 0, ?)`,
    ).run(
      id,
      insightR.value,
      sourceR.value,
      confidence,
      actionable ? 1 : 0,
      application ?? null,
      applicableTypes ? JSON.stringify(applicableTypes) : null,
      createdAt,
    );

    return json(ok<LearningStoreData>({ id, deduplicated: false, createdAt }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Insert failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
