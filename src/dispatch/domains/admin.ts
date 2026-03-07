/**
 * Admin Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP system domain operations into the canonical "admin"
 * domain. Handles version, health, config, stats, context, job management,
 * dashboard, log, sequence, init, backup, restore, migrate, sync, cleanup,
 * safestop, and inject.generate.
 *
 * All operations delegate to native engine functions from system-engine,
 * config-engine, and init-engine.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';
import { OPERATIONS } from '../registry.js';

import {
  listAdrs, showAdr, syncAdrsToDb, validateAllAdrs, findAdrs
} from '../../core/adrs/index.js';
import {
  getSyncStatus,
  clearSyncState,
} from '../../core/admin/sync.js';
import { exportTasks } from '../../core/admin/export.js';
import { importTasks } from '../../core/admin/import.js';
import { exportTasksPackage } from '../../core/admin/export-tasks.js';
import { importTasksPackage } from '../../core/admin/import-tasks.js';
import {
  exportSnapshot,
  writeSnapshot,
  readSnapshot,
  importSnapshot,
  getDefaultSnapshotPath,
} from '../../core/snapshot/index.js';
import {
  systemDash,
  systemStats,
  systemLog,
  systemContext,
  systemRuntime,
  systemSequence,
  systemSequenceRepair,
  systemHealth,
  systemDoctor,
  systemFix,
  systemInjectGenerate,
  systemBackup,
  systemRestore,
  backupRestore,
  systemMigrate,
  systemCleanup,
  systemSync,
  systemSafestop,
  configGet,
  configSet,
  getVersion,
  initProject,
} from '../lib/engine.js';

// ---------------------------------------------------------------------------
// AdminHandler
// ---------------------------------------------------------------------------

export class AdminHandler implements DomainHandler {
  private projectRoot: string;

  constructor() {
    this.projectRoot = getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'version': {
          const result = await getVersion(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'health': {
          const result = systemHealth(this.projectRoot, params as { detailed?: boolean } | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'doctor': {
          const result = await systemDoctor(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'config.show': {
          const result = await configGet(this.projectRoot, params?.key as string | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'stats': {
          const result = await systemStats(this.projectRoot, params as { period?: number } | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'context': {
          const result = systemContext(this.projectRoot, params as { session?: string } | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'runtime': {
          const result = await systemRuntime(this.projectRoot, params as { detailed?: boolean } | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'job.status': {
          const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
          const manager = getJobManager();
          if (!manager) {
            return this.errorResponse('query', 'admin', operation, 'E_NOT_AVAILABLE', 'Job manager not initialized', startTime);
          }
          const jobId = params?.jobId as string;
          if (!jobId) {
            return this.errorResponse('query', 'admin', operation, 'E_INVALID_INPUT', 'jobId is required', startTime);
          }
          const job = manager.getJob(jobId);
          if (!job) {
            return this.errorResponse('query', 'admin', operation, 'E_NOT_FOUND', `Job ${jobId} not found`, startTime);
          }
          return this.wrapEngineResult({ success: true, data: job }, 'query', 'admin', operation, startTime);
        }

        case 'job.list': {
          const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
          const mgr = getJobManager();
          if (!mgr) {
            return this.errorResponse('query', 'admin', operation, 'E_NOT_AVAILABLE', 'Job manager not initialized', startTime);
          }
          const statusFilter = params?.status as string | undefined;
          const jobs = mgr.listJobs(statusFilter);
          return this.wrapEngineResult({ success: true, data: { jobs, count: jobs.length } }, 'query', 'admin', operation, startTime);
        }

        case 'dash': {
          const blockedTasksLimit = typeof params?.blockedTasksLimit === 'number'
            ? params.blockedTasksLimit
            : undefined;
          const result = await systemDash(this.projectRoot, { blockedTasksLimit });
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'log': {
          const result = await systemLog(this.projectRoot, params as {
            operation?: string;
            taskId?: string;
            since?: string;
            until?: string;
            limit?: number;
            offset?: number;
          } | undefined);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'sequence': {
          const action = params?.action as string | undefined;
          if (action && action !== 'show' && action !== 'check') {
            return this.errorResponse('query', 'admin', operation, 'E_INVALID_INPUT', 'action must be show or check', startTime);
          }
          const result = await systemSequence(this.projectRoot, { action: action as 'show' | 'check' | undefined });
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'help': {
          const tier = typeof params?.tier === 'number' ? params.tier : 0;
          const verbose = params?.verbose === true;
          const ops = OPERATIONS.filter(op => op.tier <= tier);

          const tierGuidance: Record<number, string> = {
            0: 'Tier 0: Core task and session operations (tasks, session, admin). 80% of use cases.',
            1: 'Tier 1: + memory/research and check/validate operations. 15% of use cases.',
            2: 'Tier 2: Full access including pipeline, orchestrate, tools, nexus. 5% of use cases.',
          };

          // Compact domain-grouped format by default: { domain: { query: [...ops], mutate: [...ops] } }
          const grouped: Record<string, { query: string[]; mutate: string[] }> = {};
          for (const op of ops) {
            if (!grouped[op.domain]) grouped[op.domain] = { query: [], mutate: [] };
            grouped[op.domain][op.gateway].push(op.operation);
          }

          const getCostHint = (domain: string, op: string): 'minimal' | 'moderate' | 'heavy' => {
            const key = `${domain}.${op}`;
            const heavyOps = ['tasks.list', 'tasks.tree', 'admin.log', 'admin.stats', 'tasks.analyze'];
            const moderateOps = ['tasks.show', 'tasks.blockers', 'tasks.depends', 'admin.health', 'admin.dash', 'admin.help'];
            if (heavyOps.includes(key)) return 'heavy';
            if (moderateOps.includes(key)) return 'moderate';
            return 'minimal';
          };

          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: {
              tier,
              operationCount: ops.length,
              quickStart: tier === 0 ? [
                'query tasks.current \u2014 check active task (~100 tokens)',
                'query tasks.next \u2014 get suggestion (~300 tokens)',
                'query tasks.find {query} \u2014 search tasks (~200 tokens)',
                'mutate tasks.start {taskId} \u2014 begin work (~100 tokens)',
                'mutate tasks.complete {taskId} \u2014 finish task (~200 tokens)',
              ] : undefined,
              // Compact grouped by domain by default; pass verbose:true for full object list
              operations: verbose
                ? ops.map(op => ({
                  gateway: op.gateway,
                  domain: op.domain,
                  operation: op.operation,
                  description: op.description,
                  costHint: getCostHint(op.domain, op.operation),
                }))
                : grouped,
              guidance: tierGuidance[tier] ?? tierGuidance[0],
              escalation: tier < 2
                ? `For more operations: query({domain:"admin",operation:"help",params:{tier:${tier + 1}}})`
                : 'Full operation set displayed. Pass verbose:true for detailed object list.',
            },
          };
        }

        case 'adr.list': {
          const result = await listAdrs(this.projectRoot, {
            status: params?.status as string | undefined,
            since: params?.since as string | undefined,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'adr.show': {
          const adrId = params?.adrId as string;
          if (!adrId) {
            return this.errorResponse('query', 'admin', operation, 'E_INVALID_INPUT', 'adrId is required', startTime);
          }
          const adr = await showAdr(this.projectRoot, adrId);
          if (!adr) {
            return this.errorResponse('query', 'admin', operation, 'E_NOT_FOUND', `ADR not found: ${adrId}`, startTime);
          }
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: adr,
          };
        }

        case 'adr.find': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', 'admin', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const result = await findAdrs(this.projectRoot, query, {
            topics: params?.topics as string | undefined,
            keywords: params?.keywords as string | undefined,
            status: params?.status as string | undefined,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'archive.stats': {
          const { getArchiveStats } = await import('../../cli/commands/archive-stats.js');
          const result = await getArchiveStats({
            report: params?.report as 'summary' | 'by-phase' | 'by-label' | 'by-priority' | 'cycle-times' | 'trends' | undefined,
            since: params?.since as string | undefined,
            until: params?.until as string | undefined,
            cwd: this.projectRoot,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'grade': {
          const { gradeSession } = await import('../../core/sessions/session-grade.js');
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return this.errorResponse('query', 'admin', operation, 'E_INVALID_INPUT', 'sessionId required', startTime);
          }
          const result = await gradeSession(sessionId, this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'grade.list': {
          const { readGrades } = await import('../../core/sessions/session-grade.js');
          const result = await readGrades(undefined, this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'sync.status': {
          const result = await getSyncStatus(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'admin', operation, startTime);
        }

        case 'export': {
          const result = await exportTasks({
            format: params?.format as 'json' | 'csv' | 'tsv' | 'markdown' | 'todowrite' | undefined,
            output: params?.output as string | undefined,
            status: params?.status as string | undefined,
            parent: params?.parent as string | undefined,
            phase: params?.phase as string | undefined,
            cwd: this.projectRoot,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'snapshot.export': {
          const snapshot = await exportSnapshot(this.projectRoot);
          const outputPath = (params?.output as string) ?? getDefaultSnapshotPath(this.projectRoot);
          await writeSnapshot(snapshot, outputPath);
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: {
              exported: true,
              taskCount: snapshot._meta.taskCount,
              outputPath,
              checksum: snapshot._meta.checksum,
            },
          };
        }

        case 'export.tasks': {
          const result = await exportTasksPackage({
            taskIds: params?.taskIds as string[] | undefined,
            output: params?.output as string | undefined,
            subtree: params?.subtree as boolean | undefined,
            filter: params?.filter as string[] | undefined,
            includeDeps: params?.includeDeps as boolean | undefined,
            dryRun: params?.dryRun as boolean | undefined,
            cwd: this.projectRoot,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        default:
          return this.unsupported('query', 'admin', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'admin', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'init': {
          const result = await initProject(this.projectRoot, params as { projectName?: string; force?: boolean } | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'fix': {
          const result = await systemFix(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'config.set': {
          const key = params?.key as string;
          if (!key) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'key is required', startTime);
          }
          const result = await configSet(this.projectRoot, key, params?.value);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'backup': {
          const result = systemBackup(this.projectRoot, params as { type?: string; note?: string } | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'restore': {
          const backupId = params?.backupId as string;
          if (!backupId) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'backupId is required', startTime);
          }
          const result = systemRestore(this.projectRoot, { backupId, force: params?.force as boolean | undefined });
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'backup.restore': {
          const file = params?.file as string;
          if (!file) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'file is required', startTime);
          }
          const result = await backupRestore(this.projectRoot, file, {
            dryRun: params?.dryRun as boolean | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'migrate': {
          const result = await systemMigrate(this.projectRoot, params as { target?: string; dryRun?: boolean } | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'sync': {
          const result = systemSync(this.projectRoot, params as { direction?: string } | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'cleanup': {
          const target = params?.target as string;
          if (!target) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'target is required', startTime);
          }
          const result = await systemCleanup(this.projectRoot, {
            target,
            olderThan: params?.olderThan as string | undefined,
            dryRun: params?.dryRun as boolean | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'job.cancel': {
          const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
          const mgr = getJobManager();
          if (!mgr) {
            return this.errorResponse('mutate', 'admin', operation, 'E_NOT_AVAILABLE', 'Job manager not initialized', startTime);
          }
          const jobId = params?.jobId as string;
          if (!jobId) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'jobId is required', startTime);
          }
          const cancelled = mgr.cancelJob(jobId);
          if (!cancelled) {
            return this.errorResponse('mutate', 'admin', operation, 'E_NOT_FOUND', `Job ${jobId} not found or not running`, startTime);
          }
          return this.wrapEngineResult({ success: true, data: { jobId, cancelled: true } }, 'mutate', 'admin', operation, startTime);
        }

        case 'safestop': {
          const result = systemSafestop(this.projectRoot, params as {
            reason?: string;
            commit?: boolean;
            handoff?: string;
            noSessionEnd?: boolean;
            dryRun?: boolean;
          } | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'inject.generate': {
          const result = await systemInjectGenerate(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'sequence': {
          const action = params?.action as string | undefined;
          if (action !== 'repair') {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'action must be repair', startTime);
          }
          const result = await systemSequenceRepair(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'adr.sync': {
          const result = await syncAdrsToDb(this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'adr.validate': {
          const result = await validateAllAdrs(this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: result.valid,
            data: result,
            ...(result.valid ? {} : { error: { code: 'E_ADR_VALIDATION', message: `${result.errors.length} ADR validation error(s) found` } }),
          };
        }

        case 'sync.clear': {
          const result = await clearSyncState(this.projectRoot, params?.dryRun as boolean | undefined);
          return this.wrapEngineResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'import': {
          const file = params?.file as string;
          if (!file) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'file is required', startTime);
          }
          const result = await importTasks({
            file,
            parent: params?.parent as string | undefined,
            phase: params?.phase as string | undefined,
            onDuplicate: params?.onDuplicate as 'skip' | 'overwrite' | 'rename' | undefined,
            addLabel: params?.addLabel as string | undefined,
            dryRun: params?.dryRun as boolean | undefined,
            cwd: this.projectRoot,
          });
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'snapshot.import': {
          const file = params?.file as string;
          if (!file) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'file is required', startTime);
          }
          const snapshot = await readSnapshot(file);
          if (params?.dryRun) {
            return {
              _meta: dispatchMeta('mutate', 'admin', operation, startTime),
              success: true,
              data: {
                dryRun: true,
                source: snapshot._meta.source,
                taskCount: snapshot._meta.taskCount,
                createdAt: snapshot._meta.createdAt,
              },
            };
          }
          const result = await importSnapshot(snapshot, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: true,
            data: {
              imported: true,
              added: result.added,
              updated: result.updated,
              skipped: result.skipped,
              conflicts: result.conflicts.length > 0 ? result.conflicts : undefined,
            },
          };
        }

        case 'import.tasks': {
          const file = params?.file as string;
          if (!file) {
            return this.errorResponse('mutate', 'admin', operation, 'E_INVALID_INPUT', 'file is required', startTime);
          }
          const result = await importTasksPackage({
            file,
            dryRun: params?.dryRun as boolean | undefined,
            parent: params?.parent as string | undefined,
            phase: params?.phase as string | undefined,
            addLabel: params?.addLabel as string | undefined,
            provenance: params?.provenance as boolean | undefined,
            resetStatus: params?.resetStatus as 'pending' | 'active' | 'blocked' | undefined,
            onConflict: params?.onConflict as 'duplicate' | 'rename' | 'skip' | 'fail' | undefined,
            onMissingDep: params?.onMissingDep as 'strip' | 'placeholder' | 'fail' | undefined,
            force: params?.force as boolean | undefined,
            cwd: this.projectRoot,
          });
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'detect': {
          const { ensureProjectContext, ensureContributorMcp } = await import('../../core/scaffold.js');
          const contextResult = await ensureProjectContext(this.projectRoot, { force: true });
          const mcpResult = await ensureContributorMcp(this.projectRoot);
          return this.wrapEngineResult({
            success: true,
            data: { context: contextResult, mcp: mcpResult },
          }, 'mutate', 'admin', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'admin', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'admin', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'version', 'health', 'doctor', 'config.show', 'stats', 'context',
        'runtime', 'job.status', 'job.list', 'dash', 'log', 'sequence', 'help',
        'adr.list', 'adr.show', 'adr.find', 'grade', 'grade.list', 'archive.stats',
        'sync.status', 'export', 'snapshot.export', 'export.tasks',
      ],
      mutate: [
        'init', 'fix', 'config.set', 'backup', 'restore', 'backup.restore', 'migrate',
        'sync', 'sync.clear', 'cleanup', 'job.cancel', 'safestop', 'inject.generate', 'sequence',
        'adr.sync', 'adr.validate', 'import', 'snapshot.import', 'import.tasks', 'detect',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; fix?: string; alternatives?: Array<{ action: string; command: string }> } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? {
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details as Record<string, unknown> | undefined,
          fix: result.error.fix,
          alternatives: result.error.alternatives,
        }
      } : {}),
    };
  }

  private unsupported(gateway: string, domain: string, operation: string, startTime: number): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INVALID_OPERATION', message: `Unknown ${domain} ${gateway}: ${operation}` },
    };
  }

  private errorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(gateway: string, domain: string, operation: string, error: unknown, startTime: number): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:admin').error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
