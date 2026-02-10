/**
 * System Domain Handler
 *
 * Implements all 30 system operations for CLEO MCP server:
 * - Query (19): context, metrics, health, config, diagnostics, version, help, doctor, config.get, stats, job.status, job.list, dash, roadmap, labels, compliance, log, archive-stats, sequence
 * - Mutate (11): backup, restore, migrate, cleanup, audit, init, config.set, sync, job.cancel, safestop, uncancel
 *
 * Each operation maps to corresponding CLEO CLI commands for system management,
 * health checks, configuration, and maintenance operations.
 *
 * @task T2935
 * @task T4269
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { BackgroundJobManager } from '../lib/background-jobs.js';

/**
 * Query operation parameters and results
 */
interface SystemContextParams {
  // No parameters
}

interface ContextInfo {
  tokens: {
    used: number;
    available: number;
    percentage: number;
  };
  files: number;
  status: 'ok' | 'medium' | 'high' | 'critical';
}

interface SystemMetricsParams {
  scope?: 'session' | 'project';
  since?: string; // ISO date
}

interface MetricsInfo {
  tokens: {
    input: number;
    output: number;
    cache: number;
    total: number;
  };
  compliance: {
    total: number;
    passed: number;
    failed: number;
    score: number;
  };
  sessions: {
    total: number;
    active: number;
    completed: number;
  };
}

interface SystemHealthParams {
  detailed?: boolean;
}

interface HealthInfo {
  overall: 'healthy' | 'warning' | 'error';
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message?: string;
  }>;
  version: string;
  installation: 'ok' | 'degraded';
}

interface SystemConfigParams {
  key?: string; // If omitted, return all config
}

interface ConfigInfo {
  [key: string]: unknown;
}

interface SystemDiagnosticsParams {
  checks?: string[]; // Specific checks to run
}

interface DiagnosticsInfo {
  timestamp: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    details?: string;
    fix?: string;
  }>;
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

interface SystemVersionParams {
  // No parameters
}

interface VersionInfo {
  version: string;
  buildDate?: string;
  gitCommit?: string;
  schema: {
    todo: string;
    config: string;
    archive: string;
    log: string;
  };
}

interface SystemHelpParams {
  topic?: string; // Specific help topic
}

interface HelpInfo {
  topic?: string;
  content: string;
  relatedCommands?: string[];
}

/**
 * Mutate operation parameters and results
 */
interface SystemBackupParams {
  type?: 'snapshot' | 'safety' | 'migration';
  note?: string;
}

interface BackupResult {
  backupId: string;
  path: string;
  timestamp: string;
  type: string;
  size?: number;
}

interface SystemRestoreParams {
  backupId: string;
  force?: boolean;
}

interface RestoreResult {
  restored: boolean;
  backupId: string;
  timestamp: string;
  filesRestored: string[];
}

interface SystemMigrateParams {
  target?: string; // Target version
  dryRun?: boolean;
}

interface MigrateResult {
  from: string;
  to: string;
  migrations: Array<{
    name: string;
    applied: boolean;
    timestamp?: string;
  }>;
  dryRun: boolean;
}

interface SystemCleanupParams {
  target: 'sessions' | 'backups' | 'logs' | 'archive';
  olderThan?: string; // ISO date or relative (e.g., "30d")
  dryRun?: boolean;
}

interface CleanupResult {
  target: string;
  deleted: number;
  freedBytes?: number;
  items: string[];
  dryRun: boolean;
}

interface SystemAuditParams {
  scope?: 'all' | 'tasks' | 'sessions' | 'compliance';
  fix?: boolean;
}

interface AuditResult {
  scope: string;
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    fix?: string;
  }>;
  summary: {
    errors: number;
    warnings: number;
    fixed: number;
  };
}

interface SystemInitParams {
  projectType?: string;
  detect?: boolean;
}

interface InitResult {
  initialized: boolean;
  projectType?: string;
  path: string;
}

interface SystemConfigSetParams {
  key: string;
  value: unknown;
}

interface ConfigSetResult {
  key: string;
  value: unknown;
  previous?: unknown;
}

interface SystemSyncParams {
  direction?: 'up' | 'down';
}

interface SyncResult {
  direction: string;
  synced: number;
  conflicts: number;
}

interface SystemDashParams {
  // No required parameters
}

interface SystemRoadmapParams {
  format?: 'text' | 'json' | 'markdown';
  includeHistory?: boolean;
  upcomingOnly?: boolean;
}

interface SystemLabelsParams {
  label?: string; // Show tasks for a specific label
  subcommand?: 'show' | 'stats';
}

interface SystemComplianceParams {
  subcommand?: 'summary' | 'violations' | 'trend' | 'audit' | 'sync';
  days?: number;
  epic?: string;
}

interface SystemLogParams {
  limit?: number;
  operation?: string;
  task?: string;
}

interface SystemArchiveStatsParams {
  byPhase?: boolean;
  byLabel?: boolean;
}

interface SystemSequenceParams {
  subcommand?: 'show' | 'check' | 'repair';
}

interface SystemSafestopParams {
  reason?: string;
  commit?: boolean;
  handoff?: string;
  noSessionEnd?: boolean;
  dryRun?: boolean;
}

interface SystemUncancelParams {
  taskId: string;
  cascade?: boolean;
  notes?: string;
  dryRun?: boolean;
}

export class SystemHandler implements DomainHandler {
  private jobManager?: BackgroundJobManager;

  constructor(private executor?: CLIExecutor, jobManager?: BackgroundJobManager) {
    this.jobManager = jobManager;
  }

  /**
   * Set the background job manager (allows post-construction injection)
   */
  setJobManager(jobManager: BackgroundJobManager): void {
    this.jobManager = jobManager;
  }

  /**
   * Get the background job manager
   */
  getJobManager(): BackgroundJobManager | undefined {
    return this.jobManager;
  }

  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!this.executor) {
      return this.createErrorResponse(
        'query',
        'system',
        operation,
        'E_NOT_INITIALIZED',
        'System handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'context':
          return this.getContext(params as SystemContextParams, startTime);
        case 'metrics':
          return this.getMetrics(params as SystemMetricsParams, startTime);
        case 'health':
          return this.checkHealth(params as SystemHealthParams, startTime);
        case 'config':
          return this.getConfig(params as SystemConfigParams, startTime);
        case 'diagnostics':
          return this.runDiagnostics(params as SystemDiagnosticsParams, startTime);
        case 'version':
          return this.getVersion(params as SystemVersionParams, startTime);
        case 'help':
          return this.getHelp(params as SystemHelpParams, startTime);
        case 'doctor':
          return this.checkHealth(params as SystemHealthParams, startTime);
        case 'config.get':
          return this.getConfig(params as SystemConfigParams, startTime);
        case 'stats':
          return this.getMetrics(params as SystemMetricsParams, startTime);
        case 'job.status':
          return this.queryJobStatus(params, startTime);
        case 'job.list':
          return this.queryJobList(params, startTime);
        case 'dash':
          return this.getDash(params as SystemDashParams, startTime);
        case 'roadmap':
          return this.getRoadmap(params as SystemRoadmapParams, startTime);
        case 'labels':
          return this.getLabels(params as SystemLabelsParams, startTime);
        case 'compliance':
          return this.getCompliance(params as SystemComplianceParams, startTime);
        case 'log':
          return this.getLog(params as SystemLogParams, startTime);
        case 'archive-stats':
          return this.getArchiveStats(params as SystemArchiveStatsParams, startTime);
        case 'sequence':
          return this.getSequence(params as SystemSequenceParams, startTime);
        default:
          return this.createErrorResponse(
            'query',
            'system',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('query', 'system', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!this.executor) {
      return this.createErrorResponse(
        'mutate',
        'system',
        operation,
        'E_NOT_INITIALIZED',
        'System handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'backup':
          return this.createBackup(params as SystemBackupParams, startTime);
        case 'restore':
          return this.restoreBackup(params as unknown as SystemRestoreParams, startTime);
        case 'migrate':
          return this.runMigrations(params as SystemMigrateParams, startTime);
        case 'cleanup':
          return this.cleanup(params as unknown as SystemCleanupParams, startTime);
        case 'audit':
          return this.runAudit(params as SystemAuditParams, startTime);
        case 'init':
          return this.mutateInit(params as SystemInitParams, startTime);
        case 'config.set':
          return this.mutateConfigSet(params as unknown as SystemConfigSetParams, startTime);
        case 'sync':
          return this.mutateSync(params as SystemSyncParams, startTime);
        case 'job.cancel':
          return this.mutateJobCancel(params, startTime);
        case 'safestop':
          return this.mutateSafestop(params as SystemSafestopParams, startTime);
        case 'uncancel':
          return this.mutateUncancel(params as unknown as SystemUncancelParams, startTime);
        default:
          return this.createErrorResponse(
            'mutate',
            'system',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('mutate', 'system', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['context', 'metrics', 'health', 'config', 'diagnostics', 'version', 'help', 'doctor', 'config.get', 'stats', 'job.status', 'job.list', 'dash', 'roadmap', 'labels', 'compliance', 'log', 'archive-stats', 'sequence'],
      mutate: ['backup', 'restore', 'migrate', 'cleanup', 'audit', 'init', 'config.set', 'sync', 'job.cancel', 'safestop', 'uncancel'],
    };
  }

  /**
   * QUERY OPERATIONS
   */

  private async getContext(_params: SystemContextParams, startTime: number): Promise<DomainResponse> {
    const result = await this.executor!.execute<ContextInfo>({
      domain: 'system',
      operation: 'context',
      customCommand: 'cleo context --json'
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'context', startTime);
  }

  private async getMetrics(params: SystemMetricsParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.scope) flags.scope = params.scope;
    if (params?.since) flags.since = params.since;

    const result = await this.executor!.execute<MetricsInfo>({
      domain: 'metrics',
      operation: 'show',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'metrics', startTime);
  }

  private async checkHealth(params: SystemHealthParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.detailed) flags.detailed = true;

    const result = await this.executor!.execute<HealthInfo>({
      domain: 'cleo',
      operation: '--validate',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'health', startTime);
  }

  private async getConfig(params: SystemConfigParams | undefined, startTime: number): Promise<DomainResponse> {
    // Read config file directly since there's no cleo config command
    const result = await this.executor!.execute<ConfigInfo>({
      domain: 'system',
      operation: 'config',
      customCommand: 'cat .cleo/config.json | jq .'
    });

    if (!result.success) {
      return this.wrapExecutorResult(result, 'query', 'system', 'config', startTime);
    }

    // If specific key requested, extract it
    if (params?.key && result.data) {
      const keys = params.key.split('.');
      let value: unknown = result.data;
      for (const key of keys) {
        if (typeof value === 'object' && value !== null && key in value) {
          value = (value as Record<string, unknown>)[key];
        } else {
          return this.createErrorResponse(
            'query',
            'system',
            'config',
            'E_NOT_FOUND',
            `Config key not found: ${params.key}`,
            startTime
          );
        }
      }
      result.data = { [params.key]: value } as ConfigInfo;
    }

    return this.wrapExecutorResult(result, 'query', 'system', 'config', startTime);
  }

  private async runDiagnostics(params: SystemDiagnosticsParams | undefined, startTime: number): Promise<DomainResponse> {
    const args = params?.checks && params.checks.length > 0 ? ['--checks', params.checks.join(',')] : [];

    const result = await this.executor!.execute<DiagnosticsInfo>({
      domain: 'validate',
      operation: 'all',
      args,
      flags: { json: true }
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'diagnostics', startTime);
  }

  private async getVersion(_params: SystemVersionParams, startTime: number): Promise<DomainResponse> {
    const result = await this.executor!.execute<VersionInfo>({
      domain: 'system',
      operation: 'version',
      customCommand: 'cleo version --json'
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'version', startTime);
  }

  private async getHelp(params: SystemHelpParams | undefined, startTime: number): Promise<DomainResponse> {
    const args = params?.topic ? [params.topic] : [];

    const result = await this.executor!.execute<HelpInfo>({
      domain: 'help',
      operation: 'show',
      args,
      flags: { json: true }
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'help', startTime);
  }

  /**
   * MUTATE OPERATIONS
   */

  private async createBackup(params: SystemBackupParams | undefined, startTime: number): Promise<DomainResponse> {
    const args = [params?.type || 'snapshot'];
    const flags: Record<string, unknown> = { json: true };
    if (params?.note) flags.note = params.note;

    const result = await this.executor!.execute<BackupResult>({
      domain: 'backup',
      operation: 'create',
      args,
      flags
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'backup', startTime);
  }

  private async restoreBackup(params: SystemRestoreParams, startTime: number): Promise<DomainResponse> {
    if (!params.backupId) {
      return this.createErrorResponse(
        'mutate',
        'system',
        'restore',
        'E_INVALID_INPUT',
        'backupId parameter is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.force) flags.force = true;

    const result = await this.executor!.execute<RestoreResult>({
      domain: 'backup',
      operation: 'restore',
      args: [params.backupId],
      flags
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'restore', startTime);
  }

  private async runMigrations(params: SystemMigrateParams | undefined, startTime: number): Promise<DomainResponse> {
    const args = params?.target ? ['to', params.target] : ['up'];
    const flags: Record<string, unknown> = { json: true };
    if (params?.dryRun) flags['dry-run'] = true;

    const result = await this.executor!.execute<MigrateResult>({
      domain: 'migrate',
      operation: 'run',
      args,
      flags
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'migrate', startTime);
  }

  private async cleanup(params: SystemCleanupParams, startTime: number): Promise<DomainResponse> {
    if (!params.target) {
      return this.createErrorResponse(
        'mutate',
        'system',
        'cleanup',
        'E_INVALID_INPUT',
        'target parameter is required (sessions|backups|logs|archive)',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.olderThan) flags['older-than'] = params.olderThan;
    if (params.dryRun) flags['dry-run'] = true;

    let domain: string;
    let operation: string;

    switch (params.target) {
      case 'archive':
        domain = 'archive';
        operation = 'cleanup';
        break;
      case 'sessions':
        domain = 'session';
        operation = 'gc';
        break;
      case 'backups':
        domain = 'backup';
        operation = 'cleanup';
        break;
      case 'logs':
        domain = 'log';
        operation = 'cleanup';
        break;
      default:
        return this.createErrorResponse(
          'mutate',
          'system',
          'cleanup',
          'E_INVALID_INPUT',
          `Invalid cleanup target: ${params.target}. Must be sessions, backups, logs, or archive`,
          startTime
        );
    }

    const result = await this.executor!.execute<CleanupResult>({
      domain,
      operation,
      flags
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'cleanup', startTime);
  }

  private async runAudit(params: SystemAuditParams | undefined, startTime: number): Promise<DomainResponse> {
    const args = [params?.scope || 'all'];
    const flags: Record<string, unknown> = { json: true };
    if (params?.fix) flags.fix = true;

    const result = await this.executor!.execute<AuditResult>({
      domain: 'validate',
      operation: 'audit',
      args,
      flags
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'audit', startTime);
  }

  /**
   * init - Initialize CLEO project
   * CLI: cleo init [--project-type X] [--detect]
   */
  private async mutateInit(params: SystemInitParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.projectType) flags['project-type'] = params.projectType;
    if (params?.detect) flags.detect = true;

    const result = await this.executor!.execute<InitResult>({
      domain: 'init',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'init', startTime);
  }

  /**
   * config.set - Set configuration value
   * CLI: cleo config set <key> <value>
   */
  private async mutateConfigSet(params: SystemConfigSetParams, startTime: number): Promise<DomainResponse> {
    if (!params?.key || params?.value === undefined) {
      return this.createErrorResponse(
        'mutate',
        'system',
        'config.set',
        'E_INVALID_INPUT',
        'key and value are required',
        startTime
      );
    }

    const result = await this.executor!.execute<ConfigSetResult>({
      domain: 'config',
      operation: 'set',
      args: [params.key, String(params.value)],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'config.set', startTime);
  }

  /**
   * sync - Sync with external systems
   * CLI: cleo sync [--direction up|down]
   */
  private async mutateSync(params: SystemSyncParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.direction) flags.direction = params.direction;

    const result = await this.executor!.execute<SyncResult>({
      domain: 'sync',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'sync', startTime);
  }

  /**
   * dash - Project overview dashboard
   * CLI: cleo dash --json
   * @task T4269
   */
  private async getDash(_params: SystemDashParams | undefined, startTime: number): Promise<DomainResponse> {
    const result = await this.executor!.execute({
      domain: 'system',
      operation: 'dash',
      customCommand: 'cleo dash --json'
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'dash', startTime);
  }

  /**
   * roadmap - Generate roadmap from pending epics and CHANGELOG history
   * CLI: cleo roadmap [--json] [--include-history] [--upcoming-only]
   * @task T4269
   */
  private async getRoadmap(params: SystemRoadmapParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.includeHistory) flags['include-history'] = true;
    if (params?.upcomingOnly) flags['upcoming-only'] = true;

    const result = await this.executor!.execute({
      domain: 'roadmap',
      operation: '',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'roadmap', startTime);
  }

  /**
   * labels - List all labels with counts or show tasks with specific label
   * CLI: cleo labels [show <label>] [--json]
   * @task T4269
   */
  private async getLabels(params: SystemLabelsParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    let operation = '';

    if (params?.subcommand === 'show' && params?.label) {
      operation = `show ${params.label}`;
    } else if (params?.subcommand === 'stats') {
      operation = 'stats';
    } else if (params?.label) {
      operation = `show ${params.label}`;
    }

    const result = await this.executor!.execute({
      domain: 'labels',
      operation,
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'labels', startTime);
  }

  /**
   * compliance - Monitor and report compliance metrics
   * CLI: cleo compliance [subcommand] [--json] [--days N] [--epic T###]
   * @task T4269
   */
  private async getCompliance(params: SystemComplianceParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.days) flags.days = params.days;
    if (params?.epic) flags.epic = params.epic;

    const result = await this.executor!.execute({
      domain: 'compliance',
      operation: params?.subcommand || 'summary',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'compliance', startTime);
  }

  /**
   * log - View audit log entries
   * CLI: cleo log [--json] [--limit N] [--operation OP] [--task T###]
   * @task T4269
   */
  private async getLog(params: SystemLogParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.limit) flags.limit = params.limit;
    if (params?.operation) flags.operation = params.operation;
    if (params?.task) flags.task = params.task;

    const result = await this.executor!.execute({
      domain: 'log',
      operation: '',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'log', startTime);
  }

  /**
   * archive-stats - Generate analytics from archived tasks
   * CLI: cleo archive-stats [--json] [--by-phase] [--by-label]
   * @task T4269
   */
  private async getArchiveStats(params: SystemArchiveStatsParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.byPhase) flags['by-phase'] = true;
    if (params?.byLabel) flags['by-label'] = true;

    const result = await this.executor!.execute({
      domain: 'archive-stats',
      operation: '',
      flags
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'archive-stats', startTime);
  }

  /**
   * sequence - Inspect and manage task ID sequence
   * CLI: cleo sequence [show|check|repair] [--json]
   * @task T4269
   */
  private async getSequence(params: SystemSequenceParams | undefined, startTime: number): Promise<DomainResponse> {
    const result = await this.executor!.execute({
      domain: 'sequence',
      operation: params?.subcommand || 'show',
      flags: { json: true }
    });

    return this.wrapExecutorResult(result, 'query', 'system', 'sequence', startTime);
  }

  /**
   * JOB QUERY OPERATIONS
   */

  /**
   * job.status - Get a specific background job's status
   */
  private queryJobStatus(params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    if (!this.jobManager) {
      return this.createErrorResponse(
        'query', 'system', 'job.status',
        'E_NOT_INITIALIZED', 'Background job manager not initialized', startTime
      );
    }

    const jobId = params?.jobId as string | undefined;
    if (!jobId) {
      return this.createErrorResponse(
        'query', 'system', 'job.status',
        'E_INVALID_INPUT', 'jobId parameter is required', startTime
      );
    }

    const job = this.jobManager.getJob(jobId);
    if (!job) {
      return this.createErrorResponse(
        'query', 'system', 'job.status',
        'E_NOT_FOUND', `Job not found: ${jobId}`, startTime
      );
    }

    return {
      _meta: {
        gateway: 'query', domain: 'system', operation: 'job.status',
        version: '1.0.0', timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: job,
    };
  }

  /**
   * job.list - List all background jobs, optionally filtered by status
   */
  private queryJobList(params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    if (!this.jobManager) {
      return this.createErrorResponse(
        'query', 'system', 'job.list',
        'E_NOT_INITIALIZED', 'Background job manager not initialized', startTime
      );
    }

    const status = params?.status as string | undefined;
    const jobs = this.jobManager.listJobs(status);

    return {
      _meta: {
        gateway: 'query', domain: 'system', operation: 'job.list',
        version: '1.0.0', timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: { jobs, count: jobs.length },
    };
  }

  /**
   * JOB MUTATE OPERATIONS
   */

  /**
   * job.cancel - Cancel a running background job
   */
  private mutateJobCancel(params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    if (!this.jobManager) {
      return this.createErrorResponse(
        'mutate', 'system', 'job.cancel',
        'E_NOT_INITIALIZED', 'Background job manager not initialized', startTime
      );
    }

    const jobId = params?.jobId as string | undefined;
    if (!jobId) {
      return this.createErrorResponse(
        'mutate', 'system', 'job.cancel',
        'E_INVALID_INPUT', 'jobId parameter is required', startTime
      );
    }

    const cancelled = this.jobManager.cancelJob(jobId);
    if (!cancelled) {
      return this.createErrorResponse(
        'mutate', 'system', 'job.cancel',
        'E_NOT_FOUND', `Job not found or not running: ${jobId}`, startTime
      );
    }

    return {
      _meta: {
        gateway: 'mutate', domain: 'system', operation: 'job.cancel',
        version: '1.0.0', timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: { jobId, cancelled: true },
    };
  }

  /**
   * safestop - Graceful shutdown for agents approaching context limits
   * CLI: cleo safestop [--reason "..."] [--commit] [--handoff "..."] [--no-session-end] [--dry-run] [--json]
   * @task T4269
   */
  private async mutateSafestop(params: SystemSafestopParams | undefined, startTime: number): Promise<DomainResponse> {
    const flags: Record<string, unknown> = { json: true };
    if (params?.reason) flags.reason = params.reason;
    if (params?.commit) flags.commit = true;
    if (params?.handoff) flags.handoff = params.handoff;
    if (params?.noSessionEnd) flags['no-session-end'] = true;
    if (params?.dryRun) flags['dry-run'] = true;

    const result = await this.executor!.execute({
      domain: 'safestop',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'safestop', startTime);
  }

  /**
   * uncancel - Restore cancelled tasks back to pending status
   * CLI: cleo uncancel <taskId> [--cascade] [--notes "..."] [--dry-run] [--json]
   * @task T4269
   */
  private async mutateUncancel(params: SystemUncancelParams, startTime: number): Promise<DomainResponse> {
    if (!params?.taskId) {
      return this.createErrorResponse(
        'mutate',
        'system',
        'uncancel',
        'E_INVALID_INPUT',
        'taskId parameter is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.cascade) flags.cascade = true;
    if (params?.notes) flags.notes = params.notes;
    if (params?.dryRun) flags['dry-run'] = true;

    const result = await this.executor!.execute({
      domain: 'uncancel',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'mutate', 'system', 'uncancel', startTime);
  }

  /**
   * Helper methods
   */

  private wrapExecutorResult(
    result: any,
    gateway: string,
    domain: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;

    if (result.success) {
      return {
        _meta: {
          gateway,
          domain,
          operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms,
        },
        success: true,
        data: result.data,
      };
    }

    return {
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms,
      },
      success: false,
      error: result.error || {
        code: 'E_UNKNOWN',
        message: 'Unknown error occurred',
      },
    };
  }

  private createErrorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number
  ): DomainResponse {
    return {
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number
  ): DomainResponse {
    return this.createErrorResponse(
      gateway,
      domain,
      operation,
      'E_EXECUTION_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime
    );
  }
}
