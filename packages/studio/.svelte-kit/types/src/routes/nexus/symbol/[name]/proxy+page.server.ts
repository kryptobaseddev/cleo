// @ts-nocheck
/**
 * Symbol ego-network page server load.
 *
 * Fetches the 2-hop ego network for the named symbol directly from nexus.db.
 */

import { error } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface EgoNode {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  hop: 0 | 1 | 2;
  callerCount: number;
  communityId: string | null;
}

export interface EgoEdge {
  source: string;
  target: string;
  type: string;
}

export const load = ({ params }: Parameters<PageServerLoad>[0]) => {
  const db = getNexusDb();
  if (!db) {
    error(503, 'nexus.db not available');
  }

  const name = decodeURIComponent(params.name);

  const centerRow = db
    .prepare(
      `SELECT id, label, kind, file_path, community_id
       FROM nexus_nodes
       WHERE label = ? OR id = ?
       ORDER BY CASE WHEN label = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(name, name, name) as
    | { id: string; label: string; kind: string; file_path: string; community_id: string | null }
    | undefined;

  if (!centerRow) {
    error(404, `Symbol "${name}" not found`);
  }

  const centerId = centerRow.id;

  const hop1Rows = db
    .prepare(
      `SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.community_id
       FROM nexus_relations r
       JOIN nexus_nodes n ON (r.target_id = n.id OR r.source_id = n.id)
       WHERE (r.source_id = ? OR r.target_id = ?)
         AND n.id != ?
       LIMIT 100`,
    )
    .all(centerId, centerId, centerId) as {
    id: string;
    label: string;
    kind: string;
    file_path: string;
    community_id: string | null;
  }[];

  const hop1Ids = hop1Rows.map((n) => n.id);

  let hop2Rows: typeof hop1Rows = [];
  if (hop1Ids.length > 0) {
    const placeholders = hop1Ids.map(() => '?').join(',');
    const excludeIds = [centerId, ...hop1Ids];
    const excludePlaceholders = excludeIds.map(() => '?').join(',');
    hop2Rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.community_id
         FROM nexus_relations r
         JOIN nexus_nodes n ON (r.target_id = n.id OR r.source_id = n.id)
         WHERE (r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))
           AND n.id NOT IN (${excludePlaceholders})
         LIMIT 200`,
      )
      .all(...hop1Ids, ...hop1Ids, ...excludeIds) as typeof hop1Rows;
  }

  const allIds = [centerId, ...hop1Ids, ...hop2Rows.map((n) => n.id)];

  const callerCounts = new Map<string, number>();
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    const ccRows = db
      .prepare(
        `SELECT target_id, COUNT(*) AS cnt
         FROM nexus_relations
         WHERE target_id IN (${placeholders}) AND type = 'calls'
         GROUP BY target_id`,
      )
      .all(...allIds) as { target_id: string; cnt: number }[];
    for (const row of ccRows) {
      callerCounts.set(row.target_id, row.cnt);
    }
  }

  const edgeRows =
    allIds.length > 0
      ? (db
          .prepare(
            `SELECT source_id, target_id, type
             FROM nexus_relations
             WHERE source_id IN (${allIds.map(() => '?').join(',')})
               AND target_id IN (${allIds.map(() => '?').join(',')})
             LIMIT 1000`,
          )
          .all(...allIds, ...allIds) as {
          source_id: string;
          target_id: string;
          type: string;
        }[])
      : [];

  const egoNodes: EgoNode[] = [
    {
      id: centerRow.id,
      label: centerRow.label,
      kind: centerRow.kind,
      filePath: centerRow.file_path ?? '',
      hop: 0,
      callerCount: callerCounts.get(centerRow.id) ?? 0,
      communityId: centerRow.community_id,
    },
    ...hop1Rows.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      filePath: n.file_path ?? '',
      hop: 1 as const,
      callerCount: callerCounts.get(n.id) ?? 0,
      communityId: n.community_id,
    })),
    ...hop2Rows.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      filePath: n.file_path ?? '',
      hop: 2 as const,
      callerCount: callerCounts.get(n.id) ?? 0,
      communityId: n.community_id,
    })),
  ];

  const egoEdges: EgoEdge[] = edgeRows.map((e) => ({
    source: e.source_id,
    target: e.target_id,
    type: e.type,
  }));

  return {
    symbolName: name,
    center: centerRow,
    egoNodes,
    egoEdges,
  };
};
