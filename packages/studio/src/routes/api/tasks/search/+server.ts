/**
 * GET /api/tasks/search — search tasks by ID or partial title.
 *
 * Query params:
 *   q — raw search string (e.g. "T663", "t663", "663", "council")
 *
 * Response:
 *   { kind: 'id', task: TaskRow | null }        — exact ID lookup
 *   { kind: 'title', tasks: TaskRow[], total: number } — fuzzy title filter
 *   { kind: 'empty' }                           — no query provided
 *
 * The normalization logic (ID vs. title) is centralised in
 * $lib/tasks/search.ts so the same rules apply everywhere.
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import { normalizeSearch } from '$lib/tasks/search.js';
import type { RequestHandler } from './$types';

/** A task row returned by the search endpoint. */
export interface SearchTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  pipeline_stage: string | null;
  updated_at: string;
}

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const raw = url.searchParams.get('q') ?? '';
  const normalized = normalizeSearch(raw);

  if (normalized.kind === 'empty') {
    return json({ kind: 'empty' });
  }

  try {
    if (normalized.kind === 'id') {
      const task = db
        .prepare(
          `SELECT id, title, status, priority, type, parent_id, pipeline_stage, updated_at
           FROM tasks WHERE id = ?`,
        )
        .get(normalized.id) as SearchTaskRow | undefined;

      return json({ kind: 'id', task: task ?? null });
    }

    // Fuzzy title search — case-insensitive LIKE on title and description
    const pattern = `%${normalized.query}%`;
    const tasks = db
      .prepare(
        `SELECT id, title, status, priority, type, parent_id, pipeline_stage, updated_at
         FROM tasks
         WHERE title LIKE ? COLLATE NOCASE
            OR description LIKE ? COLLATE NOCASE
         ORDER BY
           CASE type WHEN 'epic' THEN 0 WHEN 'task' THEN 1 ELSE 2 END,
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           updated_at DESC
         LIMIT 50`,
      )
      .all(pattern, pattern) as SearchTaskRow[];

    return json({ kind: 'title', tasks, total: tasks.length });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
