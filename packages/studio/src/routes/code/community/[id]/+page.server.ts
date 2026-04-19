/**
 * /code/community/[id] — server load.
 *
 * Wires through `/api/nexus/community/[id]` to retire the direct DB
 * call flagged by the T990 code audit.  The API payload is passed to
 * the adapter on the client, so this loader stays thin.
 *
 * @task T990
 * @wave 1B
 */

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * A single symbol row returned by `/api/nexus/community/[id]`.
 */
export interface CommunityNode {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  callerCount: number;
}

/**
 * A single internal-edge row returned by the API.
 */
export interface CommunityEdge {
  source: string;
  target: string;
  /** Raw nexus_relations.type string — client maps to EdgeKind. */
  type: string;
}

/**
 * Page data payload shape consumed by `+page.svelte`.
 */
export interface CommunityPageData {
  communityId: string;
  communityLabel: string;
  nodes: CommunityNode[];
  edges: CommunityEdge[];
  summary: {
    memberCount: number;
    topKind: string;
    internalEdgeCount: number;
  };
}

export const load: PageServerLoad = async ({ params, fetch }) => {
  const communityId = decodeURIComponent(params.id);

  const [detailResp, listResp] = await Promise.all([
    fetch(`/api/nexus/community/${encodeURIComponent(communityId)}`),
    fetch('/api/nexus?only=communities'),
  ]);

  if (!detailResp.ok) {
    if (detailResp.status === 404) error(404, `Community ${communityId} not found`);
    if (detailResp.status === 503) error(503, 'nexus.db not available');
    error(detailResp.status, 'Failed to load community');
  }

  const detail = (await detailResp.json()) as {
    communityId: string;
    nodes: CommunityNode[];
    edges: CommunityEdge[];
  };

  // Enrich with the community label from the summary API.
  let communityLabel = communityId.replace('comm_', 'Cluster ');
  if (listResp.ok) {
    const communities = (await listResp.json()) as {
      communities: { id: string; rawLabel: string }[];
    };
    const match = communities.communities.find((c) => c.id === communityId);
    if (match?.rawLabel) communityLabel = match.rawLabel;
  }

  // Derive the top kind client-side from the node list.
  const kindHisto = new Map<string, number>();
  for (const n of detail.nodes) {
    kindHisto.set(n.kind, (kindHisto.get(n.kind) ?? 0) + 1);
  }
  let topKind = 'function';
  let topCount = 0;
  for (const [k, c] of kindHisto) {
    if (c > topCount) {
      topKind = k;
      topCount = c;
    }
  }

  return {
    communityId,
    communityLabel,
    nodes: detail.nodes,
    edges: detail.edges,
    summary: {
      memberCount: detail.nodes.length,
      topKind,
      internalEdgeCount: detail.edges.length,
    },
  } satisfies CommunityPageData;
};
