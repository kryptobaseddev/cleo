/**
 * GET /api/nexus
 *
 * Returns the macro-view payload (communities + cross-community edges)
 * consumed by `/code`.  Replaces the previous communities-only payload.
 *
 * Shape:
 * {
 *   communities: Array<{ id, label, size, color, topKind, rawLabel }>,
 *   edges:       Array<{ source, target, weight, dominantType }>,
 *   totalNodes:  number,
 *   totalRelations: number,
 * }
 *
 * `dominantType` preserves the most-common {@link NexusRelationType}
 * across each cross-community pair so the renderer can style edges by
 * their semantic kind instead of a hardcoded `'cross-community'`
 * placeholder.
 *
 * Legacy consumers that only need the communities array continue to
 * work by reading `response.communities`.
 *
 * @task T990
 * @wave 1B
 */

import { json } from '@sveltejs/kit';
import { getNexusDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export interface CommunityRecord {
  id: string;
  name: string;
  /** Human-readable label stored on the community node (falls back to `Cluster N`). */
  rawLabel: string;
  size: number;
  color: string;
  topKind: string;
}

/**
 * Cross-community aggregate edge.  Dominant type is the most-common
 * relation type across the aggregate window, letting the renderer pick
 * the right edge-kind colour instead of collapsing to grey.
 */
export interface MacroEdgeRecord {
  source: string;
  target: string;
  weight: number;
  dominantType: string;
}

export interface MacroPayload {
  communities: CommunityRecord[];
  edges: MacroEdgeRecord[];
  totalNodes: number;
  totalRelations: number;
}

/**
 * 12-hue semantic palette — references the installed tokens.css
 * variables so server-side macro colouring remains theme-aware once
 * the client probes its computed style.  Kept as CSS expressions so
 * the client can run them through `getComputedStyle` at render time.
 */
const CLUSTER_CSS_CYCLE: readonly string[] = [
  'var(--info)',
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--priority-critical)',
  'color-mix(in srgb, var(--info) 60%, var(--accent) 40%)',
  'color-mix(in srgb, var(--success) 50%, var(--info) 50%)',
  'color-mix(in srgb, var(--warning) 60%, var(--danger) 40%)',
  'color-mix(in srgb, var(--accent) 70%, white 30%)',
  'color-mix(in srgb, var(--info) 40%, var(--priority-critical) 60%)',
  'color-mix(in srgb, var(--success) 40%, var(--warning) 60%)',
];

function cycleColor(idx: number): string {
  return CLUSTER_CSS_CYCLE[idx % CLUSTER_CSS_CYCLE.length] ?? 'var(--accent)';
}

export const GET: RequestHandler = ({ url }) => {
  const db = getNexusDb();
  if (!db) {
    return json({ error: 'nexus.db not available' }, { status: 503 });
  }

  const onlyCommunities = url.searchParams.get('only') === 'communities';

  const totalNodes = (
    db.prepare('SELECT COUNT(*) AS cnt FROM nexus_nodes').get() as { cnt: number }
  ).cnt;
  const totalRelations = (
    db.prepare('SELECT COUNT(*) AS cnt FROM nexus_relations').get() as { cnt: number }
  ).cnt;

  const communityRows = db
    .prepare(
      `SELECT n1.community_id AS community_id,
              COUNT(*) AS size,
              (SELECT kind FROM nexus_nodes n2
               WHERE n2.community_id = n1.community_id
               GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind,
              (SELECT cn.label FROM nexus_nodes cn
               WHERE cn.id = n1.community_id
               LIMIT 1) AS community_label
       FROM nexus_nodes n1
       WHERE n1.community_id IS NOT NULL
       GROUP BY n1.community_id
       ORDER BY size DESC`,
    )
    .all() as {
    community_id: string;
    size: number;
    top_kind: string;
    community_label: string | null;
  }[];

  const communities: CommunityRecord[] = communityRows.map((row, idx) => {
    const rawLabel = (row.community_label ?? '').trim();
    const clusterNum = row.community_id.replace('comm_', '');
    const name =
      rawLabel && rawLabel !== row.community_id
        ? `${rawLabel} (${row.size})`
        : `Cluster ${clusterNum} (${row.size})`;
    return {
      id: row.community_id,
      name,
      rawLabel: rawLabel && rawLabel !== row.community_id ? rawLabel : `Cluster ${clusterNum}`,
      size: row.size,
      color: cycleColor(idx),
      topKind: row.top_kind ?? 'function',
    };
  });

  let edges: MacroEdgeRecord[] = [];
  if (!onlyCommunities) {
    const edgeRows = db
      .prepare(
        `SELECT s.community_id AS src_comm,
                t.community_id AS tgt_comm,
                r.type        AS rel_type,
                COUNT(*)      AS weight
         FROM nexus_relations r
         JOIN nexus_nodes s ON r.source_id = s.id
         JOIN nexus_nodes t ON r.target_id = t.id
         WHERE s.community_id IS NOT NULL
           AND t.community_id IS NOT NULL
           AND s.community_id != t.community_id
         GROUP BY src_comm, tgt_comm, rel_type`,
      )
      .all() as {
      src_comm: string;
      tgt_comm: string;
      rel_type: string;
      weight: number;
    }[];

    // Fold the type breakdown into the aggregate edge record.
    type Accum = { weight: number; typeCounts: Map<string, number> };
    const accum = new Map<string, Accum>();
    for (const row of edgeRows) {
      const key = `${row.src_comm}::${row.tgt_comm}`;
      const cur = accum.get(key) ?? { weight: 0, typeCounts: new Map<string, number>() };
      cur.weight += row.weight;
      cur.typeCounts.set(row.rel_type, (cur.typeCounts.get(row.rel_type) ?? 0) + row.weight);
      accum.set(key, cur);
    }

    edges = [...accum.entries()]
      .map(([key, value]) => {
        const [src, tgt] = key.split('::');
        let dominantType = 'calls';
        let bestCount = 0;
        for (const [t, c] of value.typeCounts) {
          if (c > bestCount) {
            bestCount = c;
            dominantType = t;
          }
        }
        return { source: src, target: tgt, weight: value.weight, dominantType };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 600);
  }

  const payload: MacroPayload = {
    communities,
    edges,
    totalNodes,
    totalRelations,
  };
  return json(payload);
};
