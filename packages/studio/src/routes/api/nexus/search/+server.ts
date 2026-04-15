/**
 * GET /api/nexus/search?q=xxx
 *
 * Returns up to 20 symbol matches for the given query string.
 * Searches label and id fields with LIKE, preferring exact label matches first.
 */

import { json } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export interface SearchResult {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  communityId: string | null;
}

export const GET: RequestHandler = ({ url }) => {
  const db = getNexusDb();
  if (!db) {
    return json({ error: 'nexus.db not available' }, { status: 503 });
  }

  const q = url.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) {
    return json([] as SearchResult[]);
  }

  const like = `%${q}%`;

  const rows = db
    .prepare(
      `SELECT id, label, kind, file_path, community_id
       FROM nexus_nodes
       WHERE label LIKE ? OR id LIKE ?
       ORDER BY
         CASE WHEN label = ? THEN 0
              WHEN label LIKE ? THEN 1
              ELSE 2 END,
         length(label)
       LIMIT 20`,
    )
    .all(like, like, q, `${q}%`) as {
    id: string;
    label: string;
    kind: string;
    file_path: string;
    community_id: string | null;
  }[];

  const results: SearchResult[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    filePath: row.file_path ?? '',
    communityId: row.community_id,
  }));

  return json(results);
};
