/**
 * /code/symbol/[name] — ego-network page server load.
 *
 * Wires through `/api/nexus/symbol/[name]` to kill the duplicate SQL
 * path flagged by the T990 code audit.  Returns the raw API payload
 * + a friendly community label for the breadcrumb.
 *
 * @task T990
 * @wave 1B
 */

import { error } from '@sveltejs/kit';
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

export interface SymbolPageData {
  symbolName: string;
  nodes: EgoNode[];
  edges: EgoEdge[];
  center: EgoNode | null;
  communityLabel: string | null;
}

export const load: PageServerLoad = async ({ params, fetch }) => {
  const name = decodeURIComponent(params.name);
  const resp = await fetch(`/api/nexus/symbol/${encodeURIComponent(name)}`);

  if (!resp.ok) {
    if (resp.status === 404) error(404, `Symbol "${name}" not found`);
    if (resp.status === 503) error(503, 'nexus.db not available');
    error(resp.status, 'Failed to load symbol');
  }

  const payload = (await resp.json()) as {
    center: string;
    nodes: EgoNode[];
    edges: EgoEdge[];
  };

  const center = payload.nodes.find((n) => n.id === payload.center) ?? null;

  let communityLabel: string | null = null;
  if (center?.communityId) {
    const listResp = await fetch('/api/nexus?only=communities');
    if (listResp.ok) {
      const data = (await listResp.json()) as {
        communities: { id: string; rawLabel: string }[];
      };
      const match = data.communities.find((c) => c.id === center.communityId);
      communityLabel = match?.rawLabel ?? center.communityId.replace('comm_', 'Cluster ');
    }
  }

  return {
    symbolName: name,
    nodes: payload.nodes,
    edges: payload.edges,
    center,
    communityLabel,
  } satisfies SymbolPageData;
};
