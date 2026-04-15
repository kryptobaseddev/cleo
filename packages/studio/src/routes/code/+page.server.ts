/**
 * Nexus macro view server load.
 *
 * Builds the community graph data: one node per community (up to 259),
 * with inter-community edges derived from cross-community relations.
 *
 * Label derivation priority:
 *   1. `nexus_nodes.label` for the community node itself (heuristic label
 *      written by community-processor, e.g. "Engines", "Pipeline")
 *   2. Most-common parent folder across member file paths
 *   3. `Cluster N` fallback
 */

import { getNexusDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface MacroNode {
  id: string;
  label: string;
  size: number;
  color: string;
  topKind: string;
  memberCount: number;
}

export interface MacroEdge {
  source: string;
  target: string;
  weight: number;
}

const PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#a855f7',
];

function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#3b82f6';
}

function communitySize(memberCount: number): number {
  return 6 + Math.log1p(memberCount) * 3;
}

export const load: PageServerLoad = () => {
  const db = getNexusDb();

  let macroNodes: MacroNode[] = [];
  let macroEdges: MacroEdge[] = [];
  let totalNodes = 0;
  let totalRelations = 0;

  if (db) {
    try {
      const nodeCount = db.prepare('SELECT COUNT(*) AS cnt FROM nexus_nodes').get() as {
        cnt: number;
      };
      const relCount = db.prepare('SELECT COUNT(*) AS cnt FROM nexus_relations').get() as {
        cnt: number;
      };
      totalNodes = nodeCount.cnt;
      totalRelations = relCount.cnt;

      const communityRows = db
        .prepare(
          `SELECT n1.community_id,
                  COUNT(*) AS member_count,
                  (SELECT kind FROM nexus_nodes n2
                   WHERE n2.community_id = n1.community_id
                   GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind,
                  (SELECT cn.label FROM nexus_nodes cn
                   WHERE cn.id = n1.community_id
                   LIMIT 1) AS community_label
           FROM nexus_nodes n1
           WHERE n1.community_id IS NOT NULL
           GROUP BY n1.community_id
           ORDER BY member_count DESC`,
        )
        .all() as {
        community_id: string;
        member_count: number;
        top_kind: string;
        community_label: string | null;
      }[];

      macroNodes = communityRows.map((row, idx) => {
        // Use the stored heuristic label from the community node when available.
        // The label is written by community-processor as the dominant folder name
        // (e.g. "Engines", "Pipeline").  Fall back to "Cluster N" only when
        // the community node label is missing or empty.
        const rawLabel = row.community_label?.trim() ?? '';
        const clusterNum = row.community_id.replace('comm_', '');
        const label =
          rawLabel && rawLabel !== row.community_id
            ? `${rawLabel} (${row.member_count})`
            : `Cluster ${clusterNum} (${row.member_count})`;

        return {
          id: row.community_id,
          label,
          size: communitySize(row.member_count),
          color: colorForIndex(idx),
          topKind: row.top_kind ?? 'function',
          memberCount: row.member_count,
        };
      });

      const edgeRows = db
        .prepare(
          `SELECT s.community_id AS src_comm,
                  t.community_id AS tgt_comm,
                  COUNT(*) AS weight
           FROM nexus_relations r
           JOIN nexus_nodes s ON r.source_id = s.id
           JOIN nexus_nodes t ON r.target_id = t.id
           WHERE s.community_id IS NOT NULL
             AND t.community_id IS NOT NULL
             AND s.community_id != t.community_id
           GROUP BY src_comm, tgt_comm
           ORDER BY weight DESC
           LIMIT 600`,
        )
        .all() as { src_comm: string; tgt_comm: string; weight: number }[];

      macroEdges = edgeRows.map((row) => ({
        source: row.src_comm,
        target: row.tgt_comm,
        weight: row.weight,
      }));
    } catch {
      // Database error — return empty.
    }
  }

  return { macroNodes, macroEdges, totalNodes, totalRelations };
};
