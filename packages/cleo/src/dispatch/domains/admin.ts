/**
 * Admin Domain Handler (Dispatch Layer)
 *
 * Consolidates system domain operations into the canonical "admin"
 * domain. Handles version, health, config, stats, context, job management,
 * dashboard, log, sequence, init, backup, restore, migrate, cleanup,
 * safestop, inject.generate, token, adr, export, import, install.global,
 * and context.inject.
 *
 * All operations delegate to native engine functions from system-engine,
 * config-engine, and init-engine.
 *
 * Param extraction is type-safe via TypedDomainHandler<AdminHandlerOps>
 * (T1426 — Wave D typed-dispatch migration). Zero `as any` / `as X` param
 * casts.
 *
 * @epic T4820
 * @task T5671
 * @task T1426 — typed-dispatch migration
 */

import type {
  AdminAdrFindParams,
  AdminAdrShowParams,
  AdminAdrSyncParams,
  AdminBackupListParams,
  AdminBackupMutateParams,
  AdminCleanupParams,
  AdminConfigPresetsParams,
  AdminConfigSetParams,
  AdminConfigSetPresetParams,
  AdminConfigShowParams,
  AdminContextInjectParams,
  AdminContextParams,
  AdminContextPullParams,
  AdminDashParams,
  AdminDetectParams,
  AdminExportParams,
  AdminHandlerOps,
  AdminHealthMutateParams,
  AdminHealthQueryParams,
  AdminHelpParams,
  AdminHooksMatrixParams,
  AdminImportParams,
  AdminInitParams,
  AdminInjectGenerateParams,
  AdminInstallGlobalParams,
  AdminJobCancelParams,
  AdminJobStatusParams,
  AdminLogParams,
  AdminMapMutateParams,
  AdminMapQueryParams,
  AdminMigrateParams,
  AdminPathsParams,
  AdminRoadmapParams,
  AdminRuntimeParams,
  AdminSafestopParams,
  AdminScaffoldHubParams,
  AdminSequenceParams,
  AdminSmokeParams,
  AdminSmokeProviderParams,
  AdminStatsParams,
  AdminTokenMutateParams,
  AdminTokenQueryParams,
  AdminVersionParams,
} from '@cleocode/contracts';
import {
  clearTokenUsage,
  computeHelp,
  deleteTokenUsage,
  exportSnapshot,
  exportTasks,
  exportTasksPackage,
  findAdrs,
  getDefaultSnapshotPath,
  getLogger,
  getProjectRoot,
  importSnapshot,
  importTasks,
  importTasksPackage,
  listAdrs,
  listTokenUsage,
  paginate,
  readSnapshot,
  recordTokenExchange,
  showAdr,
  showTokenUsage,
  summarizeTokenUsage,
  syncAdrsToDb,
  validateAllAdrs,
  writeSnapshot,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import {
  backupRestore,
  configGet,
  configListPresets,
  configSet,
  configSetPreset,
  getVersion,
  initProject,
  sessionContextInject,
  systemBackup,
  systemCleanup,
  systemContext,
  systemDash,
  systemDoctor,
  systemFix,
  systemHealth,
  systemHooksMatrix,
  systemInjectGenerate,
  systemListBackups,
  systemLog,
  systemMigrate,
  systemPaths,
  systemRestore,
  systemRoadmap,
  systemRuntime,
  systemSafestop,
  systemScaffoldHub,
  systemSequence,
  systemSmoke,
  systemStats,
} from '../lib/engine.js';
import { OPERATIONS } from '../registry.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { getListParams, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1426)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _adminTypedHandler = defineTypedHandler<AdminHandlerOps>('admin', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  version: async (_params: AdminVersionParams) => {
    const projectRoot = getProjectRoot();
    const result = await getVersion(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'version',
      );
    }
    return lafsSuccess(result.data ?? { version: '' }, 'version');
  },

  health: async (params: AdminHealthQueryParams) => {
    const projectRoot = getProjectRoot();
    if (params.mode === 'diagnose') {
      const result = await systemDoctor(projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'health',
        );
      }
      return lafsSuccess(
        result.data ?? { healthy: false, errors: 0, warnings: 0, checks: [] },
        'health',
      );
    }
    const result = await systemHealth(projectRoot, { detailed: params.detailed });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'health',
      );
    }
    return lafsSuccess(
      result.data ?? { overall: 'error', checks: [], version: '', installation: 'degraded' },
      'health',
    );
  },

  'config.show': async (params: AdminConfigShowParams) => {
    const projectRoot = getProjectRoot();
    const result = await configGet(projectRoot, params.key);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'config.show',
      );
    }
    return lafsSuccess(result.data ?? {}, 'config.show');
  },

  'config.presets': async (_params: AdminConfigPresetsParams) => {
    const result = configListPresets();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'config.presets',
      );
    }
    return lafsSuccess(result.data ?? { presets: [] }, 'config.presets');
  },

  stats: async (params: AdminStatsParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemStats(projectRoot, { period: params.period });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'stats',
      );
    }
    return lafsSuccess(result.data, 'stats');
  },

  context: async (params: AdminContextParams) => {
    const projectRoot = getProjectRoot();
    // Pass undefined when no session filter is provided to match engine expectations.
    const sessionFilter = params.session !== undefined ? { session: params.session } : undefined;
    const result = systemContext(projectRoot, sessionFilter);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'context',
      );
    }
    return lafsSuccess(result.data, 'context');
  },

  'context.pull': async (params: AdminContextPullParams) => {
    const projectRoot = getProjectRoot();
    const taskId = params.taskId;
    try {
      const { getAccessor, getLastHandoff, retrieveWithBudget } = await import(
        '@cleocode/core/internal'
      );

      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);

      if (!task) {
        return lafsError('E_NOT_FOUND', `Task ${taskId} not found`, 'context.pull');
      }

      const queryParts = [task.title, task.description].filter(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      );
      const query = queryParts.join(' ');
      const TOKEN_BUDGET = 800;
      const [memoriesResult, lastHandoffResult] = await Promise.all([
        retrieveWithBudget(projectRoot, query, TOKEN_BUDGET).catch(() => ({
          entries: [] as import('@cleocode/core/internal').BudgetedEntry[],
          tokensUsed: 0,
          tokensRemaining: TOKEN_BUDGET,
          excluded: 0,
        })),
        getLastHandoff(projectRoot).catch(() => null),
      ]);

      const topMemories = memoriesResult.entries.slice(0, 5);

      return lafsSuccess(
        {
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            acceptance: task.acceptance ?? [],
          },
          relevantMemory: topMemories.map((e) => ({
            id: e.id,
            type: e.memoryType ?? 'unknown',
            summary: e.title,
          })),
          lastHandoff: lastHandoffResult?.handoff?.note?.substring(0, 200) ?? null,
          meta: {
            memoryTokensUsed: memoriesResult.tokensUsed,
            memoryEntriesExcluded: memoriesResult.excluded,
          },
        },
        'context.pull',
      );
    } catch (err: unknown) {
      return lafsError(
        'E_INTERNAL',
        err instanceof Error ? err.message : String(err),
        'context.pull',
      );
    }
  },

  runtime: async (params: AdminRuntimeParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemRuntime(projectRoot, { detailed: params.detailed });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'runtime',
      );
    }
    return lafsSuccess(result.data, 'runtime');
  },

  paths: async (_params: AdminPathsParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemPaths(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'paths',
      );
    }
    return lafsSuccess(result.data, 'paths');
  },

  job: async (params: AdminJobStatusParams) => {
    const { getJobManager } = await import('../lib/job-manager-accessor.js');
    const action = params.action ?? 'status';

    if (action === 'list') {
      const mgr = getJobManager();
      if (!mgr) {
        return lafsError(
          'E_NOT_AVAILABLE',
          'Job manager not available. Background jobs require a running CLEO daemon or long-lived process.',
          'job',
        );
      }
      const allJobs = mgr.listJobs();
      const filteredJobs = params.status ? mgr.listJobs(params.status) : allJobs;
      const { limit, offset } = getListParams({ limit: params.limit, offset: params.offset });
      const page = paginate(filteredJobs, limit, offset);
      return lafsSuccess(
        {
          jobs: page.items,
          count: filteredJobs.length,
          total: allJobs.length,
          filtered: filteredJobs.length,
        },
        'job',
      );
    }

    // Default: status action
    const manager = getJobManager();
    if (!manager) {
      return lafsError(
        'E_NOT_AVAILABLE',
        'Job manager not available. Background jobs require a running CLEO daemon or long-lived process.',
        'job',
      );
    }
    const jobId = params.jobId;
    if (!jobId) {
      return lafsError('E_INVALID_INPUT', 'jobId is required', 'job');
    }
    const job = manager.getJob(jobId);
    if (!job) {
      return lafsError('E_NOT_FOUND', `Job ${jobId} not found`, 'job');
    }
    return lafsSuccess(job, 'job');
  },

  dash: async (params: AdminDashParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemDash(projectRoot, {
      blockedTasksLimit: params.blockedTasksLimit,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'dash',
      );
    }
    return lafsSuccess(result.data, 'dash');
  },

  log: async (params: AdminLogParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemLog(projectRoot, {
      operation: params.operation,
      taskId: params.taskId,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'log',
      );
    }
    return lafsSuccess(result.data, 'log');
  },

  sequence: async (params: AdminSequenceParams) => {
    const projectRoot = getProjectRoot();
    const action = params.action;
    if (action && action !== 'show' && action !== 'check') {
      return lafsError('E_INVALID_INPUT', 'action must be show or check', 'sequence');
    }
    const result = await systemSequence(projectRoot, { action });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sequence',
      );
    }
    return lafsSuccess(result.data, 'sequence');
  },

  help: async (params: AdminHelpParams) => {
    const tier = params.tier ?? 0;
    const verbose = params.verbose === true;
    const helpResult = computeHelp(OPERATIONS, tier, verbose);
    return lafsSuccess(helpResult, 'help');
  },

  'adr.find': async (params: AdminAdrFindParams) => {
    const projectRoot = getProjectRoot();
    if (params.query) {
      const result = await findAdrs(projectRoot, params.query, {
        topics: params.topics,
        keywords: params.keywords,
        status: params.status,
      });
      return lafsSuccess(result, 'adr.find');
    }
    // No query — list all ADRs
    const { limit, offset } = getListParams({ limit: params.limit, offset: params.offset });
    const result = await listAdrs(projectRoot, {
      status: params.status,
      since: params.since,
      limit,
      offset,
    });
    return lafsSuccess(
      {
        ...result,
        page: paginate(Array.from({ length: result.filtered }), limit, offset).page,
      },
      'adr.find',
    );
  },

  'adr.show': async (params: AdminAdrShowParams) => {
    const projectRoot = getProjectRoot();
    const adr = await showAdr(projectRoot, params.adrId);
    if (!adr) {
      return lafsError('E_NOT_FOUND', `ADR not found: ${params.adrId}`, 'adr.show');
    }
    return lafsSuccess(adr, 'adr.show');
  },

  token: async (params: AdminTokenQueryParams) => {
    const projectRoot = getProjectRoot();
    const action = params.action ?? 'summary';

    if (action === 'show') {
      const tokenId = params.tokenId;
      if (!tokenId) {
        return lafsError('E_INVALID_INPUT', 'tokenId is required', 'token');
      }
      const result = await showTokenUsage(tokenId, projectRoot);
      if (!result) {
        return lafsError('E_NOT_FOUND', `Token usage record not found: ${tokenId}`, 'token');
      }
      return lafsSuccess(result, 'token');
    }

    if (action === 'list') {
      const { limit, offset } = getListParams({ limit: params.limit, offset: params.offset });
      const result = await listTokenUsage(
        {
          provider: params.provider,
          transport: params.transport,
          gateway: params.gateway,
          domain: params.domain,
          operation: params.operationName,
          sessionId: params.sessionId,
          taskId: params.taskId,
          method: params.method,
          confidence: params.confidence,
          requestId: params.requestId,
          since: params.since,
          until: params.until,
          limit,
          offset,
        },
        projectRoot,
      );
      return lafsSuccess(
        {
          records: result.records,
          total: result.total,
          filtered: result.filtered,
        },
        'token',
      );
    }

    // Default: summary
    const result = await summarizeTokenUsage(
      {
        provider: params.provider,
        transport: params.transport,
        gateway: params.gateway,
        domain: params.domain,
        operation: params.operationName,
        sessionId: params.sessionId,
        taskId: params.taskId,
        method: params.method,
        confidence: params.confidence,
        requestId: params.requestId,
        since: params.since,
        until: params.until,
      },
      projectRoot,
    );
    return lafsSuccess(result, 'token');
  },

  backup: async (_params: AdminBackupListParams) => {
    const projectRoot = getProjectRoot();
    const result = systemListBackups(projectRoot);
    if (!result.success || !result.data) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'backup',
      );
    }
    const backups = result.data;
    return lafsSuccess({ backups, count: backups.length }, 'backup');
  },

  export: async (params: AdminExportParams) => {
    const projectRoot = getProjectRoot();
    if (params.scope === 'snapshot') {
      const snapshot = await exportSnapshot(projectRoot);
      const outputPath = params.output ?? getDefaultSnapshotPath(projectRoot);
      await writeSnapshot(snapshot, outputPath);
      return lafsSuccess(
        {
          exported: true,
          taskCount: snapshot._meta.taskCount,
          outputPath,
          checksum: snapshot._meta.checksum,
        },
        'export',
      );
    }
    if (params.scope === 'tasks') {
      const result = await exportTasksPackage({
        taskIds: params.taskIds,
        output: params.output,
        subtree: params.subtree,
        filter: params.filter,
        includeDeps: params.includeDeps,
        dryRun: params.dryRun,
        cwd: projectRoot,
      });
      return lafsSuccess(result, 'export');
    }
    // Default: standard export
    const result = await exportTasks({
      format: params.format,
      output: params.output,
      status: params.status,
      parent: params.parent,
      phase: params.phase,
      cwd: projectRoot,
    });
    return lafsSuccess(result, 'export');
  },

  map: async (params: AdminMapQueryParams) => {
    const projectRoot = getProjectRoot();
    const { mapCodebase } = await import('../engines/codebase-map-engine.js');
    const result = await mapCodebase(projectRoot, {
      focus: params.focus,
      storeToBrain: false,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'map',
      );
    }
    return lafsSuccess(result.data, 'map');
  },

  roadmap: async (params: AdminRoadmapParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemRoadmap(projectRoot, {
      includeHistory: params.includeHistory,
      upcomingOnly: params.upcomingOnly,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'roadmap',
      );
    }
    return lafsSuccess(result.data, 'roadmap');
  },

  smoke: async (_params: AdminSmokeParams) => {
    const result = await systemSmoke();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'smoke',
      );
    }
    return lafsSuccess(result.data, 'smoke');
  },

  'smoke.provider': async (params: AdminSmokeProviderParams) => {
    const { smokeProvider } = await import('./admin/smoke-provider.js');
    const result = await smokeProvider(params.provider);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'smoke.provider',
      );
    }
    return lafsSuccess(result.data, 'smoke.provider');
  },

  'hooks.matrix': async (params: AdminHooksMatrixParams) => {
    const result = await systemHooksMatrix({
      providerIds: params.providerIds,
      detectProvider: params.detectProvider !== false,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'hooks.matrix',
      );
    }
    return lafsSuccess(result.data, 'hooks.matrix');
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  init: async (params: AdminInitParams) => {
    const projectRoot = getProjectRoot();
    const result = await initProject(projectRoot, {
      projectName: params.projectName,
      force: params.force,
      mapCodebase: params.mapCodebase,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'init',
      );
    }
    return lafsSuccess(result.data, 'init');
  },

  'scaffold-hub': async (_params: AdminScaffoldHubParams) => {
    const result = await systemScaffoldHub();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'scaffold-hub',
      );
    }
    return lafsSuccess(result.data, 'scaffold-hub');
  },

  'health.mutate': async (params: AdminHealthMutateParams) => {
    const projectRoot = getProjectRoot();
    if (params.mode === 'diagnose') {
      const result = await systemDoctor(projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'health.mutate',
        );
      }
      return lafsSuccess(
        result.data ?? { healthy: false, errors: 0, warnings: 0, checks: [] },
        'health.mutate',
      );
    }
    // Default: repair mode
    const result = await systemFix(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'health.mutate',
      );
    }
    return lafsSuccess(result.data, 'health.mutate');
  },

  'config.set': async (params: AdminConfigSetParams) => {
    const projectRoot = getProjectRoot();
    // Runtime guard: key is declared required in the contract but the dispatcher
    // may pass an empty object when the caller omits it; validate defensively.
    if (!params.key) {
      return lafsError('E_INVALID_INPUT', 'key is required', 'config.set');
    }
    const result = await configSet(projectRoot, params.key, params.value);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'config.set',
      );
    }
    return lafsSuccess(result.data, 'config.set');
  },

  'config.set-preset': async (params: AdminConfigSetPresetParams) => {
    const projectRoot = getProjectRoot();
    const result = await configSetPreset(projectRoot, params.preset);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'config.set-preset',
      );
    }
    return lafsSuccess(result.data, 'config.set-preset');
  },

  'backup.mutate': async (params: AdminBackupMutateParams) => {
    const projectRoot = getProjectRoot();
    const action = params.action;

    if (action === 'restore') {
      const backupId = params.backupId;
      if (!backupId) {
        return lafsError('E_INVALID_INPUT', 'backupId is required', 'backup.mutate');
      }
      const result = systemRestore(projectRoot, {
        backupId,
        force: params.force,
      });
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'backup.mutate',
        );
      }
      return lafsSuccess(result.data, 'backup.mutate');
    }

    if (action === 'restore.file') {
      const file = params.file;
      if (!file) {
        return lafsError('E_INVALID_INPUT', 'file is required', 'backup.mutate');
      }
      const result = await backupRestore(projectRoot, file, {
        dryRun: params.dryRun,
      });
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'backup.mutate',
        );
      }
      return lafsSuccess(result.data, 'backup.mutate');
    }

    // Default: create backup
    const result = await systemBackup(projectRoot, {
      type: params.type,
      note: params.note,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'backup.mutate',
      );
    }
    return lafsSuccess(result.data, 'backup.mutate');
  },

  migrate: async (params: AdminMigrateParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemMigrate(projectRoot, {
      target: params.target,
      dryRun: params.dryRun,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'migrate',
      );
    }
    return lafsSuccess(result.data, 'migrate');
  },

  cleanup: async (params: AdminCleanupParams) => {
    const projectRoot = getProjectRoot();
    // Runtime guard: target is declared required in the contract but the
    // dispatcher may pass an empty object when the caller omits it.
    if (!params.target) {
      return lafsError('E_INVALID_INPUT', 'target is required', 'cleanup');
    }
    const result = await systemCleanup(projectRoot, {
      target: params.target,
      olderThan: params.olderThan,
      dryRun: params.dryRun,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'cleanup',
      );
    }
    return lafsSuccess(result.data, 'cleanup');
  },

  'job.cancel': async (params: AdminJobCancelParams) => {
    const { getJobManager } = await import('../lib/job-manager-accessor.js');
    const mgr = getJobManager();
    if (!mgr) {
      return lafsError(
        'E_NOT_AVAILABLE',
        'Job manager not available. Background jobs require a running CLEO daemon or long-lived process.',
        'job.cancel',
      );
    }
    const cancelled = mgr.cancelJob(params.jobId);
    if (!cancelled) {
      return lafsError('E_NOT_FOUND', `Job ${params.jobId} not found or not running`, 'job.cancel');
    }
    return lafsSuccess({ jobId: params.jobId, cancelled: true }, 'job.cancel');
  },

  safestop: async (params: AdminSafestopParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemSafestop(projectRoot, {
      reason: params.reason,
      commit: params.commit,
      handoff: params.handoff,
      noSessionEnd: params.noSessionEnd,
      dryRun: params.dryRun,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'safestop',
      );
    }
    return lafsSuccess(result.data, 'safestop');
  },

  'inject.generate': async (_params: AdminInjectGenerateParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemInjectGenerate(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'inject.generate',
      );
    }
    return lafsSuccess(result.data, 'inject.generate');
  },

  'adr.sync': async (params: AdminAdrSyncParams) => {
    const projectRoot = getProjectRoot();
    if (params.validate) {
      const result = await validateAllAdrs(projectRoot);
      return lafsSuccess(result, 'adr.sync');
    }
    const result = await syncAdrsToDb(projectRoot);
    return lafsSuccess(result, 'adr.sync');
  },

  import: async (params: AdminImportParams) => {
    const projectRoot = getProjectRoot();
    const file = params.file;

    if (params.scope === 'snapshot') {
      const snapshot = await readSnapshot(file);
      if (params.dryRun) {
        return lafsSuccess(
          {
            dryRun: true,
            source: snapshot._meta.source,
            taskCount: snapshot._meta.taskCount,
            createdAt: snapshot._meta.createdAt,
          },
          'import',
        );
      }
      const result = await importSnapshot(snapshot, projectRoot);
      return lafsSuccess(
        {
          imported: true,
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          conflicts: result.conflicts.length > 0 ? result.conflicts : undefined,
        },
        'import',
      );
    }

    if (params.scope === 'tasks') {
      const result = await importTasksPackage({
        file,
        dryRun: params.dryRun,
        parent: params.parent,
        phase: params.phase,
        addLabel: params.addLabel,
        provenance: params.provenance,
        resetStatus: params.resetStatus,
        onConflict: params.onConflict,
        onMissingDep: params.onMissingDep,
        force: params.force,
        cwd: projectRoot,
      });
      return lafsSuccess(result, 'import');
    }

    // Default: standard import
    const result = await importTasks({
      file,
      parent: params.parent,
      phase: params.phase,
      onDuplicate: params.onDuplicate,
      addLabel: params.addLabel,
      dryRun: params.dryRun,
      cwd: projectRoot,
    });
    return lafsSuccess(result, 'import');
  },

  detect: async (_params: AdminDetectParams) => {
    const projectRoot = getProjectRoot();
    const { ensureProjectContext, ensureContributorMcp: ensureContributorDev } = await import(
      '@cleocode/core/internal'
    );
    const contextResult = await ensureProjectContext(projectRoot, { force: true });
    const devResult = await ensureContributorDev(projectRoot);
    return lafsSuccess({ context: contextResult, devChannel: devResult }, 'detect');
  },

  'token.mutate': async (params: AdminTokenMutateParams) => {
    const projectRoot = getProjectRoot();
    const action = params.action ?? 'record';

    if (action === 'delete') {
      const tokenId = params.tokenId;
      if (!tokenId) {
        return lafsError('E_INVALID_INPUT', 'tokenId is required', 'token.mutate');
      }
      const result = await deleteTokenUsage(tokenId, projectRoot);
      return lafsSuccess(result, 'token.mutate');
    }

    if (action === 'clear') {
      const result = await clearTokenUsage(
        {
          provider: params.provider,
          transport: params.transport,
          gateway: params.gateway,
          domain: params.domain,
          operation: params.operationName,
          sessionId: params.sessionId,
          taskId: params.taskId,
          method: params.method,
          confidence: params.confidence,
          requestId: params.requestId,
          since: params.since,
          until: params.until,
        },
        projectRoot,
      );
      return lafsSuccess(result, 'token.mutate');
    }

    // Default: record
    const result = await recordTokenExchange({
      provider: params.provider,
      model: params.model,
      transport: params.transport,
      gateway: params.gateway,
      domain: params.domain,
      operation: params.operationName,
      sessionId: params.sessionId,
      taskId: params.taskId,
      requestId: params.requestId,
      requestPayload: params.requestPayload,
      responsePayload: params.responsePayload,
      metadata: params.metadata,
      cwd: projectRoot,
    });
    return lafsSuccess(result, 'token.mutate');
  },

  'context.inject': async (params: AdminContextInjectParams) => {
    const projectRoot = getProjectRoot();
    const result = sessionContextInject(
      params.protocolType,
      {
        taskId: params.taskId,
        variant: params.variant,
      },
      projectRoot,
    );
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'context.inject',
      );
    }
    return lafsSuccess(result.data, 'context.inject');
  },

  'map.mutate': async (params: AdminMapMutateParams) => {
    const projectRoot = getProjectRoot();
    const { mapCodebase } = await import('../engines/codebase-map-engine.js');
    const result = await mapCodebase(projectRoot, {
      focus: params.focus,
      storeToBrain: true,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'map.mutate',
      );
    }
    return lafsSuccess(result.data, 'map.mutate');
  },

  'install.global': async (_params: AdminInstallGlobalParams) => {
    const { ensureGlobalScaffold, ensureGlobalTemplates } = await import('@cleocode/core/internal');
    const scaffoldResult = await ensureGlobalScaffold();
    const templateResult = await ensureGlobalTemplates();
    return lafsSuccess({ scaffold: scaffoldResult, templates: templateResult }, 'install.global');
  },
});

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
//
// Converts a LafsEnvelope into the minimal EngineResult shape accepted by
// wrapResult. The error.code is coerced to string since LafsErrorDetail.code
// is typed as `number | string` but EngineResult.error.code requires string.
// ---------------------------------------------------------------------------

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * @param envelope - The LAFS envelope returned by the typed op function.
 * @returns An object compatible with the `EngineResult` type in `_base.ts`.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: number | string; readonly message: string };
}): { success: boolean; data?: unknown; error?: { code: string; message: string } } {
  if (envelope.success) {
    return { success: true, data: envelope.data };
  }
  return {
    success: false,
    error: {
      code: String(envelope.error?.code ?? 'E_INTERNAL'),
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>([
  'version',
  'health',
  'config.show',
  'config.presets',
  'stats',
  'context',
  'context.pull',
  'runtime',
  'paths',
  'job',
  'dash',
  'log',
  'sequence',
  'help',
  'token',
  'adr.find',
  'adr.show',
  'backup',
  'export',
  'map',
  'roadmap',
  'smoke',
  'smoke.provider',
  'hooks.matrix',
]);

const MUTATE_OPS = new Set<string>([
  'init',
  'scaffold-hub',
  'health',
  'config.set',
  'config.set-preset',
  'backup',
  'migrate',
  'cleanup',
  'job.cancel',
  'safestop',
  'inject.generate',
  'adr.sync',
  'import',
  'detect',
  'token',
  'context.inject',
  'map',
  'install.global',
]);

// ---------------------------------------------------------------------------
// Typed handler key maps
//
// Some operations have the same name in both query and mutate gateways (e.g.
// "health", "backup", "map", "token"). The typed handler uses distinct keys
// for the mutate variants (e.g. "health.mutate", "backup.mutate",
// "map.mutate", "token.mutate") to avoid key collisions in AdminHandlerOps.
// These maps translate the incoming operation name to the correct handler key.
// ---------------------------------------------------------------------------

/** Query gateway: operation name → AdminHandlerOps key. Defaults to identity. */
function queryKey(operation: string): keyof AdminHandlerOps & string {
  // All query ops map directly (no suffix needed for query side)
  return operation as keyof AdminHandlerOps & string;
}

/** Mutate gateway: operation name → AdminHandlerOps key. */
function mutateKey(operation: string): keyof AdminHandlerOps & string {
  // Ops that share a name with their query counterpart use a ".mutate" suffix
  // in the typed handler so AdminHandlerOps has distinct keys for each.
  switch (operation) {
    case 'health':
      return 'health.mutate';
    case 'backup':
      return 'backup.mutate';
    case 'map':
      return 'map.mutate';
    case 'token':
      return 'token.mutate';
    default:
      return operation as keyof AdminHandlerOps & string;
  }
}

// ---------------------------------------------------------------------------
// AdminHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `admin` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_adminTypedHandler` (a `TypedDomainHandler<AdminHandlerOps>`). This
 * satisfies the registry's `DomainHandler` interface while keeping every
 * param access fully type-safe via the T1426 Wave D adapter.
 */
export class AdminHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only admin query operation.
   *
   * @param operation - The admin query op name (e.g. 'version', 'health').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'admin', operation, startTime);
    }

    // Special case: 'adr.find' returns an envelope with a page property that
    // the typed handler embeds in data; 'help' also needs raw meta passthrough.
    // These are handled in the typed handler itself via lafsSuccess.
    // For 'adr.find' and 'help' we still route through the typed path and
    // let the wrapResult call handle the envelope.

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid admin query op name at this point.
      const envelope = await typedDispatch(_adminTypedHandler, queryKey(operation), params ?? {});
      return wrapResult(envelopeToEngineResult(envelope), 'query', 'admin', operation, startTime);
    } catch (error) {
      getLogger('domain:admin').error(
        { gateway: 'query', domain: 'admin', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'admin', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  /**
   * Execute a state-modifying admin mutation operation.
   *
   * @param operation - The admin mutate op name (e.g. 'init', 'backup').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'admin', operation, startTime);
    }

    // Special cases that need non-standard response shapes.
    // 'adr.sync' may return a success:false response for validation errors
    // but we still want the data; handle it after the typed dispatch.

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid admin mutate op name at this point.
      const envelope = await typedDispatch(_adminTypedHandler, mutateKey(operation), params ?? {});

      // 'adr.sync' validation mode returns success:false with data on failure
      // The original handler preserved this semantics; we replicate it here.
      if (operation === 'adr.sync') {
        // T1434: LafsEnvelope is a discriminated union — `data` only exists
        // on the success arm. Narrow before reading.
        const data = (envelope.success ? envelope.data : undefined) as
          | {
              valid?: boolean;
              errors?: unknown[];
              inserted?: number;
              updated?: number;
              skipped?: number;
            }
          | undefined;
        if (data && 'valid' in data && !data.valid) {
          const errors = Array.isArray(data.errors) ? data.errors : [];
          return {
            meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: false,
            data,
            error: {
              code: 'E_ADR_VALIDATION',
              message: `${errors.length} ADR validation error(s) found`,
            },
          };
        }
        if (data && 'errors' in data && Array.isArray(data.errors) && data.errors.length > 0) {
          return {
            meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: false,
            data,
            error: {
              code: 'E_ADR_SYNC',
              message: `${data.errors.length} ADR sync error(s) occurred`,
            },
          };
        }
      }

      return wrapResult(envelopeToEngineResult(envelope), 'mutate', 'admin', operation, startTime);
    } catch (error) {
      getLogger('domain:admin').error(
        { gateway: 'mutate', domain: 'admin', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'admin', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'version',
        'health',
        'config.show',
        'config.presets',
        'stats',
        'context',
        'context.pull',
        'runtime',
        'paths',
        'job',
        'dash',
        'log',
        'sequence',
        'help',
        'token',
        'adr.show',
        'adr.find',
        'backup',
        'export',
        'map',
        'roadmap',
        'smoke',
        'smoke.provider',
        'hooks.matrix',
      ],
      mutate: [
        'init',
        'scaffold-hub',
        'config.set',
        'config.set-preset',
        'backup',
        'migrate',
        'cleanup',
        'job.cancel',
        'safestop',
        'inject.generate',
        'install.global',
        'token',
        'adr.sync',
        'health',
        'context.inject',
        'import',
        'detect',
        'map',
      ],
    };
  }
}
