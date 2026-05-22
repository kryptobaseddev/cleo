/**
 * Nexus graph export — business logic extracted from `cleo nexus export`.
 *
 * Queries nexus.db for nodes and relations and serializes them to GEXF or
 * JSON. The CLI handler calls {@link exportNexusGraph} and routes output to
 * stdout or a file.
 *
 * @module nexus/export
 * @epic T9833
 * @task T10062
 */

import { generateGexf } from './gexf-export.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Output format for the graph export. */
export type NexusExportFormat = 'gexf' | 'json';

/** Options for {@link exportNexusGraph}. */
export interface NexusExportOptions {
  /** Serialization format (default: `'gexf'`). */
  format?: NexusExportFormat;
  /** When set, only nodes/relations belonging to this project are exported. */
  projectFilter?: string;
}

/** Result of {@link exportNexusGraph}. */
export interface NexusExportResult {
  /** Serialized graph content (GEXF XML or JSON string). */
  content: string;
  /** Number of nodes included in the export. */
  nodeCount: number;
  /** Number of edges included in the export. */
  edgeCount: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export the nexus graph as GEXF or JSON.
 *
 * Queries `nexus.db` for all nodes and relations, applies an optional project
 * filter, and serializes to the requested format.
 *
 * @param opts - Export options
 * @returns Serialized content and counts
 * @throws {Error} On unknown format or database errors
 */
export async function exportNexusGraph(opts: NexusExportOptions = {}): Promise<NexusExportResult> {
  const format = opts.format ?? 'gexf';
  const projectFilter = opts.projectFilter;

  // SSoT-EXEMPT:file-serialization — requires direct nexus.db access for
  // node/relation queries. Cannot be a LAFS dispatch op without binary data concerns.
  const { getNexusDb, nexusSchema } = await import('@cleocode/core/store/nexus-sqlite' as string);
  const db = await getNexusDb();

  let allNodes: Array<Record<string, unknown>> = [];
  let allRelations: Array<Record<string, unknown>> = [];
  try {
    allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
    allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
      Record<string, unknown>
    >;
  } catch {
    // DB may be empty
  }

  const nodes = projectFilter ? allNodes.filter((n) => n['projectId'] === projectFilter) : allNodes;
  const relations = projectFilter
    ? allRelations.filter((r) => r['projectId'] === projectFilter)
    : allRelations;

  let content: string;

  if (format === 'json') {
    content = JSON.stringify(
      {
        nodes: nodes.map((n) => ({
          id: n['id'],
          kind: n['kind'],
          label: n['label'],
          name: n['name'],
          filePath: n['filePath'],
          language: n['language'],
          isExported: n['isExported'],
          startLine: n['startLine'],
          endLine: n['endLine'],
          projectId: n['projectId'],
        })),
        edges: relations.map((r) => ({
          id: r['id'],
          source: r['sourceId'],
          target: r['targetId'],
          type: r['type'],
          confidence: r['confidence'],
          reason: r['reason'],
        })),
      },
      null,
      2,
    );
  } else if (format === 'gexf') {
    content = generateGexf(nodes, relations);
  } else {
    throw new Error(`Unknown format '${format}'. Supported: gexf, json`);
  }

  return { content, nodeCount: nodes.length, edgeCount: relations.length };
}
