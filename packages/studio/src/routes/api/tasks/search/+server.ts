/**
 * GET /api/tasks/search — search tasks by ID or partial title.
 *
 * Query params:
 *   q — raw search string (e.g. "T663", "t663", "663", "council")
 *
 * Response:
 *   { kind: 'id', task: SearchTaskRow | null }              — exact ID lookup
 *   { kind: 'title', tasks: SearchTaskRow[], total: number } — fuzzy title filter
 *   { kind: 'empty' }                                       — no query provided
 *
 * The normalisation logic (ID vs. title) is centralised in
 * $lib/tasks/search.ts so the same rules apply everywhere.
 *
 * T9617 refactor: zero raw SQL — delegates to `findTasks` from
 * `@cleocode/core/tasks`. The response preserves the pre-T9617 snake_case
 * field contract so existing consumers of this endpoint are unaffected.
 *
 * @task T9617
 */

import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { findTasks } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
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

export const GET: RequestHandler = async ({ locals, url }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const raw = url.searchParams.get('q') ?? '';
  const normalized = normalizeSearch(raw);

  if (normalized.kind === 'empty') {
    return json({ kind: 'empty' });
  }

  try {
    const accessor = await getTaskAccessor(ctx.projectPath);

    if (normalized.kind === 'id') {
      // Exact ID lookup via find with id-prefix search, limit 1 exact match
      const result = await findTasks({ id: normalized.id, limit: 50 }, ctx.projectPath, accessor);

      // Find exact match first, fallback to first prefix result
      const exact = result.results.find((r) => r.id.toUpperCase() === normalized.id.toUpperCase());
      const match = exact ?? result.results[0] ?? null;

      const task: SearchTaskRow | null = match
        ? {
            id: match.id,
            title: match.title,
            status: match.status,
            priority: match.priority,
            type: match.type ?? 'task',
            parent_id: match.parentId ?? null,
            pipeline_stage: null, // not returned by find — use /api/tasks/[id] for full fields
            updated_at: new Date().toISOString(), // core find result does not expose updated_at
          }
        : null;

      return json({ kind: 'id', task });
    }

    // Fuzzy title search
    const result = await findTasks(
      { query: normalized.query, limit: 50 },
      ctx.projectPath,
      accessor,
    );

    const tasks: SearchTaskRow[] = result.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      type: r.type ?? 'task',
      parent_id: r.parentId ?? null,
      pipeline_stage: null, // minimal find result — use /api/tasks/[id] for full fields
      updated_at: new Date().toISOString(),
    }));

    return json({ kind: 'title', tasks, total: tasks.length });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
