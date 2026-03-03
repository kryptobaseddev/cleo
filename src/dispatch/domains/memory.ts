/**
 * Memory Domain Handler (Dispatch Layer) — Brain.db Cognitive Memory
 *
 * Handles brain.db-backed cognitive memory operations: observations, decisions,
 * patterns, learnings, and the 3-layer retrieval protocol (find/timeline/fetch).
 *
 * Manifest/pipeline operations have been moved to the pipeline domain.
 * Context injection has been moved to sessions/context-inject.ts.
 *
 * @task T5241
 * @epic T5149
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

import {
  // Brain.db cognitive memory operations
  memoryShow,
  memoryFind,
  memoryTimeline,
  memoryFetch,
  memoryObserve,
  memoryBrainStats,
  memoryDecisionFind,
  memoryDecisionStore,
  // Pattern operations (renamed)
  memoryPatternFind,
  memoryPatternStore,
  memoryPatternStats,
  // Learning operations (renamed)
  memoryLearningFind,
  memoryLearningStore,
  memoryLearningStats,
  // Brain memory linking and analysis
  memoryContradictions,
  memorySuperseded,
  memoryLink,
} from '../../core/memory/engine-compat.js';

// ---------------------------------------------------------------------------
// Memory Handler Class
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
          const result = await memoryShow(entryId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'find': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', 'memory', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const result = await memoryFind(
            {
              query,
              limit: params?.limit as number | undefined,
              tables: params?.tables as string[] | undefined,
              dateStart: params?.dateStart as string | undefined,
              dateEnd: params?.dateEnd as string | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'timeline': {
          const anchor = params?.anchor as string;
          if (!anchor) {
            return this.errorResponse('query', 'memory', operation, 'E_INVALID_INPUT', 'anchor is required', startTime);
          }
          const result = await memoryTimeline(
            {
              anchor,
              depthBefore: params?.depthBefore as number | undefined,
              depthAfter: params?.depthAfter as number | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'fetch': {
          const ids = params?.ids as string[] | undefined;
          if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return this.errorResponse('query', 'memory', operation, 'E_INVALID_INPUT', 'ids is required (non-empty array)', startTime);
          }
          const result = await memoryFetch({ ids }, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'stats': {
          const result = await memoryBrainStats(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'contradictions': {
          const result = await memoryContradictions(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'superseded': {
          const result = await memorySuperseded(
            {
              type: params?.type as string | undefined,
              project: params?.project as string | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'decision.find': {
          const result = await memoryDecisionFind(
            {
              query: params?.query as string | undefined,
              taskId: params?.taskId as string | undefined,
              limit: params?.limit as number | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'pattern.find': {
          const result = await memoryPatternFind(
            {
              type: params?.type as Parameters<typeof memoryPatternFind>[0]['type'],
              impact: params?.impact as Parameters<typeof memoryPatternFind>[0]['impact'],
              query: params?.query as string | undefined,
              minFrequency: params?.minFrequency as number | undefined,
              limit: params?.limit as number | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'pattern.stats': {
          const result = await memoryPatternStats(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'learning.find': {
          const result = await memoryLearningFind(
            {
              query: params?.query as string | undefined,
              minConfidence: params?.minConfidence as number | undefined,
              actionableOnly: params?.actionableOnly as boolean | undefined,
              applicableType: params?.applicableType as string | undefined,
              limit: params?.limit as number | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'query', 'memory', operation, startTime);
        }

        case 'learning.stats': {
          const result = await memoryLearningStats(this.projectRoot);
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
        case 'observe': {
          const text = params?.text as string;
          if (!text) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'text is required', startTime);
          }
          const result = await memoryObserve(
            {
              text,
              title: params?.title as string | undefined,
              type: params?.type as string | undefined,
              project: params?.project as string | undefined,
              sourceSessionId: params?.sourceSessionId as string | undefined,
              sourceType: params?.sourceType as string | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'decision.store': {
          const decision = params?.decision as string;
          const rationale = params?.rationale as string;
          if (!decision || !rationale) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'decision and rationale are required', startTime);
          }
          const result = await memoryDecisionStore(
            {
              decision,
              rationale,
              alternatives: params?.alternatives as string[] | undefined,
              taskId: params?.taskId as string | undefined,
              sessionId: params?.sessionId as string | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'pattern.store': {
          const patternText = params?.pattern as string;
          const context = params?.context as string;
          if (!patternText || !context) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'pattern and context are required', startTime);
          }
          const result = await memoryPatternStore(
            {
              type: (params?.type as Parameters<typeof memoryPatternStore>[0]['type']) || 'workflow',
              pattern: patternText,
              context,
              impact: params?.impact as Parameters<typeof memoryPatternStore>[0]['impact'],
              antiPattern: params?.antiPattern as string | undefined,
              mitigation: params?.mitigation as string | undefined,
              examples: params?.examples as string[] | undefined,
              successRate: params?.successRate as number | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'learning.store': {
          const insight = params?.insight as string;
          const source = params?.source as string;
          if (!insight || !source) {
            return this.errorResponse('mutate', 'memory', operation, 'E_INVALID_INPUT', 'insight and source are required', startTime);
          }
          const result = await memoryLearningStore(
            {
              insight,
              source,
              confidence: (params?.confidence as number) ?? 0.5,
              actionable: params?.actionable as boolean | undefined,
              application: params?.application as string | undefined,
              applicableTypes: params?.applicableTypes as string[] | undefined,
            },
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
          const result = await memoryLink(
            { taskId, entryId },
            this.projectRoot,
          );
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
      query: ['show', 'find', 'timeline', 'fetch', 'stats', 'contradictions', 'superseded', 'decision.find', 'pattern.find', 'pattern.stats', 'learning.find', 'learning.stats'],
      mutate: ['observe', 'decision.store', 'pattern.store', 'learning.store', 'link'],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; fix?: string; alternatives?: Array<{ action: string; command: string }> } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? {
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details as Record<string, unknown> | undefined,
          fix: result.error.fix,
          alternatives: result.error.alternatives,
        }
      } : {}),
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
    getLogger('domain:memory').error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
