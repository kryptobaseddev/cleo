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

import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  stickyAdd,
  stickyArchive,
  stickyConvertToMemory,
  stickyConvertToSessionNote,
  stickyConvertToTask,
  stickyConvertToTaskNote,
  stickyListFiltered,
  stickyPurge,
  stickyShow,
} from '../engines/sticky-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

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
          const result = await stickyListFiltered(projectRoot, { status: params?.status as 'active' | 'converted' | 'archived' | undefined, color: params?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined, priority: params?.priority as 'low' | 'medium' | 'high' | undefined, tags: params?.tags as string[] | undefined }, params?.limit as number | undefined, params?.offset as number | undefined);
          return wrapResult(result, 'query', 'sticky', operation, startTime);
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
