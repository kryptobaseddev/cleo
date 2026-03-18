/**
 * Session Domain Handler (Dispatch Layer)
 *
 * Handles session lifecycle operations: status, list, show, start, end,
 * resume, suspend, gc, record.decision, decision.log,
 * context.drift, record.assumption, handoff.show, briefing.show, find.
 *
 * All operations delegate to native engine functions from session-engine.
 *
 * @epic T4820
 * @task T5671
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
import { bindSession, unbindSession } from '../context/session-context.js';
import {
  sessionBriefing,
  sessionComputeDebrief,
  sessionComputeHandoff,
  sessionContextDrift,
  sessionDebriefShow,
  sessionDecisionLog,
  sessionEnd,
  sessionFind,
  sessionGc,
  sessionHandoff,
  sessionList,
  sessionRecordAssumption,
  sessionRecordDecision,
  sessionResume,
  sessionShow,
  sessionStart,
  sessionStatus,
  sessionSuspend,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const result = await sessionStatus(this.projectRoot);
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        case 'list': {
          const result = await sessionList(
            this.projectRoot,
            params as {
              active?: boolean;
              status?: string;
              limit?: number;
              offset?: number;
            },
          );
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        // session.show absorbs debrief.show via include param (T5615)
        case 'show': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return errorResult(
              'query',
              'session',
              operation,
              'E_INVALID_INPUT',
              'sessionId is required',
              startTime,
            );
          }
          const include = params?.include as string | undefined;
          if (include === 'debrief') {
            const result = await sessionDebriefShow(this.projectRoot, sessionId);
            return wrapResult(result, 'query', 'session', operation, startTime);
          }
          const result = await sessionShow(this.projectRoot, sessionId);
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        case 'decision.log': {
          const result = await sessionDecisionLog(
            this.projectRoot,
            params as { sessionId?: string; taskId?: string },
          );
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        case 'context.drift': {
          const result = await sessionContextDrift(
            this.projectRoot,
            params as { sessionId?: string },
          );
          return wrapResult(result, 'query', 'session', operation, startTime);
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
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        case 'briefing.show': {
          const result = await sessionBriefing(this.projectRoot, {
            maxNextTasks: params?.maxNextTasks as number | undefined,
            maxBugs: params?.maxBugs as number | undefined,
            maxBlocked: params?.maxBlocked as number | undefined,
            maxEpics: params?.maxEpics as number | undefined,
            scope: params?.scope as string | undefined,
          });
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        case 'find': {
          const result = await sessionFind(
            this.projectRoot,
            params as {
              status?: string;
              scope?: string;
              query?: string;
              limit?: number;
            },
          );
          return wrapResult(result, 'query', 'session', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'session', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:session').error(
        { gateway: 'query', domain: 'session', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'session', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          const scope = params?.scope as string;
          if (!scope) {
            return errorResult(
              'mutate',
              'session',
              operation,
              'E_INVALID_INPUT',
              'scope is required',
              startTime,
            );
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
              getLogger('domain:session').warn(
                { sessionId: session.id },
                'Session context already bound, skipping bindSession',
              );
            }
          }
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'end': {
          // End the session first
          const endResult = await sessionEnd(this.projectRoot, params?.note as string | undefined);

          // If session ended successfully, compute and persist debrief + handoff data
          if (endResult.success && endResult.data) {
            const sessionId = (endResult.data as { sessionId: string }).sessionId;
            if (sessionId) {
              // T4959: Compute rich debrief (superset of handoff)
              let debriefResult: {
                success: boolean;
                data?: import('@cleocode/core').DebriefData;
              } | null = null;
              try {
                debriefResult = await sessionComputeDebrief(this.projectRoot, sessionId, {
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

              // Wave 3A: Persist session memory to brain.db (best-effort)
              if (debriefResult?.success && debriefResult.data) {
                try {
                  const { persistSessionMemory } = await import(
                    '@cleocode/core'
                  );
                  await persistSessionMemory(this.projectRoot, sessionId, debriefResult.data);
                } catch {
                  // Memory persistence failure should not fail session end
                }
              }
            }

            // T4959: Unbind session from process-scoped context
            unbindSession();
          }

          return wrapResult(endResult, 'mutate', 'session', operation, startTime);
        }

        case 'resume': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return errorResult(
              'mutate',
              'session',
              operation,
              'E_INVALID_INPUT',
              'sessionId is required',
              startTime,
            );
          }
          const result = await sessionResume(this.projectRoot, sessionId);
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'suspend': {
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return errorResult(
              'mutate',
              'session',
              operation,
              'E_INVALID_INPUT',
              'sessionId is required',
              startTime,
            );
          }
          const result = await sessionSuspend(
            this.projectRoot,
            sessionId,
            params?.reason as string | undefined,
          );
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'gc': {
          const result = await sessionGc(
            this.projectRoot,
            params?.maxAgeDays as number | undefined,
          );
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'record.decision': {
          const result = await sessionRecordDecision(this.projectRoot, {
            sessionId: params?.sessionId as string,
            taskId: params?.taskId as string,
            decision: params?.decision as string,
            rationale: params?.rationale as string,
            alternatives: params?.alternatives as string[] | undefined,
          });
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        case 'record.assumption': {
          const result = await sessionRecordAssumption(this.projectRoot, {
            sessionId: params?.sessionId as string | undefined,
            taskId: params?.taskId as string | undefined,
            assumption: params?.assumption as string,
            confidence: params?.confidence as 'high' | 'medium' | 'low',
          });
          return wrapResult(result, 'mutate', 'session', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'session', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:session').error(
        { gateway: 'mutate', domain: 'session', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'session', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status',
        'list',
        'show',
        'find',
        'decision.log',
        'context.drift',
        'handoff.show',
        'briefing.show',
      ],
      mutate: ['start', 'end', 'resume', 'suspend', 'gc', 'record.decision', 'record.assumption'],
    };
  }
}
