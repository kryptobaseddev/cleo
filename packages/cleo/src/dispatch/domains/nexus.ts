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
 * @epic T4820
 * @task T5704
 * @task T1424 — typed-dispatch narrowing (T988 follow-on)
 */

import type {
  NexusAugmentParams,
  NexusBlockersShowParams,
  NexusBrainAnchorsParams,
  NexusConduitScanParams,
  NexusContractsLinkTasksParams,
  NexusContractsShowParams,
  NexusContractsSyncParams,
  NexusDepsParams,
  NexusDiscoverParams,
  NexusFullContextParams,
  NexusGraphParams,
  NexusImpactFullParams,
  NexusImpactParams,
  NexusInitParams,
  NexusListParams,
  NexusOps,
  NexusOrphansListParams,
  NexusPathShowParams,
  NexusPermissionSetParams,
  NexusProfileExportParams,
  NexusProfileGetParams,
  NexusProfileImportParams,
  NexusProfileReinforceParams,
  NexusProfileSuperseedeParams,
  NexusProfileUpsertParams,
  NexusProfileViewParams,
  NexusReconcileParams,
  NexusRegisterParams,
  NexusResolveParams,
  NexusRouteMapParams,
  NexusSearchCodeParams,
  NexusSearchParams,
  NexusShapeCheckParams,
  NexusShareSnapshotExportParams,
  NexusShareSnapshotImportParams,
  NexusShareStatusParams,
  NexusShowParams,
  NexusSigilListParams,
  NexusSigilSyncParams,
  NexusStatusParams,
  NexusSyncParams,
  NexusTaskFootprintParams,
  NexusTaskSymbolsParams,
  NexusTopEntriesParams,
  NexusTransferParams,
  NexusTransferPreviewParams,
  NexusUnregisterParams,
  NexusWhyParams,
  NexusWikiParams,
} from '@cleocode/contracts';
import {
  getBrainNativeDb,
  getLogger,
  getNexusNativeDb,
  getProjectRoot,
  type NexusPermissionLevel,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
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
  nexusProfileExport,
  nexusProfileGet,
  nexusProfileImport,
  nexusProfileReinforce,
  nexusProfileSupersede,
  nexusProfileUpsert,
  nexusProfileView,
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
  nexusSigilList,
  nexusSigilSync,
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
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Typed inner handler (T1424 — Wave D typed-dispatch migration)
// ---------------------------------------------------------------------------

const _nexusTypedHandler = defineTypedHandler<NexusOps>('nexus', {
  // -------------------------------------------------------------------------
  // Query ops (30)
  // -------------------------------------------------------------------------

  status: async (_params: NexusStatusParams) => {
    const result = await nexusStatus();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'status',
      );
    }
    return lafsSuccess(result.data, 'status');
  },

  list: async (params: NexusListParams) => {
    const result = await nexusListProjects(params.limit, params.offset);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'list',
      );
    }
    // Engine returns page nested inside data; lift it to envelope top-level
    // and strip from data to preserve pre-T1424 contract shape.
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

  show: async (params: NexusShowParams) => {
    if (!params.name) {
      return lafsError('E_INVALID_INPUT', 'name is required', 'show');
    }
    const result = await nexusShowProject(params.name);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'show',
      );
    }
    return lafsSuccess(result.data, 'show');
  },

  resolve: async (params: NexusResolveParams) => {
    if (!params.query) {
      return lafsError('E_INVALID_INPUT', 'query is required', 'resolve');
    }
    const result = await nexusResolve(params.query, params.currentProject);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'resolve',
      );
    }
    return lafsSuccess(result.data, 'resolve');
  },

  deps: async (params: NexusDepsParams) => {
    if (!params.query) {
      return lafsError('E_INVALID_INPUT', 'query is required', 'deps');
    }
    const direction = params.direction ?? 'forward';
    const result = await nexusDepsQuery(params.query, direction);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'deps',
      );
    }
    return lafsSuccess(result.data, 'deps');
  },

  graph: async (_params: NexusGraphParams) => {
    const result = await nexusGraph();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'graph',
      );
    }
    return lafsSuccess(result.data, 'graph');
  },

  'path.show': async (_params: NexusPathShowParams) => {
    const result = await nexusCriticalPath();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'path.show',
      );
    }
    return lafsSuccess(result.data, 'path.show');
  },

  'blockers.show': async (params: NexusBlockersShowParams) => {
    if (!params.query) {
      return lafsError('E_INVALID_INPUT', 'query is required', 'blockers.show');
    }
    const result = await nexusBlockers(params.query);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'blockers.show',
      );
    }
    return lafsSuccess(result.data, 'blockers.show');
  },

  'orphans.list': async (params: NexusOrphansListParams) => {
    const result = await nexusOrphans(params.limit, params.offset);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'orphans.list',
      );
    }
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

  discover: async (params: NexusDiscoverParams) => {
    if (!params.query) {
      return lafsError('E_INVALID_INPUT', 'query is required', 'discover');
    }
    const method = params.method ?? 'auto';
    const limit = params.limit ?? 10;
    const result = await nexusDiscover(params.query, method, limit);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'discover',
      );
    }
    return lafsSuccess(result.data, 'discover');
  },

  search: async (params: NexusSearchParams) => {
    if (!params.pattern) {
      return lafsError('E_INVALID_INPUT', 'pattern is required', 'search');
    }
    const limit = params.limit ?? 20;
    const result = await nexusSearch(params.pattern, params.project, limit);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'search',
      );
    }
    return lafsSuccess(result.data, 'search');
  },

  augment: async (params: NexusAugmentParams) => {
    if (!params.pattern) {
      return lafsError('E_INVALID_INPUT', 'pattern is required', 'augment');
    }
    const limit = params.limit ?? 5;
    const result = await nexusAugment(params.pattern, limit);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'augment',
      );
    }
    return lafsSuccess(result.data, 'augment');
  },

  'share.status': async (_params: NexusShareStatusParams) => {
    const projectRoot = getProjectRoot();
    const result = await nexusShareStatus(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'share.status',
      );
    }
    return lafsSuccess(result.data, 'share.status');
  },

  'transfer.preview': async (params: NexusTransferPreviewParams) => {
    if (!params.taskIds?.length || !params.sourceProject || !params.targetProject) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskIds, sourceProject, and targetProject are required',
        'transfer.preview',
      );
    }
    const result = await nexusTransferPreview({
      taskIds: params.taskIds,
      sourceProject: params.sourceProject,
      targetProject: params.targetProject,
      mode: params.mode ?? 'copy',
      scope: params.scope ?? 'subtree',
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'transfer.preview',
      );
    }
    return lafsSuccess(result.data, 'transfer.preview');
  },

  'top-entries': async (_params: NexusTopEntriesParams) => {
    const result = await nexusGraph();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'top-entries',
      );
    }
    return lafsSuccess(result.data, 'top-entries');
  },

  impact: async (params: NexusImpactParams) => {
    if (!params.symbol) {
      return lafsError('E_INVALID_INPUT', 'symbol is required', 'impact');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusImpactFull(params.symbol, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'impact',
      );
    }
    return lafsSuccess(result.data, 'impact');
  },

  'full-context': async (params: NexusFullContextParams) => {
    if (!params.symbol) {
      return lafsError('E_INVALID_INPUT', 'symbol is required', 'full-context');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusFullContext(params.symbol, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'full-context',
      );
    }
    return lafsSuccess(result.data, 'full-context');
  },

  'task-footprint': async (params: NexusTaskFootprintParams) => {
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'task-footprint');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusTaskFootprint(params.taskId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'task-footprint',
      );
    }
    return lafsSuccess(result.data, 'task-footprint');
  },

  'brain-anchors': async (params: NexusBrainAnchorsParams) => {
    if (!params.entryId) {
      return lafsError('E_INVALID_INPUT', 'entryId is required', 'brain-anchors');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusBrainAnchors(params.entryId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'brain-anchors',
      );
    }
    return lafsSuccess(result.data, 'brain-anchors');
  },

  why: async (params: NexusWhyParams) => {
    if (!params.symbol) {
      return lafsError('E_INVALID_INPUT', 'symbol is required', 'why');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusWhy(params.symbol, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'why',
      );
    }
    return lafsSuccess(result.data, 'why');
  },

  'impact-full': async (params: NexusImpactFullParams) => {
    if (!params.symbol) {
      return lafsError('E_INVALID_INPUT', 'symbol is required', 'impact-full');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusImpactFull(params.symbol, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'impact-full',
      );
    }
    return lafsSuccess(result.data, 'impact-full');
  },

  'route-map': async (params: NexusRouteMapParams) => {
    const projectRoot = getProjectRoot();
    const projectId =
      params.projectId ?? Buffer.from(projectRoot).toString('base64url').slice(0, 32);
    const result = await nexusRouteMap(projectId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'route-map',
      );
    }
    return lafsSuccess(result.data, 'route-map');
  },

  'shape-check': async (params: NexusShapeCheckParams) => {
    if (!params.routeSymbol) {
      return lafsError('E_INVALID_INPUT', 'routeSymbol is required', 'shape-check');
    }
    const projectRoot = getProjectRoot();
    const projectId =
      params.projectId ?? Buffer.from(projectRoot).toString('base64url').slice(0, 32);
    const result = await nexusShapeCheck(params.routeSymbol, projectId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'shape-check',
      );
    }
    return lafsSuccess(result.data, 'shape-check');
  },

  'search-code': async (params: NexusSearchCodeParams) => {
    if (!params.pattern) {
      return lafsError('E_INVALID_INPUT', 'pattern is required', 'search-code');
    }
    const limit = params.limit ?? 10;
    const result = await nexusSearchCode(params.pattern, limit);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'search-code',
      );
    }
    return lafsSuccess(result.data, 'search-code');
  },

  wiki: async (params: NexusWikiParams) => {
    const projectRoot = getProjectRoot();
    const outputDir = params.outputDir ?? `${projectRoot}/.cleo/wiki`;
    const result = await nexusWiki(projectRoot, outputDir, {
      communityFilter: params.communityFilter,
      incremental: params.incremental,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'wiki',
      );
    }
    return lafsSuccess(result.data, 'wiki');
  },

  'contracts-show': async (params: NexusContractsShowParams) => {
    if (!params.projectA || !params.projectB) {
      return lafsError('E_INVALID_INPUT', 'projectA and projectB are required', 'contracts-show');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusContractsShow(params.projectA, params.projectB, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'contracts-show',
      );
    }
    return lafsSuccess(result.data, 'contracts-show');
  },

  'task-symbols': async (params: NexusTaskSymbolsParams) => {
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'task-symbols');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusTaskSymbols(params.taskId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'task-symbols',
      );
    }
    return lafsSuccess(result.data, 'task-symbols');
  },

  'profile.view': async (params: NexusProfileViewParams) => {
    const result = await nexusProfileView(params.minConfidence, params.includeSuperseded);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.view',
      );
    }
    return lafsSuccess(result.data, 'profile.view');
  },

  'profile.get': async (params: NexusProfileGetParams) => {
    if (!params.traitKey) {
      return lafsError('E_INVALID_INPUT', 'traitKey is required', 'profile.get');
    }
    const result = await nexusProfileGet(params.traitKey);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.get',
      );
    }
    return lafsSuccess(result.data, 'profile.get');
  },

  'sigil.list': async (params: NexusSigilListParams) => {
    const result = await nexusSigilList(params.role);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sigil.list',
      );
    }
    return lafsSuccess(result.data, 'sigil.list');
  },

  // -------------------------------------------------------------------------
  // Mutate ops (18)
  // -------------------------------------------------------------------------

  init: async (_params: NexusInitParams) => {
    const result = await nexusInitialize();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'init',
      );
    }
    return lafsSuccess(result.data, 'init');
  },

  register: async (params: NexusRegisterParams) => {
    if (!params.path) {
      return lafsError('E_INVALID_INPUT', 'path is required', 'register');
    }
    const result = await nexusRegisterProject(
      params.path,
      params.name,
      params.permission ?? 'read',
    );
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'register',
      );
    }
    return lafsSuccess(result.data, 'register');
  },

  unregister: async (params: NexusUnregisterParams) => {
    if (!params.name) {
      return lafsError('E_INVALID_INPUT', 'name is required', 'unregister');
    }
    const result = await nexusUnregisterProject(params.name);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'unregister',
      );
    }
    return lafsSuccess(result.data, 'unregister');
  },

  sync: async (params: NexusSyncParams) => {
    const result = await nexusSyncProject(params.name);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sync',
      );
    }
    return lafsSuccess(result.data, 'sync');
  },

  'permission.set': async (params: NexusPermissionSetParams) => {
    if (!params.name) {
      return lafsError('E_INVALID_INPUT', 'name is required', 'permission.set');
    }
    if (!params.level) {
      return lafsError('E_INVALID_INPUT', 'level is required', 'permission.set');
    }
    if (!['read', 'write', 'execute'].includes(params.level)) {
      return lafsError(
        'E_INVALID_INPUT',
        `Invalid permission level: ${params.level}. Must be: read, write, or execute`,
        'permission.set',
      );
    }
    const result = await nexusSetPermission(params.name, params.level as NexusPermissionLevel);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'permission.set',
      );
    }
    return lafsSuccess(result.data, 'permission.set');
  },

  reconcile: async (params: NexusReconcileParams) => {
    const projectRoot = params.projectRoot ?? process.cwd();
    const result = await nexusReconcileProject(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'reconcile',
      );
    }
    return lafsSuccess(result.data, 'reconcile');
  },

  'share.snapshot.export': async (params: NexusShareSnapshotExportParams) => {
    const projectRoot = getProjectRoot();
    const result = await nexusShareSnapshotExport(projectRoot, params.outputPath);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'share.snapshot.export',
      );
    }
    return lafsSuccess(result.data, 'share.snapshot.export');
  },

  'share.snapshot.import': async (params: NexusShareSnapshotImportParams) => {
    if (!params.inputPath) {
      return lafsError('E_INVALID_INPUT', 'inputPath is required', 'share.snapshot.import');
    }
    const projectRoot = getProjectRoot();
    const result = await nexusShareSnapshotImport(projectRoot, params.inputPath);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'share.snapshot.import',
      );
    }
    return lafsSuccess(result.data, 'share.snapshot.import');
  },

  transfer: async (params: NexusTransferParams) => {
    if (!params.taskIds?.length || !params.sourceProject || !params.targetProject) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskIds, sourceProject, and targetProject are required',
        'transfer',
      );
    }
    const result = await nexusTransferExecute({
      taskIds: params.taskIds,
      sourceProject: params.sourceProject,
      targetProject: params.targetProject,
      mode: params.mode ?? 'copy',
      scope: params.scope ?? 'subtree',
      onConflict: params.onConflict ?? 'rename',
      transferBrain: params.transferBrain ?? false,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'transfer',
      );
    }
    return lafsSuccess(result.data, 'transfer');
  },

  'contracts-sync': async (params: NexusContractsSyncParams) => {
    const projectRoot = getProjectRoot();
    const repoPath = params.repoPath ?? projectRoot;
    const projectId = params.projectId ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const result = await nexusContractsSync(projectId, repoPath);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'contracts-sync',
      );
    }
    return lafsSuccess(result.data, 'contracts-sync');
  },

  'contracts-link-tasks': async (params: NexusContractsLinkTasksParams) => {
    const projectRoot = getProjectRoot();
    const repoPath = params.repoPath ?? projectRoot;
    const projectId = params.projectId ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const result = await nexusContractsLinkTasks(projectId, repoPath);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'contracts-link-tasks',
      );
    }
    return lafsSuccess(result.data, 'contracts-link-tasks');
  },

  'conduit-scan': async (_params: NexusConduitScanParams) => {
    const projectRoot = getProjectRoot();
    const result = await nexusConduitScan(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'conduit-scan',
      );
    }
    return lafsSuccess(result.data, 'conduit-scan');
  },

  'profile.import': async (params: NexusProfileImportParams) => {
    const result = await nexusProfileImport(params.path);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.import',
      );
    }
    return lafsSuccess(result.data, 'profile.import');
  },

  'profile.export': async (params: NexusProfileExportParams) => {
    const result = await nexusProfileExport(params.path);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.export',
      );
    }
    return lafsSuccess(result.data, 'profile.export');
  },

  'profile.reinforce': async (params: NexusProfileReinforceParams) => {
    if (!params.traitKey) {
      return lafsError('E_INVALID_INPUT', 'traitKey is required', 'profile.reinforce');
    }
    const result = await nexusProfileReinforce(params.traitKey, params.source);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.reinforce',
      );
    }
    return lafsSuccess(result.data, 'profile.reinforce');
  },

  'profile.upsert': async (params: NexusProfileUpsertParams) => {
    if (!params.trait?.traitKey || !params.trait?.traitValue) {
      return lafsError(
        'E_INVALID_INPUT',
        'trait.traitKey and trait.traitValue are required',
        'profile.upsert',
      );
    }
    const result = await nexusProfileUpsert(params.trait);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.upsert',
      );
    }
    return lafsSuccess(result.data, 'profile.upsert');
  },

  'profile.supersede': async (params: NexusProfileSuperseedeParams) => {
    if (!params.oldKey || !params.newKey) {
      return lafsError('E_INVALID_INPUT', 'oldKey and newKey are required', 'profile.supersede');
    }
    const result = await nexusProfileSupersede(params.oldKey, params.newKey);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'profile.supersede',
      );
    }
    return lafsSuccess(result.data, 'profile.supersede');
  },

  'sigil.sync': async (_params: NexusSigilSyncParams) => {
    const result = await nexusSigilSync();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sigil.sync',
      );
    }
    return lafsSuccess(result.data, 'sigil.sync');
  },
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
]);

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
      return handleTopEntries(operation, params, startTime);
    }
    if (operation === 'impact') {
      return handleImpact(operation, params, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid nexus query op name at this point.
      const envelope = await typedDispatch(
        _nexusTypedHandler,
        operation as keyof NexusOps & string,
        params ?? {},
      );
      return wrapResult(
        {
          success: envelope.success,
          data: envelope.data,
          page: (envelope as { page?: unknown }).page,
          error: envelope.error,
        },
        'query',
        'nexus',
        operation,
        startTime,
      );
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
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid nexus mutate op name at this point.
      const envelope = await typedDispatch(
        _nexusTypedHandler,
        operation as keyof NexusOps & string,
        params ?? {},
      );
      return wrapResult(
        {
          success: envelope.success,
          data: envelope.data,
          error: envelope.error,
        },
        'mutate',
        'nexus',
        operation,
        startTime,
      );
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
