/**
 * Legacy `/tasks/tree/[epicId]` route — 301 redirect to the new Task Explorer
 * hierarchy tab on `/tasks`.
 *
 * T956 merged the three explorer tabs (Hierarchy, Graph, Kanban) into the
 * single `/tasks` page with hash-based tab switching. The old epic-tree page
 * lives on as a thin redirect shell so external links and bookmarks continue
 * to work: `/tasks/tree/TXXX` now sends the caller to
 * `/tasks?view=hierarchy&epic=TXXX#hierarchy`, preserving any additional query
 * parameters the caller passed.
 *
 * The previous tree implementation's rendering logic is already available in
 * the shared shelf under `$lib/components/tasks` (extracted by T950); deleting
 * the `+page.svelte` sibling therefore loses no functionality.
 *
 * @task T957
 * @epic T949
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, url }) => {
  const { epicId } = params;

  const target = new URL('/tasks', url.origin);
  // Preserve any caller-provided query params (filters, labels, archived flag,
  // etc.) so the task-filters store on /tasks can pick them up as-is.
  for (const [key, value] of url.searchParams) {
    target.searchParams.set(key, value);
  }
  // Add the view + epic params LAST so they always win over stale caller copies
  // of the same keys (callers never passed these before the redirect existed).
  target.searchParams.set('view', 'hierarchy');
  target.searchParams.set('epic', epicId);
  target.hash = 'hierarchy';

  redirect(301, target.pathname + target.search + target.hash);
};
