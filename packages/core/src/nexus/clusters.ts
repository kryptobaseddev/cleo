/**
 * NEXUS clusters query.
 *
 * Retrieves all detected Louvain communities for a project from the nexus.db
 * index. Used by `cleo nexus clusters` to list community nodes.
 *
 * @task T1473
 */

import { getNexusDb, nexusSchema } from '../store/nexus-sqlite.js';

/** One detected community (Louvain cluster). */
export interface NexusCommunityEntry {
  /** Community node ID. */
  id: string;
  /** Human-readable community label. */
  label: string | null;
  /** Number of symbols in this community. */
  symbolCount: number;
  /** Louvain cohesion score (0-1). */
  cohesion: number;
}

/** Result envelope for `getProjectClusters`. */
export interface NexusClustersResult {
  /** Project ID used for the query. */
  projectId: string;
  /** Absolute path to the project root. */
  repoPath: string;
  /** Number of communities found. */
  count: number;
  /** Community entries. */
  communities: NexusCommunityEntry[];
}

/**
 * Load all detected Louvain community nodes for a project from the nexus DB.
 *
 * @param projectId - The nexus project ID.
 * @param repoPath  - Absolute path to the project root.
 * @returns Clusters result including community list and count.
 *
 * @example
 * const result = await getProjectClusters('abc123', '/home/user/myproject');
 * console.log(result.communities.length);
 */
export async function getProjectClusters(
  projectId: string,
  repoPath: string,
): Promise<NexusClustersResult> {
  const db = await getNexusDb();

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }

  const communities = rows.filter((r) => r['kind'] === 'community' && r['projectId'] === projectId);

  return {
    projectId,
    repoPath,
    count: communities.length,
    communities: communities.map((c) => {
      const meta =
        typeof c['metaJson'] === 'string'
          ? (JSON.parse(c['metaJson'] as string) as Record<string, unknown>)
          : {};
      return {
        id: String(c['id']),
        label: c['label'] != null ? String(c['label']) : null,
        symbolCount: (meta['symbolCount'] as number) ?? 0,
        cohesion: (meta['cohesion'] as number) ?? 0,
      };
    }),
  };
}
