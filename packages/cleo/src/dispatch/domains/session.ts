/**
 * Session Domain Handler (Dispatch Layer)
 *
 * Handles session lifecycle operations: status, list, show, start, end,
 * resume, suspend, gc, record.decision, decision.log,
 * context.drift, record.assumption, handoff.show, briefing.show, find.
 *
 * All operations delegate to native engine functions from session-engine.
 * Param extraction is type-safe via OpsFromCore inference (T1444 — T1435 Wave 1
 * refactor). Zero per-op Params/Result imports from @cleocode/contracts in this file.
 *
 * @epic T1435
 * @task T1444 — session domain refactor to OpsFromCore
 * @task T975 — typed-dispatch migration (Wave D)
 */

import { getDb, getLogger, getProjectRoot, sessions } from '@cleocode/core/internal';
import { eq } from 'drizzle-orm';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch, type OpsFromCore } from '../adapters/typed.js';
import { bindSession, unbindSession } from '../context/session-context.js';
import {
  sessionBriefing,
  sessionComputeDebrief,
  sessionComputeHandoff,
  sessionContextDrift,
  sessionDebriefShow as sessionDebriefShowEngine,
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
// Wrapper functions — adapt engine signatures to dispatch contract signatures
//
// Engine functions take projectRoot as first param; dispatch contracts expect
// only operation-specific params. These wrappers convert engine signatures to
// the wire-format expected by the typed dispatch layer.
//
// @task T1435 — Wave 1 dispatch refactor (eliminate contracts drift)
// @task T1436 — OpsFromCore helper (T1435 prerequisite)
// ---------------------------------------------------------------------------

/** Wrapper: session.status (no params) */
async function wrapSessionStatus(): Promise<ReturnType<typeof sessionStatus>> {
  return sessionStatus(getProjectRoot());
}

/** Wrapper: session.list */
async function wrapSessionList(
  params?: { active?: boolean; status?: string; limit?: number; offset?: number },
) {
  return sessionList(getProjectRoot(), params);
}

/** Wrapper: session.show */
async function wrapSessionShow(
  params: { sessionId: string; include?: string },
) {
  const projectRoot = getProjectRoot();
  // session.show absorbs debrief.show via include param (T5615)
  if (params.include === 'debrief') {
    return sessionDebriefShowEngine(projectRoot, params.sessionId);
  }
  return sessionShow(projectRoot, params.sessionId);
}

/** Wrapper: session.find */
async function wrapSessionFind(
  params: { status?: string; scope?: string; query?: string; limit?: number },
) {
  return sessionFind(getProjectRoot(), params);
}

/** Wrapper: session.decision.log */
async function wrapSessionDecisionLog(
  params: { sessionId?: string; taskId?: string },
) {
  return sessionDecisionLog(getProjectRoot(), params);
}

/** Wrapper: session.context.drift */
async function wrapSessionContextDrift(
  params: { sessionId?: string },
) {
  return sessionContextDrift(getProjectRoot(), { sessionId: params.sessionId });
}

/** Wrapper: session.handoff.show */
async function wrapSessionHandoffShow(
  params?: { scope?: string },
) {
  let scopeFilter: { type: string; epicId?: string } | undefined;
  if (params?.scope) {
    if (params.scope === 'global') {
      scopeFilter = { type: 'global' };
    } else if (params.scope.startsWith('epic:')) {
      scopeFilter = { type: 'epic', epicId: params.scope.replace('epic:', '') };
    }
  }
  return sessionHandoff(getProjectRoot(), scopeFilter);
}

/** Wrapper: session.briefing.show */
async function wrapSessionBriefingShow(
  params?: {
    maxNextTasks?: number;
    maxBugs?: number;
    maxBlocked?: number;
    maxEpics?: number;
    scope?: string;
  },
) {
  return sessionBriefing(getProjectRoot(), {
    maxNextTasks: params?.maxNextTasks,
    maxBugs: params?.maxBugs,
    maxBlocked: params?.maxBlocked,
    maxEpics: params?.maxEpics,
    scope: params?.scope,
  });
}

/** Wrapper: session.start */
async function wrapSessionStart(
  params: {
    scope: string;
    name?: string;
    autoStart?: boolean;
    startTask?: string;
    focus?: string;
    grade?: boolean;
    ownerAuthToken?: string;
  },
) {
  return sessionStart(getProjectRoot(), {
    scope: params.scope,
    name: params.name,
    autoStart: params.autoStart,
    startTask: params.startTask ?? params.focus,
    grade: params.grade,
  }).then(async (result) => {
    // T1118 L4a — Store owner auth token if provided
    if (params.ownerAuthToken && result.success && result.data?.id) {
      try {
        await storeSessionOwnerAuthToken(getProjectRoot(), result.data.id, params.ownerAuthToken);
      } catch (err) {
        getLogger('domain:session').warn(
          { sessionId: result.data.id, err },
          'Failed to store owner_auth_token',
        );
      }
    }
    return result;
  });
}

/** Wrapper: session.end */
async function wrapSessionEnd(
  params?: { note?: string; nextAction?: string; sessionSummary?: any },
) {
  return sessionEnd(getProjectRoot(), params?.note, {
    sessionSummary: params?.sessionSummary,
  }).then(async (result) => {
    // T4959: Compute rich debrief + handoff data
    if (result.success && result.data?.sessionId) {
      const sessionId = result.data.sessionId;
      let debriefResult: { success: boolean; data?: any } | null = null;
      try {
        debriefResult = await sessionComputeDebrief(getProjectRoot(), sessionId, {
          note: params?.note,
          nextAction: params?.nextAction,
        });
      } catch {
        try {
          await sessionComputeHandoff(getProjectRoot(), sessionId, {
            note: params?.note,
            nextAction: params?.nextAction,
          });
        } catch {
          // Handoff failure is non-fatal
        }
      }

      // Wave 3A: Persist session memory
      if (debriefResult?.success && debriefResult.data) {
        try {
          const { persistSessionMemory } = await import('@cleocode/core/internal');
          await persistSessionMemory(getProjectRoot(), sessionId, debriefResult.data);
        } catch {
          // Memory persistence is best-effort
        }
      }

      unbindSession();
    }

    // Refresh memory bridge
    try {
      const { refreshMemoryBridge } = await import('@cleocode/core/internal');
      await refreshMemoryBridge(getProjectRoot());
    } catch {
      // Bridge refresh is best-effort
    }

    return result;
  });
}

/** Wrapper: session.resume */
async function wrapSessionResume(params: { sessionId: string }) {
  return sessionResume(getProjectRoot(), params.sessionId);
}

/** Wrapper: session.suspend */
async function wrapSessionSuspend(
  params: { sessionId: string; reason?: string },
) {
  return sessionSuspend(getProjectRoot(), params.sessionId, params.reason);
}

/** Wrapper: session.gc */
async function wrapSessionGc(params?: { maxAgeDays?: number }) {
  return sessionGc(getProjectRoot(), params?.maxAgeDays);
}

/** Wrapper: session.record.decision */
async function wrapSessionRecordDecision(
  params: {
    sessionId?: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  },
) {
  return sessionRecordDecision(getProjectRoot(), {
    sessionId: params.sessionId,
    taskId: params.taskId,
    decision: params.decision,
    rationale: params.rationale,
    alternatives: params.alternatives,
  });
}

/** Wrapper: session.record.assumption */
async function wrapSessionRecordAssumption(
  params: {
    sessionId?: string;
    taskId?: string;
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
  },
) {
  return sessionRecordAssumption(getProjectRoot(), {
    sessionId: params.sessionId,
    taskId: params.taskId,
    assumption: params.assumption,
    confidence: params.confidence,
  });
}

// ---------------------------------------------------------------------------
// Core operations record — source of truth for session domain types
//
// Maps dispatch operation names to their wrapper functions.
// Type inference via OpsFromCore<typeof coreOps> replaces hand-typed
// SessionOps from contracts. This ensures dispatch-vs-contracts drift is
// structurally impossible: wrapper functions are the single source of truth.
//
// @task T1435 — Wave 1 dispatch refactor (eliminate contracts drift)
// @task T1436 — OpsFromCore helper (T1435 prerequisite)
// ---------------------------------------------------------------------------

const coreOps = {
  'status': wrapSessionStatus,
  'list': wrapSessionList,
  'show': wrapSessionShow,
  'find': wrapSessionFind,
  'decision.log': wrapSessionDecisionLog,
  'context.drift': wrapSessionContextDrift,
  'handoff.show': wrapSessionHandoffShow,
  'briefing.show': wrapSessionBriefingShow,
  'start': wrapSessionStart,
  'end': wrapSessionEnd,
  'resume': wrapSessionResume,
  'suspend': wrapSessionSuspend,
  'gc': wrapSessionGc,
  'record.decision': wrapSessionRecordDecision,
  'record.assumption': wrapSessionRecordAssumption,
} as const;

/**
 * Typed operation record for the session domain.
 *
 * Inferred from Core function signatures via {@link OpsFromCore}.
 * Each entry maps operation name to `[Params, Result]` tuple.
 * Zero hand-typed Params/Result imports from @cleocode/contracts.
 *
 * @task T1435 — Wave 1 (OpsFromCore inference)
 */
type SessionOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T975)
//
// The typed handler adapts wrapper function results into LAFS envelopes.
// Each handler wraps the EngineResult from the wrapper into a LafsEnvelope.
// ---------------------------------------------------------------------------

const _sessionTypedHandler = defineTypedHandler<SessionOps>('session', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  status: async (_params: SessionOps['status'][0]) => {
    const result = await wrapSessionStatus();
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'status',
      );
    }
    return lafsSuccess(
      result.data ?? { hasActiveSession: false, session: null, taskWork: null },
      'status',
    );
  },

  list: async (params: SessionOps['list'][0]) => {
    const result = await wrapSessionList(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'list',
      );
    }
    return lafsSuccess(result.data ?? { sessions: [], total: 0, filtered: 0 }, 'list');
  },

  show: async (params: SessionOps['show'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'show');
    }
    const result = await wrapSessionShow(params);
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

  find: async (params: SessionOps['find'][0]) => {
    const result = await wrapSessionFind(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'find',
      );
    }
    return lafsSuccess({ sessions: result.data ?? [] }, 'find');
  },

  'decision.log': async (params: SessionOps['decision.log'][0]) => {
    const result = await wrapSessionDecisionLog(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'decision.log',
      );
    }
    return lafsSuccess(result.data ?? [], 'decision.log');
  },

  'context.drift': async (params: SessionOps['context.drift'][0]) => {
    const result = await wrapSessionContextDrift(params);
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

  'handoff.show': async (params: SessionOps['handoff.show'][0]) => {
    const result = await wrapSessionHandoffShow(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'handoff.show',
      );
    }
    return lafsSuccess(result.data ?? null, 'handoff.show');
  },

  'briefing.show': async (params: SessionOps['briefing.show'][0]) => {
    const result = await wrapSessionBriefingShow(params);
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

  start: async (params: SessionOps['start'][0]) => {
    if (!params.scope) {
      return lafsError('E_INVALID_INPUT', 'scope is required', 'start');
    }
    const result = await wrapSessionStart(params);

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
      getLogger('domain:session').warn(
        { sessionId },
        'Session context already bound, skipping bindSession',
      );
    }

    return lafsSuccess(sessionData, 'start');
  },

  end: async (params: SessionOps['end'][0]) => {
    const result = await wrapSessionEnd(params);

    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'end',
      );
    }

    if (!result.data) {
      return lafsError('E_INTERNAL', 'session.end returned no data', 'end');
    }
    return lafsSuccess(result.data, 'end');
  },

  resume: async (params: SessionOps['resume'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'resume');
    }
    const result = await wrapSessionResume(params);
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

  suspend: async (params: SessionOps['suspend'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'suspend');
    }
    const result = await wrapSessionSuspend(params);
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

  gc: async (params: SessionOps['gc'][0]) => {
    const result = await wrapSessionGc(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'gc',
      );
    }
    return lafsSuccess(result.data ?? { orphaned: [], removed: [] }, 'gc');
  },

  'record.decision': async (params: SessionOps['record.decision'][0]) => {
    const result = await wrapSessionRecordDecision(params);
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

  'record.assumption': async (params: SessionOps['record.assumption'][0]) => {
    const result = await wrapSessionRecordAssumption(params);
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

// ---------------------------------------------------------------------------
// T1118 L4a — Owner auth token storage helper
// ---------------------------------------------------------------------------

/**
 * Store an owner-auth HMAC token against a session row.
 *
 * Uses a raw SQL update via the native SQLite accessor to avoid coupling
 * the Session contract to the new column.
 *
 * @param projectRoot - Absolute project root path.
 * @param sessionId - Session ID to update.
 * @param token - HMAC token to store.
 *
 * @task T1118
 * @task T1123
 */
async function storeSessionOwnerAuthToken(
  projectRoot: string,
  sessionId: string,
  token: string,
): Promise<void> {
  // The native DB is always available at this point because session.start
  // already successfully ran.
  const db = await getDb(projectRoot);
  db.update(sessions).set({ ownerAuthToken: token }).where(eq(sessions.id, sessionId)).run();
}
