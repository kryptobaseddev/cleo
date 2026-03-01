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
import { bindSession, unbindSession } from '../context/session-context.js';

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
  sessionComputeDebrief,
  sessionDebriefShow,
  sessionChainShow,
  sessionFind,
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

        // T4959: Rich debrief + chain operations
        case 'debrief.show': {
          const debriefSessionId = params?.sessionId as string;
          if (!debriefSessionId) {
            return this.errorResponse('query', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
          }
          const result = await sessionDebriefShow(this.projectRoot, debriefSessionId);
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'chain.show': {
          const chainSessionId = params?.sessionId as string;
          if (!chainSessionId) {
            return this.errorResponse('query', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
          }
          const result = await sessionChainShow(this.projectRoot, chainSessionId);
          return this.wrapEngineResult(result, 'query', 'session', operation, startTime);
        }

        case 'find': {
          const result = await sessionFind(this.projectRoot, params as {
            status?: string;
            scope?: string;
            query?: string;
            limit?: number;
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
            startTask: (params?.startTask ?? params?.focus) as string | undefined,
            grade: params?.grade as boolean | undefined,
          });
          // Enrich successful result with top-level sessionId for easy extraction
          if (result.success && result.data) {
            const session = result.data as unknown as Record<string, unknown>;
            result.data = { ...session, sessionId: session.id } as unknown as typeof result.data;

            // T4959: Bind session to process-scoped context (MCP path)
            try {
              const scopeParts = scope.split(':');
              bindSession({
                sessionId: session.id as string,
                scope: {
                  type: scopeParts[0] ?? 'global',
                  epicId: scopeParts[1],
                },
                gradeMode: (params?.grade as boolean) ?? false,
              });
            } catch {
              // Already bound — log and continue (session was still created)
              getLogger('domain:session').warn({ sessionId: session.id }, 'Session context already bound, skipping bindSession');
            }
          }
          return this.wrapEngineResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'end': {
          // End the session first
          const endResult = await sessionEnd(this.projectRoot, params?.note as string | undefined);

          // If session ended successfully, compute and persist debrief + handoff data
          if (endResult.success && endResult.data) {
            const sessionId = (endResult.data as { sessionId: string }).sessionId;
            if (sessionId) {
              // T4959: Compute rich debrief (superset of handoff)
              try {
                await sessionComputeDebrief(this.projectRoot, sessionId, {
                  note: params?.note as string | undefined,
                  nextAction: params?.nextAction as string | undefined,
                });
              } catch {
                // Debrief failure — fall back to handoff only
                try {
                  await sessionComputeHandoff(this.projectRoot, sessionId, {
                    note: params?.note as string | undefined,
                    nextAction: params?.nextAction as string | undefined,
                  });
                } catch {
                  // Handoff computation failure should not fail the end operation
                }
              }
            }

            // T4959: Unbind session from process-scoped context
            unbindSession();
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
      query: ['status', 'list', 'show', 'find', 'history', 'decision.log', 'context.drift', 'handoff.show', 'briefing.show', 'debrief.show', 'chain.show'],
      mutate: ['start', 'end', 'resume', 'suspend', 'gc', 'record.decision', 'record.assumption'],
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
    getLogger('domain:session').error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
