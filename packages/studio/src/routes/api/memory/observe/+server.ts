/**
 * Memory observe write endpoint.
 *
 * POST /api/memory/observe
 *   body: { title: string, text: string, type?: string, project?: string }
 *   → LAFS envelope { success, data: { id, type, createdAt } }
 *
 * Delegates to `@cleocode/core` `observeBrain` (T9615/T9616).
 * Zero raw SQL in this handler.
 */

import { observeBrain } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import { err, isParseError, ok, optionalString, parseJsonBody, requireString } from '../_lafs.js';
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

  try {
    const result = await observeBrain(locals.projectCtx.projectPath, {
      title: titleR.value,
      text: textR.value,
      type: type as Parameters<typeof observeBrain>[1]['type'],
      project,
      sourceType: 'manual',
      sourceConfidence: 'owner',
    });

    return json(
      ok<ObserveWriteData>({ id: result.id, type: result.type, createdAt: result.createdAt }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Insert failed';
    return json(err('E_BRAIN_WRITE', msg), { status: 500 });
  }
};
