/**
 * Tasks Domain Handler
 *
 * Implements all 30 task operations for CLEO MCP server:
 * - Query (16): show, get, list, find, exists, next, depends, deps, stats, export, history, lint, batch-validate, manifest, tree, blockers, analyze
 * - Mutate (13): add, create, update, complete, delete, archive, restore, unarchive, import, reorder, reparent, promote, reopen
 *
 * Each operation maps to corresponding CLEO CLI commands with proper
 * parameter validation and error handling.
 *
 * @task T2916
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { formatSuccess, formatError, createError } from '../lib/formatter.js';
import { ManifestReader } from '../lib/manifest.js';
import type {
  Task,
  MinimalTask,
  TasksGetParams,
  TasksGetResult,
  TasksListParams,
  TasksListResult,
  TasksFindParams,
  TasksFindResult,
  TasksExistsParams,
  TasksExistsResult,
  TasksNextParams,
  TasksNextResult,
  TasksCreateParams,
  TasksCreateResult,
  TasksUpdateParams,
  TasksUpdateResult,
  TasksCompleteParams,
  TasksCompleteResult,
  TasksDeleteParams,
  TasksDeleteResult,
  TasksArchiveParams,
  TasksArchiveResult,
  TasksUnarchiveParams,
  TasksUnarchiveResult,
  TasksReorderParams,
  TasksReorderResult,
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

  constructor(
    private executor: CLIExecutor,
    manifestPath: string = 'claudedocs/agent-outputs/MANIFEST.jsonl'
  ) {
    this.manifestReader = new ManifestReader(manifestPath);
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

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
    if (params?.depth) flags.depth = params.depth;

    const result = await this.executor.execute({
      domain: 'tree',
      operation: params?.rootId || '',
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
