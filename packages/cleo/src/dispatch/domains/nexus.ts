/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Cross-project coordination via the BRAIN Network.
 * Delegates to nexus-engine which wraps src/core/nexus/ for all business logic.
 *
 * Also handles multi-contributor sharing operations (status, snapshot export/import).
 * Git CLI wrappers (remotes, push/pull, gitignore) removed in T5615.
 *
 * All operations are type-safe via TypedDomainHandler<NexusOps> (T1424 — Wave D
 * typed-dispatch migration). Zero `as string` / `as any` param casts at call sites.
 *
 * Param extraction is type-safe via OpsFromCore<typeof coreNexus.nexusCoreOps>.
 * Zero per-op contract param type imports (T1440).
 *
 * @epic T4820
 * @task T5704
 * @task T1424 — typed-dispatch narrowing (T988 follow-on)
 * @task T1440 — Core-derived OpsFromCore inference
 */

import type { nexus as coreNexus } from '@cleocode/core';
import {
  getBrainNativeDb,
  getLogger,
  getNexusNativeDb,
  getProjectRoot,
  type NexusPermissionLevel,
  nexusAugment,
  nexusBlockers,
  nexusBrainAnchors,
  nexusClusters,
  nexusColdSymbols,
  nexusConduitScan,
  nexusContext,
  nexusContractsLinkTasks,
  nexusContractsShow,
  nexusContractsSync,
  nexusCriticalPath,
  nexusDepsQuery,
  nexusDiff,
  nexusDiscover,
  nexusFlows,
  nexusFullContext,
  nexusGraph,
  nexusHotNodes,
  nexusHotPaths,
  nexusImpact,
  nexusImpactFull,
  nexusInitialize,
  nexusListProjects,
  nexusOrphans,
  nexusProfileExport,
  nexusProfileGet,
  nexusProfileImport,
  nexusProfileReinforce,
  nexusProfileSupersede,
  nexusProfileUpsert,
  nexusProfileView,
  nexusProjectsClean,
  nexusProjectsList,
  nexusProjectsRegister,
  nexusProjectsRemove,
  nexusProjectsScan,
  nexusQueryCte,
  nexusReconcileProject,
  nexusRefreshBridge,
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
  nexusSigilList,
  nexusSigilSync,
  nexusStatus,
  nexusSyncProject,
  nexusTaskFootprint,
  nexusTaskSymbols,
  nexusTopEntries,
  nexusTransferExecute,
  nexusTransferPreview,
  nexusUnregisterProject,
  nexusWhy,
  nexusWiki,
} from '@cleocode/core/internal';
import { stampNexusMeta } from '@cleocode/runtime/gateway';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
  wrapCoreResult,
} from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  envelopeToEngineResult,
  errorResult,
  handleErrorResult,
  unsupportedOp,
  wrapResult,
} from './_base.js';

// ---------------------------------------------------------------------------
// Core-derived operation type (T1440 — OpsFromCore inference)
//
// NexusOps is inferred from Core signatures via OpsFromCore so that the
// type source lives in Core, not in a hand-maintained contract import list.
// ---------------------------------------------------------------------------

type NexusOps = OpsFromCore<typeof coreNexus.nexusCoreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (T1424 — Wave D typed-dispatch migration)
// ---------------------------------------------------------------------------

const _nexusTypedHandler = defineTypedHandler<NexusOps>('nexus', {
  // -------------------------------------------------------------------------
  // Query ops (30)
  // -------------------------------------------------------------------------

  status: async (_params) => wrapCoreResult(await nexusStatus(), 'status'),

  list: async (params) => {
    const result = await nexusListProjects(params.limit, params.offset);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'list',
      );
    }
    // SSoT-EXEMPT:page-envelope-lifting — engine puts page in data.page; lift to
    // envelope top-level and strip from data to preserve pre-T1424 contract shape.
    const data = result.data as {
      projects: unknown;
      count: number;
      total: number;
      filtered: number;
      page?: unknown;
    };
    return lafsSuccess(
      { projects: data.projects, count: data.count, total: data.total, filtered: data.filtered },
      'list',
      { page: (data.page ?? result.page) as import('@cleocode/contracts').LAFSPage | undefined },
    );
  },

  show: async (params) => {
    if (!params.name) return lafsError('E_INVALID_INPUT', 'name is required', 'show');
    return wrapCoreResult(await nexusShowProject(params.name), 'show');
  },

  resolve: async (params) => {
    if (!params.query) return lafsError('E_INVALID_INPUT', 'query is required', 'resolve');
    return wrapCoreResult(await nexusResolve(params.query, params.currentProject), 'resolve');
  },

  deps: async (params) => {
    if (!params.query) return lafsError('E_INVALID_INPUT', 'query is required', 'deps');
    return wrapCoreResult(
      await nexusDepsQuery(params.query, params.direction ?? 'forward'),
      'deps',
    );
  },

  graph: async (_params) => wrapCoreResult(await nexusGraph(), 'graph'),

  'path.show': async (_params) => wrapCoreResult(await nexusCriticalPath(), 'path.show'),

  'blockers.show': async (params) => {
    if (!params.query) return lafsError('E_INVALID_INPUT', 'query is required', 'blockers.show');
    return wrapCoreResult(await nexusBlockers(params.query), 'blockers.show');
  },

  'orphans.list': async (params) => {
    const result = await nexusOrphans(params.limit, params.offset);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'orphans.list',
      );
    }
    // SSoT-EXEMPT:page-envelope-lifting — same contract as nexus.list
    const data = result.data as {
      orphans: unknown;
      count: number;
      total: number;
      filtered: number;
      page?: unknown;
    };
    return lafsSuccess(
      { orphans: data.orphans, count: data.count, total: data.total, filtered: data.filtered },
      'orphans.list',
      { page: (data.page ?? result.page) as import('@cleocode/contracts').LAFSPage | undefined },
    );
  },

  discover: async (params) => {
    if (!params.query) return lafsError('E_INVALID_INPUT', 'query is required', 'discover');
    return wrapCoreResult(
      await nexusDiscover(params.query, params.method ?? 'auto', params.limit ?? 10),
      'discover',
    );
  },

  search: async (params) => {
    if (!params.pattern) return lafsError('E_INVALID_INPUT', 'pattern is required', 'search');
    return wrapCoreResult(
      await nexusSearch(params.pattern, params.project, params.limit ?? 20),
      'search',
    );
  },

  augment: async (params) => {
    if (!params.pattern) return lafsError('E_INVALID_INPUT', 'pattern is required', 'augment');
    return wrapCoreResult(await nexusAugment(params.pattern, params.limit ?? 5), 'augment');
  },

  'share.status': async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusShareStatus(projectRoot), 'share.status');
  },

  'transfer.preview': async (params) => {
    if (!params.taskIds?.length || !params.sourceProject || !params.targetProject) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskIds, sourceProject, and targetProject are required',
        'transfer.preview',
      );
    }
    return wrapCoreResult(
      await nexusTransferPreview({
        taskIds: params.taskIds,
        sourceProject: params.sourceProject,
        targetProject: params.targetProject,
        mode: params.mode ?? 'copy',
        scope: params.scope ?? 'subtree',
      }),
      'transfer.preview',
    );
  },

  'top-entries': async (params) =>
    wrapCoreResult(
      await nexusTopEntries({
        limit: params?.limit,
        kind: params?.kind,
        nodeType: params?.nodeType,
      }),
      'top-entries',
    ),

  impact: async (params) => {
    if (!params.symbol) return lafsError('E_INVALID_INPUT', 'symbol is required', 'impact');
    return wrapCoreResult(await nexusImpact(params.symbol, params.projectId, params.why), 'impact');
  },

  'full-context': async (params) => {
    if (!params.symbol) return lafsError('E_INVALID_INPUT', 'symbol is required', 'full-context');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusFullContext(params.symbol, projectRoot), 'full-context');
  },

  'task-footprint': async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'task-footprint');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusTaskFootprint(params.taskId, projectRoot), 'task-footprint');
  },

  'brain-anchors': async (params) => {
    if (!params.entryId)
      return lafsError('E_INVALID_INPUT', 'entryId is required', 'brain-anchors');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusBrainAnchors(params.entryId, projectRoot), 'brain-anchors');
  },

  why: async (params) => {
    if (!params.symbol) return lafsError('E_INVALID_INPUT', 'symbol is required', 'why');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusWhy(params.symbol, projectRoot), 'why');
  },

  'impact-full': async (params) => {
    if (!params.symbol) return lafsError('E_INVALID_INPUT', 'symbol is required', 'impact-full');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusImpactFull(params.symbol, projectRoot), 'impact-full');
  },

  'route-map': async (params) => {
    const projectRoot = getProjectRoot();
    const projectId =
      params.projectId ?? Buffer.from(projectRoot).toString('base64url').slice(0, 32);
    return wrapCoreResult(await nexusRouteMap(projectId, projectRoot), 'route-map');
  },

  'shape-check': async (params) => {
    if (!params.routeSymbol)
      return lafsError('E_INVALID_INPUT', 'routeSymbol is required', 'shape-check');
    const projectRoot = getProjectRoot();
    const projectId =
      params.projectId ?? Buffer.from(projectRoot).toString('base64url').slice(0, 32);
    return wrapCoreResult(
      await nexusShapeCheck(params.routeSymbol, projectId, projectRoot),
      'shape-check',
    );
  },

  'search-code': async (params) => {
    if (!params.pattern) return lafsError('E_INVALID_INPUT', 'pattern is required', 'search-code');
    return wrapCoreResult(await nexusSearchCode(params.pattern, params.limit ?? 10), 'search-code');
  },

  wiki: async (params) => {
    const projectRoot = getProjectRoot();
    const outputDir = params.outputDir ?? `${projectRoot}/.cleo/wiki`;
    // Argument order: (outputDir, projectRoot, options) — matches engine signature
    return wrapCoreResult(
      await nexusWiki(outputDir, projectRoot, {
        communityFilter: params.communityFilter,
        incremental: params.incremental,
      }),
      'wiki',
    );
  },

  'contracts-show': async (params) => {
    if (!params.projectA || !params.projectB)
      return lafsError('E_INVALID_INPUT', 'projectA and projectB are required', 'contracts-show');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await nexusContractsShow(params.projectA, params.projectB, projectRoot),
      'contracts-show',
    );
  },

  'task-symbols': async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'task-symbols');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusTaskSymbols(params.taskId, projectRoot), 'task-symbols');
  },

  'profile.view': async (params) =>
    wrapCoreResult(
      await nexusProfileView(params.minConfidence, params.includeSuperseded),
      'profile.view',
    ),

  'profile.get': async (params) => {
    if (!params.traitKey)
      return lafsError('E_INVALID_INPUT', 'traitKey is required', 'profile.get');
    return wrapCoreResult(await nexusProfileGet(params.traitKey), 'profile.get');
  },

  'sigil.list': async (params) => wrapCoreResult(await nexusSigilList(params.role), 'sigil.list'),

  // T1510 — Phase 2 query ops
  clusters: async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = (params.repoPath as string | undefined) ?? projectRoot;
    const projectId =
      (params.projectId as string | undefined) ??
      Buffer.from(repoPath).toString('base64url').slice(0, 32);
    return wrapCoreResult(await nexusClusters(projectId, repoPath), 'clusters');
  },

  flows: async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = (params.repoPath as string | undefined) ?? projectRoot;
    const projectId =
      (params.projectId as string | undefined) ??
      Buffer.from(repoPath).toString('base64url').slice(0, 32);
    return wrapCoreResult(await nexusFlows(projectId, repoPath), 'flows');
  },

  context: async (params) => {
    if (!params.symbol) return lafsError('E_INVALID_INPUT', 'symbol is required', 'context');
    const projectRoot = getProjectRoot();
    const projectId =
      (params.projectId as string | undefined) ??
      Buffer.from(projectRoot).toString('base64url').slice(0, 32);
    const limit = typeof params.limit === 'number' ? params.limit : 20;
    const showContent = params.content === true;
    return wrapCoreResult(
      await nexusContext(params.symbol as string, projectId, projectRoot, limit, showContent),
      'context',
    );
  },

  'projects.list': async (_params) => wrapCoreResult(await nexusProjectsList(), 'projects.list'),

  'projects.register': async (params) => {
    if (!params.path) return lafsError('E_INVALID_INPUT', 'path is required', 'projects.register');
    return wrapCoreResult(
      await nexusProjectsRegister(params.path as string, params.name as string | undefined),
      'projects.register',
    );
  },

  'projects.remove': async (params) => {
    if (!params.nameOrHash)
      return lafsError('E_INVALID_INPUT', 'nameOrHash is required', 'projects.remove');
    return wrapCoreResult(
      await nexusProjectsRemove(params.nameOrHash as string),
      'projects.remove',
    );
  },

  'projects.scan': async (params) =>
    wrapCoreResult(
      await nexusProjectsScan({
        roots: params.roots as string | undefined,
        maxDepth: typeof params.maxDepth === 'number' ? params.maxDepth : undefined,
        autoRegister: params.autoRegister === true,
        includeExisting: params.includeExisting === true,
      }),
      'projects.scan',
    ),

  'projects.clean': async (params) =>
    wrapCoreResult(
      await nexusProjectsClean({
        dryRun: params.dryRun === true,
        pattern: params.pattern as string | undefined,
        includeTemp: params.includeTemp === true,
        includeTests: params.includeTests === true,
        matchUnhealthy: params.matchUnhealthy === true,
        matchNeverIndexed: params.matchNeverIndexed === true,
        matchOrphaned: params.matchOrphaned === true,
        removeFs: params.removeFs === true,
        vacuum: params.vacuum === true,
      }),
      'projects.clean',
    ),

  'refresh-bridge': async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = (params.repoPath as string | undefined) ?? projectRoot;
    const projectId = params.projectId as string | undefined;
    return wrapCoreResult(await nexusRefreshBridge(repoPath, projectId), 'refresh-bridge');
  },

  diff: async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = (params.repoPath as string | undefined) ?? projectRoot;
    return wrapCoreResult(
      await nexusDiff(
        repoPath,
        params.beforeRef as string | undefined,
        params.afterRef as string | undefined,
        params.projectId as string | undefined,
      ),
      'diff',
    );
  },

  'query-cte': async (params) => {
    if (!params.cte) return lafsError('E_INVALID_INPUT', 'cte is required', 'query-cte');
    return wrapCoreResult(
      await nexusQueryCte(params.cte as string, params.params as string[] | undefined),
      'query-cte',
    );
  },

  'hot-paths': async (params) => {
    const projectRoot = getProjectRoot();
    const limit = typeof params.limit === 'number' ? params.limit : 20;
    return wrapCoreResult(await nexusHotPaths(projectRoot, limit), 'hot-paths');
  },

  'hot-nodes': async (params) => {
    const projectRoot = getProjectRoot();
    const limit = typeof params.limit === 'number' ? params.limit : 20;
    return wrapCoreResult(await nexusHotNodes(projectRoot, limit), 'hot-nodes');
  },

  'cold-symbols': async (params) => {
    const projectRoot = getProjectRoot();
    const days = typeof params.days === 'number' ? params.days : 30;
    return wrapCoreResult(await nexusColdSymbols(projectRoot, days), 'cold-symbols');
  },

  // -------------------------------------------------------------------------
  // Mutate ops (18)
  // -------------------------------------------------------------------------

  init: async (_params) => wrapCoreResult(await nexusInitialize(), 'init'),

  register: async (params) => {
    if (!params.path) return lafsError('E_INVALID_INPUT', 'path is required', 'register');
    return wrapCoreResult(
      await nexusRegisterProject(params.path, params.name, params.permission ?? 'read'),
      'register',
    );
  },

  unregister: async (params) => {
    if (!params.name) return lafsError('E_INVALID_INPUT', 'name is required', 'unregister');
    return wrapCoreResult(await nexusUnregisterProject(params.name), 'unregister');
  },

  sync: async (params) => wrapCoreResult(await nexusSyncProject(params.name), 'sync'),

  'permission.set': async (params) => {
    if (!params.name) return lafsError('E_INVALID_INPUT', 'name is required', 'permission.set');
    if (!params.level) return lafsError('E_INVALID_INPUT', 'level is required', 'permission.set');
    if (!['read', 'write', 'execute'].includes(params.level)) {
      return lafsError(
        'E_INVALID_INPUT',
        `Invalid permission level: ${params.level}. Must be: read, write, or execute`,
        'permission.set',
      );
    }
    return wrapCoreResult(
      await nexusSetPermission(params.name, params.level as NexusPermissionLevel),
      'permission.set',
    );
  },

  reconcile: async (params) =>
    wrapCoreResult(
      await nexusReconcileProject(params.projectRoot ?? getProjectRoot()),
      'reconcile',
    ),

  'share.snapshot.export': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await nexusShareSnapshotExport(projectRoot, params.outputPath),
      'share.snapshot.export',
    );
  },

  'share.snapshot.import': async (params) => {
    if (!params.inputPath)
      return lafsError('E_INVALID_INPUT', 'inputPath is required', 'share.snapshot.import');
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await nexusShareSnapshotImport(projectRoot, params.inputPath),
      'share.snapshot.import',
    );
  },

  transfer: async (params) => {
    if (!params.taskIds?.length || !params.sourceProject || !params.targetProject) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskIds, sourceProject, and targetProject are required',
        'transfer',
      );
    }
    return wrapCoreResult(
      await nexusTransferExecute({
        taskIds: params.taskIds,
        sourceProject: params.sourceProject,
        targetProject: params.targetProject,
        mode: params.mode ?? 'copy',
        scope: params.scope ?? 'subtree',
        onConflict: params.onConflict ?? 'rename',
        transferBrain: params.transferBrain ?? false,
      }),
      'transfer',
    );
  },

  'contracts-sync': async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = params.repoPath ?? projectRoot;
    const projectId = params.projectId ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    return wrapCoreResult(await nexusContractsSync(projectId, repoPath), 'contracts-sync');
  },

  'contracts-link-tasks': async (params) => {
    const projectRoot = getProjectRoot();
    const repoPath = params.repoPath ?? projectRoot;
    const projectId = params.projectId ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    return wrapCoreResult(
      await nexusContractsLinkTasks(projectId, repoPath),
      'contracts-link-tasks',
    );
  },

  'conduit-scan': async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await nexusConduitScan(projectRoot), 'conduit-scan');
  },

  'profile.import': async (params) =>
    wrapCoreResult(await nexusProfileImport(params.path), 'profile.import'),

  'profile.export': async (params) =>
    wrapCoreResult(await nexusProfileExport(params.path), 'profile.export'),

  'profile.reinforce': async (params) => {
    if (!params.traitKey)
      return lafsError('E_INVALID_INPUT', 'traitKey is required', 'profile.reinforce');
    return wrapCoreResult(
      await nexusProfileReinforce(params.traitKey, params.source),
      'profile.reinforce',
    );
  },

  'profile.upsert': async (params) => {
    if (!params.trait?.traitKey || !params.trait?.traitValue) {
      return lafsError(
        'E_INVALID_INPUT',
        'trait.traitKey and trait.traitValue are required',
        'profile.upsert',
      );
    }
    return wrapCoreResult(await nexusProfileUpsert(params.trait), 'profile.upsert');
  },

  'profile.supersede': async (params) => {
    if (!params.oldKey || !params.newKey)
      return lafsError('E_INVALID_INPUT', 'oldKey and newKey are required', 'profile.supersede');
    return wrapCoreResult(
      await nexusProfileSupersede(params.oldKey, params.newKey),
      'profile.supersede',
    );
  },

  'sigil.sync': async (_params) => wrapCoreResult(await nexusSigilSync(), 'sigil.sync'),
});

// ---------------------------------------------------------------------------
// NexusHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>([
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
  'augment',
  'transfer.preview',
  'top-entries',
  'impact',
  'full-context',
  'task-footprint',
  'brain-anchors',
  'why',
  'impact-full',
  'route-map',
  'shape-check',
  'search-code',
  'wiki',
  'contracts-show',
  'task-symbols',
  'profile.view',
  'profile.get',
  'sigil.list',
  // T1510 — Phase 2 query ops
  'clusters',
  'flows',
  'context',
  'projects.list',
  'diff',
  'query-cte',
  'hot-paths',
  'hot-nodes',
  'cold-symbols',
]);

const MUTATE_OPS = new Set<string>([
  'share.snapshot.export',
  'share.snapshot.import',
  'init',
  'register',
  'unregister',
  'sync',
  'permission.set',
  'reconcile',
  'transfer',
  'contracts-sync',
  'contracts-link-tasks',
  'conduit-scan',
  'profile.import',
  'profile.export',
  'profile.reinforce',
  'profile.upsert',
  'profile.supersede',
  'sigil.sync',
  // T1510 — Phase 2 mutate ops
  'projects.register',
  'projects.remove',
  'projects.scan',
  'projects.clean',
  'refresh-bridge',
]);

// ---------------------------------------------------------------------------
// Nexus envelope helpers (ADR-058 thin-handler T1492/P1-1)
//
// Extract typed-dispatch LafsEnvelope → DispatchResponse conversion into
// helpers so each branch in query/mutate methods is ≤5 LOC.
// SSoT-EXEMPT: page-envelope lifting — dual-source page extraction (envelope-
// level vs legacy data.page nesting) is a dispatch-layer concern.
// ---------------------------------------------------------------------------

/** Convert a nexus query envelope to DispatchResponse, lifting page metadata. */
function nexusQueryEnvelopeToResponse(
  envelope: unknown,
  operation: string,
  startTime: number,
): DispatchResponse {
  const env = envelope as {
    success: boolean;
    data?: unknown;
    page?: import('@cleocode/contracts').LAFSPage;
    error?: { code: string | number; message: string };
  };
  // Two page sources: envelope-level (preferred) or legacy data.page (fallback).
  let pageMetadata: import('@cleocode/contracts').LAFSPage | undefined = env.page;
  let resultData: unknown = env.data;
  if (!pageMetadata && env.success && resultData && typeof resultData === 'object') {
    const dataObj = resultData as Record<string, unknown>;
    if ('page' in dataObj && dataObj.page) {
      pageMetadata = dataObj.page as import('@cleocode/contracts').LAFSPage;
      const { page: _removed, ...cleanData } = dataObj;
      resultData = cleanData;
    }
  }
  return wrapResult(
    envelopeToEngineResult({
      success: env.success,
      data: resultData,
      page: pageMetadata,
      error: env.error,
    }),
    'query',
    'nexus',
    operation,
    startTime,
  );
}

/** Convert a nexus mutate envelope to DispatchResponse (no page lifting). */
function nexusMutateEnvelopeToResponse(
  envelope: unknown,
  operation: string,
  startTime: number,
): DispatchResponse {
  const env = envelope as {
    success: boolean;
    data?: unknown;
    error?: { code: string | number; message: string };
  };
  return wrapResult(
    envelopeToEngineResult({
      success: env.success,
      data: env.data,
      error: env.error,
    }),
    'mutate',
    'nexus',
    operation,
    startTime,
  );
}

/**
 * Domain handler for the `nexus` domain.
 *
 * Delegates all per-op logic to the typed inner handler `_nexusTypedHandler`
 * (a `TypedDomainHandler<NexusOps>`). This satisfies the registry's
 * `DomainHandler` interface while keeping every param access fully type-safe
 * via the T1424 Wave D adapter.
 *
 * @task T1424 — typed-dispatch narrowing (T988 follow-on)
 */
export class NexusHandler implements DomainHandler {
  /**
   * Execute a read-only nexus query operation.
   *
   * @param operation - The nexus query op name (e.g. 'status', 'list').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'nexus', operation, startTime);
    }

    // Complex multi-step ops bypass typed dispatch (they need startTime + raw
    // params for legacy DispatchResponse construction). Keep them in QUERY_OPS
    // + NexusOps for typed-key safety, but route to the OLD helper functions.
    if (operation === 'top-entries') {
      const r = await handleTopEntries(operation, params, startTime);
      return stampNexusMeta(r, operation, params ?? {});
    }
    if (operation === 'impact') {
      const r = await handleImpact(operation, params, startTime);
      return stampNexusMeta(r, operation, params ?? {});
    }

    try {
      // operation is validated above — cast to typed key is safe (ADR-058 trust boundary)
      const envelope = await typedDispatch(
        _nexusTypedHandler,
        operation as keyof NexusOps & string,
        params ?? {},
      );
      const response = nexusQueryEnvelopeToResponse(envelope, operation, startTime);
      return stampNexusMeta(response, operation, params ?? {});
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'query', domain: 'nexus', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'nexus', operation, error, startTime);
    }
  }

  /**
   * Execute a state-modifying nexus mutation operation.
   *
   * @param operation - The nexus mutate op name (e.g. 'init', 'register').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'nexus', operation, startTime);
    }

    try {
      // operation is validated above — cast to typed key is safe (ADR-058 trust boundary)
      const envelope = await typedDispatch(
        _nexusTypedHandler,
        operation as keyof NexusOps & string,
        params ?? {},
      );
      const response = nexusMutateEnvelopeToResponse(envelope, operation, startTime);
      return stampNexusMeta(response, operation, params ?? {});
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'mutate', domain: 'nexus', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'nexus', operation, error, startTime);
    }
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: Array.from(QUERY_OPS),
      mutate: Array.from(MUTATE_OPS),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal types for handleTopEntries / handleImpact (restored from pre-T1424)
// ---------------------------------------------------------------------------

interface NativeSqliteDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

interface RawBrainPageNodeRow {
  id: string;
  node_type: string | null;
  label: string | null;
  quality_score: number | null;
  last_activity_at: string | null;
  metadata_json: string | null;
}

interface BrainPageNodeEntry {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  last_activity_at: string;
  metadata_json: string | null;
}

interface BrainTopEntriesResult {
  entries: BrainPageNodeEntry[];
  count: number;
  limit: number;
  nodeType: string | null;
}

interface TopEntryRow {
  source_id: string;
  totalWeight: number;
  edgeCount: number;
  label: string | null;
  kind: string | null;
  file_path: string | null;
}

interface NexusTopEntry {
  nodeId: string;
  label: string;
  kind: string;
  filePath: string | null;
  totalWeight: number;
  edgeCount: number;
}

interface NexusTopEntriesResult {
  entries: NexusTopEntry[];
  count: number;
  limit: number;
  kind: string | null;
  note?: string;
}

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
    // T11545 · ADR-090: the plasticity `weight` was partitioned out of
    // `nexus_relations` into the sibling `nexus_relation_weights` table — LEFT
    // JOIN it (absent rows ⇒ weight 0 via COALESCE).
    const sql =
      kind === null
        ? `SELECT r.source_id,
                  SUM(COALESCE(w.weight, 0)) AS totalWeight,
                  COUNT(*)                   AS edgeCount,
                  n.label,
                  n.kind,
                  n.file_path
             FROM nexus_relations r
             LEFT JOIN nexus_relation_weights w ON w.relation_id = r.id
             LEFT JOIN nexus_nodes n ON n.id = r.source_id
            GROUP BY r.source_id
            ORDER BY totalWeight DESC, edgeCount DESC
            LIMIT ?`
        : `SELECT r.source_id,
                  SUM(COALESCE(w.weight, 0)) AS totalWeight,
                  COUNT(*)                   AS edgeCount,
                  n.label,
                  n.kind,
                  n.file_path
             FROM nexus_relations r
             LEFT JOIN nexus_relation_weights w ON w.relation_id = r.id
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

/** Execute impact through the same core coverage and symbol resolution service as the CLI. */
async function handleImpact(
  operation: string,
  params: Record<string, unknown> | undefined,
  startTime: number,
): Promise<DispatchResponse> {
  if (typeof params?.symbol !== 'string' || !params.symbol) {
    return errorResult(
      'query',
      'nexus',
      operation,
      'E_INVALID_INPUT',
      'symbol is required',
      startTime,
    );
  }
  const projectId = typeof params.projectId === 'string' ? params.projectId : undefined;
  const depth = typeof params.depth === 'number' ? params.depth : undefined;
  const result = await nexusImpact(
    params.symbol,
    projectId,
    params.why === true,
    depth,
    getProjectRoot(),
  );
  return wrapResult(result, 'query', 'nexus', operation, startTime);
}
