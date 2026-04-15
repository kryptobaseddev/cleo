/**
 * GET /api/nexus/communities
 *
 * Returns all communities with member counts and assigned colors.
 * Color is derived from a deterministic palette by community index.
 */

import { json } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Community palette — 12 distinct hues cycling for 254 communities. */
const PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
  '#a855f7', // purple
];

function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#3b82f6';
}

export interface CommunityRecord {
  id: string;
  name: string;
  size: number;
  color: string;
  topKind: string;
}

export const GET: RequestHandler = () => {
  const db = getNexusDb();
  if (!db) {
    return json({ error: 'nexus.db not available' }, { status: 503 });
  }

  const rows = db
    .prepare(
      `SELECT community_id,
              COUNT(*) AS size,
              (SELECT kind FROM nexus_nodes n2
               WHERE n2.community_id = n1.community_id
               GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind
       FROM nexus_nodes n1
       WHERE community_id IS NOT NULL
       GROUP BY community_id
       ORDER BY size DESC`,
    )
    .all() as { community_id: string; size: number; top_kind: string }[];

  const communities: CommunityRecord[] = rows.map((row, idx) => ({
    id: row.community_id,
    name: `Cluster ${row.community_id.replace('comm_', '')}`,
    size: row.size,
    color: colorForIndex(idx),
    topKind: row.top_kind ?? 'function',
  }));

  return json(communities);
};
