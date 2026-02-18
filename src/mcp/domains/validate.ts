/**
 * Validate Domain Handler
 *
 * Implements all 19 validation operations for CLEO MCP server:
 * - Query (13): report, stats, task, compliance, all, schema, protocol, manifest,
 *               output, compliance.summary, compliance.violations, test.status, test.coverage
 * - Mutate (8): fix, schema, protocol, session, research, lifecycle, compliance.record, test.run
 *
 * Each operation maps to corresponding CLEO CLI validate commands with proper
 * parameter validation and error handling.
 *
 * @task T2933
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { createGatewayMeta } from '../lib/gateway-meta.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  validateSchemaOp as nativeValidateSchema,
  validateTaskOp as nativeValidateTask,
  validateProtocol as nativeValidateProtocol,
  validateManifestOp as nativeValidateManifest,
  validateOutput as nativeValidateOutput,
  validateComplianceSummary as nativeValidateComplianceSummary,
  validateComplianceViolations as nativeValidateComplianceViolations,
  validateComplianceRecord as nativeValidateComplianceRecord,
  validateTestStatus as nativeValidateTestStatus,
  validateTestCoverage as nativeValidateTestCoverage,
  validateCoherenceCheck as nativeValidateCoherenceCheck,
  validateTestRun as nativeValidateTestRun,
  validateBatchValidate as nativeValidateBatchValidate,
  resolveProjectRoot,
} from '../engine/index.js';

/**
 * Operation parameter types
 */

// Query operations
interface ValidateReportParams {
  scope?: 'todo' | 'archive' | 'all';
  format?: 'json' | 'summary';
}

interface ValidateStatsParams {
  since?: string; // ISO date
}

interface ValidateTaskParams {
  taskId: string;
  checkMode?: 'full' | 'quick';
}

interface ValidateComplianceParams {
  protocolType?: 'research' | 'consensus' | 'specification' | 'decomposition' | 'implementation' | 'contribution' | 'release' | 'validation' | 'testing';
  severity?: 'error' | 'warning';
}

interface ValidateAllParams {
  strict?: boolean;
  includeArchive?: boolean;
}

// Mutate operations
interface ValidateFixParams {
  auto?: boolean;
  dryRun?: boolean;
  fixType?: 'duplicates' | 'orphans' | 'missing-sizes' | 'all';
}

interface ValidateSchemaParams {
  fileType: 'todo' | 'config' | 'archive' | 'log';
  filePath?: string;
}

interface ValidateProtocolParams {
  taskId: string;
  protocolType: 'research' | 'consensus' | 'specification' | 'decomposition' | 'implementation' | 'contribution' | 'release' | 'validation' | 'testing';
  strict?: boolean;
}

interface ValidateSessionParams {
  sessionId?: string;
  checkFocus?: boolean;
}

interface ValidateResearchParams {
  taskId: string;
  checkLinks?: boolean;
}

interface ValidateLifecycleParams {
  taskId: string;
  targetStage?: string;
}

// New query operations
interface ValidateManifestParams {
  entry?: string;
  taskId?: string;
}

interface ValidateOutputParams {
  taskId: string;
  filePath: string;
}

interface ValidateComplianceViolationsParams {
  severity?: string;
  protocol?: string;
}

interface ValidateTestStatusParams {
  taskId?: string;
}

interface ValidateTestCoverageParams {
  taskId?: string;
}

// New mutate operations
interface ValidateComplianceRecordParams {
  taskId: string;
  result: unknown;
}

interface ValidateTestRunParams {
  scope?: string;
  pattern?: string;
  parallel?: boolean;
}

/**
 * Result types
 */
interface ValidationReport {
  success: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
  };
}

interface ValidationStats {
  totalValidations: number;
  passed: number;
  failed: number;
  byType: Record<string, number>;
}

interface ValidationIssue {
  check: string;
  severity: 'error' | 'warning';
  message: string;
  taskId?: string;
}

interface ComplianceResult {
  compliant: boolean;
  score: number;
  violations: Array<{
    rule: string;
    severity: 'error' | 'warning';
    message: string;
  }>;
}

interface FixResult {
  fixed: number;
  skipped: number;
  errors: string[];
  changes: Array<{
    type: string;
    description: string;
  }>;
}

/**
 * Validate domain handler implementation
 */
export class ValidateHandler implements DomainHandler {
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
    return canRunNatively('validate', operation, gateway);
  }

  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    if (result.success) {
      return {
        _meta: createGatewayMeta(gateway, 'validate', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: createGatewayMeta(gateway, 'validate', operation, startTime),
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  private async queryNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): Promise<DomainResponse> {
    switch (operation) {
      case 'schema':
        return this.wrapNativeResult(nativeValidateSchema(params?.fileType as string || params?.type as string, params?.data, this.projectRoot), 'cleo_query', operation, startTime);
      case 'task':
        return this.wrapNativeResult(await nativeValidateTask(params?.taskId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'protocol':
        return this.wrapNativeResult(await nativeValidateProtocol(params?.taskId as string, params?.protocolType as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'manifest':
        return this.wrapNativeResult(nativeValidateManifest(this.projectRoot), 'cleo_query', operation, startTime);
      case 'output':
        return this.wrapNativeResult(nativeValidateOutput(params?.filePath as string, params?.taskId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'compliance.summary':
        return this.wrapNativeResult(nativeValidateComplianceSummary(this.projectRoot), 'cleo_query', operation, startTime);
      case 'compliance.violations':
        return this.wrapNativeResult(nativeValidateComplianceViolations(params?.limit as number, this.projectRoot), 'cleo_query', operation, startTime);
      case 'test.status':
        return this.wrapNativeResult(nativeValidateTestStatus(this.projectRoot), 'cleo_query', operation, startTime);
      case 'test.coverage':
        return this.wrapNativeResult(nativeValidateTestCoverage(this.projectRoot), 'cleo_query', operation, startTime);
      case 'coherence-check':
        return this.wrapNativeResult(await nativeValidateCoherenceCheck(this.projectRoot), 'cleo_query', operation, startTime);
      default:
        return this.createErrorResponse('cleo_query', 'validate', operation, 'E_INVALID_OPERATION', `Unknown native query operation: ${operation}`, startTime);
    }
  }

  private async mutateNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): Promise<DomainResponse> {
    switch (operation) {
      case 'compliance.record':
        return this.wrapNativeResult(
          nativeValidateComplianceRecord(
            params?.taskId as string,
            params?.result as string,
            params?.protocol as string,
            params?.violations as any,
            this.projectRoot
          ),
          'cleo_mutate', operation, startTime
        );
      case 'test.run':
        return this.wrapNativeResult(
          nativeValidateTestRun(
            params as { scope?: string; pattern?: string; parallel?: boolean } | undefined,
            this.projectRoot
          ),
          'cleo_mutate', operation, startTime
        );
      case 'batch-validate':
        return this.wrapNativeResult(
          await nativeValidateBatchValidate(this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      default:
        return this.createErrorResponse('cleo_mutate', 'validate', operation, 'E_INVALID_OPERATION', `Unknown native mutate operation: ${operation}`, startTime);
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
        return this.handleError('cleo_query', 'validate', operation, error, startTime);
      }
    }

    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'validate.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'report':
          return await this.queryReport(params as unknown as ValidateReportParams);
        case 'stats':
          return await this.queryStats(params as unknown as ValidateStatsParams);
        case 'task':
          return await this.queryTask(params as unknown as ValidateTaskParams);
        case 'compliance':
          return await this.queryCompliance(params as unknown as ValidateComplianceParams);
        case 'all':
          return await this.queryAll(params as unknown as ValidateAllParams);
        case 'schema':
          return await this.querySchema(params as unknown as ValidateSchemaParams);
        case 'protocol':
          return await this.queryProtocol(params as unknown as ValidateProtocolParams);
        case 'manifest':
          return await this.queryManifest(params as unknown as ValidateManifestParams);
        case 'output':
          return await this.queryOutput(params as unknown as ValidateOutputParams);
        case 'compliance.summary':
          return await this.queryCompliance(params as unknown as ValidateComplianceParams);
        case 'compliance.violations':
          return await this.queryComplianceViolations(params as unknown as ValidateComplianceViolationsParams);
        case 'test.status':
          return await this.queryTestStatus(params as unknown as ValidateTestStatusParams);
        case 'test.coverage':
          return await this.queryTestCoverage(params as unknown as ValidateTestCoverageParams);
        case 'coherence-check':
          return this.queryNative(operation, params, startTime);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'validate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'validate', operation, error, startTime);
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
        return this.handleError('cleo_mutate', 'validate', operation, error, startTime);
      }
    }

    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'validate.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'fix':
          return await this.mutateFix(params as unknown as ValidateFixParams);
        case 'schema':
          return await this.mutateSchema(params as unknown as ValidateSchemaParams);
        case 'protocol':
          return await this.mutateProtocol(params as unknown as ValidateProtocolParams);
        case 'session':
          return await this.mutateSession(params as unknown as ValidateSessionParams);
        case 'research':
          return await this.mutateResearch(params as unknown as ValidateResearchParams);
        case 'lifecycle':
          return await this.mutateLifecycle(params as unknown as ValidateLifecycleParams);
        case 'compliance.record':
          return await this.mutateComplianceRecord(params as unknown as ValidateComplianceRecordParams);
        case 'test.run':
          return await this.mutateTestRun(params as unknown as ValidateTestRunParams);
        case 'batch-validate':
          return this.mutateNative('batch-validate', params, startTime);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'validate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'validate', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'report', 'stats', 'task', 'compliance', 'all',
        'schema', 'protocol', 'manifest', 'output',
        'compliance.summary', 'compliance.violations',
        'test.status', 'test.coverage', 'coherence-check',
      ],
      mutate: [
        'fix', 'schema', 'protocol', 'session', 'research', 'lifecycle',
        'compliance.record', 'test.run', 'batch-validate',
      ],
    };
  }

  // ===== Query Operations =====

  /**
   * report - Get validation report
   * CLI: cleo validate [--scope <scope>] [--format <fmt>]
   */
  private async queryReport(params: ValidateReportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.scope) flags.scope = params.scope;
    if (params?.format) flags.format = params.format;

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'report', startTime);
  }

  /**
   * stats - Validation statistics
   * CLI: cleo validate stats [--since <date>]
   */
  private async queryStats(params: ValidateStatsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.since) flags.since = params.since;

    const result = await this.executor.execute<ValidationStats>({
      domain: 'validate',
      operation: 'stats',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'stats', startTime);
  }

  /**
   * task - Validate single task
   *
   * The CLI `cleo validate` does not support per-task scoping, so we fetch the
   * task via `cleo show` and run programmatic validation checks on the returned
   * data, filtering relevant checks from the full validation report.
   */
  private async queryTask(params: ValidateTaskParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        'task',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    // Step 1: Fetch the task to verify it exists and get its data
    const showResult = await this.executor.execute<{ task: Record<string, unknown> }>({
      domain: 'show',
      operation: params.taskId,
      flags: { json: true },
    });

    if (!showResult.success) {
      return this.wrapExecutorResult(showResult, 'cleo_query', 'validate', 'task', startTime);
    }

    const task = showResult.data?.task;
    if (!task) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        'task',
        'E_NOT_FOUND',
        `Task ${params.taskId} not found`,
        startTime
      );
    }

    // Step 2: Run programmatic validation checks on the task
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // Required fields check
    const requiredFields = ['id', 'title', 'status', 'createdAt'];
    for (const field of requiredFields) {
      if (!task[field]) {
        errors.push({
          check: 'required_fields',
          severity: 'error',
          message: `Missing required field: ${field}`,
          taskId: params.taskId,
        });
      }
    }

    // Title and description must differ
    if (task.title && task.description && task.title === task.description) {
      errors.push({
        check: 'title_description_diff',
        severity: 'error',
        message: 'Title and description must be different',
        taskId: params.taskId,
      });
    }

    // Valid status check
    const validStatuses = ['pending', 'active', 'blocked', 'done'];
    if (task.status && !validStatuses.includes(task.status as string)) {
      errors.push({
        check: 'valid_status',
        severity: 'error',
        message: `Invalid status: ${task.status}. Must be one of: ${validStatuses.join(', ')}`,
        taskId: params.taskId,
      });
    }

    // Completed tasks must have completedAt
    if (task.status === 'done' && !task.completedAt) {
      errors.push({
        check: 'completed_at',
        severity: 'error',
        message: 'Done tasks must have completedAt timestamp',
        taskId: params.taskId,
      });
    }

    // Blocked tasks should have blockedBy or depends
    if (task.status === 'blocked' && !task.blockedBy && !(task.depends as unknown[])?.length) {
      warnings.push({
        check: 'blocked_reasons',
        severity: 'warning',
        message: 'Blocked task has no blockedBy reason or dependencies',
        taskId: params.taskId,
      });
    }

    // Size field check
    if (!task.size) {
      warnings.push({
        check: 'missing_size',
        severity: 'warning',
        message: 'Task is missing size field',
        taskId: params.taskId,
      });
    }

    // Future timestamp check
    const now = new Date();
    if (task.createdAt && new Date(task.createdAt as string) > now) {
      errors.push({
        check: 'future_timestamp',
        severity: 'error',
        message: 'createdAt timestamp is in the future',
        taskId: params.taskId,
      });
    }

    const totalChecks = 7; // Number of checks performed
    const report: ValidationReport = {
      success: errors.length === 0,
      errors,
      warnings,
      summary: {
        totalChecks,
        passed: totalChecks - errors.length,
        failed: errors.length,
      },
    };

    return {
      _meta: createGatewayMeta('cleo_query', 'validate', 'task', startTime),
      success: true,
      data: {
        taskId: params.taskId,
        valid: errors.length === 0,
        ...report,
      },
    };
  }

  /**
   * compliance - Check protocol compliance
   * CLI: cleo validate compliance [--protocol <type>] [--severity <level>]
   */
  private async queryCompliance(params: ValidateComplianceParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.protocolType) flags.protocol = params.protocolType;
    if (params?.severity) flags.severity = params.severity;

    const result = await this.executor.execute<ComplianceResult>({
      domain: 'validate',
      operation: 'compliance',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'compliance', startTime);
  }

  /**
   * all - Validate entire system
   * CLI: cleo validate all [--strict] [--include-archive]
   */
  private async queryAll(params: ValidateAllParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.strict) flags.strict = true;
    if (params?.includeArchive) flags.includeArchive = true;

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: 'all',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'all', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * fix - Auto-fix validation errors
   * CLI: cleo validate --fix [--auto] [--dry-run] [--fix-duplicates] [--fix-missing-sizes]
   */
  private async mutateFix(params: ValidateFixParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true, fix: true };
    if (params?.auto) flags.auto = true;
    if (params?.dryRun) flags.dryRun = true;

    // Map fixType to specific fix flags
    if (params?.fixType === 'duplicates') {
      flags.fixDuplicates = true;
    } else if (params?.fixType === 'orphans') {
      flags.fixOrphans = 'unlink'; // Default to unlink
    } else if (params?.fixType === 'missing-sizes') {
      flags.fixMissingSizes = true;
    } else if (params?.fixType === 'all') {
      // Enable all fix types
      flags.fixDuplicates = true;
      flags.fixOrphans = 'unlink';
      flags.fixMissingSizes = true;
    }

    const result = await this.executor.execute<FixResult>({
      domain: 'validate',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'fix', startTime);
  }

  /**
   * schema - Validate against schema
   * CLI: cleo validate schema <fileType> [<filePath>]
   */
  private async mutateSchema(params: ValidateSchemaParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.fileType) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        'schema',
        'E_INVALID_INPUT',
        'fileType is required',
        startTime
      );
    }

    const args: Array<string | number> = [params.fileType];
    if (params?.filePath) {
      args.push(params.filePath);
    }

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: 'schema',
      args,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'schema', startTime);
  }

  /**
   * protocol - Validate protocol compliance
   * CLI: cleo validate protocol <taskId> <protocolType> [--strict]
   */
  private async mutateProtocol(params: ValidateProtocolParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.protocolType) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        'protocol',
        'E_INVALID_INPUT',
        'taskId and protocolType are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.strict) flags.strict = true;

    const result = await this.executor.execute<ComplianceResult>({
      domain: 'validate',
      operation: 'protocol',
      args: [params.taskId, params.protocolType],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'protocol', startTime);
  }

  /**
   * session - Validate session state
   * CLI: cleo validate session [<sessionId>] [--check-focus]
   */
  private async mutateSession(params: ValidateSessionParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.checkFocus) flags.checkFocus = true;

    const args: Array<string | number> = [];
    if (params?.sessionId) {
      args.push(params.sessionId);
    }

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: 'session',
      args,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'session', startTime);
  }

  /**
   * research - Validate research links
   * CLI: cleo validate research <taskId> [--check-links]
   */
  private async mutateResearch(params: ValidateResearchParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        'research',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.checkLinks) flags.checkLinks = true;

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: 'research',
      args: [params.taskId],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'research', startTime);
  }

  /**
   * lifecycle - Validate lifecycle gates
   * CLI: cleo validate lifecycle <taskId> [<targetStage>]
   */
  private async mutateLifecycle(params: ValidateLifecycleParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        'lifecycle',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const args: Array<string | number> = [params.taskId];
    if (params?.targetStage) {
      args.push(params.targetStage);
    }

    const result = await this.executor.execute<ValidationReport>({
      domain: 'validate',
      operation: 'lifecycle',
      args,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'lifecycle', startTime);
  }

  // ===== New Query Operations =====

  /**
   * schema (query) - Validate against JSON schema (read-only check)
   * CLI: cleo validate schema <fileType> [<filePath>]
   */
  private async querySchema(params: ValidateSchemaParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.fileType) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        'schema',
        'E_INVALID_INPUT',
        'fileType is required',
        startTime
      );
    }

    const args: Array<string | number> = [params.fileType];
    if (params?.filePath) {
      args.push(params.filePath);
    }

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'schema',
      args,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'schema', startTime);
  }

  /**
   * protocol (query) - Validate protocol compliance (read-only check)
   * CLI: cleo validate protocol <taskId> <protocolType> [--strict]
   */
  private async queryProtocol(params: ValidateProtocolParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.protocolType) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        'protocol',
        'E_INVALID_INPUT',
        'taskId and protocolType are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.strict) flags.strict = true;

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'protocol',
      args: [params.taskId, params.protocolType],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'protocol', startTime);
  }

  /**
   * manifest - Validate manifest entry
   *
   * The CLI `cleo validate` does not support manifest-scoped validation.
   * We use `cleo research list --json` to fetch manifest entries, then
   * filter by taskId/entry and validate the matching entries.
   */
  private async queryManifest(params: ValidateManifestParams): Promise<DomainResponse> {
    const startTime = Date.now();

    // Fetch manifest entries via research list
    const flags: Record<string, unknown> = { json: true };
    if (params?.taskId) flags.task = params.taskId;

    const result = await this.executor.execute<{ entries?: Array<Record<string, unknown>> }>({
      domain: 'research',
      operation: 'list',
      flags,
    });

    if (!result.success) {
      return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'manifest', startTime);
    }

    const entries = result.data?.entries || [];

    // Filter by entry ID if specified
    let filtered = entries;
    if (params?.entry) {
      filtered = entries.filter((e: Record<string, unknown>) => e.id === params.entry);
    }

    // Validate each matching entry
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    const requiredManifestFields = ['id', 'file', 'title', 'date', 'status'];
    for (const entry of filtered) {
      for (const field of requiredManifestFields) {
        if (!entry[field]) {
          errors.push({
            check: 'manifest_required_fields',
            severity: 'error',
            message: `Manifest entry ${entry.id || '(unknown)'} missing required field: ${field}`,
            taskId: params?.taskId,
          });
        }
      }

      // Validate status enum
      const validStatuses = ['complete', 'partial', 'blocked'];
      if (entry.status && !validStatuses.includes(entry.status as string)) {
        errors.push({
          check: 'manifest_valid_status',
          severity: 'error',
          message: `Manifest entry ${entry.id} has invalid status: ${entry.status}`,
          taskId: params?.taskId,
        });
      }
    }

    const totalChecks = filtered.length * (requiredManifestFields.length + 1);

    return {
      _meta: createGatewayMeta('cleo_query', 'validate', 'manifest', startTime),
      success: true,
      data: {
        valid: errors.length === 0,
        entriesChecked: filtered.length,
        errors,
        warnings,
        summary: {
          totalChecks,
          passed: totalChecks - errors.length,
          failed: errors.length,
        },
      },
    };
  }

  /**
   * output - Validate output file
   * CLI: cleo validate output <taskId> <filePath>
   */
  private async queryOutput(params: ValidateOutputParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.filePath) {
      return this.createErrorResponse(
        'cleo_query',
        'validate',
        'output',
        'E_INVALID_INPUT',
        'taskId and filePath are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'output',
      args: [params.taskId, params.filePath],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'output', startTime);
  }

  /**
   * compliance.violations - List compliance violations
   * CLI: cleo compliance violations [--severity <level>] [--protocol <type>]
   */
  private async queryComplianceViolations(params: ValidateComplianceViolationsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.severity) flags.severity = params.severity;
    if (params?.protocol) flags.protocol = params.protocol;

    const result = await this.executor.execute({
      domain: 'compliance',
      operation: 'violations',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'compliance.violations', startTime);
  }

  /**
   * test.status - Test suite pass/fail counts
   * CLI: cleo validate test status [--task <taskId>]
   */
  private async queryTestStatus(params: ValidateTestStatusParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.taskId) flags.task = params.taskId;

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'test-status',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'test.status', startTime);
  }

  /**
   * test.coverage - Coverage percentages
   * CLI: cleo validate test coverage [--task <taskId>]
   */
  private async queryTestCoverage(params: ValidateTestCoverageParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.taskId) flags.task = params.taskId;

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'test-coverage',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'validate', 'test.coverage', startTime);
  }

  // ===== New Mutate Operations =====

  /**
   * compliance.record - Record compliance check result
   * CLI: cleo compliance record <taskId> --result <json>
   */
  private async mutateComplianceRecord(params: ValidateComplianceRecordParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.result) {
      return this.createErrorResponse(
        'cleo_mutate',
        'validate',
        'compliance.record',
        'E_INVALID_INPUT',
        'taskId and result are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'compliance',
      operation: 'record',
      args: [params.taskId],
      flags: {
        json: true,
        result: typeof params.result === 'string' ? params.result : JSON.stringify(params.result),
      },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'compliance.record', startTime);
  }

  /**
   * test.run - Execute test suite
   * CLI: npx jest [--scope <scope>] [--pattern <pattern>]
   */
  private async mutateTestRun(params: ValidateTestRunParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.scope) flags.scope = params.scope;
    if (params?.pattern) flags.pattern = params.pattern;
    if (params?.parallel) flags.parallel = true;

    const result = await this.executor.execute({
      domain: 'validate',
      operation: 'test-run',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'validate', 'test.run', startTime);
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
    if (result.success) {
      return {
        _meta: createGatewayMeta(gateway, domain, operation, startTime),
        success: true,
        data: result.data,
      };
    }

    return {
      _meta: createGatewayMeta(gateway, domain, operation, startTime),
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
      _meta: createGatewayMeta(gateway, domain, operation, startTime),
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
