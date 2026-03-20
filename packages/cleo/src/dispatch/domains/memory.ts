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

import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFetch,
  // Brain.db cognitive memory operations
  memoryFind,
  // PageIndex graph operations (T5385)
  memoryGraphAdd,
  memoryGraphNeighbors,
  memoryGraphRemove,
  memoryGraphShow,
  // Learning operations
  memoryLearningFind,
  memoryLearningStore,
  // Brain memory linking
  memoryLink,
  memoryObserve,
  // Pattern operations
  memoryPatternFind,
  memoryPatternStore,
  memoryReasonSimilar,
  // Reasoning & hybrid search (T5388-T5393)
  memoryReasonWhy,
  memorySearchHybrid,
  memoryTimeline,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Memory Handler Class
// ---------------------------------------------------------------------------
// MemoryHandler
// ---------------------------------------------------------------------------

export class MemoryHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'find': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await memoryFind(
            {
              query,
              limit: params?.limit as number | undefined,
              tables: params?.tables as string[] | undefined,
              dateStart: params?.dateStart as string | undefined,
              dateEnd: params?.dateEnd as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'timeline': {
          const anchor = params?.anchor as string;
          if (!anchor) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'anchor is required',
              startTime,
            );
          }
          const result = await memoryTimeline(
            {
              anchor,
              depthBefore: params?.depthBefore as number | undefined,
              depthAfter: params?.depthAfter as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'fetch': {
          const ids = params?.ids as string[] | undefined;
          if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'ids is required (non-empty array)',
              startTime,
            );
          }
          const result = await memoryFetch({ ids }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'decision.find': {
          const result = await memoryDecisionFind(
            {
              query: params?.query as string | undefined,
              taskId: params?.taskId as string | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
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
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
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
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.show': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphShow({ nodeId }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'graph.neighbors': {
          const nodeId = params?.nodeId as string;
          if (!nodeId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'nodeId is required',
              startTime,
            );
          }
          const result = await memoryGraphNeighbors(
            { nodeId, edgeType: params?.edgeType as string | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'reason.why': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await memoryReasonWhy({ taskId }, projectRoot);
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'reason.similar': {
          const entryId = params?.entryId as string;
          if (!entryId) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'entryId is required',
              startTime,
            );
          }
          const result = await memoryReasonSimilar(
            { entryId, limit: params?.limit as number | undefined },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        case 'search.hybrid': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await memorySearchHybrid(
            {
              query,
              ftsWeight: params?.ftsWeight as number | undefined,
              vecWeight: params?.vecWeight as number | undefined,
              graphWeight: params?.graphWeight as number | undefined,
              limit: params?.limit as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'query', 'memory', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'memory', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:memory').error(
        { gateway: 'query', domain: 'memory', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'memory', operation, error, startTime);
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
        case 'observe': {
          const text = params?.text as string;
          if (!text) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'text is required',
              startTime,
            );
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
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'decision.store': {
          const decision = params?.decision as string;
          const rationale = params?.rationale as string;
          if (!decision || !rationale) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'decision and rationale are required',
              startTime,
            );
          }
          const result = await memoryDecisionStore(
            {
              decision,
              rationale,
              alternatives: params?.alternatives as string[] | undefined,
              taskId: params?.taskId as string | undefined,
              sessionId: params?.sessionId as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'pattern.store': {
          const patternText = params?.pattern as string;
          const context = params?.context as string;
          if (!patternText || !context) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'pattern and context are required',
              startTime,
            );
          }
          const result = await memoryPatternStore(
            {
              type:
                (params?.type as Parameters<typeof memoryPatternStore>[0]['type']) || 'workflow',
              pattern: patternText,
              context,
              impact: params?.impact as Parameters<typeof memoryPatternStore>[0]['impact'],
              antiPattern: params?.antiPattern as string | undefined,
              mitigation: params?.mitigation as string | undefined,
              examples: params?.examples as string[] | undefined,
              successRate: params?.successRate as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'learning.store': {
          const insight = params?.insight as string;
          const source = params?.source as string;
          if (!insight || !source) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'insight and source are required',
              startTime,
            );
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
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'link': {
          const taskId = params?.taskId as string;
          const entryId = params?.entryId as string;
          if (!taskId || !entryId) {
            return errorResult(
              'mutate',
              'memory',
              operation,
              'E_INVALID_INPUT',
              'taskId and entryId are required',
              startTime,
            );
          }
          const result = await memoryLink({ taskId, entryId }, projectRoot);
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'graph.add': {
          const result = await memoryGraphAdd(
            {
              nodeId: params?.nodeId as string | undefined,
              nodeType: params?.nodeType as string | undefined,
              label: params?.label as string | undefined,
              metadataJson: params?.metadataJson as string | undefined,
              fromId: params?.fromId as string | undefined,
              toId: params?.toId as string | undefined,
              edgeType: params?.edgeType as string | undefined,
              weight: params?.weight as number | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        case 'graph.remove': {
          const result = await memoryGraphRemove(
            {
              nodeId: params?.nodeId as string | undefined,
              fromId: params?.fromId as string | undefined,
              toId: params?.toId as string | undefined,
              edgeType: params?.edgeType as string | undefined,
            },
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'memory', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'memory', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:memory').error(
        { gateway: 'mutate', domain: 'memory', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'memory', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'find',
        'timeline',
        'fetch',
        'decision.find',
        'pattern.find',
        'learning.find',
        'graph.show',
        'graph.neighbors',
        'reason.why',
        'reason.similar',
        'search.hybrid',
      ],
      mutate: [
        'observe',
        'decision.store',
        'pattern.store',
        'learning.store',
        'link',
        'graph.add',
        'graph.remove',
      ],
    };
  }
}
