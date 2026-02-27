/**
 * Session Domain Handler (Dispatch Layer)
 *
 * Handles session lifecycle operations: status, list, show, start, end,
 * resume, suspend, gc, history, record.decision, decision.log,
 * context.drift, record.assumption.
 *
 * All operations delegate to native engine functions from session-engine.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('domain:session');
import {
  sessionStatus,
  sessionList,
  sessionShow,
  sessionStart,
  sessionEnd,
  sessionResume,
  sessionSuspend,
  sessionGc,
  sessionHistory,
  sessionRecordDecision,
  sessionDecisionLog,
  sessionContextDrift,
  sessionRecordAssumption,
  sessionHandoff,
  sessionComputeHandoff,
  sessionBriefing,
} from '../lib/engine.js';

// ---------------------------------------------------------------------------
// SessionHandler
// ---------------------------------------------------------------------------

export class SessionHandler implements DomainHandler {
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
        case 'status': {
          const result = await sessionStatus(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'list': {
          const result = await sessionList(this.projectRoot, params as { active?: boolean; limit?: number });
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'show': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return this.errorResponse('query', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
          }
          const result = await sessionShow(this.projectRoot, sessionId);
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'history': {
          const result = await sessionHistory(this.projectRoot, params as { sessionId?: string; limit?: number });
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'decision.log': {
          const result = await sessionDecisionLog(this.projectRoot, params as { sessionId?: string; taskId?: string });
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'context.drift': {
          const result = await sessionContextDrift(this.projectRoot, params as { sessionId?: string });
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'handoff.show': {
          const scope = params?.scope as string | undefined;
          let scopeFilter: { type: string; epicId?: string } | undefined;
          if (scope) {
            if (scope === 'global') {
              scopeFilter = { type: 'global' };
            } else if (scope.startsWith('epic:')) {
              scopeFilter = { type: 'epic', epicId: scope.replace('epic:', '') };
            }
          }
          const result = await sessionHandoff(this.projectRoot, scopeFilter);
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'briefing.show': {
          const result = await sessionBriefing(this.projectRoot, {
            maxNextTasks: params?.maxNextTasks as number | undefined,
            maxBugs: params?.maxBugs as number | undefined,
            maxBlocked: params?.maxBlocked as number | undefined,
            maxEpics: params?.maxEpics as number | undefined,
            scope: params?.scope as string | undefined,
          });
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        default:
          return this.unsupported('query', 'session', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'session', operation, error, startTime);
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
        case 'start': {
          const scope = params?.scope as string;
          if (!scope) {
            return this.errorResponse('mutate', 'session', operation, 'E_INVALID_INPUT', 'scope is required', startTime);
          }
          const result = await sessionStart(this.projectRoot, {
            scope,
            name: params?.name as string | undefined,
            autoStart: params?.autoStart as boolean | undefined,
            focus: params?.focus as string | undefined,
            grade: params?.grade as boolean | undefined,
          });
          // Enrich successful result with top-level sessionId for easy extraction
          if (result.success && result.data) {
            const session = result.data as unknown as Record<string, unknown>;
            result.data = { ...session, sessionId: session.id } as unknown as typeof result.data;
          }
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'end': {
          // End the session first
          const endResult = await sessionEnd(this.projectRoot, params?.note as string | undefined);
          
          // If session ended successfully, compute and persist handoff data
          if (endResult.success && endResult.data) {
            const sessionId = (endResult.data as { sessionId: string }).sessionId;
            if (sessionId) {
              try {
                await sessionComputeHandoff(this.projectRoot, sessionId, {
                  note: params?.note as string | undefined,
                  nextAction: params?.nextAction as string | undefined,
                });
              } catch {
                // Handoff computation failure should not fail the end operation
                // Just log and continue
              }
            }
          }
          
          return this.wrapEngineResult(endResult, 'mutate', 'session', operation, startTime);
        }

        case 'resume': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return this.errorResponse('mutate', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
          }
          const result = await sessionResume(this.projectRoot, sessionId);
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'suspend': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return this.errorResponse('mutate', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
          }
          const result = await sessionSuspend(this.projectRoot, sessionId, params?.reason as string | undefined);
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'gc': {
          const result = await sessionGc(this.projectRoot, params?.maxAgeDays as number | undefined);
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'record.decision': {
          const result = await sessionRecordDecision(this.projectRoot, {
            sessionId: params?.sessionId as string,
            taskId: params?.taskId as string,
            decision: params?.decision as string,
            rationale: params?.rationale as string,
            alternatives: params?.alternatives as string[] | undefined,
          });
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'record.assumption': {
          const result = await sessionRecordAssumption(this.projectRoot, {
            sessionId: params?.sessionId as string | undefined,
            taskId: params?.taskId as string | undefined,
            assumption: params?.assumption as string,
            confidence: params?.confidence as 'high' | 'medium' | 'low',
          });
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'session', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'session', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'list', 'show', 'history', 'decision.log', 'context.drift', 'handoff.show', 'briefing.show'],
      mutate: ['start', 'end', 'resume', 'suspend', 'gc', 'record.decision', 'record.assumption'],
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
    logger.error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
