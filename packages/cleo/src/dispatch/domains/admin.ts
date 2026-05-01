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
 * Param extraction is type-safe via OpsFromCore<typeof coreAdmin.adminCoreOps>.
 * Zero `as any` / `as X` param casts.
 *
 * @epic T4820
 * @task T5671
 * @task T1426 — typed-dispatch migration
 * @task T1437 — Core-derived OpsFromCore inference
 */

import type { admin as coreAdmin } from '@cleocode/core';
import {
  checkSequence,
  cleanupSystem,
  clearTokenUsage,
  computeHelp,
  coreDoctorReport,
  deleteTokenUsage,
  ensureCleoOsHub,
  exportSnapshot,
  exportTasks,
  exportTasksPackage,
  fileRestore,
  findAdrs,
  generateInjection,
  getAccessor,
  getContextWindow,
  getDashboard,
  getDefaultSnapshotPath,
  getLogger,
  getMigrationStatus,
  getProjectRoot,
  getProjectStatsExtended,
  getRoadmap,
  getRuntimeDiagnostics,
  getSystemHealth,
  getSystemPaths,
  importSnapshot,
  importTasks,
  importTasksPackage,
  listAdrs,
  listSystemBackups,
  listTokenUsage,
  paginate,
  queryAuditLog,
  readSnapshot,
  recordTokenExchange,
  restoreBackup,
  runDoctorFixes,
  safestop,
  showAdr,
  showSequence,
  showTokenUsage,
  summarizeTokenUsage,
  syncAdrsToDb,
  systemCreateBackup,
  validateAllAdrs,
  writeSnapshot,
} from '@cleocode/core/internal';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import {
  configGet,
  configListPresets,
  configSet,
  configSetPreset,
  getVersion,
  initProject,
  sessionContextInject,
  systemHooksMatrix,
} from '../lib/engine.js';
import { OPERATIONS } from '../registry.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { getListParams, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

type AdminOps = OpsFromCore<typeof coreAdmin.adminCoreOps>;

// ---------------------------------------------------------------------------
// Smoke test helpers (Q3: systemSmoke inlined here — uses dispatchRaw which
// would create core→cleo circular dep if moved to core)
// ---------------------------------------------------------------------------

/** Result for a single domain smoke probe. */
interface SmokeProbe {
  domain: string;
  operation: string;
  status: 'pass' | 'fail' | 'skip';
  timeMs: number;
  error?: string;
}

/** Aggregate smoke test result. */
interface SmokeResult {
  probes: SmokeProbe[];
  dbChecks: SmokeProbe[];
  passed: number;
  failed: number;
  skipped: number;
  totalMs: number;
}

const SMOKE_PROBES: Array<{ domain: string; operation: string; params?: Record<string, unknown> }> =
  [
    { domain: 'admin', operation: 'version' },
    { domain: 'tasks', operation: 'find', params: { query: '__smoke_probe__', limit: 1 } },
    { domain: 'session', operation: 'status' },
    { domain: 'memory', operation: 'find', params: { query: '__smoke_probe__' } },
    { domain: 'pipeline', operation: 'list' },
    { domain: 'check', operation: 'schema' },
    { domain: 'tools', operation: 'list', params: { limit: 1 } },
    { domain: 'sticky', operation: 'list', params: { limit: 1 } },
    { domain: 'nexus', operation: 'status' },
    { domain: 'orchestrate', operation: 'status' },
    { domain: 'adapter', operation: 'list' },
  ];

/**
 * Run operational smoke tests across all domains.
 *
 * Inlined from system-engine.ts (Q3 decision: cannot move to core because
 * it imports `dispatchRaw` from the cleo adapter layer, which would create
 * a core→cleo circular dependency).
 *
 * @returns Aggregate smoke result with per-domain probe outcomes
 */
async function runSystemSmoke(): Promise<SmokeResult> {
  const { dispatchRaw } = await import('../adapters/cli.js');
  const totalStart = Date.now();
  const probes: SmokeProbe[] = [];

  for (const probe of SMOKE_PROBES) {
    const start = Date.now();
    try {
      const response = await dispatchRaw('query', probe.domain, probe.operation, probe.params);
      const elapsed = Date.now() - start;
      if (response.success) {
        probes.push({
          domain: probe.domain,
          operation: probe.operation,
          status: 'pass',
          timeMs: elapsed,
        });
      } else {
        const code = response.error?.code ?? '';
        const isCrash = code === 'E_INTERNAL' || code === 'E_NO_HANDLER';
        probes.push({
          domain: probe.domain,
          operation: probe.operation,
          status: isCrash ? 'fail' : 'pass',
          timeMs: elapsed,
          ...(isCrash ? { error: response.error?.message } : {}),
        });
      }
    } catch (err) {
      probes.push({
        domain: probe.domain,
        operation: probe.operation,
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
      });
    }
  }

  const dbChecks: SmokeProbe[] = [];

  // tasks.db connectivity + integrity
  {
    const start = Date.now();
    try {
      const { getDb, getNativeDb } = await import('@cleocode/core/internal');
      const projectRoot = getProjectRoot();
      await getDb(projectRoot);
      const nativeDb = getNativeDb();
      if (nativeDb) {
        const result = nativeDb.prepare('PRAGMA integrity_check').get() as
          | Record<string, unknown>
          | undefined;
        const ok = result?.integrity_check === 'ok';
        dbChecks.push({
          domain: 'db',
          operation: 'tasks.db',
          status: ok ? 'pass' : 'fail',
          timeMs: Date.now() - start,
          ...(!ok ? { error: 'SQLite integrity check failed' } : {}),
        });
      } else {
        dbChecks.push({
          domain: 'db',
          operation: 'tasks.db',
          status: 'fail',
          timeMs: Date.now() - start,
          error: 'Native DB handle unavailable',
        });
      }
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'tasks.db',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // brain.db connectivity
  {
    const start = Date.now();
    try {
      const { getBrainDb } = await import('@cleocode/core/internal');
      const projectRoot = getProjectRoot();
      const brainDb = await getBrainDb(projectRoot);
      if (brainDb) {
        dbChecks.push({
          domain: 'db',
          operation: 'brain.db',
          status: 'pass',
          timeMs: Date.now() - start,
        });
      } else {
        dbChecks.push({
          domain: 'db',
          operation: 'brain.db',
          status: 'fail',
          timeMs: Date.now() - start,
          error: 'brain.db not initialized',
        });
      }
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'brain.db',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Migration state validation
  {
    const start = Date.now();
    try {
      const migrationStatus = await getMigrationStatus(getProjectRoot());
      const hasPending = migrationStatus.migrations.some(
        (m) => !(m as Record<string, unknown>).applied,
      );
      dbChecks.push({
        domain: 'db',
        operation: 'migrations',
        status: hasPending ? 'fail' : 'pass',
        timeMs: Date.now() - start,
        ...(hasPending
          ? {
              error: `Unapplied migrations detected (${migrationStatus.from} → ${migrationStatus.to}). Run: cleo upgrade`,
            }
          : {}),
      });
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'migrations',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allProbes = [...probes, ...dbChecks];
  const totalMs = Date.now() - totalStart;
  const passed = allProbes.filter((p) => p.status === 'pass').length;
  const failed = allProbes.filter((p) => p.status === 'fail').length;
  const skipped = allProbes.filter((p) => p.status === 'skip').length;

  return { probes, dbChecks, passed, failed, skipped, totalMs };
}

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1426, Core-derived · T1437)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _adminTypedHandler = defineTypedHandler<AdminOps>('admin', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  version: async (_params) => {
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

  health: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.mode === 'diagnose') {
      try {
        const data = await coreDoctorReport(projectRoot);
        return lafsSuccess(
          data ?? { healthy: false, errors: 0, warnings: 0, checks: [] },
          'health',
        );
      } catch (err) {
        return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), 'health');
      }
    }
    try {
      const data = await getSystemHealth(projectRoot, { detailed: params.detailed });
      return lafsSuccess(
        data ?? { overall: 'error', checks: [], version: '', installation: 'degraded' },
        'health',
      );
    } catch (err) {
      return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), 'health');
    }
  },

  'config.show': async (params) => {
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

  'config.presets': async (_params) => {
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

  stats: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await getProjectStatsExtended(projectRoot, { period: params.period });
      return lafsSuccess(data, 'stats');
    } catch (err) {
      return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), 'stats');
    }
  },

  context: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = getContextWindow(
        projectRoot,
        params.session !== undefined ? { session: params.session } : undefined,
      );
      return lafsSuccess(data, 'context');
    } catch (err) {
      return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), 'context');
    }
  },

  'context.pull': async (params) => {
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

  runtime: async (params) => {
    try {
      const data = await getRuntimeDiagnostics({ detailed: params.detailed ?? false });
      return lafsSuccess(data, 'runtime');
    } catch (err) {
      return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), 'runtime');
    }
  },

  paths: async (_params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = getSystemPaths(projectRoot);
      return lafsSuccess(data, 'paths');
    } catch (err) {
      return lafsError(
        'E_PATHS_RESOLVE_FAILED',
        err instanceof Error ? err.message : String(err),
        'paths',
      );
    }
  },

  job: async (params) => {
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

  dash: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const accessor = await getAccessor(projectRoot);
      const raw = await getDashboard(
        { cwd: projectRoot, blockedTasksLimit: params.blockedTasksLimit },
        accessor,
      );
      const data = raw as Record<string, unknown>;
      const summary = data.summary as Record<string, number>;
      return lafsSuccess(
        {
          project: data.project as string,
          currentPhase: data.currentPhase as string | null,
          summary: {
            pending: summary.pending,
            active: summary.active,
            blocked: summary.blocked,
            done: summary.done,
            cancelled: summary.cancelled ?? 0,
            total: summary.total,
            archived: summary.archived ?? 0,
            grandTotal: summary.grandTotal ?? summary.total,
          },
          taskWork: (data.focus ?? data.taskWork) as Record<string, unknown>,
          activeSession: (data.activeSession as string | null) ?? null,
          highPriority: data.highPriority as Record<string, unknown>,
          blockedTasks: data.blockedTasks as Record<string, unknown>,
          recentCompletions: (data.recentCompletions ?? []) as unknown[],
          topLabels: data.topLabels as unknown[],
        },
        'dash',
      );
    } catch (err) {
      return lafsError(
        'E_NOT_INITIALIZED',
        err instanceof Error ? err.message : String(err),
        'dash',
      );
    }
  },

  log: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await queryAuditLog(projectRoot, {
        operation: params.operation,
        taskId: params.taskId,
        since: params.since,
        until: params.until,
        limit: params.limit,
        offset: params.offset,
      });
      return lafsSuccess(data, 'log');
    } catch (err) {
      return lafsError('E_FILE_ERROR', err instanceof Error ? err.message : String(err), 'log');
    }
  },

  sequence: async (params) => {
    const projectRoot = getProjectRoot();
    const action = params.action;
    if (action && action !== 'show' && action !== 'check') {
      return lafsError('E_INVALID_INPUT', 'action must be show or check', 'sequence');
    }
    try {
      if (action === 'check') {
        const data = await checkSequence(projectRoot);
        return lafsSuccess(data, 'sequence');
      }
      const seq = await showSequence(projectRoot);
      return lafsSuccess(
        {
          counter: Number(seq.counter ?? 0),
          lastId: String(seq.lastId ?? ''),
          checksum: String(seq.checksum ?? ''),
          nextId: String(seq.nextId ?? ''),
        },
        'sequence',
      );
    } catch (err) {
      return lafsError('E_NOT_FOUND', err instanceof Error ? err.message : String(err), 'sequence');
    }
  },

  help: async (params) => {
    const tier = params.tier ?? 0;
    const verbose = params.verbose === true;
    const helpResult = computeHelp(OPERATIONS, tier, verbose);
    return lafsSuccess(helpResult, 'help');
  },

  'adr.find': async (params) => {
    const projectRoot = getProjectRoot();
    if (params.query) {
      const result = await findAdrs(projectRoot, params);
      return lafsSuccess(result, 'adr.find');
    }
    // No query — list all ADRs
    const { limit, offset } = getListParams({ limit: params.limit, offset: params.offset });
    const result = await listAdrs(projectRoot, { ...params, limit, offset });
    return lafsSuccess(
      {
        ...result,
        page: paginate(Array.from({ length: result.filtered }), limit, offset).page,
      },
      'adr.find',
    );
  },

  'adr.show': async (params) => {
    const projectRoot = getProjectRoot();
    const adr = await showAdr(projectRoot, params);
    if (!adr) {
      return lafsError('E_NOT_FOUND', `ADR not found: ${params.adrId}`, 'adr.show');
    }
    return lafsSuccess(adr, 'adr.show');
  },

  token: async (params) => {
    const projectRoot = getProjectRoot();
    const action = params.action ?? 'summary';

    if (action === 'show') {
      const tokenId = params.tokenId;
      if (!tokenId) {
        return lafsError('E_INVALID_INPUT', 'tokenId is required', 'token');
      }
      const result = await showTokenUsage(projectRoot, { id: tokenId });
      if (!result) {
        return lafsError('E_NOT_FOUND', `Token usage record not found: ${tokenId}`, 'token');
      }
      return lafsSuccess(result, 'token');
    }

    if (action === 'list') {
      const { limit, offset } = getListParams({ limit: params.limit, offset: params.offset });
      const result = await listTokenUsage(projectRoot, {
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
      });
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
    const result = await summarizeTokenUsage(projectRoot, {
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
    });
    return lafsSuccess(result, 'token');
  },

  backup: async (_params) => {
    const projectRoot = getProjectRoot();
    try {
      const backups = listSystemBackups(projectRoot);
      return lafsSuccess({ backups, count: backups.length }, 'backup');
    } catch (err) {
      return lafsError('E_GENERAL', err instanceof Error ? err.message : String(err), 'backup');
    }
  },

  export: async (params) => {
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
      const result = await exportTasksPackage(projectRoot, params);
      return lafsSuccess(result, 'export');
    }
    // Default: standard export
    const result = await exportTasks(projectRoot, params);
    return lafsSuccess(result, 'export');
  },

  map: async (params) => {
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

  roadmap: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const accessor = await getAccessor(projectRoot);
      const data = await getRoadmap(
        {
          includeHistory: params.includeHistory,
          upcomingOnly: params.upcomingOnly,
          cwd: projectRoot,
        },
        accessor,
      );
      return lafsSuccess(data, 'roadmap');
    } catch (err) {
      return lafsError(
        'E_NOT_INITIALIZED',
        err instanceof Error ? err.message : String(err),
        'roadmap',
      );
    }
  },

  smoke: async (_params) => {
    const smokeResult = await runSystemSmoke();
    if (smokeResult.failed === 0) {
      return lafsSuccess(smokeResult, 'smoke');
    }
    return lafsError(
      'E_SMOKE_FAILURES',
      `${smokeResult.failed} probe(s) failed smoke test`,
      'smoke',
    );
  },

  'smoke.provider': async (params) => {
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

  'hooks.matrix': async (params) => {
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

  init: async (params) => {
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

  'scaffold-hub': async (_params) => {
    try {
      const data = await ensureCleoOsHub();
      return lafsSuccess(data, 'scaffold-hub');
    } catch (err) {
      return lafsError(
        'E_SCAFFOLD_HUB_FAILED',
        err instanceof Error ? err.message : String(err),
        'scaffold-hub',
      );
    }
  },

  'health.mutate': async (params) => {
    const projectRoot = getProjectRoot();
    if (params.mode === 'diagnose') {
      try {
        const data = await coreDoctorReport(projectRoot);
        return lafsSuccess(
          data ?? { healthy: false, errors: 0, warnings: 0, checks: [] },
          'health.mutate',
        );
      } catch (err) {
        return lafsError(
          'E_INTERNAL',
          err instanceof Error ? err.message : String(err),
          'health.mutate',
        );
      }
    }
    try {
      const data = await runDoctorFixes(projectRoot);
      return lafsSuccess(data, 'health.mutate');
    } catch (err) {
      return lafsError(
        'E_INTERNAL',
        err instanceof Error ? err.message : String(err),
        'health.mutate',
      );
    }
  },

  'config.set': async (params) => {
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

  'config.set-preset': async (params) => {
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

  'backup.mutate': async (params) => {
    const projectRoot = getProjectRoot();
    const action = params.action;

    if (action === 'restore') {
      const backupId = params.backupId;
      if (!backupId) {
        return lafsError('E_INVALID_INPUT', 'backupId is required', 'backup.mutate');
      }
      try {
        const data = restoreBackup(projectRoot, { backupId, force: params.force });
        return lafsSuccess(data, 'backup.mutate');
      } catch (err) {
        return lafsError(
          'E_RESTORE_FAILED',
          err instanceof Error ? err.message : String(err),
          'backup.mutate',
        );
      }
    }

    if (action === 'restore.file') {
      const file = params.file;
      if (!file) {
        return lafsError('E_INVALID_INPUT', 'file is required', 'backup.mutate');
      }
      try {
        const data = await fileRestore(projectRoot, file, { dryRun: params.dryRun });
        return lafsSuccess(data, 'backup.mutate');
      } catch (err) {
        return lafsError(
          'E_GENERAL',
          err instanceof Error ? err.message : String(err),
          'backup.mutate',
        );
      }
    }

    // Default: create backup
    try {
      const data = await systemCreateBackup(projectRoot, { type: params.type, note: params.note });
      return lafsSuccess(data, 'backup.mutate');
    } catch (err) {
      return lafsError(
        'E_GENERAL',
        err instanceof Error ? err.message : String(err),
        'backup.mutate',
      );
    }
  },

  migrate: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await getMigrationStatus(projectRoot, {
        target: params.target,
        dryRun: params.dryRun,
      });
      return lafsSuccess(data, 'migrate');
    } catch (err) {
      return lafsError(
        'E_MIGRATE_FAILED',
        err instanceof Error ? err.message : String(err),
        'migrate',
      );
    }
  },

  cleanup: async (params) => {
    const projectRoot = getProjectRoot();
    // Runtime guard: target is declared required in the contract but the
    // dispatcher may pass an empty object when the caller omits it.
    if (!params.target) {
      return lafsError('E_INVALID_INPUT', 'target is required', 'cleanup');
    }
    try {
      const data = await cleanupSystem(projectRoot, {
        target: params.target,
        olderThan: params.olderThan,
        dryRun: params.dryRun,
      });
      return lafsSuccess(data, 'cleanup');
    } catch (err) {
      return lafsError(
        'E_CLEANUP_FAILED',
        err instanceof Error ? err.message : String(err),
        'cleanup',
      );
    }
  },

  'job.cancel': async (params) => {
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

  safestop: async (params) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await safestop(projectRoot, {
        reason: params.reason,
        commit: params.commit,
        handoff: params.handoff,
        noSessionEnd: params.noSessionEnd,
        dryRun: params.dryRun,
      });
      return lafsSuccess(data, 'safestop');
    } catch (err) {
      return lafsError('E_GENERAL', err instanceof Error ? err.message : String(err), 'safestop');
    }
  },

  'inject.generate': async (_params) => {
    const projectRoot = getProjectRoot();
    try {
      const accessor = await getAccessor(projectRoot);
      const data = await generateInjection(projectRoot, accessor);
      return lafsSuccess(data, 'inject.generate');
    } catch (err) {
      return lafsError(
        'E_GENERAL',
        err instanceof Error ? err.message : String(err),
        'inject.generate',
      );
    }
  },

  'adr.sync': async (params) => {
    const projectRoot = getProjectRoot();
    if (params.validate) {
      const result = await validateAllAdrs(projectRoot);
      return lafsSuccess(result, 'adr.sync');
    }
    const result = await syncAdrsToDb(projectRoot);
    return lafsSuccess(result, 'adr.sync');
  },

  import: async (params) => {
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
      const result = await importTasksPackage(projectRoot, params);
      return lafsSuccess(result, 'import');
    }

    // Default: standard import
    const result = await importTasks(projectRoot, params);
    return lafsSuccess(result, 'import');
  },

  detect: async (_params) => {
    const projectRoot = getProjectRoot();
    const { ensureProjectContext, ensureContributorMcp: ensureContributorDev } = await import(
      '@cleocode/core/internal'
    );
    const contextResult = await ensureProjectContext(projectRoot, { force: true });
    const devResult = await ensureContributorDev(projectRoot);
    return lafsSuccess({ context: contextResult, devChannel: devResult }, 'detect');
  },

  'token.mutate': async (params) => {
    const projectRoot = getProjectRoot();
    const action = params.action ?? 'record';

    if (action === 'delete') {
      const tokenId = params.tokenId;
      if (!tokenId) {
        return lafsError('E_INVALID_INPUT', 'tokenId is required', 'token.mutate');
      }
      const result = await deleteTokenUsage(projectRoot, { id: tokenId });
      return lafsSuccess(result, 'token.mutate');
    }

    if (action === 'clear') {
      const result = await clearTokenUsage(projectRoot, {
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
      });
      return lafsSuccess(result, 'token.mutate');
    }

    // Default: record
    const result = await recordTokenExchange(projectRoot, {
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
    });
    return lafsSuccess(result, 'token.mutate');
  },

  'context.inject': async (params) => {
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

  'map.mutate': async (params) => {
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

  'install.global': async (_params) => {
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
// "map.mutate", "token.mutate") to avoid key collisions in AdminOps.
// These maps translate the incoming operation name to the correct handler key.
// ---------------------------------------------------------------------------

/** Query gateway: operation name → AdminOps key. Defaults to identity. */
function queryKey(operation: string): keyof AdminOps & string {
  // All query ops map directly (no suffix needed for query side)
  return operation as keyof AdminOps & string;
}

/** Mutate gateway: operation name → AdminOps key. */
function mutateKey(operation: string): keyof AdminOps & string {
  // Ops that share a name with their query counterpart use a ".mutate" suffix
  // in the typed handler so AdminOps has distinct keys for each.
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
      return operation as keyof AdminOps & string;
  }
}

// ---------------------------------------------------------------------------
// AdminHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `admin` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_adminTypedHandler` (a `TypedDomainHandler<AdminOps>`). This
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
