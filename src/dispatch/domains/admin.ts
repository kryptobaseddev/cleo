/**
 * Admin Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP system domain operations into the canonical "admin"
 * domain. Handles version, health, config, stats, context, job management,
 * dashboard, log, sequence, init, backup, restore, migrate, cleanup,
 * safestop, inject.generate, token, adr, export, import, install.global,
 * and context.inject.
 *
 * All operations delegate to native engine functions from system-engine,
 * config-engine, and init-engine.
 *
 * @epic T4820
 * @task T5671
 */

import { exportTasks } from '../../core/admin/export.js';
import { exportTasksPackage } from '../../core/admin/export-tasks.js';
import { importTasks } from '../../core/admin/import.js';
import { importTasksPackage } from '../../core/admin/import-tasks.js';
import {
  findAdrs,
  listAdrs,
  showAdr,
  syncAdrsToDb,
  validateAllAdrs,
} from '../../core/adrs/index.js';
import { getLogger } from '../../core/logger.js';
import {
  clearTokenUsage,
  deleteTokenUsage,
  listTokenUsage,
  recordTokenExchange,
  showTokenUsage,
  summarizeTokenUsage,
} from '../../core/metrics/token-service.js';
import { paginate } from '../../core/pagination.js';
import { getProjectRoot } from '../../core/paths.js';
import {
  exportSnapshot,
  getDefaultSnapshotPath,
  importSnapshot,
  readSnapshot,
  writeSnapshot,
} from '../../core/snapshot/index.js';
import {
  backupRestore,
  configGet,
  configSet,
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
  systemInjectGenerate,
  systemLog,
  systemMigrate,
  systemRestore,
  systemRuntime,
  systemSafestop,
  systemSequence,
  systemStats,
} from '../lib/engine.js';
import { OPERATIONS } from '../registry.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  errorResult,
  getListParams,
  handleErrorResult,
  unsupportedOp,
  wrapResult,
} from './_base.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'version': {
          const result = await getVersion(this.projectRoot);
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'health': {
          const mode = params?.mode as string | undefined;
          if (mode === 'diagnose') {
            const result = await systemDoctor(this.projectRoot);
            return wrapResult(result, 'query', 'admin', operation, startTime);
          }
          const result = systemHealth(
            this.projectRoot,
            params as { detailed?: boolean } | undefined,
          );
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'config.show': {
          const result = await configGet(this.projectRoot, params?.key as string | undefined);
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'stats': {
          const result = await systemStats(
            this.projectRoot,
            params as { period?: number } | undefined,
          );
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'context': {
          const result = systemContext(
            this.projectRoot,
            params as { session?: string } | undefined,
          );
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'runtime': {
          const result = await systemRuntime(
            this.projectRoot,
            params as { detailed?: boolean } | undefined,
          );
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        // Merged: job.status + job.list → job via action param (T5615)
        case 'job': {
          return routeByParam<Promise<DispatchResponse>>(
            params,
            'action',
            {
              status: async (): Promise<DispatchResponse> => {
                const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
                const manager = getJobManager();
                if (!manager) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_NOT_AVAILABLE',
                    'Job manager not initialized',
                    startTime,
                  );
                }
                const jobId = params?.jobId as string;
                if (!jobId) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_INVALID_INPUT',
                    'jobId is required',
                    startTime,
                  );
                }
                const job = manager.getJob(jobId);
                if (!job) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_NOT_FOUND',
                    `Job ${jobId} not found`,
                    startTime,
                  );
                }
                return wrapResult(
                  { success: true, data: job },
                  'query',
                  'admin',
                  operation,
                  startTime,
                );
              },
              list: async (): Promise<DispatchResponse> => {
                const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
                const mgr = getJobManager();
                if (!mgr) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_NOT_AVAILABLE',
                    'Job manager not initialized',
                    startTime,
                  );
                }
                const statusFilter = params?.status as string | undefined;
                const { limit, offset } = getListParams(params);
                const allJobs = mgr.listJobs();
                const filteredJobs = statusFilter ? mgr.listJobs(statusFilter) : allJobs;
                const page = paginate(filteredJobs, limit, offset);
                return wrapResult(
                  {
                    success: true,
                    data: {
                      jobs: page.items,
                      count: filteredJobs.length,
                      total: allJobs.length,
                      filtered: filteredJobs.length,
                    },
                    page: page.page,
                  },
                  'query',
                  'admin',
                  operation,
                  startTime,
                );
              },
            },
            'status',
          );
        }

        case 'dash': {
          const blockedTasksLimit =
            typeof params?.blockedTasksLimit === 'number' ? params.blockedTasksLimit : undefined;
          const result = await systemDash(this.projectRoot, { blockedTasksLimit });
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'log': {
          const result = await systemLog(
            this.projectRoot,
            params as
              | {
                  operation?: string;
                  taskId?: string;
                  since?: string;
                  until?: string;
                  limit?: number;
                  offset?: number;
                }
              | undefined,
          );
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'sequence': {
          const action = params?.action as string | undefined;
          if (action && action !== 'show' && action !== 'check') {
            return errorResult(
              'query',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'action must be show or check',
              startTime,
            );
          }
          const result = await systemSequence(this.projectRoot, {
            action: action as 'show' | 'check' | undefined,
          });
          return wrapResult(result, 'query', 'admin', operation, startTime);
        }

        case 'help': {
          const tier = typeof params?.tier === 'number' ? params.tier : 0;
          const verbose = params?.verbose === true;
          const ops = OPERATIONS.filter((op) => op.tier <= tier);

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
            const heavyOps = [
              'tasks.list',
              'tasks.tree',
              'admin.log',
              'admin.stats',
              'tasks.analyze',
            ];
            const moderateOps = [
              'tasks.show',
              'tasks.blockers',
              'tasks.depends',
              'admin.health',
              'admin.dash',
              'admin.help',
            ];
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
              quickStart:
                tier === 0
                  ? [
                      'query tasks.current \u2014 check active task (~100 tokens)',
                      'query tasks.next \u2014 get suggestion (~300 tokens)',
                      'query tasks.find {query} \u2014 search tasks (~200 tokens)',
                      'mutate tasks.start {taskId} \u2014 begin work (~100 tokens)',
                      'mutate tasks.complete {taskId} \u2014 finish task (~200 tokens)',
                    ]
                  : undefined,
              // Compact grouped by domain by default; pass verbose:true for full object list
              operations: verbose
                ? ops.map((op) => ({
                    gateway: op.gateway,
                    domain: op.domain,
                    operation: op.operation,
                    description: op.description,
                    costHint: getCostHint(op.domain, op.operation),
                  }))
                : grouped,
              guidance: tierGuidance[tier] ?? tierGuidance[0],
              escalation:
                tier < 2
                  ? `For more operations: query({domain:"admin",operation:"help",params:{tier:${tier + 1}}})`
                  : 'Full operation set displayed. Pass verbose:true for detailed object list.',
            },
          };
        }

        case 'adr.find': {
          const query = params?.query as string | undefined;
          if (query) {
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
          // No query — list all ADRs
          const { limit, offset } = getListParams(params);
          const result = await listAdrs(this.projectRoot, {
            status: params?.status as string | undefined,
            since: params?.since as string | undefined,
            limit,
            offset,
          });
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: result,
            page: paginate(Array.from({ length: result.filtered }), limit, offset).page,
          };
        }

        case 'adr.show': {
          const adrId = params?.adrId as string;
          if (!adrId) {
            return errorResult(
              'query',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'adrId is required',
              startTime,
            );
          }
          const adr = await showAdr(this.projectRoot, adrId);
          if (!adr) {
            return errorResult(
              'query',
              'admin',
              operation,
              'E_NOT_FOUND',
              `ADR not found: ${adrId}`,
              startTime,
            );
          }
          return {
            _meta: dispatchMeta('query', 'admin', operation, startTime),
            success: true,
            data: adr,
          };
        }

        // Merged: token.summary + token.list + token.show → token via action param (T5615)
        case 'token': {
          return routeByParam<Promise<DispatchResponse>>(
            params,
            'action',
            {
              summary: async (): Promise<DispatchResponse> => {
                const result = await summarizeTokenUsage(
                  {
                    provider: params?.provider as string | undefined,
                    transport: params?.transport as
                      | 'cli'
                      | 'mcp'
                      | 'api'
                      | 'agent'
                      | 'unknown'
                      | undefined,
                    gateway: params?.gateway as string | undefined,
                    domain: params?.domain as string | undefined,
                    operation: params?.operationName as string | undefined,
                    sessionId: params?.sessionId as string | undefined,
                    taskId: params?.taskId as string | undefined,
                    method: params?.method as
                      | 'otel'
                      | 'provider_api'
                      | 'tokenizer'
                      | 'heuristic'
                      | undefined,
                    confidence: params?.confidence as
                      | 'real'
                      | 'high'
                      | 'estimated'
                      | 'coarse'
                      | undefined,
                    requestId: params?.requestId as string | undefined,
                    since: params?.since as string | undefined,
                    until: params?.until as string | undefined,
                  },
                  this.projectRoot,
                );
                return {
                  _meta: dispatchMeta('query', 'admin', operation, startTime),
                  success: true,
                  data: result,
                };
              },
              list: async (): Promise<DispatchResponse> => {
                const { limit, offset } = getListParams(params);
                const result = await listTokenUsage(
                  {
                    provider: params?.provider as string | undefined,
                    transport: params?.transport as
                      | 'cli'
                      | 'mcp'
                      | 'api'
                      | 'agent'
                      | 'unknown'
                      | undefined,
                    gateway: params?.gateway as string | undefined,
                    domain: params?.domain as string | undefined,
                    operation: params?.operationName as string | undefined,
                    sessionId: params?.sessionId as string | undefined,
                    taskId: params?.taskId as string | undefined,
                    method: params?.method as
                      | 'otel'
                      | 'provider_api'
                      | 'tokenizer'
                      | 'heuristic'
                      | undefined,
                    confidence: params?.confidence as
                      | 'real'
                      | 'high'
                      | 'estimated'
                      | 'coarse'
                      | undefined,
                    requestId: params?.requestId as string | undefined,
                    since: params?.since as string | undefined,
                    until: params?.until as string | undefined,
                    limit,
                    offset,
                  },
                  this.projectRoot,
                );
                return {
                  _meta: dispatchMeta('query', 'admin', operation, startTime),
                  success: true,
                  data: {
                    records: result.records,
                    total: result.total,
                    filtered: result.filtered,
                  },
                  page: paginate(Array.from({ length: result.filtered }), limit, offset).page,
                };
              },
              show: async (): Promise<DispatchResponse> => {
                const tokenId = params?.tokenId as string;
                if (!tokenId) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_INVALID_INPUT',
                    'tokenId is required',
                    startTime,
                  );
                }
                const result = await showTokenUsage(tokenId, this.projectRoot);
                if (!result) {
                  return errorResult(
                    'query',
                    'admin',
                    operation,
                    'E_NOT_FOUND',
                    `Token usage record not found: ${tokenId}`,
                    startTime,
                  );
                }
                return {
                  _meta: dispatchMeta('query', 'admin', operation, startTime),
                  success: true,
                  data: result,
                };
              },
            },
            'summary',
          );
        }

        // Merged: export + snapshot.export + export.tasks → export via scope param (T5615)
        case 'export': {
          const scope = params?.scope as string | undefined;
          if (scope === 'snapshot') {
            const snapshot = await exportSnapshot(this.projectRoot);
            const outputPath =
              (params?.output as string) ?? getDefaultSnapshotPath(this.projectRoot);
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
          if (scope === 'tasks') {
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
          // Default: standard export
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

        default:
          return unsupportedOp('query', 'admin', operation, startTime);
      }
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

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'init': {
          const result = await initProject(
            this.projectRoot,
            params as { projectName?: string; force?: boolean } | undefined,
          );
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        // Merged: health (mutate) absorbs fix and doctor via mode param (T5615)
        case 'health': {
          const mode = params?.mode as string | undefined;
          if (mode === 'diagnose') {
            const result = await systemDoctor(this.projectRoot);
            return wrapResult(result, 'mutate', 'admin', operation, startTime);
          }
          // Default: repair mode
          const result = await systemFix(this.projectRoot);
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'config.set': {
          const key = params?.key as string;
          if (!key) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'key is required',
              startTime,
            );
          }
          const result = await configSet(this.projectRoot, key, params?.value);
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        // Merged: backup absorbs restore and backup.restore via action param (T5615)
        case 'backup': {
          const action = params?.action as string | undefined;
          if (action === 'restore') {
            const backupId = params?.backupId as string;
            if (!backupId) {
              return errorResult(
                'mutate',
                'admin',
                operation,
                'E_INVALID_INPUT',
                'backupId is required',
                startTime,
              );
            }
            const result = systemRestore(this.projectRoot, {
              backupId,
              force: params?.force as boolean | undefined,
            });
            return wrapResult(result, 'mutate', 'admin', operation, startTime);
          }
          if (action === 'restore.file') {
            const file = params?.file as string;
            if (!file) {
              return errorResult(
                'mutate',
                'admin',
                operation,
                'E_INVALID_INPUT',
                'file is required',
                startTime,
              );
            }
            const result = await backupRestore(this.projectRoot, file, {
              dryRun: params?.dryRun as boolean | undefined,
            });
            return wrapResult(result, 'mutate', 'admin', operation, startTime);
          }
          // Default: create backup
          const result = systemBackup(
            this.projectRoot,
            params as { type?: string; note?: string } | undefined,
          );
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'migrate': {
          const result = await systemMigrate(
            this.projectRoot,
            params as { target?: string; dryRun?: boolean } | undefined,
          );
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'cleanup': {
          const target = params?.target as string;
          if (!target) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'target is required',
              startTime,
            );
          }
          const result = await systemCleanup(this.projectRoot, {
            target,
            olderThan: params?.olderThan as string | undefined,
            dryRun: params?.dryRun as boolean | undefined,
          });
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'job.cancel': {
          const { getJobManager } = await import('../../mcp/lib/job-manager-accessor.js');
          const mgr = getJobManager();
          if (!mgr) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_NOT_AVAILABLE',
              'Job manager not initialized',
              startTime,
            );
          }
          const jobId = params?.jobId as string;
          if (!jobId) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'jobId is required',
              startTime,
            );
          }
          const cancelled = mgr.cancelJob(jobId);
          if (!cancelled) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_NOT_FOUND',
              `Job ${jobId} not found or not running`,
              startTime,
            );
          }
          return wrapResult(
            { success: true, data: { jobId, cancelled: true } },
            'mutate',
            'admin',
            operation,
            startTime,
          );
        }

        case 'safestop': {
          const result = systemSafestop(
            this.projectRoot,
            params as
              | {
                  reason?: string;
                  commit?: boolean;
                  handoff?: string;
                  noSessionEnd?: boolean;
                  dryRun?: boolean;
                }
              | undefined,
          );
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        case 'inject.generate': {
          const result = await systemInjectGenerate(this.projectRoot);
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        // adr.sync absorbs adr.validate via validate flag (T5615)
        case 'adr.sync': {
          const validate = params?.validate as boolean | undefined;
          if (validate) {
            const result = await validateAllAdrs(this.projectRoot);
            return {
              _meta: dispatchMeta('mutate', 'admin', operation, startTime),
              success: result.valid,
              data: result,
              ...(result.valid
                ? {}
                : {
                    error: {
                      code: 'E_ADR_VALIDATION',
                      message: `${result.errors.length} ADR validation error(s) found`,
                    },
                  }),
            };
          }
          const result = await syncAdrsToDb(this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'admin', operation, startTime),
            success: true,
            data: result,
          };
        }

        // Merged: import + snapshot.import + import.tasks → import via scope param (T5615)
        case 'import': {
          const scope = params?.scope as string | undefined;
          if (scope === 'snapshot') {
            const file = params?.file as string;
            if (!file) {
              return errorResult(
                'mutate',
                'admin',
                operation,
                'E_INVALID_INPUT',
                'file is required',
                startTime,
              );
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
          if (scope === 'tasks') {
            const file = params?.file as string;
            if (!file) {
              return errorResult(
                'mutate',
                'admin',
                operation,
                'E_INVALID_INPUT',
                'file is required',
                startTime,
              );
            }
            const result = await importTasksPackage({
              file,
              dryRun: params?.dryRun as boolean | undefined,
              parent: params?.parent as string | undefined,
              phase: params?.phase as string | undefined,
              addLabel: params?.addLabel as string | undefined,
              provenance: params?.provenance as boolean | undefined,
              resetStatus: params?.resetStatus as 'pending' | 'active' | 'blocked' | undefined,
              onConflict: params?.onConflict as
                | 'duplicate'
                | 'rename'
                | 'skip'
                | 'fail'
                | undefined,
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
          // Default: standard import
          const file = params?.file as string;
          if (!file) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'file is required',
              startTime,
            );
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

        case 'detect': {
          const { ensureProjectContext, ensureContributorMcp } = await import(
            '../../core/scaffold.js'
          );
          const contextResult = await ensureProjectContext(this.projectRoot, { force: true });
          const mcpResult = await ensureContributorMcp(this.projectRoot);
          return wrapResult(
            {
              success: true,
              data: { context: contextResult, mcp: mcpResult },
            },
            'mutate',
            'admin',
            operation,
            startTime,
          );
        }

        // Merged: token.record + token.delete + token.clear → token via action param (T5615)
        case 'token': {
          return routeByParam<Promise<DispatchResponse>>(
            params,
            'action',
            {
              record: async (): Promise<DispatchResponse> => {
                const result = await recordTokenExchange({
                  provider: params?.provider as string | undefined,
                  model: params?.model as string | undefined,
                  transport: params?.transport as
                    | 'cli'
                    | 'mcp'
                    | 'api'
                    | 'agent'
                    | 'unknown'
                    | undefined,
                  gateway: params?.gateway as string | undefined,
                  domain: params?.domain as string | undefined,
                  operation: params?.operationName as string | undefined,
                  sessionId: params?.sessionId as string | undefined,
                  taskId: params?.taskId as string | undefined,
                  requestId: params?.requestId as string | undefined,
                  requestPayload: params?.requestPayload,
                  responsePayload: params?.responsePayload,
                  metadata: params?.metadata as Record<string, unknown> | undefined,
                  cwd: this.projectRoot,
                });
                return {
                  _meta: dispatchMeta('mutate', 'admin', operation, startTime),
                  success: true,
                  data: result,
                };
              },
              delete: async (): Promise<DispatchResponse> => {
                const tokenId = params?.tokenId as string;
                if (!tokenId) {
                  return errorResult(
                    'mutate',
                    'admin',
                    operation,
                    'E_INVALID_INPUT',
                    'tokenId is required',
                    startTime,
                  );
                }
                const result = await deleteTokenUsage(tokenId, this.projectRoot);
                return {
                  _meta: dispatchMeta('mutate', 'admin', operation, startTime),
                  success: true,
                  data: result,
                };
              },
              clear: async (): Promise<DispatchResponse> => {
                const result = await clearTokenUsage(
                  {
                    provider: params?.provider as string | undefined,
                    transport: params?.transport as
                      | 'cli'
                      | 'mcp'
                      | 'api'
                      | 'agent'
                      | 'unknown'
                      | undefined,
                    gateway: params?.gateway as string | undefined,
                    domain: params?.domain as string | undefined,
                    operation: params?.operationName as string | undefined,
                    sessionId: params?.sessionId as string | undefined,
                    taskId: params?.taskId as string | undefined,
                    method: params?.method as
                      | 'otel'
                      | 'provider_api'
                      | 'tokenizer'
                      | 'heuristic'
                      | undefined,
                    confidence: params?.confidence as
                      | 'real'
                      | 'high'
                      | 'estimated'
                      | 'coarse'
                      | undefined,
                    requestId: params?.requestId as string | undefined,
                    since: params?.since as string | undefined,
                    until: params?.until as string | undefined,
                  },
                  this.projectRoot,
                );
                return {
                  _meta: dispatchMeta('mutate', 'admin', operation, startTime),
                  success: true,
                  data: result,
                };
              },
            },
            'record',
          );
        }

        // admin.context.inject — moved from session domain (T5615)
        case 'context.inject': {
          const protocolType = params?.protocolType as string;
          if (!protocolType) {
            return errorResult(
              'mutate',
              'admin',
              operation,
              'E_INVALID_INPUT',
              'protocolType is required',
              startTime,
            );
          }
          const result = sessionContextInject(
            protocolType,
            {
              taskId: params?.taskId as string | undefined,
              variant: params?.variant as string | undefined,
            },
            this.projectRoot,
          );
          return wrapResult(result, 'mutate', 'admin', operation, startTime);
        }

        // admin.install.global — refresh global CLEO setup (T4916)
        case 'install.global': {
          const { ensureGlobalScaffold, ensureGlobalTemplates } = await import(
            '../../core/scaffold.js'
          );
          const scaffoldResult = await ensureGlobalScaffold();
          const templateResult = await ensureGlobalTemplates();
          return wrapResult(
            {
              success: true,
              data: { scaffold: scaffoldResult, templates: templateResult },
            },
            'mutate',
            'admin',
            operation,
            startTime,
          );
        }

        default:
          return unsupportedOp('mutate', 'admin', operation, startTime);
      }
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

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'version',
        'health',
        'config.show',
        'stats',
        'context',
        'runtime',
        'job',
        'dash',
        'log',
        'sequence',
        'help',
        'token',
        'adr.show',
        'adr.find',
        'export',
      ],
      mutate: [
        'init',
        'config.set',
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
      ],
    };
  }
}
