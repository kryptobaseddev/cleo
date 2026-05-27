/**
 * GET /api/nexus/community/:id
 *
 * Returns all member nodes for a given community, along with edges
 * between members (internal edges only, for drill-down view).
 */

import { json } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export interface NexusNode {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  callerCount: number;
}

export interface NexusEdge {
  source: string;
  target: string;
  type: string;
}

export interface CommunityDetail {
  communityId: string;
  nodes: NexusNode[];
  edges: NexusEdge[];
}

export const GET: RequestHandler = ({ params }) => {
  const db = getNexusDb();
  if (!db) {
    return json({ error: 'nexus.db not available' }, { status: 503 });
  }

  const communityId = params.id;

  const nodeRows = db
    .prepare(
      `SELECT n.id,
              n.label,
              n.kind,
              n.file_path,
              COUNT(r.id) AS caller_count
       FROM nexus_nodes n
       LEFT JOIN nexus_relations r ON r.target_id = n.id AND r.type = 'calls'
       WHERE n.community_id = ?
       GROUP BY n.id
       ORDER BY caller_count DESC
       LIMIT 500`,
    )
    .all(communityId) as {
    id: string;
    label: string;
    kind: string;
    file_path: string;
    caller_count: number;
  }[];

  if (nodeRows.length === 0) {
    return json({ error: `Community ${communityId} not found` }, { status: 404 });
  }

  const nodeIds = nodeRows.map((n) => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const edgeRows = db
    .prepare(
      `SELECT source_id, target_id, type
       FROM nexus_relations
       WHERE source_id IN (${placeholders})
         AND target_id IN (${placeholders})
       LIMIT 2000`,
    )
    .all(...nodeIds, ...nodeIds) as { source_id: string; target_id: string; type: string }[];

  const nodes: NexusNode[] = nodeRows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    filePath: row.file_path ?? '',
    callerCount: row.caller_count,
  }));

  const edges: NexusEdge[] = edgeRows.map((row) => ({
    source: row.source_id,
    target: row.target_id,
    type: row.type,
  }));

  return json({ communityId, nodes, edges } satisfies CommunityDetail);
};
