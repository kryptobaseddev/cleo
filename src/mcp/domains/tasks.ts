/**
 * Tasks Domain Handler
 *
 * Implements all 30 task operations for CLEO MCP server:
 * - Query (16): show, get, list, find, exists, next, depends, deps, stats, export, history, lint, batch-validate, manifest, tree, blockers, analyze
 * - Mutate (14): add, create, update, complete, delete, archive, restore, unarchive, import, reorder, reparent, promote, reopen, uncancel
 *
 * Each operation maps to corresponding CLEO CLI commands with proper
 * parameter validation and error handling.
 *
 * @task T2916
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
// Formatter imports available but currently handled via class methods
// import { formatSuccess, formatError, createError } from '../lib/formatter.js';
import { ManifestReader } from '../lib/manifest.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  taskShow as nativeTaskShow,
  taskList as nativeTaskList,
  taskFind as nativeTaskFind,
  taskExists as nativeTaskExists,
  taskCreate as nativeTaskCreate,
  taskUpdate as nativeTaskUpdate,
  taskComplete as nativeTaskComplete,
  taskDelete as nativeTaskDelete,
  taskArchive as nativeTaskArchive,
  taskNext as nativeTaskNext,
  taskBlockers as nativeTaskBlockers,
  taskTree as nativeTaskTree,
  taskDeps as nativeTaskDeps,
  taskRelates as nativeTaskRelates,
  taskAnalyze as nativeTaskAnalyze,
  taskRestore as nativeTaskRestore,
  taskUnarchive as nativeTaskUnarchive,
  taskReorder as nativeTaskReorder,
  taskReparent as nativeTaskReparent,
  taskPromote as nativeTaskPromote,
  taskReopen as nativeTaskReopen,
  taskRelatesAdd as nativeTaskRelatesAdd,
  taskComplexityEstimate as nativeTaskComplexityEstimate,
  taskDepends as nativeTaskDepends,
  taskStats as nativeTaskStats,
  taskExport as nativeTaskExport,
  taskHistory as nativeTaskHistory,
  taskLint as nativeTaskLint,
  taskBatchValidate as nativeTaskBatchValidate,
  taskImport as nativeTaskImport,
  resolveProjectRoot,
  isProjectInitialized,
} from '../engine/index.js';
import { createCLIRequiredError, createNotInitializedError } from '../lib/mode-detector.js';
import type {
  Task,
  MinimalTask,
  TasksGetParams,
  TasksListParams,
  TasksFindParams,
  TasksExistsParams,
  TasksNextParams,
  TasksCreateParams,
  TasksUpdateParams,
  TasksCompleteParams,
  TasksDeleteParams,
  TasksArchiveParams,
  TasksUnarchiveParams,
  TasksReorderParams,
} from '../types/index.js';

/**
 * Additional operation types not in base types
 */
interface TasksDependsParams {
  taskId: string;
  direction?: 'upstream' | 'downstream' | 'both';
}

interface DependencyInfo {
  taskId: string;
  depends: string[];
  blockedBy: string[];
}

interface TasksStatsParams {
  epicId?: string;
}

interface TaskStats {
  total: number;
  pending: number;
  active: number;
  blocked: number;
  done: number;
}

interface TasksExportParams {
  format?: 'json' | 'csv';
  filter?: {
    status?: string;
    parent?: string;
  };
}

interface TasksHistoryParams {
  taskId: string;
  limit?: number;
}

interface HistoryEntry {
  timestamp: string;
  action: string;
  details?: string;
}

interface TasksLintParams {
  taskId?: string;
  fix?: boolean;
}

interface ValidationIssue {
  taskId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

interface TasksBatchValidateParams {
  taskIds: string[];
  checkMode?: 'full' | 'quick';
}

interface TasksImportParams {
  source: string;
  overwrite?: boolean;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface TasksTreeParams {
  rootId?: string;
  depth?: number;
}

interface TasksBlockersParams {
  taskId: string;
}

interface TasksAnalyzeParams {
  epicId?: string;
}

interface TasksReparentParams {
  taskId: string;
  newParent: string;
}

interface TasksPromoteParams {
  taskId: string;
}

interface TasksReopenParams {
  taskId: string;
}

interface TasksUncancelParams {
  taskId: string;
  cascade?: boolean;
  notes?: string;
}

interface TasksRelatesParams {
  taskId: string;
  subcommand?: 'suggest' | 'list' | 'discover';
  targetId?: string;
  type?: string;
  reason?: string;
  threshold?: number;
}

/**
 * Tasks domain handler implementation
 */
export class TasksHandler implements DomainHandler {
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
    return canRunNatively('tasks', operation, gateway);
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
        _meta: { gateway, domain: 'tasks', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'tasks', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
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
        return this.handleError('cleo_query', 'tasks', operation, error, startTime);
      }
    }

    // CLI-only operations: check CLI availability
    if (!this.executor.isAvailable()) {
      const err = createCLIRequiredError('tasks', operation);
      return this.wrapNativeResult(err, 'cleo_query', operation, startTime);
    }

    try {
      switch (operation) {
        case 'show':
          return await this.queryShow(params as unknown as TasksGetParams);
        case 'list':
          return await this.queryList(params as unknown as TasksListParams);
        case 'find':
          return await this.queryFind(params as unknown as TasksFindParams);
        case 'exists':
          return await this.queryExists(params as unknown as TasksExistsParams);
        case 'next':
          return await this.queryNext(params as unknown as TasksNextParams);
        case 'depends':
          return await this.queryDepends(params as unknown as TasksDependsParams);
        case 'stats':
          return await this.queryStats(params as unknown as TasksStatsParams);
        case 'export':
          return await this.queryExport(params as unknown as TasksExportParams);
        case 'history':
          return await this.queryHistory(params as unknown as TasksHistoryParams);
        case 'lint':
          return await this.queryLint(params as unknown as TasksLintParams);
        case 'batch-validate':
          return await this.queryBatchValidate(params as unknown as TasksBatchValidateParams);
        case 'manifest':
          return await this.queryManifest(params as { taskId: string });
        case 'tree':
          return await this.queryTree(params as unknown as TasksTreeParams);
        case 'blockers':
          return await this.queryBlockers(params as unknown as TasksBlockersParams);
        case 'analyze':
          return await this.queryAnalyze(params as unknown as TasksAnalyzeParams);
        case 'get':
          return await this.queryShow(params as unknown as TasksGetParams);
        case 'deps':
          return await this.queryDepends(params as unknown as TasksDependsParams);
        case 'relates':
          return await this.queryRelates(params as unknown as TasksRelatesParams);
        case 'complexity-estimate':
          return this.queryComplexityEstimate(params as unknown as { taskId: string });
        default:
          return this.createErrorResponse(
            'cleo_query',
            'tasks',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'tasks', operation, error, startTime);
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
        return await this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'tasks', operation, error, startTime);
      }
    }

    // CLI-only operations: check CLI availability
    if (!this.executor.isAvailable()) {
      const err = createCLIRequiredError('tasks', operation);
      return this.wrapNativeResult(err, 'cleo_mutate', operation, startTime);
    }

    try {
      switch (operation) {
        case 'add':
          return await this.mutateAdd(params as unknown as TasksCreateParams);
        case 'update':
          return await this.mutateUpdate(params as unknown as TasksUpdateParams);
        case 'complete':
          return await this.mutateComplete(params as unknown as TasksCompleteParams);
        case 'delete':
          return await this.mutateDelete(params as unknown as TasksDeleteParams);
        case 'archive':
          return await this.mutateArchive(params as unknown as TasksArchiveParams);
        case 'restore':
          return await this.mutateRestore(params as unknown as TasksUnarchiveParams);
        case 'import':
          return await this.mutateImport(params as unknown as TasksImportParams);
        case 'reorder':
          return await this.mutateReorder(params as unknown as TasksReorderParams);
        case 'reparent':
          return await this.mutateReparent(params as unknown as TasksReparentParams);
        case 'promote':
          return await this.mutatePromote(params as unknown as TasksPromoteParams);
        case 'reopen':
          return await this.mutateReopen(params as unknown as TasksReopenParams);
        case 'create':
          return await this.mutateAdd(params as unknown as TasksCreateParams);
        case 'unarchive':
          return await this.mutateRestore(params as unknown as TasksUnarchiveParams);
        case 'relates.add':
          return await this.mutateRelatesAdd(params as unknown as TasksRelatesParams);
        case 'uncancel':
          return await this.mutateUncancel(params as unknown as TasksUncancelParams);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'tasks',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'tasks', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'show',
        'get',
        'list',
        'find',
        'exists',
        'next',
        'depends',
        'deps',
        'stats',
        'export',
        'history',
        'lint',
        'batch-validate',
        'manifest',
        'tree',
        'blockers',
        'analyze',
        'relates',
        'complexity-estimate',
      ],
      mutate: [
        'add',
        'create',
        'update',
        'complete',
        'delete',
        'archive',
        'restore',
        'unarchive',
        'import',
        'reorder',
        'reparent',
        'promote',
        'reopen',
        'relates.add',
        'uncancel',
      ],
    };
  }

  // ===== Query Operations =====

  /**
   * show - Get single task details
   * CLI: cleo show <taskId>
   */
  private async queryShow(params: TasksGetParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'show',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute<Task>({
      domain: 'show',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'show', startTime);
  }

  /**
   * list - List tasks with filters
   * CLI: cleo list [--parent <id>] [--status <status>] [--limit <n>]
   */
  private async queryList(params: TasksListParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };

    if (params?.parent) flags.parent = params.parent;
    if (params?.status) flags.status = params.status;
    if (params?.limit) flags.limit = params.limit;

    const result = await this.executor.execute<Task[]>({
      domain: 'list',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'list', startTime);
  }

  /**
   * find - Fuzzy search tasks
   * CLI: cleo find <query> [--limit <n>]
   */
  private async queryFind(params: TasksFindParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.query) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'find',
        'E_INVALID_INPUT',
        'query is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.limit) flags.limit = params.limit;

    const result = await this.executor.execute<MinimalTask[]>({
      domain: 'find',
      operation: params.query,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'find', startTime);
  }

  /**
   * exists - Check task existence
   * CLI: cleo exists <taskId>
   */
  private async queryExists(params: TasksExistsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'exists',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute<{ exists: boolean; taskId: string }>({
      domain: 'exists',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'exists', startTime);
  }

  /**
   * next - Get next suggested task
   * CLI: cleo next [--epic <id>] [--count <n>]
   */
  private async queryNext(params: TasksNextParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;
    if (params?.count) flags.count = params.count;

    const result = await this.executor.execute({
      domain: 'next',
      operation: '',
      flags,
      timeout: 60000,  // next scans all tasks, needs more time than default 30s
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'next', startTime);
  }

  /**
   * depends - Get task dependencies
   * CLI: cleo depends <taskId> [--direction <dir>]
   */
  private async queryDepends(params: TasksDependsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'depends',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.direction) flags.direction = params.direction;

    const result = await this.executor.execute<DependencyInfo>({
      domain: 'depends',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'depends', startTime);
  }

  /**
   * stats - Task statistics
   * CLI: cleo stats [--epic <id>]
   */
  private async queryStats(params: TasksStatsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.epicId) flags.epic = params.epicId;

    const result = await this.executor.execute<TaskStats>({
      domain: 'stats',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'stats', startTime);
  }

  /**
   * export - Export tasks to JSON
   * CLI: cleo export [--format <fmt>] [--status <status>] [--parent <id>]
   */
  private async queryExport(params: TasksExportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.format) flags.format = params.format;
    if (params?.filter?.status) flags.status = params.filter.status;
    if (params?.filter?.parent) flags.parent = params.filter.parent;

    const result = await this.executor.execute({
      domain: 'export',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'export', startTime);
  }

  /**
   * history - Task history
   * CLI: cleo history <taskId> [--limit <n>]
   */
  private async queryHistory(params: TasksHistoryParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'history',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.limit) flags.limit = params.limit;

    const result = await this.executor.execute<HistoryEntry[]>({
      domain: 'history',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'history', startTime);
  }

  /**
   * lint - Validate task data
   * CLI: cleo lint [<taskId>]
   */
  private async queryLint(params: TasksLintParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };

    const result = await this.executor.execute<ValidationIssue[]>({
      domain: 'lint',
      operation: params?.taskId || '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'lint', startTime);
  }

  /**
   * batch-validate - Validate multiple tasks
   * CLI: cleo validate <id1> <id2> ... [--mode <mode>]
   */
  private async queryBatchValidate(params: TasksBatchValidateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskIds || params.taskIds.length === 0) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'batch-validate',
        'E_INVALID_INPUT',
        'taskIds array is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.checkMode) flags.mode = params.checkMode;

    const result = await this.executor.execute<Record<string, ValidationIssue[]>>({
      domain: 'validate',
      operation: '',
      args: params.taskIds,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'batch-validate', startTime);
  }

  /**
   * manifest - Get manifest entries for task
   * Direct: ManifestReader (not CLI)
   */
  private async queryManifest(params: { taskId: string }): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'manifest',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    try {
      const entries = await this.manifestReader.getTaskEntries(params.taskId);

      return {
        _meta: {
          gateway: 'cleo_query',
          domain: 'tasks',
          operation: 'manifest',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
        },
        success: true,
        data: {
          taskId: params.taskId,
          entries,
          total: entries.length,
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'manifest',
        'E_MANIFEST_READ_FAILED',
        error instanceof Error ? error.message : String(error),
        startTime
      );
    }
  }

  /**
   * tree - Hierarchical task view
   * CLI: cleo tree [rootId] [--depth N]
   */
  private async queryTree(params: TasksTreeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.rootId) flags.parent = params.rootId;
    if (params?.depth) flags.depth = params.depth;

    const result = await this.executor.execute({
      domain: 'tree',
      operation: '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'tree', startTime);
  }

  /**
   * blockers - Get blocking tasks
   * CLI: cleo blockers <taskId>
   */
  private async queryBlockers(params: TasksBlockersParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'blockers',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'blockers',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'blockers', startTime);
  }

  /**
   * analyze - Triage analysis
   * CLI: cleo analyze [epicId]
   */
  private async queryAnalyze(params: TasksAnalyzeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };

    const result = await this.executor.execute({
      domain: 'analyze',
      operation: params?.epicId || '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'analyze', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * add - Create new task
   * CLI: cleo add <title> --description <desc> [--parent <id>] [--depends <id>...] [--priority <p>] [--labels <l>...]
   */
  private async mutateAdd(params: TasksCreateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.title || !params?.description) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'add',
        'E_INVALID_INPUT',
        'title and description are required',
        startTime
      );
    }

    const flags: Record<string, unknown> = {
      json: true,
      description: params.description,
    };

    if (params?.parent) flags.parent = params.parent;
    if (params?.depends) flags.depends = params.depends;
    if (params?.priority) flags.priority = params.priority;
    if (params?.labels) flags.labels = params.labels;

    const result = await this.executor.execute<Task>({
      domain: 'add',
      operation: params.title,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'add', startTime);
  }

  /**
   * update - Update task fields
   * CLI: cleo update <taskId> [--title <t>] [--description <d>] [--status <s>] [--priority <p>] [--notes <n>]
   */
  private async mutateUpdate(params: TasksUpdateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'update',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };

    if (params?.title) flags.title = params.title;
    if (params?.description) flags.description = params.description;
    if (params?.status) flags.status = params.status;
    if (params?.priority) flags.priority = params.priority;
    if (params?.notes) flags.notes = params.notes;

    const result = await this.executor.execute<Task>({
      domain: 'update',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'update', startTime);
  }

  /**
   * complete - Mark task done
   * CLI: cleo complete <taskId> [--notes <n>] [--archive]
   */
  private async mutateComplete(params: TasksCompleteParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'complete',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };

    if (params?.notes) flags.notes = params.notes;
    if (params?.archive) flags.archive = true;

    const result = await this.executor.execute({
      domain: 'complete',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'complete', startTime);
  }

  /**
   * delete - Delete task
   * CLI: cleo delete <taskId> [--force]
   */
  private async mutateDelete(params: TasksDeleteParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'delete',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.force) flags.force = true;

    const result = await this.executor.execute({
      domain: 'delete',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'delete', startTime);
  }

  /**
   * archive - Archive completed tasks
   * CLI: cleo archive [<taskId>] [--before <date>]
   */
  private async mutateArchive(params: TasksArchiveParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.before) flags.before = params.before;

    const result = await this.executor.execute({
      domain: 'archive',
      operation: params?.taskId || '',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'archive', startTime);
  }

  /**
   * restore - Restore from archive
   * CLI: cleo restore <taskId>
   */
  private async mutateRestore(params: TasksUnarchiveParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'restore',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute<Task>({
      domain: 'restore',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'restore', startTime);
  }

  /**
   * import - Import tasks from JSON
   * CLI: cleo import <source> [--overwrite]
   */
  private async mutateImport(params: TasksImportParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.source) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'import',
        'E_INVALID_INPUT',
        'source is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.overwrite) flags.overwrite = true;

    const result = await this.executor.execute<ImportResult>({
      domain: 'import',
      operation: params.source,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'import', startTime);
  }

  /**
   * reorder - Change task order
   * CLI: cleo reorder <taskId> <position>
   */
  private async mutateReorder(params: TasksReorderParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || params?.position === undefined) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'reorder',
        'E_INVALID_INPUT',
        'taskId and position are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'reorder',
      operation: params.taskId,
      args: [params.position],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'reorder', startTime);
  }

  /**
   * reparent - Change task parent
   * CLI: cleo reparent <taskId> <newParent>
   */
  private async mutateReparent(params: TasksReparentParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.newParent) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'reparent',
        'E_INVALID_INPUT',
        'taskId and newParent are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'reparent',
      operation: params.taskId,
      args: [params.newParent],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'reparent', startTime);
  }

  /**
   * promote - Promote subtask to task
   * CLI: cleo promote <taskId>
   */
  private async mutatePromote(params: TasksPromoteParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'promote',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'promote',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'promote', startTime);
  }

  /**
   * reopen - Reopen completed task
   * CLI: cleo reopen <taskId>
   */
  private async mutateReopen(params: TasksReopenParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'reopen',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'reopen',
      operation: params.taskId,
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'reopen', startTime);
  }

  /**
   * relates - Query task relationships (suggest, list, discover)
   * CLI: cleo relates suggest|list|discover <taskId> [--json] [--threshold N]
   * @task T4269
   */
  private async queryRelates(params: TasksRelatesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'relates',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.threshold) flags.threshold = params.threshold;

    const subcommand = params?.subcommand || 'list';

    const result = await this.executor.execute({
      domain: 'relates',
      operation: `${subcommand} ${params.taskId}`,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'tasks', 'relates', startTime);
  }

  /**
   * complexity-estimate - Deterministic complexity scoring
   * Native only (no CLI equivalent)
   */
  private queryComplexityEstimate(params: { taskId: string }): DomainResponse {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_query',
        'tasks',
        'complexity-estimate',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = nativeTaskComplexityEstimate(this.projectRoot, { taskId: params.taskId });
    return this.wrapNativeResult(result, 'cleo_query', 'complexity-estimate', startTime);
  }

  /**
   * uncancel - Restore cancelled task to pending status.
   * CLI: cleo uncancel <taskId> [--cascade] [--notes <note>]
   * @task T4555
   */
  private async mutateUncancel(params: TasksUncancelParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'uncancel',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    // Use native engine if available
    if (this.useNative('uncancel', 'mutate')) {
      if (!isProjectInitialized(this.projectRoot)) {
        return this.wrapNativeResult(createNotInitializedError(), 'cleo_mutate', 'uncancel', startTime);
      }
      const result = await nativeTaskRestore(this.projectRoot, params.taskId, {
        cascade: params.cascade,
        notes: params.notes,
      });
      return this.wrapNativeResult(result, 'cleo_mutate', 'uncancel', startTime);
    }

    const flags: Record<string, unknown> = { json: true };
    if (params.cascade) flags.cascade = true;
    if (params.notes) flags.notes = params.notes;

    const result = await this.executor.execute({
      domain: 'uncancel',
      operation: params.taskId,
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'uncancel', startTime);
  }

  /**
   * relates.add - Add a relationship between tasks
   * CLI: cleo relates add <from> <to> <type> "<reason>" [--json]
   * @task T4269
   */
  private async mutateRelatesAdd(params: TasksRelatesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId || !params?.targetId || !params?.type || !params?.reason) {
      return this.createErrorResponse(
        'cleo_mutate',
        'tasks',
        'relates.add',
        'E_INVALID_INPUT',
        'taskId, targetId, type, and reason are required',
        startTime
      );
    }

    const result = await this.executor.execute({
      domain: 'relates',
      operation: `add ${params.taskId} ${params.targetId} ${params.type}`,
      args: [params.reason],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'tasks', 'relates.add', startTime);
  }

  // ===== Native Engine Operations =====

  /**
   * Route query operations to native TypeScript engine
   */
  private queryNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): DomainResponse {
    if (!isProjectInitialized(this.projectRoot)) {
      return this.wrapNativeResult(createNotInitializedError(), 'cleo_query', operation, startTime);
    }

    switch (operation) {
      case 'show':
      case 'get': {
        const taskId = (params as unknown as TasksGetParams)?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(nativeTaskShow(this.projectRoot, taskId), 'cleo_query', operation, startTime);
      }
      case 'list': {
        const p = params as unknown as TasksListParams;
        return this.wrapNativeResult(
          nativeTaskList(this.projectRoot, { parent: p?.parent, status: p?.status, limit: p?.limit }),
          'cleo_query', operation, startTime
        );
      }
      case 'find': {
        const p = params as unknown as TasksFindParams;
        if (!p?.query) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'query is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskFind(this.projectRoot, p.query, p?.limit),
          'cleo_query', operation, startTime
        );
      }
      case 'exists': {
        const taskId = (params as unknown as TasksExistsParams)?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(nativeTaskExists(this.projectRoot, taskId), 'cleo_query', operation, startTime);
      }
      case 'next': {
        const p = params as unknown as TasksNextParams;
        return this.wrapNativeResult(
          nativeTaskNext(this.projectRoot, { count: p?.count, explain: true }),
          'cleo_query', operation, startTime
        );
      }
      case 'blockers': {
        return this.wrapNativeResult(
          nativeTaskBlockers(this.projectRoot, { analyze: true }),
          'cleo_query', operation, startTime
        );
      }
      case 'tree': {
        const p = params as unknown as TasksTreeParams;
        return this.wrapNativeResult(
          nativeTaskTree(this.projectRoot, p?.rootId),
          'cleo_query', operation, startTime
        );
      }
      case 'deps': {
        const taskId = (params as unknown as TasksDependsParams)?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskDeps(this.projectRoot, taskId),
          'cleo_query', operation, startTime
        );
      }
      case 'relates': {
        const taskId = (params as unknown as TasksRelatesParams)?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskRelates(this.projectRoot, taskId),
          'cleo_query', operation, startTime
        );
      }
      case 'analyze': {
        const p = params as unknown as TasksAnalyzeParams;
        return this.wrapNativeResult(
          nativeTaskAnalyze(this.projectRoot, p?.epicId),
          'cleo_query', operation, startTime
        );
      }
      case 'complexity-estimate': {
        const taskId = (params as unknown as { taskId: string })?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskComplexityEstimate(this.projectRoot, { taskId }),
          'cleo_query', operation, startTime
        );
      }
      case 'depends': {
        const p = params as unknown as TasksDependsParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskDepends(this.projectRoot, p.taskId, p.direction),
          'cleo_query', operation, startTime
        );
      }
      case 'stats': {
        const p = params as unknown as TasksStatsParams;
        return this.wrapNativeResult(
          nativeTaskStats(this.projectRoot, p?.epicId),
          'cleo_query', operation, startTime
        );
      }
      case 'export': {
        const p = params as unknown as TasksExportParams;
        return this.wrapNativeResult(
          nativeTaskExport(this.projectRoot, {
            format: p?.format,
            status: p?.filter?.status,
            parent: p?.filter?.parent,
          }),
          'cleo_query', operation, startTime
        );
      }
      case 'history': {
        const p = params as unknown as TasksHistoryParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskHistory(this.projectRoot, p.taskId, p.limit),
          'cleo_query', operation, startTime
        );
      }
      case 'lint': {
        const p = params as unknown as TasksLintParams;
        return this.wrapNativeResult(
          nativeTaskLint(this.projectRoot, p?.taskId),
          'cleo_query', operation, startTime
        );
      }
      case 'batch-validate': {
        const p = params as unknown as TasksBatchValidateParams;
        if (!p?.taskIds || p.taskIds.length === 0) {
          return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_INPUT', 'taskIds array is required', startTime);
        }
        return this.wrapNativeResult(
          nativeTaskBatchValidate(this.projectRoot, p.taskIds, p.checkMode),
          'cleo_query', operation, startTime
        );
      }
      default:
        return this.createErrorResponse('cleo_query', 'tasks', operation, 'E_INVALID_OPERATION', `No native handler for: ${operation}`, startTime);
    }
  }

  /**
   * Route mutate operations to native TypeScript engine
   */
  private async mutateNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): Promise<DomainResponse> {
    if (!isProjectInitialized(this.projectRoot)) {
      return this.wrapNativeResult(createNotInitializedError(), 'cleo_mutate', operation, startTime);
    }

    switch (operation) {
      case 'add':
      case 'create': {
        const p = params as unknown as TasksCreateParams;
        if (!p?.title || !p?.description) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'title and description are required', startTime);
        }
        const result = await nativeTaskCreate(this.projectRoot, {
          title: p.title,
          description: p.description,
          parent: p.parent,
          depends: p.depends,
          priority: p.priority,
          labels: p.labels,
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'update': {
        const p = params as unknown as TasksUpdateParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskUpdate(this.projectRoot, p.taskId, {
          title: p.title,
          description: p.description,
          status: p.status,
          priority: p.priority,
          notes: p.notes,
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'complete': {
        const p = params as unknown as TasksCompleteParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskComplete(this.projectRoot, p.taskId, p.notes);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'delete': {
        const p = params as unknown as TasksDeleteParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskDelete(this.projectRoot, p.taskId, p.force);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'archive': {
        const p = params as unknown as TasksArchiveParams;
        const result = await nativeTaskArchive(this.projectRoot, p?.taskId, p?.before);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'restore': {
        const p = params as unknown as TasksUnarchiveParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskRestore(this.projectRoot, p.taskId, { cascade: (params as any)?.cascade, notes: (params as any)?.notes });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'unarchive': {
        const p = params as unknown as TasksUnarchiveParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskUnarchive(this.projectRoot, p.taskId, { status: (params as any)?.status, preserveStatus: (params as any)?.preserveStatus });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'reorder': {
        const p = params as unknown as TasksReorderParams;
        if (!p?.taskId || p?.position === undefined) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId and position are required', startTime);
        }
        const result = await nativeTaskReorder(this.projectRoot, p.taskId, p.position);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'reparent': {
        const p = params as unknown as TasksReparentParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskReparent(this.projectRoot, p.taskId, p.newParent || null);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'promote': {
        const p = params as unknown as TasksPromoteParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskPromote(this.projectRoot, p.taskId);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'reopen': {
        const p = params as unknown as TasksReopenParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskReopen(this.projectRoot, p.taskId, { status: (params as any)?.status, reason: (params as any)?.reason });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'relates.add': {
        const p = params as unknown as TasksRelatesParams;
        if (!p?.taskId || !p?.targetId || !p?.type) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId, targetId, and type are required', startTime);
        }
        const result = await nativeTaskRelatesAdd(this.projectRoot, p.taskId, p.targetId, p.type, p.reason);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'uncancel': {
        const p = params as unknown as TasksUncancelParams;
        if (!p?.taskId) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeTaskRestore(this.projectRoot, p.taskId, { cascade: p.cascade, notes: p.notes });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'import': {
        const p = params as unknown as TasksImportParams;
        if (!p?.source) {
          return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_INPUT', 'source is required', startTime);
        }
        const result = await nativeTaskImport(this.projectRoot, p.source, p.overwrite);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      default:
        return this.createErrorResponse('cleo_mutate', 'tasks', operation, 'E_INVALID_OPERATION', `No native handler for: ${operation}`, startTime);
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
