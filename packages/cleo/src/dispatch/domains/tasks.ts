/**
 * Tasks Domain Handler (Dispatch Layer)
 *
 * Handles all task CRUD and non-CRUD operations: show, list, find, exists,
 * tree, blockers, depends, analyze, next, relates, complexity.estimate,
 * current, add, update, complete, delete, archive, restore, reparent,
 * promote, reorder, relates.add, start, stop, sync.reconcile, sync.links,
 * sync.links.remove.
 *
 * Query operations delegate to task-engine; start/stop/current delegate
 * to session-engine (which hosts task-work functions).
 *
 * @epic T4820
 * @task T4818
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
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
  taskSyncLinks,
  taskSyncLinksRemove,
  taskSyncReconcile,
  taskTree,
  taskUnarchive,
  taskUpdate,
  taskWorkHistory,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// TasksHandler
// ---------------------------------------------------------------------------

export class TasksHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'show': {
          const result = await taskShow(projectRoot, params!.taskId as string);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'list': {
          const result = await taskList(projectRoot, {
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
            projectRoot,
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
          const result = await taskTree(projectRoot, taskId);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'blockers': {
          const result = await taskBlockers(
            projectRoot,
            params as { analyze?: boolean; limit?: number },
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'depends': {
          // Action-based routing for overview/cycles (T5157)
          const action = params?.action as string | undefined;
          if (action === 'overview') {
            const result = await taskDepsOverview(projectRoot);
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          if (action === 'cycles') {
            const result = await taskDepsCycles(projectRoot);
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
          const result = await taskDepends(projectRoot, taskId, direction, tree);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'analyze': {
          const taskId = params?.taskId as string | undefined;
          const tierLimit = params?.tierLimit as number | undefined;
          const result = await taskAnalyze(projectRoot, taskId, { tierLimit });
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'next': {
          const result = await taskNext(
            projectRoot,
            params as { count?: number; explain?: boolean },
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'plan': {
          const result = await taskPlan(projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'relates': {
          const taskId = params!.taskId as string;
          // Consolidated: mode param routes to relates.find logic (T5615/T5671)
          if (params?.mode) {
            const result = await taskRelatesFind(projectRoot, taskId, {
              mode: params.mode as 'suggest' | 'discover',
              threshold: params?.threshold ? Number(params.threshold) : undefined,
            });
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          const result = await taskRelates(projectRoot, taskId);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'complexity.estimate': {
          const result = await taskComplexityEstimate(projectRoot, {
            taskId: params!.taskId as string,
          });
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'current': {
          const result = await taskCurrentGet(projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'history': {
          const taskId = params?.taskId as string;
          if (taskId) {
            const result = await taskHistory(projectRoot, taskId, params?.limit as number);
            return wrapResult(result, 'query', 'tasks', operation, startTime);
          }
          const result = await taskWorkHistory(projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'label.list': {
          const result = await taskLabelList(projectRoot);
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        case 'sync.links': {
          const result = await taskSyncLinks(
            projectRoot,
            params as { providerId?: string; taskId?: string } | undefined,
          );
          return wrapResult(result, 'query', 'tasks', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'tasks', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'query', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'add': {
          const result = await taskCreate(projectRoot, {
            title: params!.title as string,
            description: (params?.description as string) ?? (params!.title as string),
            parent: (params?.parent ?? params?.parentId) as string | undefined,
            depends: params?.depends as string[] | undefined,
            priority: params?.priority as string | undefined,
            labels: params?.labels as string[] | undefined,
            type: params?.type as string | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'update': {
          const result = await taskUpdate(projectRoot, params!.taskId as string, {
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
          const result = await taskComplete(
            projectRoot,
            params!.taskId as string,
            params?.notes as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'delete': {
          const result = await taskDelete(
            projectRoot,
            params!.taskId as string,
            params?.force as boolean | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'archive': {
          const result = await taskArchive(
            projectRoot,
            params?.taskId as string | undefined,
            params?.before as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'restore': {
          const taskId = params!.taskId as string;
          // Consolidated: from param routes to reopen/unarchive logic (T5615/T5671)
          const from = params?.from as string | undefined;
          if (from === 'done') {
            const result = await taskReopen(projectRoot, taskId, {
              status: params?.status as string | undefined,
              reason: params?.reason as string | undefined,
            });
            return wrapResult(result, 'mutate', 'tasks', operation, startTime);
          }
          if (from === 'archived') {
            const result = await taskUnarchive(projectRoot, taskId, {
              status: params?.status as string | undefined,
              preserveStatus: params?.preserveStatus as boolean | undefined,
            });
            return wrapResult(result, 'mutate', 'tasks', operation, startTime);
          }
          const result = await taskRestore(projectRoot, taskId, {
            cascade: params?.cascade as boolean | undefined,
            notes: params?.notes as string | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'cancel': {
          const result = await taskCancel(
            projectRoot,
            params!.taskId as string,
            params?.reason as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reparent': {
          const result = await taskReparent(
            projectRoot,
            params!.taskId as string,
            (params?.newParentId as string | null) ?? null,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'reorder': {
          const result = await taskReorder(
            projectRoot,
            params!.taskId as string,
            params!.position as number,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'relates.add': {
          // Accept both targetId and relatedId for compatibility (T5149)
          const relatedId = (params?.relatedId ?? params?.targetId) as string;
          if (!relatedId) {
            return errorResult(
              'mutate',
              'tasks',
              operation,
              'E_INVALID_INPUT',
              'relatedId (or targetId) is required',
              startTime,
            );
          }
          const result = await taskRelatesAdd(
            projectRoot,
            params!.taskId as string,
            relatedId,
            params!.type as string,
            params?.reason as string | undefined,
          );
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'start': {
          const result = await taskStart(projectRoot, params!.taskId as string);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'stop': {
          const result = await taskStop(projectRoot);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'sync.reconcile': {
          const result = await taskSyncReconcile(projectRoot, {
            providerId: params!.providerId as string,
            externalTasks: params!.externalTasks as import('@cleocode/contracts').ExternalTask[],
            dryRun: params?.dryRun as boolean | undefined,
            conflictPolicy: params?.conflictPolicy as string | undefined,
            defaultPhase: params?.defaultPhase as string | undefined,
            defaultLabels: params?.defaultLabels as string[] | undefined,
          });
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        case 'sync.links.remove': {
          const result = await taskSyncLinksRemove(projectRoot, params!.providerId as string);
          return wrapResult(result, 'mutate', 'tasks', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'tasks', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'mutate', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
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
        'sync.links',
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
        'sync.reconcile',
        'sync.links.remove',
      ],
    };
  }
}
