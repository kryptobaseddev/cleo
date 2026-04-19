/**
 * GET /api/project/audit
 *
 * Returns the trailing N audit entries from
 * `<projectPath>/.cleo/audit/studio-actions.jsonl` (newest first).
 *
 * Query string:
 *   - `limit` — max entries to return (default 50, cap 500).
 *
 * @task T990
 * @wave 1E
 */

import { json } from '@sveltejs/kit';
import { readAuditLog } from '$lib/server/audit-log.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, locals }) => {
  const raw = url.searchParams.get('limit');
  let limit = 50;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, 500);
    }
  }

  const entries = readAuditLog(locals.projectCtx.projectPath, limit);
  return json({
    success: true,
    data: {
      entries,
      projectPath: locals.projectCtx.projectPath,
    },
  });
};
