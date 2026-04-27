/**
 * NEXUS execution flows query.
 *
 * Retrieves all detected execution flow (process) nodes for a project from
 * the nexus.db index. Used by `cleo nexus flows` to list process nodes.
 *
 * @task T1473
 */

import { getNexusDb, nexusSchema } from '../store/nexus-sqlite.js';

/** One detected execution flow (process node). */
export interface NexusFlowEntry {
  /** Process node ID. */
  id: string;
  /** Human-readable flow label. */
  label: string | null;
  /** Number of steps in this flow. */
  stepCount: number;
  /** Process type (e.g. 'intra_community', 'inter_community'). */
  processType: string;
  /** Entry-point symbol ID for this flow, or null. */
  entryPointId: string | null;
}

/** Result envelope for `getProjectFlows`. */
export interface NexusFlowsResult {
  /** Project ID used for the query. */
  projectId: string;
  /** Absolute path to the project root. */
  repoPath: string;
  /** Number of flows found. */
  count: number;
  /** Flow entries. */
  flows: NexusFlowEntry[];
}

/**
 * Load all detected execution flow nodes for a project from the nexus DB.
 *
 * @param projectId - The nexus project ID.
 * @param repoPath  - Absolute path to the project root.
 * @returns Flows result including flow list and count.
 *
 * @example
 * const result = await getProjectFlows('abc123', '/home/user/myproject');
 * console.log(result.flows.length);
 */
export async function getProjectFlows(
  projectId: string,
  repoPath: string,
): Promise<NexusFlowsResult> {
  const db = await getNexusDb();

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }

  const processes = rows.filter((r) => r['kind'] === 'process' && r['projectId'] === projectId);

  return {
    projectId,
    repoPath,
    count: processes.length,
    flows: processes.map((p) => {
      const meta =
        typeof p['metaJson'] === 'string'
          ? (JSON.parse(p['metaJson'] as string) as Record<string, unknown>)
          : {};
      return {
        id: String(p['id']),
        label: p['label'] != null ? String(p['label']) : null,
        stepCount: (meta['stepCount'] as number) ?? 0,
        processType: String(meta['processType'] ?? 'intra_community'),
        entryPointId: meta['entryPointId'] != null ? String(meta['entryPointId']) : null,
      };
    }),
  };
}
