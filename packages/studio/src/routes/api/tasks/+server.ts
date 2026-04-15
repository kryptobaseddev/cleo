/**
 * GET /api/tasks — list tasks with optional filters.
 *
 * Query params:
 *   status  — pending | active | done | archived (comma-separated)
 *   priority — critical | high | medium | low (comma-separated)
 *   type    — epic | task | subtask (comma-separated)
 *   limit   — max rows (default 200)
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  pipeline_stage: string | null;
  size: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  verification_json: string | null;
  acceptance_json: string | null;
}

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const statusParam = url.searchParams.get('status');
  const priorityParam = url.searchParams.get('priority');
  const typeParam = url.searchParams.get('type');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '200'), 1000);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusParam) {
    const values = statusParam.split(',').map((s) => s.trim());
    conditions.push(`status IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  if (priorityParam) {
    const values = priorityParam.split(',').map((s) => s.trim());
    conditions.push(`priority IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  if (typeParam) {
    const values = typeParam.split(',').map((s) => s.trim());
    conditions.push(`type IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT id, title, description, status, priority, type, parent_id,
           pipeline_stage, size, created_at, updated_at, completed_at,
           verification_json, acceptance_json
    FROM tasks
    ${where}
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as TaskRow[];
    return json({ tasks: rows, total: rows.length });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
