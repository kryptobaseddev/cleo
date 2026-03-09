/**
 * Tasks Domain Handler (Dispatch Layer)
 *
 * Handles all task CRUD and non-CRUD operations: show, list, find, exists,
 * tree, blockers, depends, analyze, next, relates, complexity.estimate,
 * current, add, update, complete, delete, archive, restore, reparent,
 * promote, reorder, relates.add, start, stop.
 *
 * Query operations delegate to task-engine; start/stop/current delegate
 * to session-engine (which hosts task-work functions).
 *
 * @epic T4820
 * @task T4818
 */

import { getLogger } from '../../core/logger.js';
import { getProjectRoot } from '../../core/paths.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import {
  taskAnalyze,
  taskArchive,
  taskBlockers,
  taskCancel,
  taskComplete,
  taskComplexityEstimate,
  taskCreate,
  taskCurrentGet,
  taskDelete,
  taskDepends,
  taskDepsCycles,
  taskDepsOverview,
  taskFind,
  taskHistory,
  taskLabelList,
  taskList,
  taskNext,
  taskPlan,
  taskRelates,
  taskRelatesAdd,
  taskRelatesFind,
  taskReopen,
  taskReorder,
  taskReparent,
  taskRestore,
  taskShow,
  taskStart,
  taskStop,
  taskTree,
  taskUnarchive,
  taskUpdate,
  taskWorkHistory,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'show': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskShow(this.projectRoot, taskId);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'list': {
          const result = await taskList(this.projectRoot, {
            parent: params?.parent as string | undefined,
            status: params?.status as string | undefined,
            priority: params?.priority as string | undefined,
            type: params?.type as string | undefined,
            phase: params?.phase as string | undefined,
            label: params?.label as string | undefined,
            children: params?.children as boolean | undefined,
            limit: params?.limit as number | undefined,
            offset: params?.offset as number | undefined,
            compact: params?.compact as boolean | undefined,
          });
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'find': {
          const result = await taskFind(
            this.projectRoot,
            params?.query as string,
            params?.limit as number | undefined,
            {
              id: params?.id as string | undefined,
              exact: params?.exact as boolean | undefined,
              status: params?.status as string | undefined,
              includeArchive: params?.includeArchive as boolean | undefined,
              offset: params?.offset as number | undefined,
            },
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'tree': {
          const taskId = params?.taskId as string | undefined;
          const result = await taskTree(this.projectRoot, taskId);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'blockers': {
          const result = await taskBlockers(
            this.projectRoot,
            params as { analyze?: boolean; limit?: number },
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'depends': {
          // Action-based routing for overview/cycles (T5157)
          const action = params?.action as string | undefined;
          if (action === 'overview') {
            const result = await taskDepsOverview(this.projectRoot);
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          if (action === 'cycles') {
            const result = await taskDepsCycles(this.projectRoot);
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          // Default: single-task dependency query requires taskId
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required (or use action: overview|cycles)',
              startTime,
            );
          }
          const direction = params?.direction as 'upstream' | 'downstream' | 'both' | undefined;
          const tree = params?.tree as boolean | undefined;
          const result = await taskDepends(this.projectRoot, taskId, direction, tree);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'analyze': {
          const taskId = params?.taskId as string | undefined;
          const tierLimit = params?.tierLimit as number | undefined;
          const result = await taskAnalyze(this.projectRoot, taskId, { tierLimit });
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'next': {
          const result = await taskNext(
            this.projectRoot,
            params as { count?: number; explain?: boolean },
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'plan': {
          const result = await taskPlan(this.projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'relates': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          // Consolidated: mode param routes to relates.find logic (T5615/T5671)
          if (params?.mode) {
            const result = await taskRelatesFind(this.projectRoot, taskId, {
              mode: params.mode as 'suggest' | 'discover',
              threshold: params?.threshold ? Number(params.threshold) : undefined,
            });
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          const result = await taskRelates(this.projectRoot, taskId);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'complexity.estimate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskComplexityEstimate(this.projectRoot, { taskId });
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'current': {
          const result = await taskCurrentGet(this.projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'history': {
          const taskId = params?.taskId as string;
          if (taskId) {
            const result = await taskHistory(this.projectRoot, taskId, params?.limit as number);
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          const result = await taskWorkHistory(this.projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'label.list': {
          const result = await taskLabelList(this.projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'tasks', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:tasks').error({ gateway: 'query', domain: 'tasks', operation, err: error }, error instanceof Error ? error.message : String(error));
      return handleErrorResult('query', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'add': {
          const title = params?.title as string;
          if (!title) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'title is required',
              startTime,
            );
          }
          const result = await taskCreate(this.projectRoot, {
            title,
            description: (params?.description as string) ?? title,
            parent: (params?.parent ?? params?.parentId) as string | undefined,
            depends: params?.depends as string[] | undefined,
            priority: params?.priority as string | undefined,
            labels: params?.labels as string[] | undefined,
            type: params?.type as string | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'update': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskUpdate(this.projectRoot, taskId, {
            title: params?.title as string | undefined,
            description: params?.description as string | undefined,
            status: params?.status as string | undefined,
            priority: params?.priority as string | undefined,
            notes: (params?.notes ?? params?.note) as string | undefined,
            labels: params?.labels as string[] | undefined,
            addLabels: params?.addLabels as string[] | undefined,
            removeLabels: params?.removeLabels as string[] | undefined,
            depends: params?.depends as string[] | undefined,
            addDepends: params?.addDepends as string[] | undefined,
            removeDepends: params?.removeDepends as string[] | undefined,
            acceptance: params?.acceptance as string[] | undefined,
            parent: (params?.parent ?? params?.parentId) as string | null | undefined,
            type: params?.type as string | undefined,
            size: params?.size as string | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'complete': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskComplete(
            this.projectRoot,
            taskId,
            params?.notes as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'delete': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskDelete(
            this.projectRoot,
            taskId,
            params?.force as boolean | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'archive': {
          const result = await taskArchive(
            this.projectRoot,
            params?.taskId as string | undefined,
            params?.before as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'restore': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          // Consolidated: from param routes to reopen/unarchive logic (T5615/T5671)
          const from = params?.from as string | undefined;
          if (from === 'done') {
            const result = await taskReopen(this.projectRoot, taskId, {
              status: params?.status as string | undefined,
              reason: params?.reason as string | undefined,
            });
            return wrapResult(result, 'mutate', 'tasks', operation, startTime);
          }
          if (from === 'archived') {
            const result = await taskUnarchive(this.projectRoot, taskId, {
              status: params?.status as string | undefined,
              preserveStatus: params?.preserveStatus as boolean | undefined,
            });
            return wrapResult(result, 'mutate', 'tasks', operation, startTime);
          }
          const result = await taskRestore(this.projectRoot, taskId, {
            cascade: params?.cascade as boolean | undefined,
            notes: params?.notes as string | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'cancel': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskCancel(
            this.projectRoot,
            taskId,
            params?.reason as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reparent': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskReparent(
            this.projectRoot,
            taskId,
            (params?.newParentId as string | null) ?? null,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reorder': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const position = params?.position as number;
          if (position === undefined || position === null) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'position is required',
              startTime,
            );
          }
          const result = await taskReorder(this.projectRoot, taskId, position);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'relates.add': {
          const taskId = params?.taskId as string;
          // Accept both targetId and relatedId for compatibility (T5149)
          const relatedId = (params?.relatedId ?? params?.targetId) as string;
          const type = params?.type as string;
          if (!taskId || !relatedId || !type) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId, relatedId (or targetId), and type are required',
              startTime,
            );
          }
          const result = await taskRelatesAdd(
            this.projectRoot,
            taskId,
            relatedId,
            type,
            params?.reason as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'start': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await taskStart(this.projectRoot, taskId);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'stop': {
          const result = await taskStop(this.projectRoot);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'tasks', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:tasks').error({ gateway: 'mutate', domain: 'tasks', operation, err: error }, error instanceof Error ? error.message : String(error));
      return handleErrorResult('mutate', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'show',
        'list',
        'find',
        'tree',
        'blockers',
        'depends',
        'analyze',
        'next',
        'plan',
        'relates',
        'complexity.estimate',
        'history',
        'current',
        'label.list',
      ],
      mutate: [
        'add',
        'update',
        'complete',
        'cancel',
        'delete',
        'archive',
        'restore',
        'reparent',
        'reorder',
        'relates.add',
        'start',
        'stop',
      ],
    };
  }

}
