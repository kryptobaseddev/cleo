/**
 * Intelligence Domain Handler (Dispatch Layer) — Predictive Quality Intelligence
 *
 * Exposes the intelligence functions from @cleocode/core to the dispatch layer:
 * - predict: calculateTaskRisk / predictValidationOutcome
 * - suggest: suggestGateFocus
 * - learn-errors: extractPatternsFromHistory
 * - confidence: scoreVerificationConfidence
 * - match: matchPatterns
 *
 * All operations are query-only (read-from brain.db + tasks.db). The mutate
 * gateway is unsupported — intelligence writes happen via hooks.
 *
 * @task T549
 * @epic T5149
 */

import { getAccessor, getLogger, getProjectRoot } from '@cleocode/core';
import {
  calculateTaskRisk,
  extractPatternsFromHistory,
  getBrainAccessor,
  matchPatterns,
  predictValidationOutcome,
  scoreVerificationConfidence,
  suggestGateFocus,
} from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// IntelligenceHandler
// ---------------------------------------------------------------------------

export class IntelligenceHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        // ------------------------------------------------------------------
        // predict — calculateTaskRisk or predictValidationOutcome
        // ------------------------------------------------------------------
        case 'predict': {
          const taskId = params?.taskId as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'intelligence',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const [accessor, brain] = await Promise.all([
            getAccessor(projectRoot),
            getBrainAccessor(projectRoot),
          ]);

          const stage = params?.stage as string | undefined;

          if (stage) {
            // Stage provided → predictValidationOutcome
            const result = await predictValidationOutcome(taskId, stage, accessor, brain);
            return wrapResult(
              { success: true, data: result },
              'query',
              'intelligence',
              operation,
              startTime,
            );
          }

          // No stage → calculateTaskRisk
          const result = await calculateTaskRisk(taskId, accessor, brain);
          return wrapResult(
            { success: true, data: result },
            'query',
            'intelligence',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // suggest — suggestGateFocus
        // ------------------------------------------------------------------
        case 'suggest': {
          const taskId = params?.taskId as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'intelligence',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const [accessor, brain] = await Promise.all([
            getAccessor(projectRoot),
            getBrainAccessor(projectRoot),
          ]);

          const result = await suggestGateFocus(taskId, accessor, brain);
          return wrapResult(
            { success: true, data: result },
            'query',
            'intelligence',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // learn-errors — extractPatternsFromHistory
        // ------------------------------------------------------------------
        case 'learn-errors': {
          const [accessor, brain] = await Promise.all([
            getAccessor(projectRoot),
            getBrainAccessor(projectRoot),
          ]);

          const limit = typeof params?.limit === 'number' ? params.limit : undefined;
          const result = await extractPatternsFromHistory(accessor, brain, { limit });
          return wrapResult(
            { success: true, data: result },
            'query',
            'intelligence',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // confidence — scoreVerificationConfidence
        // ------------------------------------------------------------------
        case 'confidence': {
          const taskId = params?.taskId as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'intelligence',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const [accessor, brain] = await Promise.all([
            getAccessor(projectRoot),
            getBrainAccessor(projectRoot),
          ]);

          // Load verification state from the task
          const task = await accessor.loadSingleTask(taskId);
          if (!task) {
            return errorResult(
              'query',
              'intelligence',
              operation,
              'E_NOT_FOUND',
              `Task ${taskId} not found`,
              startTime,
            );
          }

          const verification = task.verification ?? {
            passed: false,
            gates: {},
            checkedAt: new Date().toISOString(),
          };

          const result = await scoreVerificationConfidence(taskId, verification, accessor, brain, {
            dryRun: true,
          });
          return wrapResult(
            { success: true, data: result },
            'query',
            'intelligence',
            operation,
            startTime,
          );
        }

        // ------------------------------------------------------------------
        // match — matchPatterns
        // ------------------------------------------------------------------
        case 'match': {
          const taskId = params?.taskId as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'intelligence',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const [accessor, brain] = await Promise.all([
            getAccessor(projectRoot),
            getBrainAccessor(projectRoot),
          ]);

          const result = await matchPatterns(taskId, accessor, brain);
          return wrapResult(
            { success: true, data: result },
            'query',
            'intelligence',
            operation,
            startTime,
          );
        }

        default:
          return unsupportedOp('query', 'intelligence', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:intelligence').error(
        { gateway: 'query', domain: 'intelligence', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'intelligence', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate — not supported; intelligence is read-only at the domain level
  // -----------------------------------------------------------------------

  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    return unsupportedOp('mutate', 'intelligence', operation, startTime);
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['predict', 'suggest', 'learn-errors', 'confidence', 'match'],
      mutate: [],
    };
  }
}
