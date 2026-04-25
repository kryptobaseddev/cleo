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
import { getLogger, getProjectRoot, type NexusPermissionLevel } from '@cleocode/core/internal';
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
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

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
    return lafsSuccess(result.data, 'list');
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
    return lafsSuccess(result.data, 'orphans.list');
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
  'share.status',
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
  'init',
  'register',
  'unregister',
  'sync',
  'permission.set',
  'reconcile',
  'share.snapshot.export',
  'share.snapshot.import',
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
      query: Array.from(QUERY_OPS).sort(),
      mutate: Array.from(MUTATE_OPS).sort(),
    };
  }
}
