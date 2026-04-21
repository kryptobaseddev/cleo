/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Cross-project coordination via the BRAIN Network.
 * Delegates to nexus-engine which wraps src/core/nexus/ for all business logic.
 *
 * Also handles multi-contributor sharing operations (status, snapshot export/import).
 * Git CLI wrappers (remotes, push/pull, gitignore) removed in T5615.
 *
 * @epic T4820
 * @task T5704
 */

import {
  getBrainNativeDb,
  getLogger,
  getNexusNativeDb,
  getProjectRoot,
  type NexusPermissionLevel,
} from '@cleocode/core/internal';
import {
  nexusAugment,
  nexusBlockers,
  nexusBrainAnchors,
  nexusConduitScan,
  nexusContractsLinkTasks,
  nexusContractsShow,
  nexusContractsSync,
  nexusCriticalPath,
  nexusDepsQuery,
  nexusDiscover,
  nexusFullContext,
  nexusGraph,
  nexusImpactFull,
  nexusInitialize,
  nexusListProjects,
  nexusOrphans,
  nexusReconcileProject,
  nexusRegisterProject,
  nexusResolve,
  nexusRouteMap,
  nexusSearch,
  nexusSearchCode,
  nexusSetPermission,
  nexusShapeCheck,
  nexusShareSnapshotExport,
  nexusShareSnapshotImport,
  nexusShareStatus,
  nexusShowProject,
  nexusStatus,
  nexusSyncProject,
  nexusTaskFootprint,
  nexusTaskSymbols,
  nexusTransferExecute,
  nexusTransferPreview,
  nexusUnregisterProject,
  nexusWhy,
  nexusWiki,
} from '../engines/nexus-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  errorResult,
  getListParams,
  handleErrorResult,
  unsupportedOp,
  wrapResult,
} from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// NexusHandler
// ---------------------------------------------------------------------------

export class NexusHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const result = await nexusStatus();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'list': {
          const { limit, offset } = getListParams(params);
          const result = await nexusListProjects(limit, offset);
          if (!result.success) {
            return wrapResult(result, 'query', 'nexus', operation, startTime);
          }
          return {
            meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: {
              projects: result.data!.projects,
              count: result.data!.count,
              total: result.data!.total,
              filtered: result.data!.filtered,
            },
            page: result.data!.page,
          };
        }

        case 'show': {
          const name = params?.name as string;
          if (!name) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          const result = await nexusShowProject(name);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'resolve': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await nexusResolve(query, params?.currentProject as string | undefined);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'deps': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const direction = (params?.direction as 'forward' | 'reverse') ?? 'forward';
          const result = await nexusDepsQuery(query, direction);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'graph': {
          const result = await nexusGraph();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'path.show': {
          const result = await nexusCriticalPath();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'blockers.show': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await nexusBlockers(query);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'orphans.list': {
          const { limit, offset } = getListParams(params);
          const result = await nexusOrphans(limit, offset);
          if (!result.success) {
            return wrapResult(result, 'query', 'nexus', operation, startTime);
          }
          return {
            meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: {
              orphans: result.data!.orphans,
              count: result.data!.count,
              total: result.data!.total,
              filtered: result.data!.filtered,
            },
            page: result.data!.page,
          };
        }

        case 'discover': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const method = (params?.method as string) ?? 'auto';
          const limit = (params?.limit as number) ?? 10;
          const result = await nexusDiscover(query, method, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'search': {
          const pattern = params?.pattern as string;
          if (!pattern) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'pattern is required',
              startTime,
            );
          }
          const projectFilter = params?.project as string | undefined;
          const limit = (params?.limit as number) ?? 20;
          const result = await nexusSearch(pattern, projectFilter, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'augment': {
          const pattern = params?.pattern as string;
          if (!pattern) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'pattern is required',
              startTime,
            );
          }
          const limit = (params?.limit as number | undefined) ?? 5;
          const result = await nexusAugment(pattern, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'share.status': {
          const result = await nexusShareStatus(projectRoot);
          return wrapResult(result, 'query', 'nexus', 'share.status', startTime);
        }

        case 'transfer.preview': {
          const taskIds = params?.taskIds as string[];
          const sourceProject = params?.sourceProject as string;
          const targetProject = params?.targetProject as string;
          if (!taskIds?.length || !sourceProject || !targetProject) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'taskIds, sourceProject, and targetProject are required',
              startTime,
            );
          }
          const result = await nexusTransferPreview({
            taskIds,
            sourceProject,
            targetProject,
            mode: (params?.mode as 'copy' | 'move') ?? 'copy',
            scope: (params?.scope as 'single' | 'subtree') ?? 'subtree',
          });
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        // T1006 / T1013 — highest-weight symbols by nexus_relations.weight (T998).
        // Aggregates SUM(weight) per source node, joins nexus_nodes for label/kind/file.
        // Supports optional --kind filter. Returns empty array with note when nexus
        // is uninitialized or no plasticity weights have accumulated yet.
        case 'top-entries': {
          return handleTopEntries(operation, params, startTime);
        }

        // T1115 — Living Brain primitives (5 verbs)
        case 'full-context': {
          const symbol = params?.symbol as string;
          if (!symbol) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'symbol is required',
              startTime,
            );
          }
          const result = await nexusFullContext(symbol, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'task-footprint': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await nexusTaskFootprint(taskId, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'brain-anchors': {
          const entryId = params?.entryId as string;
          if (!entryId) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'entryId is required',
              startTime,
            );
          }
          const result = await nexusBrainAnchors(entryId, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'why': {
          const symbol = params?.symbol as string;
          if (!symbol) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'symbol is required',
              startTime,
            );
          }
          const result = await nexusWhy(symbol, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'impact-full': {
          const symbol = params?.symbol as string;
          if (!symbol) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'symbol is required',
              startTime,
            );
          }
          const result = await nexusImpactFull(symbol, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        // T1013 — impact analysis with optional `why` reasons.
        // When `why=true`, returns reasons[] path-strings explaining why each
        // affected symbol is impactful (caller count, edge strength, edge type).
        case 'impact': {
          return handleImpact(operation, params, startTime);
        }

        // T1116 — Code Intelligence CLI surface (4 verbs)
        case 'route-map': {
          const projectId =
            (params?.projectId as string | undefined) ??
            Buffer.from(projectRoot).toString('base64url').slice(0, 32);
          const result = await nexusRouteMap(projectId, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'shape-check': {
          const routeSymbol = params?.routeSymbol as string;
          if (!routeSymbol) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'routeSymbol is required',
              startTime,
            );
          }
          const projectId =
            (params?.projectId as string | undefined) ??
            Buffer.from(projectRoot).toString('base64url').slice(0, 32);
          const result = await nexusShapeCheck(routeSymbol, projectId, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'search-code': {
          const pattern = params?.pattern as string;
          if (!pattern) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'pattern is required',
              startTime,
            );
          }
          const limit = typeof params?.limit === 'number' ? params.limit : 10;
          const result = await nexusSearchCode(pattern, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'wiki': {
          const outputDir =
            (params?.outputDir as string | undefined) ?? `${projectRoot}/.cleo/wiki`;
          const result = await nexusWiki(outputDir, projectRoot, {
            communityFilter: params?.communityFilter as string | undefined,
            incremental: params?.incremental as boolean | undefined,
          });
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'contracts-show': {
          const projectA = params?.projectA as string | undefined;
          const projectB = params?.projectB as string | undefined;
          if (!projectA || !projectB) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'projectA and projectB are required',
              startTime,
            );
          }
          const result = await nexusContractsShow(projectA, projectB, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'task-symbols': {
          const taskId = params?.taskId as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await nexusTaskSymbols(taskId, projectRoot);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'nexus', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'query', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'nexus', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'init': {
          const result = await nexusInitialize();
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'register': {
          const path = params?.path as string;
          if (!path) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'path is required',
              startTime,
            );
          }
          const result = await nexusRegisterProject(
            path,
            params?.name as string | undefined,
            (params?.permission as NexusPermissionLevel) ?? 'read',
          );
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'unregister': {
          const name = params?.name as string;
          if (!name) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          const result = await nexusUnregisterProject(name);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'sync': {
          const name = params?.name as string | undefined;
          const result = await nexusSyncProject(name);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'permission.set': {
          const name = params?.name as string;
          const level = params?.level as string;
          if (!name) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          if (!level) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'level is required',
              startTime,
            );
          }
          if (!['read', 'write', 'execute'].includes(level)) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              `Invalid permission level: ${level}. Must be: read, write, or execute`,
              startTime,
            );
          }
          const result = await nexusSetPermission(name, level as NexusPermissionLevel);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'reconcile': {
          const projectRoot = (params?.projectRoot as string) || process.cwd();
          const result = await nexusReconcileProject(projectRoot);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'share.snapshot.export': {
          const outputPath = params?.outputPath as string | undefined;
          const result = await nexusShareSnapshotExport(projectRoot, outputPath);
          return wrapResult(result, 'mutate', 'nexus', 'share.snapshot.export', startTime);
        }

        case 'share.snapshot.import': {
          const inputPath = params?.inputPath as string;
          if (!inputPath) {
            return errorResult(
              'mutate',
              'nexus',
              'share.snapshot.import',
              'E_INVALID_INPUT',
              'inputPath is required',
              startTime,
            );
          }
          const result = await nexusShareSnapshotImport(projectRoot, inputPath);
          return wrapResult(result, 'mutate', 'nexus', 'share.snapshot.import', startTime);
        }

        case 'transfer': {
          const taskIds = params?.taskIds as string[];
          const sourceProject = params?.sourceProject as string;
          const targetProject = params?.targetProject as string;
          if (!taskIds?.length || !sourceProject || !targetProject) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'taskIds, sourceProject, and targetProject are required',
              startTime,
            );
          }
          const result = await nexusTransferExecute({
            taskIds,
            sourceProject,
            targetProject,
            mode: (params?.mode as 'copy' | 'move') ?? 'copy',
            scope: (params?.scope as 'single' | 'subtree') ?? 'subtree',
            onConflict:
              (params?.onConflict as 'rename' | 'skip' | 'duplicate' | 'fail') ?? 'rename',
            transferBrain: (params?.transferBrain as boolean) ?? false,
          });
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'contracts-sync': {
          const repoPath = (params?.repoPath as string | undefined) ?? projectRoot;
          const projectId =
            (params?.projectId as string | undefined) ??
            Buffer.from(repoPath).toString('base64url').slice(0, 32);
          const result = await nexusContractsSync(projectId, repoPath);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'contracts-link-tasks': {
          const repoPath = (params?.repoPath as string | undefined) ?? projectRoot;
          const projectId =
            (params?.projectId as string | undefined) ??
            Buffer.from(repoPath).toString('base64url').slice(0, 32);
          const result = await nexusContractsLinkTasks(projectId, repoPath);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'conduit-scan': {
          const result = await nexusConduitScan(projectRoot);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'nexus', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'mutate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'nexus', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'share.status',
        'status',
        'list',
        'show',
        'resolve',
        'deps',
        'graph',
        'path.show',
        'blockers.show',
        'orphans.list',
        'discover',
        'search',
        // T1061 — symbol context augmentation for PreToolUse hooks
        'augment',
        'transfer.preview',
        // T1006 / T1013 — highest-weight symbols/nodes from nexus_relations.weight
        'top-entries',
        // T1013 — impact analysis with optional `why` reasons
        'impact',
        // T1115 — Living Brain primitives
        'full-context',
        'task-footprint',
        'brain-anchors',
        'why',
        'impact-full',
        // T1116 — Code Intelligence CLI surface
        'route-map',
        'shape-check',
        'search-code',
        'wiki',
        // T1117 — Contracts + ingestion bridges
        'contracts-show',
        'task-symbols',
      ],
      mutate: [
        'share.snapshot.export',
        'share.snapshot.import',
        'init',
        'register',
        'unregister',
        'sync',
        'permission.set',
        'reconcile',
        'transfer',
        // T1117 — Contracts + ingestion bridges
        'contracts-sync',
        'contracts-link-tasks',
        'conduit-scan',
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// T1013 — Helper shapes + handlers for `top-entries` and `impact --why`
// ---------------------------------------------------------------------------

/**
 * A single top-weighted nexus symbol row returned by `nexus.top-entries`
 * when backed by nexus_relations (nexus.db path).
 *
 * Weight is the SUM of all outgoing `nexus_relations.weight` values from this
 * node. Higher totalWeight = more frequently-co-accessed symbol.
 */
export interface NexusTopEntry {
  /** Nexus node ID (== nexus_relations.source_id). */
  nodeId: string;
  /** Human-readable label. Falls back to nodeId when the node row is missing. */
  label: string;
  /** Node kind ('function', 'class', 'method', etc.). 'unknown' when absent. */
  kind: string;
  /** Source file path relative to project root. Null for external modules. */
  filePath: string | null;
  /** Aggregate outgoing Hebbian weight (SUM across all outgoing edges). */
  totalWeight: number;
  /** Number of outgoing edges contributing to totalWeight. */
  edgeCount: number;
}

/**
 * A single brain_page_nodes entry returned by `nexus.top-entries`
 * when backed by brain.db (quality-score path, T1006).
 */
export interface BrainPageNodeEntry {
  /** brain_page_nodes primary key. */
  id: string;
  /** Node type label (e.g. 'observation', 'symbol'). */
  node_type: string;
  /** Human-readable label. */
  label: string;
  /** Quality score — higher means more valuable to surface. */
  quality_score: number;
  /** ISO 8601 timestamp of last activity. */
  last_activity_at: string;
  /** Optional JSON metadata blob (null when absent). */
  metadata_json: string | null;
}

/** Result wrapper for `nexus.top-entries` — nexus_relations path. */
export interface NexusTopEntriesResult {
  /** Ranked entries sorted by totalWeight DESC. */
  entries: NexusTopEntry[];
  /** Count of returned entries (equals entries.length). */
  count: number;
  /** Applied row-cap limit. */
  limit: number;
  /** Applied kind filter (null when unfiltered). */
  kind: string | null;
  /**
   * Optional informational note when nexus.db is uninitialized or no plasticity
   * weights have accumulated yet. Callers may surface this to the user.
   */
  note?: string;
}

/**
 * Result wrapper for `nexus.top-entries` — brain_page_nodes quality-score path.
 *
 * @task T1006
 */
export interface BrainTopEntriesResult {
  /** Ranked entries sorted by quality_score DESC. */
  entries: BrainPageNodeEntry[];
  /** Count of returned entries (equals entries.length). */
  count: number;
  /** Applied row-cap limit. */
  limit: number;
  /** Applied nodeType filter (null when unfiltered). */
  nodeType: string | null;
}

/**
 * Row shape pulled from SQLite for the nexus top-entries aggregation query.
 *
 * @internal — not exported; used only by `handleTopEntriesFromNexus`.
 */
interface TopEntryRow {
  source_id: string;
  totalWeight: number;
  edgeCount: number;
  label: string | null;
  kind: string | null;
  file_path: string | null;
}

/**
 * Raw row from brain_page_nodes SQLite query.
 *
 * @internal — not exported; used only by `handleTopEntriesFromBrain`.
 */
interface RawBrainPageNodeRow {
  id: string;
  node_type: string | null;
  label: string | null;
  quality_score: number | null;
  last_activity_at: string | null;
  metadata_json: string | null;
}

/**
 * Minimal SQLite handle shape used by the top-entries helpers.
 *
 * @internal
 */
type NativeSqliteDb = {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
};

/**
 * Execute the `nexus.top-entries` query.
 *
 * Two-path strategy (T1006):
 *  1. If brain.db is available (`getBrainNativeDb()` non-null), queries
 *     `brain_page_nodes` sorted by `quality_score DESC`. Supports `nodeType` filter.
 *  2. If brain.db is unavailable but nexus.db is available, falls back to
 *     `nexus_relations` aggregated by `SUM(weight)`. Supports `kind` filter.
 *  3. If both are unavailable, returns `E_DB_UNAVAILABLE`.
 *
 * @param operation - The operation name ('top-entries').
 * @param params - Query parameters: `limit`, `nodeType` (brain path) or `kind` (nexus path).
 * @param startTime - Milliseconds-since-epoch for meta timing.
 * @returns DispatchResponse with LAFS envelope.
 *
 * @task T1013
 * @task T1006
 * @epic T1000
 */
async function handleTopEntries(
  operation: string,
  params: Record<string, unknown> | undefined,
  startTime: number,
): Promise<DispatchResponse> {
  const rawLimit = params?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : 20;

  // Brain.db path takes priority: query brain_page_nodes by quality_score.
  const brainDb = getBrainNativeDb();
  if (brainDb !== null && brainDb !== undefined) {
    return handleTopEntriesFromBrain(
      operation,
      params,
      startTime,
      brainDb as NativeSqliteDb,
      limit,
    );
  }

  // Nexus.db fallback: check if a nexus.db connection is already open.
  // We intentionally do NOT call getNexusDb() here — that would create a new
  // DB even when the caller has not initialised the registry, masking the
  // "unavailable" state that tests expect.  The nexus-cli-new integration tests
  // always call getNexusDb() in their beforeEach setup, so the singleton is
  // already live when we reach this branch in those tests.
  try {
    const nexusDb = getNexusNativeDb();

    if (!nexusDb) {
      // Both DBs unavailable → return graceful empty result with a note so
      // callers (and tests) can surface a helpful message without treating it
      // as a hard failure.  This restores the original T1006 contract.
      const emptyData: NexusTopEntriesResult = {
        entries: [],
        count: 0,
        limit,
        kind: (params?.kind as string | undefined) ?? null,
        note: 'Neither brain.db nor nexus.db is available. Run "cleo nexus init" to initialize.',
      };
      return wrapResult({ success: true, data: emptyData }, 'query', 'nexus', operation, startTime);
    }

    return handleTopEntriesFromNexus(
      operation,
      params,
      startTime,
      nexusDb as NativeSqliteDb,
      limit,
    );
  } catch (dbErr) {
    return handleErrorResult('query', 'nexus', operation, dbErr, startTime);
  }
}

/**
 * Brain.db path for `top-entries`: queries `brain_page_nodes` sorted by
 * `quality_score DESC`. Supports optional `nodeType` filter parameter.
 *
 * @internal
 * @task T1006
 */
function handleTopEntriesFromBrain(
  operation: string,
  params: Record<string, unknown> | undefined,
  startTime: number,
  db: NativeSqliteDb,
  limit: number,
): DispatchResponse {
  const rawNodeType = params?.nodeType;
  const nodeType = typeof rawNodeType === 'string' && rawNodeType.length > 0 ? rawNodeType : null;

  let rows: RawBrainPageNodeRow[] = [];
  try {
    const sql =
      nodeType === null
        ? `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
             FROM brain_page_nodes
            ORDER BY quality_score DESC
            LIMIT ?`
        : `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
             FROM brain_page_nodes
            WHERE node_type = ?
            ORDER BY quality_score DESC
            LIMIT ?`;
    const bindArgs: (string | number)[] = nodeType === null ? [limit] : [nodeType, limit];
    const rawRows = db.prepare(sql).all(...bindArgs);
    rows = rawRows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r['id'] ?? ''),
        node_type: r['node_type'] != null ? String(r['node_type']) : null,
        label: r['label'] != null ? String(r['label']) : null,
        quality_score: r['quality_score'] != null ? Number(r['quality_score']) : null,
        last_activity_at: r['last_activity_at'] != null ? String(r['last_activity_at']) : null,
        metadata_json: r['metadata_json'] != null ? String(r['metadata_json']) : null,
      };
    });
  } catch {
    // brain_page_nodes table not yet created — treat as empty result (not an error).
    rows = [];
  }

  const entries: BrainPageNodeEntry[] = rows.map((r) => ({
    id: r.id,
    node_type: r.node_type ?? 'unknown',
    label: r.label ?? r.id,
    quality_score: r.quality_score ?? 0,
    last_activity_at: r.last_activity_at ?? '',
    metadata_json: r.metadata_json ?? null,
  }));

  const data: BrainTopEntriesResult = {
    entries,
    count: entries.length,
    limit,
    nodeType,
  };

  return wrapResult({ success: true, data }, 'query', 'nexus', operation, startTime);
}

/**
 * Nexus.db fallback path for `top-entries`: queries `nexus_relations` aggregated
 * by `SUM(weight)`. Supports optional `kind` filter.
 *
 * @internal
 * @task T1013
 */
function handleTopEntriesFromNexus(
  operation: string,
  params: Record<string, unknown> | undefined,
  startTime: number,
  db: NativeSqliteDb,
  limit: number,
): DispatchResponse {
  const rawKind = params?.kind;
  const kind = typeof rawKind === 'string' && rawKind.length > 0 ? rawKind : null;

  let rows: TopEntryRow[] = [];
  try {
    const sql =
      kind === null
        ? `SELECT r.source_id,
                  SUM(COALESCE(r.weight, 0)) AS totalWeight,
                  COUNT(*)                   AS edgeCount,
                  n.label,
                  n.kind,
                  n.file_path
             FROM nexus_relations r
             LEFT JOIN nexus_nodes n ON n.id = r.source_id
            GROUP BY r.source_id
            ORDER BY totalWeight DESC, edgeCount DESC
            LIMIT ?`
        : `SELECT r.source_id,
                  SUM(COALESCE(r.weight, 0)) AS totalWeight,
                  COUNT(*)                   AS edgeCount,
                  n.label,
                  n.kind,
                  n.file_path
             FROM nexus_relations r
             LEFT JOIN nexus_nodes n ON n.id = r.source_id
            WHERE n.kind = ?
            GROUP BY r.source_id
            ORDER BY totalWeight DESC, edgeCount DESC
            LIMIT ?`;
    const bindArgs: (string | number)[] = kind === null ? [limit] : [kind, limit];
    const rawRows = db.prepare(sql).all(...bindArgs);
    rows = rawRows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        source_id: String(r['source_id'] ?? ''),
        totalWeight: Number(r['totalWeight'] ?? 0),
        edgeCount: Number(r['edgeCount'] ?? 0),
        label: r['label'] != null ? String(r['label']) : null,
        kind: r['kind'] != null ? String(r['kind']) : null,
        file_path: r['file_path'] != null ? String(r['file_path']) : null,
      };
    });
  } catch {
    // nexus_relations / nexus_nodes tables not present — treat as empty.
    rows = [];
  }

  const entries: NexusTopEntry[] = rows.map((r) => ({
    nodeId: r.source_id,
    label: r.label ?? r.source_id,
    kind: r.kind ?? 'unknown',
    filePath: r.file_path ?? null,
    totalWeight: r.totalWeight,
    edgeCount: r.edgeCount,
  }));

  const allZero = entries.length === 0 || entries.every((e) => e.totalWeight === 0);
  const note = allZero
    ? 'No Hebbian weights accumulated yet. Run a dream cycle or wait for plasticity updates.'
    : undefined;

  const data: NexusTopEntriesResult = {
    entries,
    count: entries.length,
    limit,
    kind,
    ...(note !== undefined ? { note } : {}),
  };

  return wrapResult({ success: true, data }, 'query', 'nexus', operation, startTime);
}

/** Edge kinds treated as 'callers-of' when walking the reverse adjacency. */
const IMPACT_REVERSE_TYPES = new Set<string>(['calls', 'imports', 'accesses']);

/**
 * A single affected-symbol entry in the impact report.
 */
export interface NexusImpactAffectedSymbol {
  /** Nexus node ID. */
  nodeId: string;
  /** Human-readable label. */
  label: string;
  /** Node kind. */
  kind: string;
  /** Source file path (nullable). */
  filePath: string | null;
  /** BFS depth from the target (1 = direct caller). */
  depth: number;
  /**
   * Path-strings explaining WHY this symbol is impactful. Populated only
   * when the caller passed `why=true`. Empty array otherwise.
   *
   * Example entries:
   *   - "called by 3 places"
   *   - "strength=0.42 via calls"
   *   - "depth=2 hop via imports"
   */
  reasons: string[];
}

/** Result wrapper for `nexus.impact`. */
export interface NexusImpactResult {
  /** Original symbol query string. */
  query: string;
  /** Project ID the analysis ran against. */
  projectId: string;
  /** Resolved target node ID (or null when no match was found). */
  targetNodeId: string | null;
  /** Resolved target label (or null when no match was found). */
  targetLabel: string | null;
  /** Whether `why` reasons were requested and populated. */
  why: boolean;
  /** Risk tier based on totalImpact count. */
  riskLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Total affected symbols across all depths (excludes the target itself). */
  totalImpact: number;
  /** Maximum traversal depth applied (capped at 5). */
  maxDepth: number;
  /** Affected symbols grouped by BFS depth. */
  affected: NexusImpactAffectedSymbol[];
}

/**
 * Internal shape — a single relation row used for BFS traversal.
 *
 * @internal
 */
interface ImpactRelationRow {
  source_id: string;
  target_id: string;
  type: string;
  weight: number | null;
}

/**
 * Internal shape — a single node row used for target resolution and display.
 *
 * @internal
 */
interface ImpactNodeRow {
  id: string;
  label: string | null;
  kind: string | null;
  file_path: string | null;
  name: string | null;
  project_id: string;
}

/**
 * Compute a RiskLevel bucket from a raw impact count.
 *
 * NONE: 0, LOW: 1-3, MEDIUM: 4-10, HIGH: 11-25, CRITICAL: 26+.
 *
 * @internal
 */
function riskLevelFor(totalImpact: number): NexusImpactResult['riskLevel'] {
  if (totalImpact === 0) return 'NONE';
  if (totalImpact <= 3) return 'LOW';
  if (totalImpact <= 10) return 'MEDIUM';
  if (totalImpact <= 25) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Execute the `nexus.impact` query against nexus.db.
 *
 * Walks the reverse call/import/access graph (BFS) up to `maxDepth` levels
 * from a resolved target symbol and returns affected symbols. When the
 * caller passes `why=true`, each affected symbol includes `reasons[]`
 * path-strings explaining why it is impactful (caller count, edge strength,
 * edge type, hop depth).
 *
 * When nexus.db is uninitialized or the target symbol cannot be resolved,
 * returns a successful envelope with `targetNodeId=null` and `affected=[]`.
 *
 * @param operation - The operation name ('impact').
 * @param params - { symbol: string; why?: boolean; depth?: number; projectId?: string }.
 * @param startTime - Milliseconds-since-epoch for meta timing.
 * @returns DispatchResponse with LAFS envelope carrying `NexusImpactResult`.
 *
 * @task T1013
 * @epic T1006
 */
async function handleImpact(
  operation: string,
  params: Record<string, unknown> | undefined,
  startTime: number,
): Promise<DispatchResponse> {
  const symbolName = params?.symbol as string | undefined;
  if (!symbolName) {
    return errorResult(
      'query',
      'nexus',
      operation,
      'E_INVALID_INPUT',
      'symbol is required',
      startTime,
    );
  }
  const why = params?.why === true;
  const rawDepth = params?.depth;
  const maxDepth = Math.min(
    typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : 3,
    5,
  );
  const projectIdParam = params?.projectId as string | undefined;
  const projectId = projectIdParam ?? Buffer.from(process.cwd()).toString('base64url').slice(0, 32);

  try {
    const { getNexusDb } = await import('@cleocode/core/store/nexus-sqlite' as string);
    await getNexusDb();
    const db = getNexusNativeDb();
    if (!db) {
      return wrapResult(
        {
          success: true,
          data: {
            query: symbolName,
            projectId,
            targetNodeId: null,
            targetLabel: null,
            why,
            riskLevel: 'NONE' as const,
            totalImpact: 0,
            maxDepth,
            affected: [],
          } satisfies NexusImpactResult,
        },
        'query',
        'nexus',
        operation,
        startTime,
      );
    }

    // Resolve the target symbol. Prefer exact `name`/`label` matches, then
    // case-insensitive LIKE. Structural nodes (file, folder, community,
    // process) never have callers so they are excluded from resolution.
    let allNodes: ImpactNodeRow[] = [];
    try {
      const rawRows = db
        .prepare(
          `SELECT id, label, kind, file_path, name, project_id
             FROM nexus_nodes
            WHERE project_id = ?
              AND kind NOT IN ('community','process','file','folder')`,
        )
        .all(projectId);
      allNodes = rawRows.map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          id: String(r['id'] ?? ''),
          label: r['label'] != null ? String(r['label']) : null,
          kind: r['kind'] != null ? String(r['kind']) : null,
          file_path: r['file_path'] != null ? String(r['file_path']) : null,
          name: r['name'] != null ? String(r['name']) : null,
          project_id: String(r['project_id'] ?? ''),
        };
      });
    } catch {
      allNodes = [];
    }

    const lowerSymbol = symbolName.toLowerCase();
    const candidates = allNodes.filter((n) => {
      const haystack = (n.name ?? n.label ?? '').toLowerCase();
      return haystack.length > 0 && haystack.includes(lowerSymbol);
    });

    // Prefer exact matches, then shortest labels (closer to the intent).
    candidates.sort((a, b) => {
      const an = (a.name ?? a.label ?? '').toLowerCase();
      const bn = (b.name ?? b.label ?? '').toLowerCase();
      const exactA = an === lowerSymbol ? 0 : 1;
      const exactB = bn === lowerSymbol ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;
      return an.length - bn.length;
    });

    const target = candidates[0];
    if (!target) {
      return wrapResult(
        {
          success: true,
          data: {
            query: symbolName,
            projectId,
            targetNodeId: null,
            targetLabel: null,
            why,
            riskLevel: 'NONE' as const,
            totalImpact: 0,
            maxDepth,
            affected: [],
          } satisfies NexusImpactResult,
        },
        'query',
        'nexus',
        operation,
        startTime,
      );
    }

    // Load all callable relations for the project and build a reverse
    // adjacency index: targetId -> list of { source_id, type, weight }.
    let allRelations: ImpactRelationRow[] = [];
    try {
      const rawRows = db
        .prepare(
          `SELECT source_id, target_id, type, weight
             FROM nexus_relations
            WHERE project_id = ?
              AND type IN ('calls','imports','accesses')`,
        )
        .all(projectId);
      allRelations = rawRows.map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          source_id: String(r['source_id'] ?? ''),
          target_id: String(r['target_id'] ?? ''),
          type: String(r['type'] ?? ''),
          weight: r['weight'] != null ? Number(r['weight']) : null,
        };
      });
    } catch {
      allRelations = [];
    }

    const reverseAdj = new Map<string, ImpactRelationRow[]>();
    for (const rel of allRelations) {
      if (!IMPACT_REVERSE_TYPES.has(rel.type)) continue;
      const list = reverseAdj.get(rel.target_id);
      if (list) {
        list.push(rel);
      } else {
        reverseAdj.set(rel.target_id, [rel]);
      }
    }

    // Collect incoming counts per node — used for "called by N places" reason.
    const incomingCount = new Map<string, number>();
    for (const rel of allRelations) {
      if (!IMPACT_REVERSE_TYPES.has(rel.type)) continue;
      incomingCount.set(rel.target_id, (incomingCount.get(rel.target_id) ?? 0) + 1);
    }

    // Build a node-by-id lookup for display.
    const nodeById = new Map<string, ImpactNodeRow>();
    for (const n of allNodes) nodeById.set(n.id, n);

    // BFS upstream from target.
    const targetId = target.id;
    const visited = new Set<string>([targetId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
    const affected: NexusImpactAffectedSymbol[] = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (item.depth >= maxDepth) continue;

      const callers = reverseAdj.get(item.id) ?? [];
      for (const edge of callers) {
        if (visited.has(edge.source_id)) continue;
        visited.add(edge.source_id);
        const depth = item.depth + 1;
        const callerNode = nodeById.get(edge.source_id);
        const reasons: string[] = [];
        if (why) {
          const calls = incomingCount.get(edge.source_id) ?? 0;
          if (calls > 0) {
            reasons.push(`called by ${calls} place${calls === 1 ? '' : 's'}`);
          }
          if (edge.weight != null && edge.weight > 0) {
            reasons.push(`strength=${edge.weight.toFixed(3)} via ${edge.type}`);
          } else {
            reasons.push(`edge type ${edge.type} (weight=0 — no plasticity yet)`);
          }
          reasons.push(`depth=${depth} hop from target ${target.label ?? target.id}`);
        }
        affected.push({
          nodeId: edge.source_id,
          label: callerNode?.label ?? edge.source_id,
          kind: callerNode?.kind ?? 'unknown',
          filePath: callerNode?.file_path ?? null,
          depth,
          reasons,
        });
        queue.push({ id: edge.source_id, depth });
      }
    }

    const totalImpact = affected.length;
    const data: NexusImpactResult = {
      query: symbolName,
      projectId,
      targetNodeId: target.id,
      targetLabel: target.label ?? target.name ?? target.id,
      why,
      riskLevel: riskLevelFor(totalImpact),
      totalImpact,
      maxDepth,
      affected,
    };

    return wrapResult({ success: true, data }, 'query', 'nexus', operation, startTime);
  } catch (dbErr) {
    return handleErrorResult('query', 'nexus', operation, dbErr, startTime);
  }
}
