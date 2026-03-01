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

import { listAdrs, showAdr, syncAdrsToDb, validateAllAdrs, findAdrs } from '../../core/adrs/index.js';
import {
  systemDash,
  systemStats,
  systemLog,
  systemContext,
  systemRuntime,
  systemSequence,
  systemSequenceRepair,
  systemHealth,
  systemInjectGenerate,
  systemBackup,
  systemRestore,
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

        case 'config.show':
        case 'config.get': {
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
          const result = await systemDash(this.projectRoot);
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
          const ops = OPERATIONS.filter(op => op.tier <= tier);

          const getCostHint = (domain: string, op: string): 'minimal' | 'moderate' | 'heavy' => {
            const key = `${domain}.${op}`;
            const heavyOps = ['tasks.list', 'tasks.tree', 'admin.log', 'admin.stats', 'tasks.analyze'];
            const moderateOps = ['tasks.show', 'tasks.blockers', 'tasks.depends', 'admin.health', 'admin.dash', 'admin.help'];
            if (heavyOps.includes(key)) return 'heavy';
            if (moderateOps.includes(key)) return 'moderate';
            return 'minimal';
          };

          const tierGuidance: Record<number, string> = {
            0: 'Tier 0: Core task and session operations (tasks, session, admin). 80% of use cases.',
            1: 'Tier 1: + memory/research and check/validate operations. 15% of use cases.',
            2: 'Tier 2: Full access including pipeline, orchestrate, tools, nexus. 5% of use cases.',
          };
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: {
              tier,
              operationCount: ops.length,
              quickStart: tier === 0 ? [
                'cleo_query tasks.current \u2014 check active task (~100 tokens)',
                'cleo_query tasks.next \u2014 get suggestion (~300 tokens)',
                'cleo_query tasks.find {query} \u2014 search tasks (~200 tokens)',
                'cleo_mutate tasks.start {taskId} \u2014 begin work (~100 tokens)',
                'cleo_mutate tasks.complete {taskId} \u2014 finish task (~200 tokens)',
              ] : undefined,
              operations: ops.map(op => ({
                gateway: op.gateway,
                domain: op.domain,
                operation: op.operation,
                description: op.description,
                costHint: getCostHint(op.domain, op.operation),
              })),
              guidance: tierGuidance[tier] ?? tierGuidance[0],
              escalation: tier < 2
                ? `For more operations: cleo_query({domain:"admin",operation:"help",params:{tier:${tier + 1}}})`
                : 'Full operation set displayed.',
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

        case 'migrate': {
          const result = systemMigrate(this.projectRoot, params as { target?: string; dryRun?: boolean } | undefined);
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
          const result = systemCleanup(this.projectRoot, {
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
        'version', 'health', 'config.show', 'config.get', 'stats', 'context',
        'runtime', 'job.status', 'job.list', 'dash', 'log', 'sequence', 'help',
        'adr.list', 'adr.show', 'adr.find', 'grade', 'grade.list',
      ],
      mutate: [
        'init', 'config.set', 'backup', 'restore', 'migrate',
        'sync', 'cleanup', 'job.cancel', 'safestop', 'inject.generate', 'sequence',
        'adr.sync', 'adr.validate',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? { error: { code: result.error.code, message: result.error.message, details: result.error.details as Record<string, unknown> | undefined } } : {}),
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
