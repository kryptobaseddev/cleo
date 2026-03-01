/**
 * Orchestrate Domain Handler (Dispatch Layer)
 *
 * Handles multi-agent orchestration: dependency analysis, wave computation,
 * spawn readiness, parallel coordination, and orchestration context.
 * All operations delegate to native engine functions.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

import {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
  orchestrateBootstrap,
  orchestrateUnblockOpportunities,
  orchestrateCriticalPath,
  orchestrateStartup,
  orchestrateSpawn,
  orchestrateValidate,
  orchestrateParallelStart,
  orchestrateParallelEnd,
  orchestrateCheck,
} from '../lib/engine.js';

// ---------------------------------------------------------------------------
// OrchestrateHandler
// ---------------------------------------------------------------------------

export class OrchestrateHandler implements DomainHandler {
  private projectRoot: string;

  constructor() {
    this.projectRoot = getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateStatus(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'next': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateNext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'ready': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateReady(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'analyze': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateAnalyze(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'context': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateContext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'waves': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateWaves(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'bootstrap': {
          const speed = params?.speed as 'fast' | 'full' | 'complete' | undefined;
          const result = await orchestrateBootstrap(this.projectRoot, { speed });
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'unblock.opportunities': {
          const result = await orchestrateUnblockOpportunities(this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'critical.path': {
          const result = await orchestrateCriticalPath(this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        default:
          return this.errorResponse('query', operation, 'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`, startTime);
      }
    } catch (error) {
      return this.handleError('query', operation, error, startTime);
    }
  }

  async mutate(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateStartup(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'spawn': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          const protocolType = params?.protocolType as string | undefined;
          const result = await orchestrateSpawn(taskId, protocolType, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'validate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          const result = await orchestrateValidate(taskId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'parallel.start': {
          const epicId = params?.epicId as string;
          const wave = params?.wave as number;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          if (wave === undefined || wave === null) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'wave number is required', startTime);
          }
          const result = await orchestrateParallelStart(epicId, wave, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'parallel.end': {
          const epicId = params?.epicId as string;
          const wave = params?.wave as number;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          if (wave === undefined || wave === null) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'wave number is required', startTime);
          }
          const result = orchestrateParallelEnd(epicId, wave, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'verify': {
          const result = await orchestrateCheck(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        default:
          return this.errorResponse('mutate', operation, 'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status', 'next', 'ready', 'analyze', 'context',
        'waves', 'bootstrap', 'unblock.opportunities', 'critical.path',
      ],
      mutate: [
        'start', 'spawn', 'validate',
        'parallel.start', 'parallel.end', 'verify',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    if (result.success) {
      return {
        _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
      success: false,
      error: {
        code: result.error?.code || 'E_UNKNOWN',
        message: result.error?.message || 'Unknown error',
      },
    };
  }

  private errorResponse(
    gateway: string,
    operation: string,
    code: string,
    message: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(
    gateway: string,
    operation: string,
    error: unknown,
    startTime: number,
  ): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:orchestrate').error({ gateway, domain: 'orchestrate', operation, err: error }, message);
    return this.errorResponse(
      gateway, operation,
      'E_INTERNAL_ERROR',
      message,
      startTime,
    );
  }
}
