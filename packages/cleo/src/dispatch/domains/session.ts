/**
 * Session Domain Handler (Dispatch Layer)
 *
 * Handles session lifecycle operations: status, list, show, start, end,
 * resume, suspend, gc, record.decision, decision.log,
 * context.drift, record.assumption, handoff.show, briefing.show, find.
 *
 * All operations delegate to native engine functions from session-engine.
 * Param extraction is type-safe via OpsFromCore inference (T1444 — T1435
 * Wave 1 dispatch refactor). Per-op Params types are sole-sourced via
 * `import type` from `@cleocode/contracts` (T1489).
 *
 * @epic T4820
 * @task T5671
 * @task T975 — typed-dispatch migration
 * @task T1444 — OpsFromCore inference migration
 * @task T1489 — sole-source Params/Result aliases via contracts re-exports
 */

import type {
  SessionEndParams,
  SessionGcParams,
  SessionHandoffShowParams,
  SessionResumeParams,
  SessionShowParams,
  SessionStartParams,
  SessionSuspendParams,
} from '@cleocode/contracts';
import { getDb, getLogger, getProjectRoot, sessions } from '@cleocode/core/internal';
import { eq } from 'drizzle-orm';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
  wrapCoreResult,
} from '../adapters/typed.js';
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
import { envelopeToEngineResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

async function sessionStatusOp() {
  return sessionStatus(getProjectRoot());
}

async function sessionListOp(params: NonNullable<Parameters<typeof sessionList>[1]>) {
  return sessionList(getProjectRoot(), params);
}

async function sessionShowOp(params: SessionShowParams) {
  if (params.include === 'debrief') {
    return sessionDebriefShow(getProjectRoot(), params.sessionId);
  }
  return sessionShow(getProjectRoot(), params.sessionId);
}

async function sessionFindOp(params: NonNullable<Parameters<typeof sessionFind>[1]>) {
  return sessionFind(getProjectRoot(), params);
}

async function sessionDecisionLogOp(params: NonNullable<Parameters<typeof sessionDecisionLog>[1]>) {
  return sessionDecisionLog(getProjectRoot(), params);
}

async function sessionContextDriftOp(
  params: NonNullable<Parameters<typeof sessionContextDrift>[1]>,
) {
  return sessionContextDrift(getProjectRoot(), params);
}

async function sessionHandoffShowOp(params: SessionHandoffShowParams) {
  let scopeFilter: { type: string; epicId?: string } | undefined;
  if (params.scope) {
    if (params.scope === 'global') {
      scopeFilter = { type: 'global' };
    } else if (params.scope.startsWith('epic:')) {
      scopeFilter = { type: 'epic', epicId: params.scope.replace('epic:', '') };
    }
  }
  return sessionHandoff(getProjectRoot(), scopeFilter);
}

async function sessionBriefingShowOp(params: NonNullable<Parameters<typeof sessionBriefing>[1]>) {
  return sessionBriefing(getProjectRoot(), params);
}

async function sessionStartOp(params: SessionStartParams) {
  return sessionStart(getProjectRoot(), params);
}

async function sessionEndOp(params: SessionEndParams) {
  return sessionEnd(getProjectRoot(), params.note, {
    sessionSummary: params.sessionSummary,
  });
}

async function sessionResumeOp(params: SessionResumeParams) {
  return sessionResume(getProjectRoot(), params.sessionId);
}

async function sessionSuspendOp(params: SessionSuspendParams) {
  return sessionSuspend(getProjectRoot(), params.sessionId, params.reason);
}

async function sessionGcOp(params: SessionGcParams) {
  return sessionGc(getProjectRoot(), params.maxAgeDays);
}

async function sessionRecordDecisionOp(params: Parameters<typeof sessionRecordDecision>[1]) {
  return sessionRecordDecision(getProjectRoot(), params);
}

async function sessionRecordAssumptionOp(params: Parameters<typeof sessionRecordAssumption>[1]) {
  return sessionRecordAssumption(getProjectRoot(), params);
}

const coreOps = {
  status: sessionStatusOp,
  list: sessionListOp,
  show: sessionShowOp,
  find: sessionFindOp,
  'decision.log': sessionDecisionLogOp,
  'context.drift': sessionContextDriftOp,
  'handoff.show': sessionHandoffShowOp,
  'briefing.show': sessionBriefingShowOp,
  start: sessionStartOp,
  end: sessionEndOp,
  resume: sessionResumeOp,
  suspend: sessionSuspendOp,
  gc: sessionGcOp,
  'record.decision': sessionRecordDecisionOp,
  'record.assumption': sessionRecordAssumptionOp,
} as const;

type SessionOps = OpsFromCore<typeof coreOps>;

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

  // Engine guarantees data on success; fallback mirrors empty-state shape.
  // overrideCount included per T1501 / P0-5.
  status: async (_params: SessionOps['status'][0]) =>
    wrapCoreResult(await coreOps.status(), 'status', {
      hasActiveSession: false as const,
      session: null,
      taskWork: null,
      overrideCount: 0,
    }),

  list: async (params: SessionOps['list'][0]) => wrapCoreResult(await coreOps.list(params), 'list'),

  // session.show absorbs debrief.show via include param (T5615)
  show: async (params: SessionOps['show'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'show');
    }
    const result = await coreOps.show(params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'show',
      );
    }
    // Non-debrief path: require data. Debrief returns opaque shape — no null check needed.
    if (params.include !== 'debrief' && !result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'show');
    }
    return lafsSuccess(result.data, 'show');
  },

  find: async (params: SessionOps['find'][0]) => {
    const result = await coreOps.find(params);
    // Core returns an array; wrap in the expected {sessions:[]} envelope shape.
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'find',
      );
    }
    return lafsSuccess({ sessions: result.data ?? [] }, 'find');
  },

  'decision.log': async (params: SessionOps['decision.log'][0]) =>
    wrapCoreResult(await coreOps['decision.log'](params), 'decision.log', []),

  'context.drift': async (params: SessionOps['context.drift'][0]) => {
    const result = await coreOps['context.drift'](params);
    if (result.success && !result.data) {
      return lafsError('E_INTERNAL', 'context.drift returned no data', 'context.drift');
    }
    return wrapCoreResult(result, 'context.drift');
  },

  'handoff.show': async (params: SessionOps['handoff.show'][0]) =>
    wrapCoreResult(await coreOps['handoff.show'](params), 'handoff.show', null),

  'briefing.show': async (params: SessionOps['briefing.show'][0]) =>
    wrapCoreResult(await coreOps['briefing.show'](params), 'briefing.show'),

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  // SSoT-EXEMPT: storeOwnerAuthToken (DB side-effect requiring post-create sessionId),
  // bindSession (process-scoped context, requires scope-string parsing) — ADR-058
  start: async (params: SessionOps['start'][0]) => {
    const projectRoot = getProjectRoot();
    if (!params.scope) {
      return lafsError('E_INVALID_INPUT', 'scope is required', 'start');
    }
    const result = await coreOps.start(params);

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

    // T1118 L4a — If an ownerAuthToken was provided, store it in sessions.owner_auth_token.
    if (params.ownerAuthToken) {
      try {
        await storeSessionOwnerAuthToken(projectRoot, sessionId, params.ownerAuthToken);
      } catch (err) {
        // Non-fatal — session was created, token store failed
        getLogger('domain:session').warn(
          { sessionId, err },
          'Failed to store owner_auth_token — override auth will not be available',
        );
      }
    }

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

  // SSoT-EXEMPT: orchestrated post-op pipeline — sessionComputeDebrief, persistSessionMemory,
  // unbindSession (process-context teardown), refreshMemoryBridge — ADR-058
  end: async (params: SessionOps['end'][0]) => {
    const projectRoot = getProjectRoot();
    // End the session first (T140: pass sessionSummary for structured ingestion)
    const endResult = await coreOps.end(params);

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

  resume: async (params: SessionOps['resume'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'resume');
    }
    const result = await coreOps.resume(params);
    if (result.success && !result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'resume');
    }
    return wrapCoreResult(result, 'resume');
  },

  suspend: async (params: SessionOps['suspend'][0]) => {
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId is required', 'suspend');
    }
    const result = await coreOps.suspend(params);
    if (result.success && !result.data) {
      return lafsError('E_NOT_FOUND', `Session ${params.sessionId} not found`, 'suspend');
    }
    return wrapCoreResult(result, 'suspend');
  },

  // Engine guarantees data on success; fallback for safety.
  gc: async (params: SessionOps['gc'][0]) =>
    wrapCoreResult(await coreOps.gc(params), 'gc', { orphaned: [], removed: [] }),

  'record.decision': async (params: SessionOps['record.decision'][0]) => {
    const result = await coreOps['record.decision'](params);
    if (result.success && !result.data) {
      return lafsError('E_INTERNAL', 'record.decision returned no data', 'record.decision');
    }
    return wrapCoreResult(result, 'record.decision');
  },

  'record.assumption': async (params: SessionOps['record.assumption'][0]) => {
    const result = await coreOps['record.assumption'](params);
    if (result.success && !result.data) {
      return lafsError('E_INTERNAL', 'record.assumption returned no data', 'record.assumption');
    }
    return wrapCoreResult(result, 'record.assumption');
  },
});

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
