/**
 * Legacy `/tasks/graph` route — 301 redirect to the new Task Explorer graph
 * tab on `/tasks`.
 *
 * T956 merged the three explorer tabs (Hierarchy, Graph, Kanban) into the
 * single `/tasks` page with hash-based tab switching. The old graph page lives
 * on as a thin redirect shell so external links and bookmarks continue to
 * work: `/tasks/graph` now sends the caller to `/tasks?view=graph#graph`,
 * preserving any additional query parameters (e.g. `?archived=1`, `?epic=`)
 * so existing filter state round-trips through the redirect.
 *
 * The previous graph implementation's rendering logic is already available in
 * the shared shelf under `$lib/components/tasks` (extracted by T950); deleting
 * the `+page.svelte` sibling therefore loses no functionality.
 *
 * @task T957
 * @epic T949
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
  const target = new URL('/tasks', url.origin);
  // Preserve caller-provided query params first (filters, archived flag, etc.)
  for (const [key, value] of url.searchParams) {
    target.searchParams.set(key, value);
  }
  // Add view LAST so it always resolves to the graph tab even if a caller
  // happened to pass `?view=...` already.
  target.searchParams.set('view', 'graph');
  target.hash = 'graph';

  redirect(301, target.pathname + target.search + target.hash);
};
