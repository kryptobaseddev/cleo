/**
 * Memory pattern-store write endpoint (T990 Wave 1D).
 *
 * POST /api/memory/pattern-store
 *   body: {
 *     pattern: string,
 *     context: string,
 *     type?: 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization',
 *     impact?: 'low' | 'medium' | 'high',
 *     antiPattern?: string,
 *     mitigation?: string,
 *     examples?: string[]
 *   }
 *   → LAFS envelope { success, data: { id, deduplicated, createdAt } }
 *
 * Inserts a new row into `brain_patterns` (note: table uses
 * `extracted_at` rather than `created_at`). Dedup is best-effort —
 * match on lowercased-pattern + type; if hit, increment frequency and
 * return `deduplicated: true` without inserting.
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
export interface PatternStoreData {
  id: string;
  deduplicated: boolean;
  createdAt: string;
}

const VALID_TYPES = new Set(['workflow', 'blocker', 'success', 'failure', 'optimization']);
const VALID_IMPACTS = new Set(['low', 'medium', 'high']);

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const patternR = requireString(body, 'pattern', 2_000);
  if (!patternR.ok) {
    return json(err('E_VALIDATION', patternR.message), { status: 400 });
  }
  const contextR = requireString(body, 'context', 4_000);
  if (!contextR.ok) {
    return json(err('E_VALIDATION', contextR.message), { status: 400 });
  }

  const typeIn = optionalString(body, 'type') ?? 'workflow';
  const type = VALID_TYPES.has(typeIn) ? typeIn : 'workflow';
  const impactIn = optionalString(body, 'impact') ?? 'medium';
  const impact = VALID_IMPACTS.has(impactIn) ? impactIn : 'medium';
  const antiPattern = optionalString(body, 'antiPattern');
  const mitigation = optionalString(body, 'mitigation');
  const examples = optionalStringArray(body, 'examples');

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(err('E_BRAIN_UNAVAILABLE', 'brain.db is unavailable for this project'), {
      status: 503,
    });
  }

  try {
    // Dedup probe — match on pattern + type (case-insensitive).
    const dupe = db
      .prepare(
        `SELECT id, frequency FROM brain_patterns
         WHERE LOWER(pattern) = LOWER(?) AND type = ?
         LIMIT 1`,
      )
      .get(patternR.value, type) as { id: string; frequency: number } | undefined;

    const createdAt = new Date().toISOString();

    if (dupe) {
      db.prepare(`UPDATE brain_patterns SET frequency = frequency + 1 WHERE id = ?`).run(dupe.id);
      return json(ok<PatternStoreData>({ id: dupe.id, deduplicated: true, createdAt }));
    }

    const id = `P-${shortId()}`;

    db.prepare(
      `INSERT INTO brain_patterns
         (id, type, pattern, context, impact, anti_pattern, mitigation, examples,
          frequency, memory_tier, verified, prune_candidate, extracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?,
               1, 'short', 0, 0, ?)`,
    ).run(
      id,
      type,
      patternR.value,
      contextR.value,
      impact,
      antiPattern ?? null,
      mitigation ?? null,
      examples ? JSON.stringify(examples) : null,
      createdAt,
    );

    return json(ok<PatternStoreData>({ id, deduplicated: false, createdAt }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Insert failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
