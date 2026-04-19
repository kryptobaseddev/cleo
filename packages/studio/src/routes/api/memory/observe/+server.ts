/**
 * Memory observe write endpoint (T990 Wave 1D).
 *
 * POST /api/memory/observe
 *   body: { title: string, text: string, type?: string, project?: string }
 *   → LAFS envelope { success, data: { id, type, createdAt } }
 *
 * Inserts a new row into `brain_observations`. Studio owns its own
 * insertion path so the UI can write without spawning a CLI subprocess.
 * The insert schema mirrors the canonical `memory.observe` CLI op
 * payload so a future migration to the SDK-backed dispatch layer is a
 * drop-in swap.
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
  parseJsonBody,
  requireString,
  shortId,
} from '../_lafs.js';
import type { RequestHandler } from './$types';

/** Data returned on success. */
export interface ObserveWriteData {
  id: string;
  type: string;
  createdAt: string;
}

const VALID_KINDS = new Set(['discovery', 'change', 'feature', 'bugfix', 'decision', 'refactor']);

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const titleR = requireString(body, 'title', 200);
  if (!titleR.ok) {
    return json(err('E_VALIDATION', titleR.message), { status: 400 });
  }
  const textR = requireString(body, 'text', 10_000);
  if (!textR.ok) {
    return json(err('E_VALIDATION', textR.message), { status: 400 });
  }

  const typeIn = optionalString(body, 'type') ?? 'discovery';
  const type = VALID_KINDS.has(typeIn) ? typeIn : 'discovery';
  const project = optionalString(body, 'project');

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(err('E_BRAIN_UNAVAILABLE', 'brain.db is unavailable for this project'), {
      status: 503,
    });
  }

  try {
    const id = `O-${shortId()}`;
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO brain_observations
         (id, type, title, narrative, project, source_type, source_confidence,
          memory_tier, memory_type, verified, citation_count,
          prune_candidate, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', 'owner',
               'short', 'episodic', 0, 0,
               0, ?)`,
    ).run(id, type, titleR.value, textR.value, project ?? null, createdAt);

    return json(ok<ObserveWriteData>({ id, type, createdAt }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Insert failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
