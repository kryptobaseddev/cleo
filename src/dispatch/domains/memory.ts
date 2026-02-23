/**
 * Memory Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP research domain operations into the canonical "memory"
 * domain. Handles research manifest CRUD, research queries, contradiction
 * detection, supersession tracking, and protocol injection.
 *
 * All operations delegate to native engine functions from research-engine.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import {
  memoryShow,
  memoryList,
  memoryQuery,
  memoryPending,
  memoryStats,
  memoryManifestRead,
  memoryContradictions,
  memorySuperseded,
  memoryInject,
  memoryLink,
  memoryManifestAppend,
  memoryManifestArchive,
} from '../../core/memory/engine-compat.js';

// ---------------------------------------------------------------------------
// MemoryHandler
// ---------------------------------------------------------------------------

export class MemoryHandler implements DomainHandler {
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
          const entryId = params?.entryId as string;
          if (!entryId) {
            return this.errorResponse('query', 'memory', operation, 'E_INVALID_INPUT', 'entryId is required', startTime);
          }
          const result = memoryShow(entryId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'list': {
          const result = memoryList(
            (params ?? {}) as Parameters<typeof memoryList>[0],
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'find': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', 'memory', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const result = memoryQuery(
            query,
            { confidence: params?.confidence as number | undefined, limit: params?.limit as number | undefined },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'pending': {
          const result = memoryPending(params?.epicId as string | undefined, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'stats': {
          const result = memoryStats(params?.epicId as string | undefined, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'manifest.read': {
          const result = memoryManifestRead(
            params as Parameters<typeof memoryManifestRead>[0],
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'contradictions': {
          const result = memoryContradictions(this.projectRoot, params as { topic?: string } | undefined);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'superseded': {
          const result = memorySuperseded(this.projectRoot, params as { topic?: string } | undefined);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        default:
          return this.unsupported('query', 'memory', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'memory', operation, error, startTime);
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
        case 'inject': {
          const protocolType = params?.protocolType as string;
          if (!protocolType) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'protocolType is required', startTime);
          }
          const result = memoryInject(
            protocolType,
            { taskId: params?.taskId as string | undefined, variant: params?.variant as string | undefined },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'link': {
          const taskId = params?.taskId as string;
          const entryId = params?.entryId as string;
          if (!taskId || !entryId) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'taskId and entryId are required', startTime);
          }
          const result = memoryLink(taskId, entryId, params?.notes as string | undefined, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'manifest.append': {
          const entry = params?.entry as Parameters<typeof memoryManifestAppend>[0];
          if (!entry) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'entry is required', startTime);
          }
          const result = memoryManifestAppend(entry, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'manifest.archive': {
          const beforeDate = params?.beforeDate as string;
          if (!beforeDate) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'beforeDate is required (ISO-8601: YYYY-MM-DD)', startTime);
          }
          const result = memoryManifestArchive(beforeDate, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'memory', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'memory', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['show', 'list', 'find', 'pending', 'stats', 'manifest.read', 'contradictions', 'superseded'],
      mutate: ['inject', 'link', 'manifest.append', 'manifest.archive'],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? { error: { code: result.error.code, message: result.error.message, details: result.error.details as Record<string, unknown> | undefined } } : {}),
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
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
