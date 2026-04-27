/**
 * NEXUS symbol context query.
 *
 * Retrieves caller/callee relationships, community membership, and process
 * participation for a named code symbol. Used by `cleo nexus context`.
 *
 * @task T1473
 */

import path from 'node:path';
import { getNexusDb, nexusSchema } from '../store/nexus-sqlite.js';

/** Source code content fetched via smartUnfold. */
export interface NexusSourceContent {
  /** Extracted source text. */
  source: string;
  /** Start line (1-based). */
  startLine: number;
  /** End line (1-based). */
  endLine: number;
  /** Any parse errors encountered. */
  errors: string[];
}

/** A single caller or callee relationship entry. */
export interface NexusContextRelation {
  /** Relation type (calls, imports, accesses). */
  relationType: string;
  /** Node ID of the related symbol. */
  nodeId: unknown;
  /** Human-readable symbol name. */
  name: string;
  /** Node kind (function, method, class, …). */
  kind: string;
  /** Relative file path, or null. */
  filePath: unknown;
}

/** Process participation entry. */
export interface NexusContextProcess {
  /** Process node ID. */
  processId: unknown;
  /** Human-readable process label. */
  label: unknown;
  /** Role of this symbol in the process. */
  role: string;
  /** Step order within the process, or null. */
  step: unknown;
}

/** Context result for a single matching node. */
export interface NexusContextNode {
  /** Node ID. */
  nodeId: string;
  /** Symbol name. */
  name: unknown;
  /** Node kind. */
  kind: unknown;
  /** Relative file path. */
  filePath: unknown;
  /** Start line (1-based). */
  startLine: unknown;
  /** End line (1-based). */
  endLine: unknown;
  /** Whether the symbol is exported. */
  isExported: unknown;
  /** One-line doc summary (if present). */
  docSummary: unknown;
  /** Community membership, or null. */
  community: { id: string | null; label: unknown } | null;
  /** Incoming call/import edges (callers). */
  callers: NexusContextRelation[];
  /** Outgoing call/import edges (callees). */
  callees: NexusContextRelation[];
  /** Process participation records. */
  processes: NexusContextProcess[];
  /** Source content (populated when opts.showContent is true). */
  source?: NexusSourceContent;
}

/** Options for {@link getSymbolContext}. */
export interface NexusContextOptions {
  /** Max callers/callees to return per symbol (default: 20). */
  limit?: number;
  /** When true, fetch source code via smartUnfold. */
  showContent?: boolean;
}

/** Result envelope for {@link getSymbolContext}. */
export interface NexusContextResult {
  /** Original symbol query. */
  query: string;
  /** Project ID. */
  projectId: string;
  /** Total matching nodes count. */
  matchCount: number;
  /** Per-node context entries (up to 5). */
  results: NexusContextNode[];
}

/**
 * Retrieve caller/callee context and process participation for a named symbol.
 *
 * Searches the nexus_nodes table for nodes whose `name` contains `symbolName`
 * (case-insensitive), then builds caller/callee lists from nexus_relations.
 * Returns up to 5 matching nodes with full context.
 *
 * Throws with code `E_NOT_FOUND` when no symbol matches.
 *
 * @param symbolName      - Symbol name to look up (partial match).
 * @param projectId       - Nexus project ID.
 * @param repoPath        - Absolute repository root path.
 * @param opts            - Query options.
 * @returns Resolved symbol context.
 *
 * @example
 * const ctx = await getSymbolContext('dispatchFromCli', projectId, repoPath);
 * console.log(ctx.results[0].callers.length);
 */
export async function getSymbolContext(
  symbolName: string,
  projectId: string,
  repoPath: string,
  opts: NexusContextOptions = {},
): Promise<NexusContextResult> {
  const limit = opts.limit ?? 20;
  const showContent = opts.showContent ?? false;

  const { sortMatchingNodes } = await import('./symbol-ranking.js');
  const db = await getNexusDb();

  let allNodes: Array<Record<string, unknown>> = [];
  try {
    allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
  } catch {
    allNodes = [];
  }

  const lowerSymbol = symbolName.toLowerCase();
  const rawMatchingNodes = allNodes.filter(
    (n) =>
      n['projectId'] === projectId &&
      n['name'] != null &&
      String(n['name']).toLowerCase().includes(lowerSymbol) &&
      n['kind'] !== 'community' &&
      n['kind'] !== 'process',
  );
  const matchingNodes = sortMatchingNodes(rawMatchingNodes, symbolName);

  if (matchingNodes.length === 0) {
    const err = new Error(`No symbol found matching '${symbolName}' in project ${projectId}`);
    (err as NodeJS.ErrnoException).code = 'E_NOT_FOUND';
    throw err;
  }

  let allRelations: Array<Record<string, unknown>> = [];
  try {
    allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
      Record<string, unknown>
    >;
  } catch {
    allRelations = [];
  }

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of allNodes) {
    nodeById.set(String(n['id']), n);
  }

  const results = await Promise.all(
    matchingNodes.slice(0, 5).map(async (node) => {
      const nodeId = String(node['id']);

      const incoming = allRelations
        .filter(
          (r) =>
            r['targetId'] === nodeId &&
            r['projectId'] === projectId &&
            (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses'),
        )
        .slice(0, limit)
        .map((r) => {
          const src = nodeById.get(String(r['sourceId']));
          return {
            relationType: String(r['type'] ?? ''),
            nodeId: r['sourceId'],
            name: String(src?.['name'] ?? r['sourceId']),
            kind: String(src?.['kind'] ?? 'unknown'),
            filePath: src?.['filePath'] ?? null,
          };
        });

      const outgoing = allRelations
        .filter(
          (r) =>
            r['sourceId'] === nodeId &&
            r['projectId'] === projectId &&
            (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses'),
        )
        .slice(0, limit)
        .map((r) => {
          const tgt = nodeById.get(String(r['targetId']));
          return {
            relationType: String(r['type'] ?? ''),
            nodeId: r['targetId'],
            name: String(tgt?.['name'] ?? r['targetId']),
            kind: String(tgt?.['kind'] ?? 'unknown'),
            filePath: tgt?.['filePath'] ?? null,
          };
        });

      const communityId = node['communityId'] as string | null;
      const community = communityId ? nodeById.get(communityId) : null;

      const processRelations = allRelations.filter(
        (r) =>
          r['sourceId'] === nodeId &&
          r['projectId'] === projectId &&
          (r['type'] === 'step_in_process' || r['type'] === 'entry_point_of'),
      );
      const processes = processRelations
        .map((r) => {
          const proc = nodeById.get(String(r['targetId']));
          return {
            processId: r['targetId'],
            label: proc?.['label'] ?? r['targetId'],
            role: r['type'] === 'entry_point_of' ? 'entry_point' : 'step',
            step: r['step'] ?? null,
          };
        })
        .filter((p) => p.label !== p.processId);

      let sourceContent: NexusSourceContent | undefined;
      if (showContent && node['filePath']) {
        try {
          const unfoldModule = await import('@cleocode/nexus/dist/src/code/unfold.js' as string);
          const smartUnfold = unfoldModule.smartUnfold as (
            filePath: string,
            symbolName: string,
            projectRoot?: string,
          ) => {
            found: boolean;
            source: string;
            startLine: number;
            endLine: number;
            errors: string[];
          };
          const absolutePath = path.resolve(repoPath, String(node['filePath']));
          const unfoldResult = smartUnfold(absolutePath, String(node['name']), repoPath);
          if (unfoldResult.found) {
            sourceContent = {
              source: unfoldResult.source,
              startLine: unfoldResult.startLine,
              endLine: unfoldResult.endLine,
              errors: unfoldResult.errors,
            };
          } else if (unfoldResult.errors.length > 0) {
            sourceContent = {
              source: '',
              startLine: 0,
              endLine: 0,
              errors: unfoldResult.errors,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sourceContent = { source: '', startLine: 0, endLine: 0, errors: [msg] };
        }
      }

      return {
        nodeId,
        name: node['name'],
        kind: node['kind'],
        filePath: node['filePath'],
        startLine: node['startLine'],
        endLine: node['endLine'],
        isExported: node['isExported'],
        docSummary: node['docSummary'],
        community: community
          ? {
              id: communityId,
              label: community['label'] != null ? String(community['label']) : null,
            }
          : communityId != null
            ? { id: communityId, label: null }
            : null,
        callers: incoming,
        callees: outgoing,
        processes,
        ...(sourceContent && { source: sourceContent }),
      };
    }),
  );

  return {
    query: symbolName,
    projectId,
    matchCount: matchingNodes.length,
    results,
  };
}
