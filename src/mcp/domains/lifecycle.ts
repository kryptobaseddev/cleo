/**
 * Lifecycle Domain Handler
 *
 * Implements all 16 lifecycle operations for RCSD-IVTR pipeline:
 * - Query (9): stages, status, validate, report, export, history, gates, prerequisites, check (alias)
 * - Mutate (9): record, enforce, skip, unskip, import, reset, gate.pass, gate.fail, progress (alias)
 *
 * Handles lifecycle progression, gate enforcement, and RCSD manifest integration.
 *
 * @task T2932
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  lifecycleStatus as nativeLifecycleStatus,
  lifecycleHistory as nativeLifecycleHistory,
  lifecycleGates as nativeLifecycleGates,
  lifecyclePrerequisites as nativeLifecyclePrerequisites,
  lifecycleCheck as nativeLifecycleCheck,
  lifecycleProgress as nativeLifecycleProgress,
  lifecycleSkip as nativeLifecycleSkip,
  lifecycleReset as nativeLifecycleReset,
  lifecycleGatePass as nativeLifecycleGatePass,
  lifecycleGateFail as nativeLifecycleGateFail,
  resolveProjectRoot,
} from '../engine/index.js';

/**
 * Lifecycle stages in RCSD-IVTR pipeline
 */
export type LifecycleStage =
  | 'research'
  | 'consensus'
  | 'specification'
  | 'decomposition'
  | 'implementation'
  | 'validation'
  | 'testing'
  | 'release'
  | 'contribution';

/**
 * Stage status
 */
export type StageStatus = 'pending' | 'completed' | 'skipped' | 'blocked';

/**
 * Lifecycle stage info
 */
export interface StageInfo {
  stage: LifecycleStage;
  name: string;
  description: string;
  exitCode: number;
  order: number;
  optional: boolean;
}

/**
 * Query: stages - List lifecycle stages
 */
interface LifecycleStagesParams {
  pipeline?: 'rcsd' | 'ivtr' | 'all';
}

interface LifecycleStagesResult {
  stages: StageInfo[];
}

/**
 * Query: status - Get lifecycle status for epic
 */
interface LifecycleStatusParams {
  epicId: string;
}

interface StageProgressInfo {
  stage: LifecycleStage;
  status: StageStatus;
  completedAt?: string;
  notes?: string;
}

interface LifecycleStatusResult {
  epicId: string;
  currentStage: LifecycleStage | null;
  stages: StageProgressInfo[];
  nextStage: LifecycleStage | null;
  blockedOn: string[];
}

/**
 * Query: validate - Validate lifecycle progression
 */
interface LifecycleValidateParams {
  epicId: string;
  targetStage: LifecycleStage;
}

interface ValidationIssue {
  stage: LifecycleStage;
  severity: 'error' | 'warning';
  message: string;
}

interface LifecycleValidateResult {
  valid: boolean;
  canProgress: boolean;
  missingPrerequisites: LifecycleStage[];
  issues: ValidationIssue[];
}

/**
 * Query: report - Generate lifecycle report
 */
interface LifecycleReportParams {
  epicId?: string;
  format?: 'summary' | 'detailed';
}

interface StageMetrics {
  stage: LifecycleStage;
  count: number;
  averageDuration?: number;
  successRate?: number;
}

interface LifecycleReportResult {
  totalEpics: number;
  byStage: StageMetrics[];
  completionRate: number;
  averageCycleTime?: number;
}

/**
 * Query: export - Export lifecycle data
 */
interface LifecycleExportParams {
  epicId?: string;
  format?: 'json' | 'csv';
  includeHistory?: boolean;
}

interface LifecycleExportResult {
  format: string;
  data: unknown;
  timestamp: string;
}

/**
 * Mutate: record - Record stage completion
 */
interface LifecycleRecordParams {
  epicId: string;
  stage: LifecycleStage;
  status: StageStatus;
  notes?: string;
}

interface LifecycleRecordResult {
  epicId: string;
  stage: LifecycleStage;
  status: StageStatus;
  recorded: boolean;
  timestamp: string;
}

/**
 * Mutate: enforce - Enforce lifecycle gates
 */
interface LifecycleEnforceParams {
  epicId: string;
  stage: LifecycleStage;
  strict?: boolean;
}

interface LifecycleEnforceResult {
  epicId: string;
  stage: LifecycleStage;
  allowed: boolean;
  gatesPassed: string[];
  gatesFailed: string[];
}

/**
 * Mutate: skip - Skip a stage
 */
interface LifecycleSkipParams {
  epicId: string;
  stage: LifecycleStage;
  reason: string;
}

interface LifecycleSkipResult {
  epicId: string;
  stage: LifecycleStage;
  skipped: boolean;
  reason: string;
}

/**
 * Mutate: unskip - Unskip a stage
 */
interface LifecycleUnskipParams {
  epicId: string;
  stage: LifecycleStage;
}

interface LifecycleUnskipResult {
  epicId: string;
  stage: LifecycleStage;
  unskipped: boolean;
}

/**
 * Mutate: import - Import lifecycle data
 */
interface LifecycleImportParams {
  source: string;
  epicId?: string;
  overwrite?: boolean;
}

interface LifecycleImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Query: history - Stage transition history
 */
interface LifecycleHistoryParams {
  taskId: string;
}

/**
 * Query: gates - All gate statuses
 */
interface LifecycleGatesParams {
  taskId: string;
}

/**
 * Query: prerequisites - Required prior stages
 */
interface LifecyclePrerequisitesParams {
  targetStage: LifecycleStage;
}

/**
 * Mutate: reset - Reset a stage (emergency)
 */
interface LifecycleResetParams {
  taskId: string;
  stage: LifecycleStage;
  reason: string;
}

interface LifecycleResetResult {
  taskId: string;
  stage: LifecycleStage;
  reset: string;
  reason: string;
  warning: string;
}

/**
 * Mutate: gate.pass - Mark gate as passed
 */
interface LifecycleGatePassParams {
  taskId: string;
  gateName: string;
  agent: string;
  notes?: string;
}

interface LifecycleGatePassResult {
  taskId: string;
  gateName: string;
  status: 'passed';
  timestamp: string;
}

/**
 * Mutate: gate.fail - Mark gate as failed
 */
interface LifecycleGateFailParams {
  taskId: string;
  gateName: string;
  reason: string;
}

interface LifecycleGateFailResult {
  taskId: string;
  gateName: string;
  status: 'failed';
  reason: string;
  timestamp: string;
}

/**
 * Lifecycle domain handler implementation
 */
export class LifecycleHandler implements DomainHandler {
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(private executor: CLIExecutor, executionMode: ResolvedMode = 'cli') {
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor.isAvailable()) {
      return false;
    }
    return canRunNatively('lifecycle', operation, gateway);
  }

  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;
    if (result.success) {
      return {
        _meta: { gateway, domain: 'lifecycle', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'lifecycle', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  private queryNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    switch (operation) {
      case 'status':
        return this.wrapNativeResult(nativeLifecycleStatus(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'check':
      case 'validate':
        return this.wrapNativeResult(nativeLifecycleCheck(params?.epicId as string, params?.targetStage as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'history':
        return this.wrapNativeResult(nativeLifecycleHistory(params?.taskId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'gates':
        return this.wrapNativeResult(nativeLifecycleGates(params?.taskId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'prerequisites':
        return this.wrapNativeResult(nativeLifecyclePrerequisites(params?.targetStage as string, this.projectRoot), 'cleo_query', operation, startTime);
      default:
        return this.createErrorResponse('cleo_query', 'lifecycle', operation, 'E_INVALID_OPERATION', `Unknown native query operation: ${operation}`, startTime);
    }
  }

  private mutateNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    switch (operation) {
      case 'progress':
      case 'record':
        return this.wrapNativeResult(
          nativeLifecycleProgress(params?.taskId as string || params?.epicId as string, params?.stage as string, params?.status as string, params?.notes as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'skip':
        return this.wrapNativeResult(
          nativeLifecycleSkip(params?.taskId as string || params?.epicId as string, params?.stage as string, params?.reason as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'reset':
        return this.wrapNativeResult(
          nativeLifecycleReset(params?.taskId as string, params?.stage as string, params?.reason as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'gate.pass':
        return this.wrapNativeResult(
          nativeLifecycleGatePass(params?.taskId as string, params?.gateName as string, params?.agent as string, params?.notes as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'gate.fail':
        return this.wrapNativeResult(
          nativeLifecycleGateFail(params?.taskId as string, params?.gateName as string, params?.reason as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      default:
        return this.createErrorResponse('cleo_mutate', 'lifecycle', operation, 'E_INVALID_OPERATION', `Unknown native mutate operation: ${operation}`, startTime);
    }
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (this.useNative(operation, 'query')) {
      try {
        return this.queryNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_query', 'lifecycle', operation, error, startTime);
      }
    }

    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'lifecycle.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'stages':
          return await this.queryStages(params as unknown as LifecycleStagesParams);
        case 'status':
          return await this.queryStatus(params as unknown as LifecycleStatusParams);
        case 'validate':
          return await this.queryValidate(params as unknown as LifecycleValidateParams);
        case 'report':
          return await this.queryReport(params as unknown as LifecycleReportParams);
        case 'export':
          return await this.queryExport(params as unknown as LifecycleExportParams);
        case 'history':
          return await this.queryHistory(params as unknown as LifecycleHistoryParams);
        case 'gates':
          return await this.queryGates(params as unknown as LifecycleGatesParams);
        case 'prerequisites':
          return await this.queryPrerequisites(params as unknown as LifecyclePrerequisitesParams);
        case 'check':
          return await this.queryValidate(params as unknown as LifecycleValidateParams);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'lifecycle',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'lifecycle', operation, error, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (this.useNative(operation, 'mutate')) {
      try {
        return this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'lifecycle', operation, error, startTime);
      }
    }

    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'lifecycle.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'record':
          return await this.mutateRecord(params as unknown as LifecycleRecordParams);
        case 'enforce':
          return await this.mutateEnforce(params as unknown as LifecycleEnforceParams);
        case 'skip':
          return await this.mutateSkip(params as unknown as LifecycleSkipParams);
        case 'unskip':
          return await this.mutateUnskip(params as unknown as LifecycleUnskipParams);
        case 'import':
          return await this.mutateImport(params as unknown as LifecycleImportParams);
        case 'reset':
          return await this.mutateReset(params as unknown as LifecycleResetParams);
        case 'gate.pass':
          return await this.mutateGatePass(params as unknown as LifecycleGatePassParams);
        case 'gate.fail':
          return await this.mutateGateFail(params as unknown as LifecycleGateFailParams);
        case 'progress':
          return await this.mutateRecord(params as unknown as LifecycleRecordParams);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'lifecycle',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'lifecycle', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['stages', 'status', 'validate', 'report', 'export', 'history', 'gates', 'prerequisites', 'check'],
      mutate: ['record', 'enforce', 'skip', 'unskip', 'import', 'reset', 'gate.pass', 'gate.fail', 'progress'],
    };
  }

  // ===== Query Operations =====

  /**
   * stages - List lifecycle stages
   * CLI: cleo lifecycle stages [--pipeline <rcsd|ivtr|all>]
   */
  private async queryStages(params: LifecycleStagesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.pipeline) flags.pipeline = params.pipeline;

    const result = await this.executor.execute<LifecycleStagesResult>({
      domain: 'lifecycle',
      operation: 'stages',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'stages', startTime);
  }

  /**
   * status - Get lifecycle status for epic
   * CLI: cleo lifecycle status <epicId>
   */
  private async queryStatus(params: LifecycleStatusParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        'status',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor.execute<LifecycleStatusResult>({
      domain: 'lifecycle',
      operation: 'status',
      args: [params.epicId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'status', startTime);
  }

  /**
   * validate - Validate lifecycle progression
   * CLI: cleo lifecycle validate <epicId> <targetStage>
   */
  private async queryValidate(params: LifecycleValidateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || !params?.targetStage) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        'validate',
        'E_INVALID_INPUT',
        'epicId and targetStage are required',
        startTime
      );
    }

    const result = await this.executor.execute<LifecycleValidateResult>({
      domain: 'lifecycle',
      operation: 'validate',
      args: [params.epicId, params.targetStage],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'validate', startTime);
  }

  /**
   * report - Generate lifecycle report
   * CLI: cleo lifecycle report [--epic <id>] [--format <summary|detailed>]
   */
  private async queryReport(params: LifecycleReportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;
    if (params?.format) flags.format = params.format;

    const result = await this.executor.execute<LifecycleReportResult>({
      domain: 'lifecycle',
      operation: 'report',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'report', startTime);
  }

  /**
   * export - Export lifecycle data
   * CLI: cleo lifecycle export [--epic <id>] [--format <json|csv>] [--history]
   */
  private async queryExport(params: LifecycleExportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;
    if (params?.format) flags.format = params.format;
    if (params?.includeHistory) flags.history = true;

    const result = await this.executor.execute<LifecycleExportResult>({
      domain: 'lifecycle',
      operation: 'export',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'export', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * record - Record stage completion
   * CLI: cleo lifecycle record <epicId> <stage> <status> [--notes <n>]
   */
  private async mutateRecord(params: LifecycleRecordParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || !params?.stage || !params?.status) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'record',
        'E_INVALID_INPUT',
        'epicId, stage, and status are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.notes) flags.notes = params.notes;

    const result = await this.executor.execute<LifecycleRecordResult>({
      domain: 'lifecycle',
      operation: 'record',
      args: [params.epicId, params.stage, params.status],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'record', startTime);
  }

  /**
   * enforce - Enforce lifecycle gates
   * CLI: cleo lifecycle enforce <epicId> <stage> [--strict]
   */
  private async mutateEnforce(params: LifecycleEnforceParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || !params?.stage) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'enforce',
        'E_INVALID_INPUT',
        'epicId and stage are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.strict) flags.strict = true;

    const result = await this.executor.execute<LifecycleEnforceResult>({
      domain: 'lifecycle',
      operation: 'enforce',
      args: [params.epicId, params.stage],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'enforce', startTime);
  }

  /**
   * skip - Skip a stage
   * CLI: cleo lifecycle skip <epicId> <stage> --reason <reason>
   */
  private async mutateSkip(params: LifecycleSkipParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || !params?.stage || !params?.reason) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'skip',
        'E_INVALID_INPUT',
        'epicId, stage, and reason are required',
        startTime
      );
    }

    const result = await this.executor.execute<LifecycleSkipResult>({
      domain: 'lifecycle',
      operation: 'skip',
      args: [params.epicId, params.stage],
      flags: { json: true, reason: params.reason },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'skip', startTime);
  }

  /**
   * unskip - Unskip a stage
   * CLI: cleo lifecycle unskip <epicId> <stage>
   */
  private async mutateUnskip(params: LifecycleUnskipParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || !params?.stage) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'unskip',
        'E_INVALID_INPUT',
        'epicId and stage are required',
        startTime
      );
    }

    const result = await this.executor.execute<LifecycleUnskipResult>({
      domain: 'lifecycle',
      operation: 'unskip',
      args: [params.epicId, params.stage],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'unskip', startTime);
  }

  /**
   * import - Import lifecycle data
   * CLI: cleo lifecycle import <source> [--epic <id>] [--overwrite]
   */
  private async mutateImport(params: LifecycleImportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.source) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'import',
        'E_INVALID_INPUT',
        'source is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;
    if (params?.overwrite) flags.overwrite = true;

    const result = await this.executor.execute<LifecycleImportResult>({
      domain: 'lifecycle',
      operation: 'import',
      args: [params.source],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'import', startTime);
  }

  /**
   * history - Stage transition history
   * CLI: cleo lifecycle history <taskId>
   */
  private async queryHistory(params: LifecycleHistoryParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        'history',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'lifecycle',
      operation: 'history',
      args: [params.taskId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'history', startTime);
  }

  /**
   * gates - All gate statuses
   * CLI: cleo lifecycle gates <taskId>
   */
  private async queryGates(params: LifecycleGatesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        'gates',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'lifecycle',
      operation: 'gates',
      args: [params.taskId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'gates', startTime);
  }

  /**
   * prerequisites - Required prior stages
   * CLI: cleo lifecycle prerequisites <targetStage>
   */
  private async queryPrerequisites(params: LifecyclePrerequisitesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.targetStage) {
      return this.createErrorResponse(
        'cleo_query',
        'lifecycle',
        'prerequisites',
        'E_INVALID_INPUT',
        'targetStage is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'lifecycle',
      operation: 'prerequisites',
      args: [params.targetStage],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'lifecycle', 'prerequisites', startTime);
  }

  // ===== New Mutate Operations =====

  /**
   * reset - Reset a stage (emergency)
   * CLI: cleo lifecycle reset <taskId> <stage> --reason <reason>
   */
  private async mutateReset(params: LifecycleResetParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.stage || !params?.reason) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'reset',
        'E_INVALID_INPUT',
        'taskId, stage, and reason are required',
        startTime
      );
    }

    const result = await this.executor.execute<LifecycleResetResult>({
      domain: 'lifecycle',
      operation: 'reset',
      args: [params.taskId, params.stage],
      flags: { json: true, reason: params.reason },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'reset', startTime);
  }

  /**
   * gate.pass - Mark gate as passed
   * CLI: cleo lifecycle gate pass <taskId> <gateName> --agent <agent> [--notes <notes>]
   */
  private async mutateGatePass(params: LifecycleGatePassParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.gateName) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'gate.pass',
        'E_INVALID_INPUT',
        'taskId and gateName are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.agent) flags.agent = params.agent;
    if (params?.notes) flags.notes = params.notes;

    const result = await this.executor.execute<LifecycleGatePassResult>({
      domain: 'lifecycle',
      operation: 'gate',
      args: ['pass', params.taskId, params.gateName],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'gate.pass', startTime);
  }

  /**
   * gate.fail - Mark gate as failed
   * CLI: cleo lifecycle gate fail <taskId> <gateName> --reason <reason>
   */
  private async mutateGateFail(params: LifecycleGateFailParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.gateName) {
      return this.createErrorResponse(
        'cleo_mutate',
        'lifecycle',
        'gate.fail',
        'E_INVALID_INPUT',
        'taskId and gateName are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.reason) flags.reason = params.reason;

    const result = await this.executor.execute<LifecycleGateFailResult>({
      domain: 'lifecycle',
      operation: 'gate',
      args: ['fail', params.taskId, params.gateName],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'lifecycle', 'gate.fail', startTime);
  }

  // ===== Helper Methods =====

  /**
   * Wrap executor result in DomainResponse format
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
      error: result.error,
    };
  }

  /**
   * Create error response
   */
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

  /**
   * Handle unexpected errors
   */
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
      'E_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime
    );
  }
}
