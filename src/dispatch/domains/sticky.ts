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

import { getLogger } from '../../core/logger.js';
import { paginate } from '../../core/pagination.js';
import { getProjectRoot } from '../../core/paths.js';
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
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// StickyHandler
// ---------------------------------------------------------------------------

export class StickyHandler implements DomainHandler {
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
        case 'list': {
          const filters = {
            status: params?.status as 'active' | 'converted' | 'archived' | undefined,
            color: params?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
            priority: params?.priority as 'low' | 'medium' | 'high' | undefined,
          };
          const result = await stickyList(this.projectRoot, filters);
          if (!result.success) {
            return this.wrapEngineResult(result, 'query', 'sticky', operation, startTime);
          }

          const filteredStickies = result.data?.stickies ?? [];
          const hasFilter =
            filters.status !== undefined ||
            filters.color !== undefined ||
            filters.priority !== undefined;
          const totalResult = hasFilter ? await stickyList(this.projectRoot, {}) : result;
          if (!totalResult.success) {
            return this.wrapEngineResult(totalResult, 'query', 'sticky', operation, startTime);
          }

          const limit = params?.limit as number | undefined;
          const offset = params?.offset as number | undefined;
          const page = paginate(filteredStickies, limit, offset);

          return {
            _meta: dispatchMeta('query', 'sticky', operation, startTime),
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
            return this.errorResponse(
              'query',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyShow(this.projectRoot, stickyId);
          return this.wrapEngineResult(result, 'query', 'sticky', operation, startTime);
        }

        default:
          return this.unsupported('query', 'sticky', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'sticky', operation, error, startTime);
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
          const content = params?.content as string;
          if (!content) {
            return this.errorResponse(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'content is required',
              startTime,
            );
          }
          const result = await stickyAdd(this.projectRoot, {
            content,
            tags: params?.tags as string[] | undefined,
            color: params?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
            priority: params?.priority as 'low' | 'medium' | 'high' | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
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
            return this.errorResponse(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          if (!targetType) {
            return this.errorResponse(
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
              this.projectRoot,
              stickyId,
              params?.title as string | undefined,
            );
            return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
          } else if (targetType === 'task_note') {
            const taskId = params?.taskId as string | undefined;
            if (!taskId) {
              return this.errorResponse(
                'mutate',
                'sticky',
                operation,
                'E_INVALID_INPUT',
                'taskId is required for task_note conversion',
                startTime,
              );
            }
            const result = await stickyConvertToTaskNote(this.projectRoot, stickyId, taskId);
            return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
          } else if (targetType === 'session_note') {
            const result = await stickyConvertToSessionNote(
              this.projectRoot,
              stickyId,
              params?.sessionId as string | undefined,
            );
            return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
          } else {
            const result = await stickyConvertToMemory(
              this.projectRoot,
              stickyId,
              params?.memoryType as string | undefined,
            );
            return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
          }
        }

        case 'archive': {
          const stickyId = params?.stickyId as string;
          if (!stickyId) {
            return this.errorResponse(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyArchive(this.projectRoot, stickyId);
          return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
        }

        case 'purge': {
          const stickyId = params?.stickyId as string;
          if (!stickyId) {
            return this.errorResponse(
              'mutate',
              'sticky',
              operation,
              'E_INVALID_INPUT',
              'stickyId is required',
              startTime,
            );
          }
          const result = await stickyPurge(this.projectRoot, stickyId);
          return this.wrapEngineResult(result, 'mutate', 'sticky', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'sticky', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'sticky', operation, error, startTime);
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

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: {
      success: boolean;
      data?: unknown;
      error?: {
        code: string;
        message: string;
        details?: unknown;
        fix?: string;
        alternatives?: Array<{ action: string; command: string }>;
      };
    },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              details: result.error.details as Record<string, unknown> | undefined,
              fix: result.error.fix,
              alternatives: result.error.alternatives,
            },
          }
        : {}),
    };
  }

  private unsupported(
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
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

  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number,
  ): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:sticky').error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
