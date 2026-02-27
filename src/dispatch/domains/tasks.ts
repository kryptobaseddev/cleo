/**
 * Tasks Domain Handler (Dispatch Layer)
 *
 * Handles all task CRUD and non-CRUD operations: show, list, find, exists,
 * tree, blockers, depends, analyze, next, relates, complexity.estimate,
 * current, add, update, complete, delete, archive, restore, reparent,
 * promote, reorder, reopen, relates.add, start, stop.
 *
 * Query operations delegate to task-engine; start/stop/current delegate
 * to session-engine (which hosts task-work functions).
 *
 * @epic T4820
 * @task T4818
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('domain:tasks');
import {
  taskShow,
  taskList,
  taskFind,
  taskExists,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskDelete,
  taskArchive,
  taskNext,
  taskPlan,
  taskBlockers,
  taskTree,
  taskRelates,
  taskRelatesAdd,
  taskAnalyze,
  taskRestore,
  taskReorder,
  taskReparent,
  taskPromote,
  taskReopen,
  taskComplexityEstimate,
  taskDepends,
  taskCurrentGet,
  taskStart,
  taskStop,
} from '../lib/engine.js';

// ---------------------------------------------------------------------------
// TasksHandler
// ---------------------------------------------------------------------------

export class TasksHandler implements DomainHandler {
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
        case 'show': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskShow(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'list': {
          const result = await taskList(this.projectRoot, params as { parent?: string; status?: string; limit?: number });
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'find': {
          // taskFind(projectRoot, query, limit) — simple string query, not an options object
          const result = await taskFind(
            this.projectRoot,
            params?.query as string,
            params?.limit as number | undefined,
          );
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'exists': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskExists(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'tree': {
          const taskId = params?.taskId as string | undefined;
          const result = await taskTree(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'blockers': {
          const result = await taskBlockers(this.projectRoot, params as { analyze?: boolean });
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'depends': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const direction = params?.direction as 'upstream' | 'downstream' | 'both' | undefined;
          const result = await taskDepends(this.projectRoot, taskId, direction);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'analyze': {
          const taskId = params?.taskId as string | undefined;
          const result = await taskAnalyze(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'next': {
          const result = await taskNext(this.projectRoot, params as { count?: number; explain?: boolean });
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'plan': {
          const result = await taskPlan(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'relates': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskRelates(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'complexity.estimate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskComplexityEstimate(this.projectRoot, { taskId });
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'current': {
          const result = await taskCurrentGet(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'tasks', operation, startTime);
        }

        default:
          return this.unsupported('query', 'tasks', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'tasks', operation, error, startTime);
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
        case 'add': {
          const title = params?.title as string;
          if (!title) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'title is required', startTime);
          }
          const result = await taskCreate(this.projectRoot, {
            title,
            description: params?.description as string ?? title,
            parent: params?.parent as string | undefined,
            depends: params?.depends as string[] | undefined,
            priority: params?.priority as string | undefined,
            labels: params?.labels as string[] | undefined,
            type: params?.type as string | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'update': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskUpdate(this.projectRoot, taskId, {
            title: params?.title as string | undefined,
            description: params?.description as string | undefined,
            status: params?.status as string | undefined,
            priority: params?.priority as string | undefined,
            notes: params?.notes as string | undefined,
            labels: params?.labels as string[] | undefined,
            addLabels: params?.addLabels as string[] | undefined,
            removeLabels: params?.removeLabels as string[] | undefined,
            depends: params?.depends as string[] | undefined,
            addDepends: params?.addDepends as string[] | undefined,
            removeDepends: params?.removeDepends as string[] | undefined,
            acceptance: params?.acceptance as string[] | undefined,
            parent: params?.parent as string | null | undefined,
            type: params?.type as string | undefined,
            size: params?.size as string | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'complete': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskComplete(this.projectRoot, taskId, params?.notes as string | undefined);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'delete': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskDelete(this.projectRoot, taskId, params?.force as boolean | undefined);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'archive': {
          const result = await taskArchive(
            this.projectRoot,
            params?.taskId as string | undefined,
            params?.before as string | undefined,
          );
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'restore': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskRestore(this.projectRoot, taskId, {
            cascade: params?.cascade as boolean | undefined,
            notes: params?.notes as string | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reparent': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskReparent(
            this.projectRoot,
            taskId,
            (params?.newParentId as string | null) ?? null,
          );
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'promote': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskPromote(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reorder': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const position = params?.position as number;
          if (position === undefined || position === null) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'position is required', startTime);
          }
          const result = await taskReorder(this.projectRoot, taskId, position);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reopen': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskReopen(this.projectRoot, taskId, {
            status: params?.status as string | undefined,
            reason: params?.reason as string | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'relates.add': {
          const taskId = params?.taskId as string;
          const relatedId = params?.relatedId as string;
          const type = params?.type as string;
          if (!taskId || !relatedId || !type) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId, relatedId, and type are required', startTime);
          }
          const result = await taskRelatesAdd(
            this.projectRoot,
            taskId,
            relatedId,
            type,
            params?.reason as string | undefined,
          );
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'start': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'tasks', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await taskStart(this.projectRoot, taskId);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'stop': {
          const result = await taskStop(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'tasks', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'tasks', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'show', 'list', 'find', 'exists', 'tree', 'blockers',
        'depends', 'analyze', 'next', 'plan', 'relates', 'complexity.estimate', 'current',
      ],
      mutate: [
        'add', 'update', 'complete', 'delete', 'archive', 'restore',
        'reparent', 'promote', 'reorder', 'reopen', 'relates.add',
        'start', 'stop',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; exitCode?: number } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? { error: { code: result.error.code, message: result.error.message, exitCode: result.error.exitCode, details: result.error.details as Record<string, unknown> | undefined } } : {}),
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
    logger.error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
