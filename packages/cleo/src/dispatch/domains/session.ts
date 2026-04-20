/**
 * Session Domain Handler (Dispatch Layer)
 *
 * Handles session lifecycle operations: status, list, show, start, end,
 * resume, suspend, gc, record.decision, decision.log,
 * context.drift, record.assumption, handoff.show, briefing.show, find.
 *
 * All operations delegate to native engine functions from session-engine.
 * Param extraction is type-safe via TypedDomainHandler<SessionOps> (T975 —
 * Wave D typed-dispatch migration). Zero `as any` / `as X` param casts.
 *
 * @epic T4820
 * @task T5671
 * @task T975 — typed-dispatch migration
 */

import type {
  SessionBriefingShowParams,
  SessionContextDriftParams,
  SessionDecisionLogParams,
  SessionEndParams,
  SessionFindParams,
  SessionGcParams,
  SessionHandoffShowParams,
  SessionListParams,
  SessionOps,
  SessionRecordAssumptionParams,
  SessionRecordDecisionParams,
  SessionResumeParams,
  SessionShowParams,
  SessionStartParams,
  SessionStatusParams,
  SessionSuspendParams,
} from '@cleocode/contracts';
import { getLogger, getProjectRoot } from '@cleocode/core';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
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
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T975)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _sessionTypedHandler = defineTypedHandler<SessionOps>('session', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  status: async (_params: SessionStatusParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionStatus(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'status',
      );
    }
    // Engine guarantees data on success; return as-is (data shape matches SessionStatusResult)
    return lafsSuccess(
      result.data ?? { hasActiveSession: false, session: null, taskWork: null },
      'status',
    );
  },

  list: async (params: SessionListParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionList(projectRoot, {
      active: params.active,
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'list',
      );
    }
    return lafsSuccess(result.data ?? { sessions: [], total: 0, filtered: 0 }, 'list');
  },

  // session.show absorbs debrief.show via include param (T5615)
  show: async (params: SessionShowParams) => {
    const projectRoot = getProjectRoot();
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'show');
    }
    if (params.include === 'debrief') {
      const result = await sessionDebriefShow(projectRoot, params.sessionId);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'show',
        );
      }
      // sessionDebriefShow returns opaque debrief data — SessionShowResult is `unknown`
      // so no cast is needed; the typed result passes through unchanged.
      return lafsSuccess(result.data, 'show');
    }
    const result = await sessionShow(projectRoot, params.sessionId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'show',
      );
    }
    if (!result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'show');
    }
    return lafsSuccess(result.data, 'show');
  },

  find: async (params: SessionFindParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionFind(projectRoot, {
      status: params.status,
      scope: params.scope,
      query: params.query,
      limit: params.limit,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'find',
      );
    }
    return lafsSuccess({ sessions: result.data ?? [] }, 'find');
  },

  'decision.log': async (params: SessionDecisionLogParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionDecisionLog(projectRoot, {
      sessionId: params.sessionId,
      taskId: params.taskId,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'decision.log',
      );
    }
    return lafsSuccess(result.data ?? [], 'decision.log');
  },

  'context.drift': async (params: SessionContextDriftParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionContextDrift(projectRoot, { sessionId: params.sessionId });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'context.drift',
      );
    }
    if (!result.data) {
      return lafsError('E_INTERNAL', 'context.drift returned no data', 'context.drift');
    }
    return lafsSuccess(result.data, 'context.drift');
  },

  'handoff.show': async (params: SessionHandoffShowParams) => {
    const projectRoot = getProjectRoot();
    let scopeFilter: { type: string; epicId?: string } | undefined;
    if (params.scope) {
      if (params.scope === 'global') {
        scopeFilter = { type: 'global' };
      } else if (params.scope.startsWith('epic:')) {
        scopeFilter = { type: 'epic', epicId: params.scope.replace('epic:', '') };
      }
    }
    const result = await sessionHandoff(projectRoot, scopeFilter);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'handoff.show',
      );
    }
    return lafsSuccess(result.data ?? null, 'handoff.show');
  },

  'briefing.show': async (params: SessionBriefingShowParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionBriefing(projectRoot, {
      maxNextTasks: params.maxNextTasks,
      maxBugs: params.maxBugs,
      maxBlocked: params.maxBlocked,
      maxEpics: params.maxEpics,
      scope: params.scope,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'briefing.show',
      );
    }
    return lafsSuccess(result.data, 'briefing.show');
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  start: async (params: SessionStartParams) => {
    const projectRoot = getProjectRoot();
    if (!params.scope) {
      return lafsError('E_INVALID_INPUT', 'scope is required', 'start');
    }
    const result = await sessionStart(projectRoot, {
      scope: params.scope,
      name: params.name,
      autoStart: params.autoStart,
      startTask: params.startTask ?? params.focus,
      grade: params.grade,
    });

    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'start',
      );
    }
    if (!result.data) {
      return lafsError('E_INTERNAL', 'sessionStart returned no data', 'start');
    }

    const sessionData = result.data;
    const sessionId = sessionData.id;

    // Enrich with sessionId alias for easy extraction
    // Use Object.assign to add the alias without violating Session type
    Object.assign(sessionData, { sessionId });

    // T4959: Bind session to process-scoped context
    try {
      const scopeParts = params.scope.split(':');
      bindSession({
        sessionId,
        scope: {
          type: scopeParts[0] ?? 'global',
          epicId: scopeParts[1],
        },
        gradeMode: params.grade ?? false,
      });
    } catch {
      // Already bound — log and continue (session was still created)
      getLogger('domain:session').warn(
        { sessionId },
        'Session context already bound, skipping bindSession',
      );
    }

    return lafsSuccess(sessionData, 'start');
  },

  end: async (params: SessionEndParams) => {
    const projectRoot = getProjectRoot();
    // End the session first (T140: pass sessionSummary for structured ingestion)
    const endResult = await sessionEnd(projectRoot, params.note, {
      sessionSummary: params.sessionSummary,
    });

    if (!endResult.success) {
      return lafsError(
        String(endResult.error?.code ?? 'E_INTERNAL'),
        endResult.error?.message ?? 'Unknown error',
        'end',
      );
    }

    // If session ended successfully, compute and persist debrief + handoff data
    if (endResult.data) {
      const sessionId = endResult.data.sessionId;
      if (sessionId) {
        // T4959: Compute rich debrief (superset of handoff)
        let debriefResult: {
          success: boolean;
          data?: import('@cleocode/core/internal').DebriefData;
        } | null = null;
        try {
          debriefResult = await sessionComputeDebrief(projectRoot, sessionId, {
            note: params.note,
            nextAction: params.nextAction,
          });
        } catch {
          // Debrief failure — fall back to handoff only
          try {
            await sessionComputeHandoff(projectRoot, sessionId, {
              note: params.note,
              nextAction: params.nextAction,
            });
          } catch {
            // Handoff computation failure should not fail the end operation
          }
        }

        // Wave 3A: Persist session memory to brain.db (best-effort)
        if (debriefResult?.success && debriefResult.data) {
          try {
            const { persistSessionMemory } = await import('@cleocode/core/internal');
            await persistSessionMemory(projectRoot, sessionId, debriefResult.data);
          } catch {
            // Memory persistence failure should not fail session end
          }
        }
      }

      // T4959: Unbind session from process-scoped context
      unbindSession();
    }

    // Refresh memory bridge AFTER all session end work completes (T546).
    // The engine path (session-engine.ts) does not go through core/sessions/index.ts
    // which has the direct refreshMemoryBridge call, so we must trigger it here.
    try {
      const { refreshMemoryBridge } = await import('@cleocode/core/internal');
      await refreshMemoryBridge(projectRoot);
    } catch {
      // Best-effort: never block session end on bridge refresh failure
    }

    if (!endResult.data) {
      return lafsError('E_INTERNAL', 'session.end returned no data', 'end');
    }
    return lafsSuccess(endResult.data, 'end');
  },

  resume: async (params: SessionResumeParams) => {
    const projectRoot = getProjectRoot();
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'resume');
    }
    const result = await sessionResume(projectRoot, params.sessionId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'resume',
      );
    }
    if (!result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'resume');
    }
    return lafsSuccess(result.data, 'resume');
  },

  suspend: async (params: SessionSuspendParams) => {
    const projectRoot = getProjectRoot();
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'suspend');
    }
    const result = await sessionSuspend(projectRoot, params.sessionId, params.reason);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'suspend',
      );
    }
    if (!result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'suspend');
    }
    return lafsSuccess(result.data, 'suspend');
  },

  gc: async (params: SessionGcParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionGc(projectRoot, params.maxAgeDays);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'gc',
      );
    }
    // Engine guarantees data on success; provide empty fallback for safety
    return lafsSuccess(result.data ?? { orphaned: [], removed: [] }, 'gc');
  },

  'record.decision': async (params: SessionRecordDecisionParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionRecordDecision(projectRoot, {
      sessionId: params.sessionId,
      taskId: params.taskId,
      decision: params.decision,
      rationale: params.rationale,
      alternatives: params.alternatives,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'record.decision',
      );
    }
    if (!result.data) {
      return lafsError('E_INTERNAL', 'record.decision returned no data', 'record.decision');
    }
    return lafsSuccess(result.data, 'record.decision');
  },

  'record.assumption': async (params: SessionRecordAssumptionParams) => {
    const projectRoot = getProjectRoot();
    const result = await sessionRecordAssumption(projectRoot, {
      sessionId: params.sessionId,
      taskId: params.taskId,
      assumption: params.assumption,
      confidence: params.confidence,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'record.assumption',
      );
    }
    if (!result.data) {
      return lafsError('E_INTERNAL', 'record.assumption returned no data', 'record.assumption');
    }
    return lafsSuccess(result.data, 'record.assumption');
  },
});

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
//
// Converts a LafsEnvelope into the minimal EngineResult shape accepted by
// wrapResult. The error.code is coerced to string since LafsErrorDetail.code
// is typed as `number | string` but EngineResult.error.code requires string.
// ---------------------------------------------------------------------------

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * @param envelope - The LAFS envelope returned by the typed op function.
 * @returns An object compatible with the `EngineResult` type in `_base.ts`.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: number | string; readonly message: string };
}): { success: boolean; data?: unknown; error?: { code: string; message: string } } {
  if (envelope.success) {
    return { success: true, data: envelope.data };
  }
  return {
    success: false,
    error: {
      code: String(envelope.error?.code ?? 'E_INTERNAL'),
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>([
  'status',
  'list',
  'show',
  'find',
  'decision.log',
  'context.drift',
  'handoff.show',
  'briefing.show',
]);

const MUTATE_OPS = new Set<string>([
  'start',
  'end',
  'resume',
  'suspend',
  'gc',
  'record.decision',
  'record.assumption',
]);

// ---------------------------------------------------------------------------
// SessionHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `session` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_sessionTypedHandler` (a `TypedDomainHandler<SessionOps>`). This
 * satisfies the registry's `DomainHandler` interface while keeping every
 * param access fully type-safe via the T975 Wave D adapter.
 */
export class SessionHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only session query operation.
   *
   * @param operation - The session query op name (e.g. 'status', 'list').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'session', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid session query op name at this point.
      const envelope = await typedDispatch(
        _sessionTypedHandler,
        operation as keyof SessionOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'query', 'session', operation, startTime);
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

  /**
   * Execute a state-modifying session mutation operation.
   *
   * @param operation - The session mutate op name (e.g. 'start', 'end').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'session', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid session mutate op name at this point.
      const envelope = await typedDispatch(
        _sessionTypedHandler,
        operation as keyof SessionOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'mutate',
        'session',
        operation,
        startTime,
      );
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

  /** Declared operations for introspection and validation. */
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
