/**
 * Community drill-down page server load.
 *
 * Fetches all member nodes and internal edges for the given community.
 */

import { error } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface CommunityNode {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  callerCount: number;
}

export interface CommunityEdge {
  source: string;
  target: string;
  type: string;
}

export const load: PageServerLoad = ({ params }) => {
  const db = getNexusDb();
  if (!db) {
    error(503, 'nexus.db not available');
  }

  const communityId = decodeURIComponent(params.id);

  const nodeRows = db
    .prepare(
      `SELECT n.id, n.label, n.kind, n.file_path,
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
    error(404, `Community ${communityId} not found`);
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

  const communityNodes: CommunityNode[] = nodeRows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    filePath: row.file_path ?? '',
    callerCount: row.caller_count,
  }));

  const communityEdges: CommunityEdge[] = edgeRows.map((row) => ({
    source: row.source_id,
    target: row.target_id,
    type: row.type,
  }));

  return { communityId, communityNodes, communityEdges };
};
