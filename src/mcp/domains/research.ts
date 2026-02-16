/**
 * Research Domain Handler
 *
 * Implements all 10 research operations for CLEO MCP server:
 * - Query (5): list, stats, validate, search, export
 * - Mutate (5): link, unlink, import, aggregate, report
 *
 * Maps to cleo research CLI commands with proper parameter validation.
 *
 * @task T2931
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { ManifestReader, ManifestEntry, ManifestFilter } from '../lib/manifest.js';
import { validateEntry, serializeEntry } from '../lib/manifest-parser.js';
import { appendFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  researchShow as nativeResearchShow,
  researchList as nativeResearchList,
  researchQuery as nativeResearchQuery,
  researchPending as nativeResearchPending,
  researchStats as nativeResearchStats,
  researchManifestRead as nativeResearchManifestRead,
  researchLink as nativeResearchLink,
  researchManifestAppend as nativeResearchManifestAppend,
  researchManifestArchive as nativeResearchManifestArchive,
  researchContradictions as nativeResearchContradictions,
  researchSuperseded as nativeResearchSuperseded,
  researchInject as nativeResearchInject,
  researchCompact as nativeResearchCompact,
  researchValidateOp as nativeResearchValidate,
  resolveProjectRoot,
} from '../engine/index.js';

/**
 * Research entry from manifest
 */
interface ResearchEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup?: string[];
  linked_tasks?: string[];
}

/**
 * Research statistics
 */
interface ResearchStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  actionable: number;
  needsFollowup: number;
  averageFindings: number;
}

/**
 * Query operation parameters
 */
interface ResearchListParams {
  taskId?: string;
  status?: string;
  type?: string;
  topic?: string;
  limit?: number;
  actionable?: boolean;
}

interface ResearchStatsParams {
  epicId?: string;
}

interface ResearchValidateParams {
  taskId: string;
}

interface ResearchSearchParams {
  query: string;
  confidence?: number;
  limit?: number;
}

interface ResearchExportParams {
  format?: 'json' | 'markdown';
  filter?: {
    status?: string;
    type?: string;
  };
}

/**
 * Mutate operation parameters
 */
interface ResearchLinkParams {
  taskId: string;
  researchId: string;
  notes?: string;
}

interface ResearchUnlinkParams {
  taskId: string;
  researchId: string;
}

interface ResearchImportParams {
  source: string;
  overwrite?: boolean;
}

interface ResearchAggregateParams {
  taskIds: string[];
  outputFile?: string;
}

interface ResearchReportParams {
  epicId?: string;
  format?: 'markdown' | 'html';
  includeLinks?: boolean;
}

interface ResearchShowParams {
  researchId: string;
}

interface ResearchPendingParams {
  epicId?: string;
}

interface ResearchInjectParams {
  protocolType: string;
  taskId?: string;
  variant?: string;
}

interface ResearchManifestAppendParams {
  entry: ManifestEntry;
}

interface ResearchManifestArchiveParams {
  beforeDate: string;
}

/**
 * Research domain handler implementation
 */
export class ResearchHandler implements DomainHandler {
  private manifestReader: ManifestReader;
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(
    private executor: CLIExecutor,
    manifestPath: string = 'claudedocs/agent-outputs/MANIFEST.jsonl',
    executionMode: ResolvedMode = 'cli'
  ) {
    this.manifestReader = new ManifestReader(manifestPath);
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  /**
   * Check if we should use native engine for this operation
   */
  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor.isAvailable()) {
      return false;
    }
    return canRunNatively('research', operation, gateway);
  }

  /**
   * Wrap a native engine result in DomainResponse format
   */
  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;
    if (result.success) {
      return {
        _meta: { gateway, domain: 'research', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'research', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'query')) {
      try {
        return this.queryNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_query', 'research', operation, error, startTime);
      }
    }

    // CLI-only operations: check CLI availability
    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'research.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'list':
          return await this.queryList(params as unknown as ResearchListParams);
        case 'stats':
          return await this.queryStats(params as unknown as ResearchStatsParams);
        case 'validate':
          return await this.queryValidate(params as unknown as ResearchValidateParams);
        case 'search':
          return await this.querySearch(params as unknown as ResearchSearchParams);
        case 'export':
          return await this.queryExport(params as unknown as ResearchExportParams);
        case 'manifest.read':
          return await this.queryManifestRead(params as ManifestFilter);
        case 'manifest.validate':
          return await this.queryManifestValidate();
        case 'manifest.summary':
          return await this.queryManifestSummary();
        case 'show':
          return await this.queryShow(params as unknown as ResearchShowParams);
        case 'pending':
          return await this.queryPending(params as unknown as ResearchPendingParams);
        case 'query':
          return await this.querySearch(params as unknown as ResearchSearchParams);
        case 'contradictions':
          return this.wrapNativeResult(nativeResearchContradictions(this.projectRoot, params as any), 'cleo_query', operation, startTime);
        case 'superseded':
          return this.wrapNativeResult(nativeResearchSuperseded(this.projectRoot, params as any), 'cleo_query', operation, startTime);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'research',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'research', operation, error, startTime);
    }
  }

  /**
   * Native query dispatch
   */
  private queryNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    switch (operation) {
      case 'show':
        return this.wrapNativeResult(nativeResearchShow(params?.researchId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'list':
        return this.wrapNativeResult(nativeResearchList(params as any, this.projectRoot), 'cleo_query', operation, startTime);
      case 'query':
      case 'search':
        return this.wrapNativeResult(
          nativeResearchQuery(params?.query as string, { confidence: params?.confidence as number, limit: params?.limit as number }, this.projectRoot),
          'cleo_query', operation, startTime
        );
      case 'pending':
        return this.wrapNativeResult(nativeResearchPending(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'stats':
        return this.wrapNativeResult(nativeResearchStats(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'manifest.read':
        return this.wrapNativeResult(nativeResearchManifestRead(params as any, this.projectRoot), 'cleo_query', operation, startTime);
      case 'contradictions':
        return this.wrapNativeResult(nativeResearchContradictions(this.projectRoot, params as any), 'cleo_query', operation, startTime);
      case 'superseded':
        return this.wrapNativeResult(nativeResearchSuperseded(this.projectRoot, params as any), 'cleo_query', operation, startTime);
      default:
        return this.createErrorResponse('cleo_query', 'research', operation, 'E_INVALID_OPERATION', `Unknown native query operation: ${operation}`, startTime);
    }
  }

  /**
   * Native mutate dispatch
   */
  private mutateNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): DomainResponse {
    switch (operation) {
      case 'link':
        return this.wrapNativeResult(
          nativeResearchLink(params?.taskId as string, params?.researchId as string, params?.notes as string, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'manifest.append':
        return this.wrapNativeResult(nativeResearchManifestAppend(params?.entry as any, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'manifest.archive':
        return this.wrapNativeResult(nativeResearchManifestArchive(params?.beforeDate as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'inject':
        return this.wrapNativeResult(
          nativeResearchInject(params?.protocolType as string, params as { taskId?: string; variant?: string }, this.projectRoot),
          'cleo_mutate', operation, startTime
        );
      case 'compact':
        return this.wrapNativeResult(nativeResearchCompact(this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'validate':
        return this.wrapNativeResult(nativeResearchValidate(params?.taskId as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      default:
        return this.createErrorResponse('cleo_mutate', 'research', operation, 'E_INVALID_OPERATION', `Unknown native mutate operation: ${operation}`, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'mutate')) {
      try {
        return this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'research', operation, error, startTime);
      }
    }

    // CLI-only operations: check CLI availability
    if (!this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'research.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'link':
          return await this.mutateLink(params as unknown as ResearchLinkParams);
        case 'unlink':
          return await this.mutateUnlink(params as unknown as ResearchUnlinkParams);
        case 'import':
          return await this.mutateImport(params as unknown as ResearchImportParams);
        case 'aggregate':
          return await this.mutateAggregate(params as unknown as ResearchAggregateParams);
        case 'report':
          return await this.mutateReport(params as unknown as ResearchReportParams);
        case 'inject':
          return await this.mutateInject(params as unknown as ResearchInjectParams);
        case 'manifest.append':
          return await this.mutateManifestAppend(params as unknown as ResearchManifestAppendParams);
        case 'manifest.archive':
          return await this.mutateManifestArchive(params as unknown as ResearchManifestArchiveParams);
        case 'compact':
          return this.mutateNative('compact', params, startTime);
        case 'validate':
          return this.mutateNative('validate', params, startTime);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'research',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'research', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'stats', 'validate', 'search', 'export', 'manifest.read', 'manifest.validate', 'manifest.summary', 'show', 'pending', 'query', 'contradictions', 'superseded'],
      mutate: ['link', 'unlink', 'import', 'aggregate', 'report', 'inject', 'manifest.append', 'manifest.archive', 'compact', 'validate'],
    };
  }

  // ===== Query Operations =====

  /**
   * list - List research entries
   * Uses ManifestReader directly for reliable parsing (CLI has jq issues with malformed lines)
   */
  private async queryList(params: ResearchListParams): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      const entries = await this.manifestReader.readManifest();

      // Build filter from params
      const filter: ManifestFilter = {};
      if (params?.taskId) filter.taskId = params.taskId;
      if (params?.status) filter.status = params.status as ManifestFilter['status'];
      if (params?.type) filter.agent_type = params.type;
      if (params?.topic) filter.topic = params.topic;
      if (params?.limit) filter.limit = params.limit;
      if (params?.actionable !== undefined) filter.actionable = params.actionable;

      const filtered = this.manifestReader.filterEntries(entries, filter);

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'research',
          operation: 'list',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          entries: filtered,
          total: filtered.length,
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'list',
        'E_MANIFEST_READ_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * stats - Research statistics
   * Uses ManifestReader directly for reliable parsing (CLI has jq issues with malformed lines)
   */
  private async queryStats(params: ResearchStatsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      const entries = await this.manifestReader.readManifest();

      // If epicId filter is provided, filter entries first
      let filteredEntries = entries;
      if (params?.epicId) {
        filteredEntries = entries.filter(
          (e) =>
            e.id.startsWith(params.epicId!) ||
            e.linked_tasks?.includes(params.epicId!)
        );
      }

      // Compute stats from entries
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let actionable = 0;
      let needsFollowup = 0;
      let totalFindings = 0;

      for (const entry of filteredEntries) {
        byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
        byType[entry.agent_type] = (byType[entry.agent_type] || 0) + 1;
        if (entry.actionable) actionable++;
        if (entry.needs_followup && entry.needs_followup.length > 0) needsFollowup++;
        if (entry.key_findings) totalFindings += entry.key_findings.length;
      }

      const stats: ResearchStats = {
        total: filteredEntries.length,
        byStatus,
        byType,
        actionable,
        needsFollowup,
        averageFindings: filteredEntries.length > 0
          ? Math.round((totalFindings / filteredEntries.length) * 10) / 10
          : 0,
      };

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'research',
          operation: 'stats',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: stats,
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'stats',
        'E_MANIFEST_READ_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * validate - Validate research links
   * CLI: cleo research validate <taskId>
   */
  private async queryValidate(params: ResearchValidateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'validate',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'validate',
      args: [params.taskId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'research', 'validate', startTime);
  }

  /**
   * search - Search research entries
   * CLI: cleo research show <query> [--confidence <n>] [--limit <n>]
   */
  private async querySearch(params: ResearchSearchParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.query) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'search',
        'E_INVALID_INPUT',
        'query is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.confidence !== undefined) flags.confidence = params.confidence;
    if (params?.limit) flags.limit = params.limit;

    const result = await this.executor.execute<ResearchEntry[]>({
      domain: 'research',
      operation: 'show',
      args: [params.query],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'research', 'search', startTime);
  }

  /**
   * export - Export research data
   * CLI: cleo research export [--format <fmt>] [--status <status>] [--type <type>]
   */
  private async queryExport(params: ResearchExportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.format) flags.format = params.format;
    if (params?.filter?.status) flags.status = params.filter.status;
    if (params?.filter?.type) flags.type = params.filter.type;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'export',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'research', 'export', startTime);
  }

  /**
   * manifest.read - Read manifest entries
   * Direct: ManifestReader (not CLI)
   */
  private async queryManifestRead(params?: ManifestFilter): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      const entries = await this.manifestReader.readManifest();
      const filtered = params
        ? this.manifestReader.filterEntries(entries, params)
        : entries;

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'research',
          operation: 'manifest.read',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          entries: filtered,
          total: filtered.length,
          filter: params || {},
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'manifest.read',
        'E_MANIFEST_READ_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * manifest.validate - Validate manifest integrity
   * Direct: ManifestReader (not CLI)
   */
  private async queryManifestValidate(): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      const validation = await this.manifestReader.validateManifest();

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'research',
          operation: 'manifest.validate',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: validation,
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'manifest.validate',
        'E_MANIFEST_VALIDATION_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * manifest.summary - Get manifest statistics
   * Direct: ManifestReader (not CLI)
   */
  private async queryManifestSummary(): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      const summary = await this.manifestReader.getSummary();

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'research',
          operation: 'manifest.summary',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: summary,
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'manifest.summary',
        'E_MANIFEST_SUMMARY_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  // ===== Mutate Operations =====

  /**
   * link - Link research to task
   * CLI: cleo research link <taskId> <researchId> [--notes <text>]
   */
  private async mutateLink(params: ResearchLinkParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.researchId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'link',
        'E_INVALID_INPUT',
        'taskId and researchId are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.notes) flags.notes = params.notes;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'link',
      args: [params.taskId, params.researchId],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'link', startTime);
  }

  /**
   * unlink - Unlink research from task
   * CLI: cleo research unlink <taskId> <researchId>
   */
  private async mutateUnlink(params: ResearchUnlinkParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.researchId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'unlink',
        'E_INVALID_INPUT',
        'taskId and researchId are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'unlink',
      args: [params.taskId, params.researchId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'unlink', startTime);
  }

  /**
   * import - Import research data
   * CLI: cleo research import <source> [--overwrite]
   */
  private async mutateImport(params: ResearchImportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.source) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'import',
        'E_INVALID_INPUT',
        'source is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.overwrite) flags.overwrite = true;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'import',
      args: [params.source],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'import', startTime);
  }

  /**
   * aggregate - Aggregate research findings
   * CLI: cleo research aggregate <id1> <id2> ... [--output <file>]
   */
  private async mutateAggregate(params: ResearchAggregateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskIds || params.taskIds.length === 0) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'aggregate',
        'E_INVALID_INPUT',
        'taskIds array is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.outputFile) flags.output = params.outputFile;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'aggregate',
      args: params.taskIds,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'aggregate', startTime);
  }

  /**
   * report - Generate research report
   * CLI: cleo research report [--epic <id>] [--format <fmt>] [--include-links]
   */
  private async mutateReport(params: ResearchReportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;
    if (params?.format) flags.format = params.format;
    if (params?.includeLinks) flags['include-links'] = true;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'report',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'report', startTime);
  }

  /**
   * show - Get research entry details
   * CLI: cleo research show <researchId>
   */
  private async queryShow(params: ResearchShowParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.researchId) {
      return this.createErrorResponse(
        'cleo_query',
        'research',
        'show',
        'E_INVALID_INPUT',
        'researchId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'show',
      args: [params.researchId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'research', 'show', startTime);
  }

  /**
   * pending - Get pending research items
   * CLI: cleo research pending [--epicId <id>]
   */
  private async queryPending(params: ResearchPendingParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'pending',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'research', 'pending', startTime);
  }

  /**
   * inject - Get protocol injection content
   * CLI: cleo research inject <protocolType> [--taskId <id>] [--variant <variant>]
   */
  private async mutateInject(params: ResearchInjectParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.protocolType) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'inject',
        'E_INVALID_INPUT',
        'protocolType is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.taskId) flags.task = params.taskId;
    if (params?.variant) flags.variant = params.variant;

    const result = await this.executor.execute({
      domain: 'research',
      operation: 'inject',
      args: [params.protocolType],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'research', 'inject', startTime);
  }

  /**
   * manifest.append - Append entry to MANIFEST.jsonl
   * Direct: Validates and appends to manifest file
   */
  private async mutateManifestAppend(params: ResearchManifestAppendParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.entry) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'manifest.append',
        'E_INVALID_INPUT',
        'entry is required',
        startTime
      );
    }

    try {
      // Validate the entry
      const validation = validateEntry(params.entry as ManifestEntry);
      if (!validation.valid) {
        const errorMessages = validation.errors
          .filter((e) => e.severity === 'error')
          .map((e) => `${e.field}: ${e.message}`)
          .join(', ');
        return this.createErrorResponse(
          'cleo_mutate',
          'research',
          'manifest.append',
          'E_VALIDATION_FAILED',
          `Invalid manifest entry: ${errorMessages}`,
          startTime
        );
      }

      // Serialize and append
      const serialized = serializeEntry(params.entry as ManifestEntry);
      const manifestPath = resolve(process.cwd(), 'claudedocs/agent-outputs/MANIFEST.jsonl');
      await appendFile(manifestPath, serialized + '\n', 'utf-8');

      return {
        _meta: {
          gateway: 'cleo_mutate',
          domain: 'research',
          operation: 'manifest.append',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          appended: true,
          entryId: params.entry.id,
          file: 'claudedocs/agent-outputs/MANIFEST.jsonl',
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'manifest.append',
        'E_MANIFEST_APPEND_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * manifest.archive - Archive old manifest entries
   * Direct: Reads manifest, filters by date, writes archived entries
   */
  private async mutateManifestArchive(params: ResearchManifestArchiveParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.beforeDate) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'manifest.archive',
        'E_INVALID_INPUT',
        'beforeDate is required (ISO-8601 format: YYYY-MM-DD)',
        startTime
      );
    }

    try {
      const entries = await this.manifestReader.readManifest();
      const toArchive = entries.filter((e) => e.date < params.beforeDate);
      const toKeep = entries.filter((e) => e.date >= params.beforeDate);

      if (toArchive.length === 0) {
        return {
          _meta: {
            gateway: 'cleo_mutate',
            domain: 'research',
            operation: 'manifest.archive',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
          },
          success: true,
          data: {
            archived: 0,
            remaining: entries.length,
            message: 'No entries found before the specified date',
          },
        };
      }

      // Write archived entries to archive file
      const archivePath = resolve(process.cwd(), 'claudedocs/agent-outputs/MANIFEST.archive.jsonl');
      const archiveContent = toArchive.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await appendFile(archivePath, archiveContent, 'utf-8');

      // Rewrite main manifest with remaining entries
      const manifestPath = resolve(process.cwd(), 'claudedocs/agent-outputs/MANIFEST.jsonl');
      const remainingContent = toKeep.length > 0
        ? toKeep.map((e) => JSON.stringify(e)).join('\n') + '\n'
        : '';
      await writeFile(manifestPath, remainingContent, 'utf-8');

      return {
        _meta: {
          gateway: 'cleo_mutate',
          domain: 'research',
          operation: 'manifest.archive',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          archived: toArchive.length,
          remaining: toKeep.length,
          archiveFile: 'claudedocs/agent-outputs/MANIFEST.archive.jsonl',
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_mutate',
        'research',
        'manifest.archive',
        'E_MANIFEST_ARCHIVE_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
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
