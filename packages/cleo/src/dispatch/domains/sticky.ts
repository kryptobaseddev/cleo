/**
 * Sticky Domain Handler (Dispatch Layer)
 *
 * Handles sticky note operations: list, show, add, convert, archive.
 *
 * All operations delegate to native engine functions from sticky-engine.
 *
 * @task T5280
 * @epic T5267
 */

import { getLogger, getProjectRoot, paginate } from '@cleocode/core';
import {
  stickyAdd,
  stickyArchive,
  stickyConvertToMemory,
  stickyConvertToSessionNote,
  stickyConvertToTask,
  stickyConvertToTaskNote,
  stickyList,
  stickyPurge,
  stickyShow,
} from '../engines/sticky-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// StickyHandler
// ---------------------------------------------------------------------------

export class StickyHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'list': {
          const filters = {
            status: params?.status as 'active' | 'converted' | 'archived' | undefined,
            color: params?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
            priority: params?.priority as 'low' | 'medium' | 'high' | undefined,
          };
          const result = await stickyList(projectRoot, filters);
          if (!result.success) {
            return wrapResult(result, 'query', 'sticky', operation, startTime);
          }

          const filteredStickies = result.data?.stickies ?? [];
          const hasFilter =
            filters.status !== undefined ||
            filters.color !== undefined ||
            filters.priority !== undefined;
          const totalResult = hasFilter ? await stickyList(projectRoot, {}) : result;
          if (!totalResult.success) {
            return wrapResult(totalResult, 'query', 'sticky', operation, startTime);
          }

          const limit = params?.limit as number | undefined;
          const offset = params?.offset as number | undefined;
          const page = paginate(filteredStickies, limit, offset);

          return {
            meta: dispatchMeta('query', 'sticky', operation, startTime),
            success: true,
            data: {
              stickies: page.items,
              total: totalResult.data?.total ?? filteredStickies.length,
              filtered: filteredStickies.length,
            },
            page: page.page,
          };
        }

        case 'show': {
          const stickyId = params?.stickyId as string;
          if (!stickyId) {
            return errorResult(
              'query',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyShow(projectRoot, stickyId);
          return wrapResult(result, 'query', 'sticky', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'sticky', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:sticky').error(
        { gateway: 'query', domain: 'sticky', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'sticky', operation, error, startTime);
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
          const content = params?.content as string;
          if (!content) {
            return errorResult(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'content is required',
              startTime,
            );
          }
          const result = await stickyAdd(projectRoot, {
            content,
            tags: params?.tags as string[] | undefined,
            color: params?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
            priority: params?.priority as 'low' | 'medium' | 'high' | undefined,
          });
          return wrapResult(result, 'mutate', 'sticky', operation, startTime);
        }

        case 'convert': {
          const stickyId = params?.stickyId as string;
          const targetType = params?.targetType as
            | 'task'
            | 'memory'
            | 'session_note'
            | 'task_note'
            | undefined;
          if (!stickyId) {
            return errorResult(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          if (!targetType) {
            return errorResult(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'targetType is required (task, memory, session_note, or task_note)',
              startTime,
            );
          }

          if (targetType === 'task') {
            const result = await stickyConvertToTask(
              projectRoot,
              stickyId,
              params?.title as string | undefined,
            );
            return wrapResult(result, 'mutate', 'sticky', operation, startTime);
          } else if (targetType === 'task_note') {
            const taskId = params?.taskId as string | undefined;
            if (!taskId) {
              return errorResult(
                'mutate',
                'sticky',
                operation,
                'E_INVALID_INPUT',
                'taskId is required for task_note conversion',
                startTime,
              );
            }
            const result = await stickyConvertToTaskNote(projectRoot, stickyId, taskId);
            return wrapResult(result, 'mutate', 'sticky', operation, startTime);
          } else if (targetType === 'session_note') {
            const result = await stickyConvertToSessionNote(
              projectRoot,
              stickyId,
              params?.sessionId as string | undefined,
            );
            return wrapResult(result, 'mutate', 'sticky', operation, startTime);
          } else {
            const result = await stickyConvertToMemory(
              projectRoot,
              stickyId,
              params?.memoryType as string | undefined,
            );
            return wrapResult(result, 'mutate', 'sticky', operation, startTime);
          }
        }

        case 'archive': {
          const stickyId = params?.stickyId as string;
          if (!stickyId) {
            return errorResult(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyArchive(projectRoot, stickyId);
          return wrapResult(result, 'mutate', 'sticky', operation, startTime);
        }

        case 'purge': {
          const stickyId = params?.stickyId as string;
          if (!stickyId) {
            return errorResult(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyPurge(projectRoot, stickyId);
          return wrapResult(result, 'mutate', 'sticky', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'sticky', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:sticky').error(
        { gateway: 'mutate', domain: 'sticky', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'sticky', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'show'],
      mutate: ['add', 'convert', 'archive', 'purge'],
    };
  }
}
