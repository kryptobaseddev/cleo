/**
 * /code macro view — server load.
 *
 * Wires the macro page through `/api/nexus` instead of calling
 * `getNexusDb()` directly, killing the drift flagged by the T990 code
 * audit.  The API now preserves the dominant relation type per
 * cross-community aggregate so the renderer can style edges correctly.
 *
 * @task T990
 * @wave 1B
 */

import type { MacroPayload } from '../api/nexus/+server.js';
import type { PageServerLoad } from './$types';

/**
 * Shape consumed by `+page.svelte` — a thin passthrough over the API
 * payload plus a friendly `empty` flag.
 */
export interface CodePageData {
  communities: MacroPayload['communities'];
  edges: MacroPayload['edges'];
  totalNodes: number;
  totalRelations: number;
  /** True when nexus.db is unreachable or empty. */
  empty: boolean;
  /** Optional reason to show in the EmptyState. */
  emptyReason: string | null;
}

export const load: PageServerLoad = async ({ fetch }) => {
  const resp = await fetch('/api/nexus');
  if (!resp.ok) {
    const message = resp.status === 503 ? 'nexus.db not available' : `API error ${resp.status}`;
    return {
      communities: [],
      edges: [],
      totalNodes: 0,
      totalRelations: 0,
      empty: true,
      emptyReason: message,
    } satisfies CodePageData;
  }

  const payload = (await resp.json()) as MacroPayload;
  return {
    communities: payload.communities,
    edges: payload.edges,
    totalNodes: payload.totalNodes,
    totalRelations: payload.totalRelations,
    empty: payload.communities.length === 0,
    emptyReason:
      payload.communities.length === 0
        ? 'No communities indexed yet. Run `cleo nexus analyze` to populate nexus.db.'
        : null,
  } satisfies CodePageData;
};
