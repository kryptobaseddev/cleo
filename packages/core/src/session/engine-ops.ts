/**
 * Session Engine Operations — business logic layer.
 *
 * Contains all session domain logic migrated from
 * `packages/cleo/src/dispatch/engines/session-engine.ts` (ENG-MIG-6 / T1573).
 *
 * Each exported function returns `EngineResult` and is importable from
 * `@cleocode/core/internal` so the CLI dispatch layer can call them without
 * any intermediate engine file.
 *
 * @task T1573 — ENG-MIG-6
 * @epic T1566
 */

import type { Session, SessionSummaryInput, TaskWorkState } from '@cleocode/contracts';
import { SESSION_JOURNAL_SCHEMA_VERSION } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { paginate } from '../pagination.js';
import { type ContextInjectionData, injectContext } from '../sessions/context-inject.js';
import {
  archiveSessions,
  cleanupSessions,
  computeBriefing,
  computeDebrief,
  computeHandoff,
  type DebriefData,
  type DecisionRecord,
  type FindSessionsParams,
  findSessions,
  getContextDrift,
  getDecisionLog,
  getLastHandoff,
  getSessionHistory,
  getSessionStats,
  type HandoffData,
  type MinimalSessionRecord,
  parseScope,
  persistHandoff,
  recordAssumption,
  recordDecision,
  type SessionBriefing,
  showSession,
  suspendSession,
  switchSession,
} from '../sessions/index.js';
import { generateSessionId } from '../sessions/session-id.js';
import { appendSessionJournalEntry } from '../sessions/session-journal.js';
import { getAccessor } from '../store/data-accessor.js';
import {
  currentTask,
  getTaskHistory,
  startTask,
  stopTask,
  type TaskWorkHistoryEntry,
} from '../task-work/index.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Convert any caught CleoError-like value into a failed EngineResult,
 * forwarding its rich fields (fix, details, alternatives) when available.
 *
 * @internal
 */
function toEngineError<T>(
  err: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): EngineResult<T> {
  if (typeof err === 'string') return engineError<T>(fallbackCode, err);
  if (err === null || typeof err !== 'object') return engineError<T>(fallbackCode, String(err));

  const e = err as {
    code?: number;
    message?: string;
    fix?: string;
    details?: Record<string, unknown>;
    alternatives?: Array<{ action: string; command: string }>;
  };

  // Map numeric CleoError exit codes to string codes where straightforward.
  // For unrecognised codes fall back to the provided fallbackCode.
  const code = fallbackCode;
  const message = e.message ?? fallbackMessage;
  return engineError<T>(code, message, {
    ...(e.fix !== undefined && { fix: e.fix }),
    ...(e.details !== undefined && { details: e.details }),
    ...(e.alternatives !== undefined && { alternatives: e.alternatives }),
  });
}

// ---------------------------------------------------------------------------
// Query ops
// ---------------------------------------------------------------------------

/** Default limit for sessionList when none is provided. */
const SESSION_LIST_DEFAULT_LIMIT = 10;

/**
 * Get current session status.
 *
 * Returns whether there is an active session, along with the session record,
 * current task work state, and the running CLEO_OWNER_OVERRIDE count for
 * the active session (T1501 / P0-5).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with active session flag, session record, task work
 *   state, and `overrideCount` for the active session.
 *
 * @task T1573
 */
export async function sessionStatus(projectRoot: string): Promise<
  EngineResult<{
    hasActiveSession: boolean;
    session?: Session | null;
    taskWork?: TaskWorkState | null;
    /** Running CLEO_OWNER_OVERRIDE count for the active session. */
    overrideCount: number;
  }>
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const focusState = await accessor.getMetaValue<TaskWorkState>('focus_state');
    const sessions = await accessor.loadSessions();
    const active = sessions.find((s: Session) => s.status === 'active');

    // Surface persisted override count for the active session (T1501).
    let overrideCount = 0;
    if (active) {
      const { readSessionOverrideCount } = await import('../security/override-cap.js');
      overrideCount = readSessionOverrideCount(projectRoot, active.id);
    }

    return engineSuccess({
      hasActiveSession: !!active,
      session: active ?? null,
      taskWork: focusState ?? null,
      overrideCount,
    });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * List sessions with budget enforcement.
 *
 * Defaults to 10 results when no explicit limit is provided to protect
 * agent context budgets. Includes `_meta.truncated` and `_meta.total`
 * so agents know when the result set was capped.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filter and pagination parameters
 * @returns EngineResult with sessions array, total, filtered count, and truncation metadata
 *
 * @task T1573
 */
export async function sessionList(
  projectRoot: string,
  params?: { active?: boolean; status?: string; limit?: number; offset?: number },
): Promise<
  EngineResult<{
    sessions: Session[];
    total: number;
    filtered: number;
    _meta: { truncated: boolean; total: number };
  }>
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    let result = sessions;

    if (params?.status) {
      result = result.filter((s: Session) => s.status === params.status);
    } else if (params?.active === true) {
      result = result.filter((s: Session) => s.status === 'active');
    } else if (params?.active === false) {
      result = result.filter((s: Session) => s.status !== 'active');
    }

    const total = sessions.length;
    const filtered = result.length;
    const limit = params?.limit && params.limit > 0 ? params.limit : SESSION_LIST_DEFAULT_LIMIT;
    const offset = typeof params?.offset === 'number' && params.offset > 0 ? params.offset : 0;
    const pageResult = paginate(result, limit, offset);
    const truncated = filtered !== pageResult.items.length || offset > 0;

    return {
      success: true,
      data: {
        sessions: pageResult.items,
        total,
        filtered,
        _meta: { truncated, total: filtered },
      },
      page: pageResult.page,
    };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Lightweight session discovery — returns minimal session records.
 *
 * Optimized for low context cost. Returns only essential fields (ID, status,
 * scope, timestamps) without full session details.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional search parameters
 * @returns EngineResult with array of minimal session records
 *
 * @task T1573
 */
export async function sessionFind(
  projectRoot: string,
  params?: FindSessionsParams,
): Promise<EngineResult<MinimalSessionRecord[]>> {
  try {
    const result = await findSessions(projectRoot, params);
    return engineSuccess(result);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show a specific session by ID.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session identifier to look up
 * @returns EngineResult with the full Session record
 *
 * @task T1573
 */
export async function sessionShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await showSession(projectRoot, { sessionId });
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Session not initialized');
  }
}

/**
 * Get current task being worked on.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with currentTask and currentPhase
 *
 * @task T1573
 */
export async function taskCurrentGet(
  projectRoot: string,
): Promise<EngineResult<{ currentTask: string | null; currentPhase: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await currentTask(undefined, accessor);
    return engineSuccess({
      currentTask: result.currentTask,
      currentPhase: result.currentPhase,
    });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Start working on a specific task.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task ID to start working on
 * @returns EngineResult with taskId and previousTask
 *
 * @task T1573
 */
export async function taskStart(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ taskId: string; previousTask: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await startTask(taskId, undefined, accessor);
    return engineSuccess({ taskId: result.taskId, previousTask: result.previousTask });
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to start task');
  }
}

/**
 * Stop working on the current task.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with cleared flag and previousTask
 *
 * @task T1573
 */
export async function taskStop(
  projectRoot: string,
): Promise<EngineResult<{ cleared: boolean; previousTask: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await stopTask(undefined, accessor);
    return engineSuccess({ cleared: true, previousTask: result.previousTask });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get task work history from session notes.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with history entries and count
 *
 * @task T1573
 */
export async function taskWorkHistory(
  projectRoot: string,
): Promise<EngineResult<{ history: TaskWorkHistoryEntry[]; count: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const history = await getTaskHistory(undefined, accessor);
    return engineSuccess({ history, count: history.length });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle ops
// ---------------------------------------------------------------------------

/**
 * Start a new session.
 *
 * Validates scope, guards against active session conflicts, chains session
 * links, computes auto-briefing, and appends a session_start journal entry.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Session start parameters including scope, name, and options
 * @returns EngineResult with the newly created Session (enriched with briefing)
 *
 * @task T1573
 */
export async function sessionStart(
  projectRoot: string,
  params: {
    scope: string;
    name?: string;
    autoStart?: boolean;
    startTask?: string;
    /** Enable full query+mutation audit logging for behavioral grading. */
    grade?: boolean;
  },
): Promise<EngineResult<Session>> {
  try {
    const accessor = await getAccessor(projectRoot);

    // Validate scope BEFORE auto-ending active session (prevents data loss on invalid input)
    let scope: ReturnType<typeof parseScope>;
    try {
      scope = parseScope(params.scope);
    } catch (err) {
      return toEngineError(err, 'E_INVALID_INPUT', 'Invalid scope');
    }

    // For non-global scopes, verify root task exists before auto-ending
    if (scope.type !== 'global') {
      const rootTask = await accessor.loadSingleTask(scope.rootTaskId!);
      if (!rootTask) {
        return engineError('E_NOT_FOUND', `Root task '${scope.rootTaskId}' not found`);
      }
    }

    // Guard: reject if an active session already exists (no silent auto-end)
    const existingActive = await accessor.getActiveSession();
    if (existingActive) {
      return engineError(
        'E_SESSION_CONFLICT',
        `An active session already exists (${existingActive.id}). End it first with 'cleo session end'.`,
        {
          fix: "Run 'cleo session end' before starting a new session.",
          details: { activeSessionId: existingActive.id },
        },
      );
    }

    const now = new Date().toISOString();
    const sessionId = generateSessionId();

    // T4959: Chain linking — find most recent ended session for same scope
    let previousSessionId: string | null = null;
    {
      const sessions = await accessor.loadSessions();
      const sameScope = sessions
        .filter(
          (s: Session) =>
            s.status === 'ended' &&
            s.endedAt &&
            s.scope?.type === scope.type &&
            (scope.type === 'global' || s.scope?.rootTaskId === scope.rootTaskId),
        )
        .sort(
          (a: Session, b: Session) =>
            new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime(),
        );
      if (sameScope.length > 0) {
        previousSessionId = sameScope[0].id;
      }
    }

    const agentIdentifier =
      ((params as Record<string, unknown>).agentIdentifier as string | undefined) ??
      process.env['CLEO_AGENT_ID'] ??
      null;

    const rootTaskId = scope.type !== 'global' ? scope.rootTaskId : undefined;
    const startingTaskId = params.startTask ?? (params.autoStart && rootTaskId ? rootTaskId : null);

    const newSession: Session = {
      id: sessionId,
      status: 'active',
      name: params.name ?? `session-${sessionId}`,
      scope:
        scope.type === 'global'
          ? { type: 'global' }
          : { type: scope.type, rootTaskId: scope.rootTaskId!, includeDescendants: true },
      taskWork: {
        taskId: startingTaskId,
        setAt: now,
      },
      startedAt: now,
      resumeCount: 0,
      ...(params.grade ? { gradeMode: true } : {}),
      stats: {
        tasksCompleted: 0,
        tasksCreated: 0,
        tasksUpdated: 0,
        focusChanges: 0,
        totalActiveMinutes: 0,
        suspendCount: 0,
      },
    };

    // Update focus state via metadata
    const existingFocus = (await accessor.getMetaValue<TaskWorkState>('focus_state')) ?? {
      currentTask: null,
      currentPhase: null,
      blockedUntil: null,
      sessionNote: null,
      sessionNotes: [],
      nextAction: null,
      primarySession: null,
    };

    if (params.startTask) {
      existingFocus.currentTask = params.startTask;
    } else if (params.autoStart && rootTaskId) {
      existingFocus.currentTask = rootTaskId;
    }

    await accessor.setMetaValue('focus_state', existingFocus);

    // Update file meta
    const currentMeta = (await accessor.getMetaValue<Record<string, unknown>>('file_meta')) ?? {};
    currentMeta.lastSessionId = sessionId;
    currentMeta.generation = ((currentMeta.generation as number) || 0) + 1;
    await accessor.setMetaValue('file_meta', currentMeta);

    // T4959: Set chain fields on new session
    if (previousSessionId) {
      newSession.previousSessionId = previousSessionId;
    }
    if (agentIdentifier) {
      newSession.agentIdentifier = agentIdentifier;
    }

    // Insert new session FIRST — FK constraints require the target row to exist
    // before predecessor.nextSessionId can reference it.
    await accessor.upsertSingleSession(newSession);

    // Now update predecessor's nextSessionId
    if (previousSessionId) {
      const sessions = await accessor.loadSessions();
      const pred = sessions.find((s: Session) => s.id === previousSessionId);
      if (pred) {
        pred.nextSessionId = sessionId;
        await accessor.upsertSingleSession(pred);
      }
    }

    // Enable grade mode
    if (params.grade) {
      process.env['CLEO_SESSION_GRADE'] = 'true';
      process.env['CLEO_SESSION_ID'] = sessionId;
      process.env['CLEO_SESSION_GRADE_ID'] = sessionId;
    }

    // T4959: Auto-briefing — enrich response with briefing + predecessor debrief
    let briefing: SessionBriefing | null = null;
    let previousDebrief: DebriefData | null = null;
    try {
      briefing = await computeBriefing(projectRoot, { scope: params.scope });
    } catch {
      // Best-effort — briefing failure should not fail session start
    }

    // Load predecessor debrief/handoff and mark consumed
    let previousHandoff: HandoffData | null = null;
    if (previousSessionId) {
      try {
        const sessions2 = await accessor.loadSessions();
        const pred = sessions2.find((s: Session) => s.id === previousSessionId);
        if (pred) {
          if (pred.debriefJson) {
            previousDebrief = JSON.parse(pred.debriefJson as string) as DebriefData;
          } else if (pred.handoffJson) {
            previousHandoff = JSON.parse(pred.handoffJson) as HandoffData;
          }
          pred.handoffConsumedAt = new Date().toISOString();
          pred.handoffConsumedBy = sessionId;
          await accessor.upsertSingleSession(pred);
        }
      } catch {
        // Best-effort
      }
    }

    const enrichedSession = {
      ...newSession,
      ...(briefing && { briefing }),
      ...(previousDebrief && { previousDebrief }),
      ...(previousHandoff && { previousHandoff }),
    };

    // T1263: Append session_start journal entry (best-effort, fire-and-forget)
    appendSessionJournalEntry(projectRoot, {
      schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      sessionId,
      eventType: 'session_start',
      agentIdentifier: agentIdentifier ?? undefined,
      scope: params.scope,
    }).catch(() => {
      /* Journal write is best-effort — never block session start */
    });

    return engineSuccess(enrichedSession as Session);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * End the current session.
 *
 * Clears focus state, updates session status, optionally builds a
 * summarization prompt, and appends a session_end journal entry.
 *
 * @param projectRoot - Absolute path to the project root
 * @param notes - Optional notes to record
 * @param params - Optional session summary input
 * @returns EngineResult with sessionId, ended flag, and optional memoryPrompt
 *
 * @task T1573
 */
export async function sessionEnd(
  projectRoot: string,
  notes?: string,
  params?: { sessionSummary?: SessionSummaryInput },
): Promise<EngineResult<{ sessionId: string; ended: boolean; memoryPrompt?: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const activeSession = await accessor.getActiveSession();

    const sessionId = activeSession?.id;
    if (!sessionId) {
      return engineError('E_SESSION_NOT_FOUND', 'No active session to end', {
        fix: 'Start a session first with: session start --scope <scope> --name <name>',
      });
    }
    const now = new Date().toISOString();

    // Clear focus
    const focusEnd = await accessor.getMetaValue<TaskWorkState>('focus_state');
    if (focusEnd) {
      focusEnd.currentTask = null;
      if (notes) {
        if (!focusEnd.sessionNotes) focusEnd.sessionNotes = [];
        focusEnd.sessionNotes.push({ timestamp: now, note: notes });
      }
      await accessor.setMetaValue('focus_state', focusEnd);
    }

    // Bump file_meta generation
    const fileMetaEnd = await accessor.getMetaValue<Record<string, unknown>>('file_meta');
    if (fileMetaEnd) {
      fileMetaEnd.generation = ((fileMetaEnd.generation as number) || 0) + 1;
      await accessor.setMetaValue('file_meta', fileMetaEnd);
    }

    // Update session record — status is the source of truth
    if (sessionId !== 'default') {
      activeSession.status = 'ended';
      activeSession.endedAt = now;
      await accessor.upsertSingleSession(activeSession);
    }

    // T140: Build summarization prompt and ingest structured summary if provided
    let memoryPrompt: string | undefined;
    try {
      const { loadConfig } = await import('../config.js');
      const config = await loadConfig(projectRoot);
      if (config.brain?.summarization?.enabled) {
        const sessions = await accessor.loadSessions();
        const endedSession = sessions.find((s: Session) => s.id === sessionId);
        if (endedSession?.debriefJson) {
          try {
            const debrief = JSON.parse(endedSession.debriefJson as string);
            const { buildSummarizationPrompt } = await import('../memory/session-memory.js');
            const prompt = buildSummarizationPrompt(sessionId, debrief);
            if (prompt) memoryPrompt = prompt;
          } catch {
            // Best-effort
          }
        }
      }

      if (params?.sessionSummary) {
        const { ingestStructuredSummary } = await import('../memory/session-memory.js');
        await ingestStructuredSummary(projectRoot, sessionId, params.sessionSummary);
      }
    } catch {
      // Summarization must never block session end
    }

    // T1263: Append session_end journal entry (best-effort)
    try {
      let doctorSummary:
        | {
            isClean: boolean;
            findingsCount: number;
            patterns: string[];
            totalScanned: number;
          }
        | undefined;
      try {
        const { scanBrainNoise } = await import('../memory/brain-doctor.js');
        const scanResult = await scanBrainNoise(projectRoot);
        doctorSummary = {
          isClean: scanResult.isClean,
          findingsCount: scanResult.findings.length,
          patterns: scanResult.findings.map((f) => f.pattern),
          totalScanned: scanResult.totalScanned,
        };
      } catch {
        // brain scan is best-effort
      }

      const agentIdentifier =
        process.env['CLEO_AGENT_ID'] ?? process.env['CLAUDE_CODE_AGENT_ID'] ?? undefined;
      const duration = Math.floor(
        (Date.now() - new Date(activeSession.startedAt).getTime()) / 1000,
      );

      await appendSessionJournalEntry(projectRoot, {
        schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        sessionId,
        eventType: 'session_end',
        agentIdentifier,
        providerId: activeSession.providerId ?? undefined,
        duration,
        tasksCompleted: activeSession.tasksCompleted ?? [],
        ...(doctorSummary !== undefined ? { doctorSummary } : {}),
      });
    } catch {
      // Journal write is best-effort — never block session end
    }

    return engineSuccess({
      sessionId,
      ended: true,
      ...(memoryPrompt && { memoryPrompt }),
    });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Resume an ended or suspended session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to resume
 * @returns EngineResult with the resumed Session
 *
 * @task T1573
 */
export async function sessionResume(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const session = sessions.find((s: Session) => s.id === sessionId);

    if (!session) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    if (session.status === 'active') {
      return engineSuccess(session);
    }

    if ((session.status as string) === 'archived') {
      return engineError(
        'E_INVALID_INPUT',
        `Session '${sessionId}' is archived and cannot be resumed`,
      );
    }

    session.status = 'active';
    session.endedAt = undefined;
    session.resumeCount = (session.resumeCount || 0) + 1;

    // Bump file_meta generation
    const resumeMeta = (await accessor.getMetaValue<Record<string, unknown>>('file_meta')) ?? {};
    resumeMeta.generation = ((resumeMeta.generation as number) || 0) + 1;
    await accessor.setMetaValue('file_meta', resumeMeta);

    // Restore focus from session task work
    if (session.taskWork?.taskId) {
      const resumeFocus = await accessor.getMetaValue<TaskWorkState>('focus_state');
      if (resumeFocus) {
        resumeFocus.currentTask = session.taskWork.taskId;
        await accessor.setMetaValue('focus_state', resumeFocus);
      }
    }

    await accessor.upsertSingleSession(session);

    // Wave 3B: Enrich resumed session with brain memory context (best-effort)
    let memoryContext:
      | Awaited<ReturnType<typeof import('../memory/session-memory.js').getSessionMemoryContext>>
      | undefined;
    try {
      const { getSessionMemoryContext } = await import('../memory/session-memory.js');
      const scopeType = session.scope?.type;
      const rootTaskId = session.scope?.rootTaskId;
      memoryContext = await getSessionMemoryContext(projectRoot, {
        type: scopeType ?? 'global',
        rootTaskId,
        epicId: rootTaskId,
      });
    } catch {
      // Best-effort -- memory context failure should not fail resume
    }

    const enrichedSession = {
      ...session,
      ...(memoryContext && { memoryContext }),
    };

    return engineSuccess(enrichedSession as Session);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Garbage collect old sessions.
 *
 * @param projectRoot - Absolute path to the project root
 * @param maxAgeDays - Maximum age in days before marking active sessions orphaned
 * @returns EngineResult with orphaned and removed session IDs
 *
 * @task T1573
 */
export async function sessionGc(
  projectRoot: string,
  maxAgeDays = 1,
): Promise<EngineResult<{ orphaned: string[]; removed: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const orphaned: string[] = [];
    const removed: string[] = [];

    // Mark stale active sessions as orphaned
    for (const session of sessions) {
      if (session.status === 'active') {
        const lastActive = new Date(session.endedAt ?? session.startedAt).getTime();
        if (now - lastActive > maxAgeMs) {
          session.status = 'ended';
          session.endedAt = new Date().toISOString();
          orphaned.push(session.id);
          await accessor.upsertSingleSession(session);
        }
      }
    }

    // Remove very old ended sessions
    for (const s of sessions) {
      if (s.status === 'active') continue;
      const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.startedAt).getTime();
      if (now - endedAt > thirtyDaysMs) {
        removed.push(s.id);
        await accessor.removeSingleSession(s.id);
      }
    }

    // T1263: Apply session journal retention policy (best-effort)
    try {
      const { rotateSessionJournals } = await import('../sessions/session-journal.js');
      await rotateSessionJournals(projectRoot);
    } catch {
      // Rotation is best-effort — never block session GC
    }

    return engineSuccess({ orphaned, removed });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Suspend an active session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to suspend
 * @param reason - Optional suspension reason
 * @returns EngineResult with the suspended Session
 *
 * @task T1573
 */
export async function sessionSuspend(
  projectRoot: string,
  sessionId: string,
  reason?: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await suspendSession(projectRoot, { sessionId, reason });
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to end session');
  }
}

/**
 * List session history with focus changes and completed tasks.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filter parameters
 * @returns EngineResult with session history entries
 *
 * @task T1573
 */
export async function sessionHistory(
  projectRoot: string,
  params?: { sessionId?: string; limit?: number },
): Promise<
  EngineResult<{
    sessions: Array<{
      id: string;
      name?: string;
      status: string;
      startedAt: string;
      endedAt?: string | null;
      tasksCompleted: number;
      focusChanges: number;
      focusHistory: Array<{ taskId: string; timestamp: string }>;
    }>;
  }>
> {
  try {
    const result = await getSessionHistory(projectRoot, params);
    return engineSuccess(result);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Remove orphaned sessions and clean up stale data.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with removed, autoEnded, and cleaned status
 *
 * @task T1573
 */
export async function sessionCleanup(
  projectRoot: string,
): Promise<EngineResult<{ removed: string[]; autoEnded: string[]; cleaned: boolean }>> {
  try {
    const result = await cleanupSessions(projectRoot);
    return engineSuccess(result);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Record a decision to the audit trail.
 *
 * When `sessionId` is omitted, resolves to the active session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Decision recording parameters
 * @returns EngineResult with the recorded DecisionRecord
 *
 * @task T1573
 */
export async function sessionRecordDecision(
  projectRoot: string,
  params: {
    sessionId?: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  },
): Promise<EngineResult<DecisionRecord>> {
  try {
    let resolvedSessionId = params.sessionId;
    if (!resolvedSessionId) {
      const accessor = await getAccessor(projectRoot);
      const activeSession = await accessor.getActiveSession();
      resolvedSessionId = activeSession?.id ?? 'default';
    }
    const result = await recordDecision(projectRoot, {
      ...params,
      sessionId: resolvedSessionId,
    });
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INVALID_INPUT', 'Failed to record decision');
  }
}

/**
 * Read the decision log, optionally filtered by sessionId and/or taskId.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filter parameters
 * @returns EngineResult with array of DecisionRecord entries
 *
 * @task T1573
 */
export async function sessionDecisionLog(
  projectRoot: string,
  params?: { sessionId?: string; taskId?: string },
): Promise<EngineResult<DecisionRecord[]>> {
  try {
    const result = await getDecisionLog(projectRoot, params ?? {});
    return engineSuccess(result);
  } catch {
    return engineSuccess([]);
  }
}

/**
 * Compute context drift score for the current session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional session filter
 * @returns EngineResult with drift score, factors, and scope counts
 *
 * @task T1573
 */
export async function sessionContextDrift(
  projectRoot: string,
  params?: { sessionId?: string },
): Promise<
  EngineResult<{
    score: number;
    factors: string[];
    completedInScope: number;
    totalInScope: number;
    outOfScope: number;
  }>
> {
  try {
    const result = await getContextDrift(projectRoot, params ?? {});
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to read decision log');
  }
}

/**
 * Record an assumption made during a session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Assumption recording parameters
 * @returns EngineResult with the recorded assumption
 *
 * @task T1573
 */
export async function sessionRecordAssumption(
  projectRoot: string,
  params: {
    sessionId?: string;
    taskId?: string;
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
  },
): Promise<
  EngineResult<{
    id: string;
    sessionId: string;
    taskId: string | null;
    assumption: string;
    confidence: string;
    timestamp: string;
  }>
> {
  try {
    const result = await recordAssumption(projectRoot, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to record assumption');
  }
}

/**
 * Compute session statistics, optionally for a specific session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Optional session ID to filter
 * @returns EngineResult with aggregate statistics
 *
 * @task T1573
 */
export async function sessionStats(
  projectRoot: string,
  sessionId?: string,
): Promise<
  EngineResult<{
    totalSessions: number;
    activeSessions: number;
    suspendedSessions: number;
    endedSessions: number;
    archivedSessions: number;
    totalTasksCompleted: number;
    totalFocusChanges: number;
    averageResumeCount: number;
    session?: {
      id: string;
      status: string;
      tasksCompleted: number;
      focusChanges: number;
      resumeCount: number;
      durationMinutes: number;
    };
  }>
> {
  try {
    const result = await getSessionStats(projectRoot, sessionId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to get session stats');
  }
}

/**
 * Switch to a different session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to switch to
 * @returns EngineResult with the switched Session
 *
 * @task T1573
 */
export async function sessionSwitch(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await switchSession(projectRoot, sessionId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_NOT_INITIALIZED', 'Failed to switch session');
  }
}

/**
 * Archive old/ended sessions.
 *
 * @param projectRoot - Absolute path to the project root
 * @param olderThan - Optional ISO date string; sessions older than this are archived
 * @returns EngineResult with archived session IDs and count
 *
 * @task T1573
 */
export async function sessionArchive(
  projectRoot: string,
  olderThan?: string,
): Promise<EngineResult<{ archived: string[]; count: number }>> {
  try {
    const result = await archiveSessions(projectRoot, olderThan);
    return engineSuccess(result);
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get handoff data for the most recent ended session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param scope - Optional scope filter
 * @returns EngineResult with handoff data or null
 *
 * @task T1573
 */
export async function sessionHandoff(
  projectRoot: string,
  scope?: { type: string; epicId?: string },
): Promise<EngineResult<{ sessionId: string; handoff: HandoffData } | null>> {
  try {
    const result = await getLastHandoff(projectRoot, scope);
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_GENERAL', 'Failed to archive sessions');
  }
}

/**
 * Compute and persist handoff data for a session.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to compute handoff for
 * @param options - Optional note and nextAction
 * @returns EngineResult with computed HandoffData
 *
 * @task T1573
 */
export async function sessionComputeHandoff(
  projectRoot: string,
  sessionId: string,
  options?: { note?: string; nextAction?: string },
): Promise<EngineResult<HandoffData>> {
  try {
    const handoff = await computeHandoff(projectRoot, {
      sessionId,
      note: options?.note,
      nextAction: options?.nextAction,
    });
    await persistHandoff(projectRoot, sessionId, handoff);
    return engineSuccess(handoff);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to get handoff');
  }
}

/**
 * Compute session briefing — composite view for session start.
 *
 * Aggregates data from handoff, current focus, next tasks, bugs, blockers, and epics.
 *
 * @param projectRoot - Absolute path to the project root
 * @param options - Optional briefing configuration
 * @returns EngineResult with SessionBriefing data
 *
 * @task T1573
 */
export async function sessionBriefing(
  projectRoot: string,
  options?: {
    maxNextTasks?: number;
    maxBugs?: number;
    maxBlocked?: number;
    maxEpics?: number;
    scope?: string;
  },
): Promise<EngineResult<SessionBriefing>> {
  try {
    const briefing = await computeBriefing(projectRoot, options);
    return engineSuccess(briefing);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to compute briefing');
  }
}

// ---------------------------------------------------------------------------
// Rich debrief + chain operations (T4959)
// ---------------------------------------------------------------------------

/**
 * Compute and persist rich debrief data for a session.
 *
 * Persists as both handoffJson (backward compat) and debriefJson (rich data).
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to compute debrief for
 * @param options - Optional note and nextAction
 * @returns EngineResult with computed DebriefData
 *
 * @epic T4959
 * @task T1573
 */
export async function sessionComputeDebrief(
  projectRoot: string,
  sessionId: string,
  options?: { note?: string; nextAction?: string },
): Promise<EngineResult<DebriefData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const session = sessions.find((s: Session) => s.id === sessionId);

    const debrief = await computeDebrief(projectRoot, {
      sessionId,
      note: options?.note,
      nextAction: options?.nextAction,
      agentIdentifier: session?.agentIdentifier ?? null,
      startedAt: session?.startedAt,
      endedAt: session?.endedAt ?? new Date().toISOString(),
    });

    // Persist both handoffJson and debriefJson
    await persistHandoff(projectRoot, sessionId, debrief.handoff);

    // Persist debriefJson via session update
    if (session) {
      session.debriefJson = JSON.stringify(debrief);
      await accessor.upsertSingleSession(session);
    }

    return engineSuccess(debrief);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to compute debrief');
  }
}

/**
 * Read a session's debrief data.
 *
 * Falls back to handoff data if no debrief is available.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Session ID to retrieve debrief for
 * @returns EngineResult with DebriefData, fallback handoff, or null
 *
 * @epic T4959
 * @task T1573
 */
export async function sessionDebriefShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<DebriefData | { handoff: unknown; fallback: true } | null>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const session = sessions.find((s: Session) => s.id === sessionId);

    if (!session) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    // Try debriefJson first
    if (session.debriefJson) {
      try {
        const debrief = JSON.parse(session.debriefJson as string) as DebriefData;
        return engineSuccess(debrief);
      } catch {
        // Fall through to handoff
      }
    }

    // Fall back to handoffJson
    if (typeof session.handoffJson === 'string') {
      try {
        const handoff = JSON.parse(session.handoffJson);
        return engineSuccess({ handoff, fallback: true });
      } catch {
        // No data available
      }
    }

    return engineSuccess(null);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to show debrief');
  }
}

/**
 * Show the session chain for a given session.
 *
 * Returns ordered list of sessions linked via previousSessionId/nextSessionId.
 *
 * @param projectRoot - Absolute path to the project root
 * @param sessionId - Anchor session ID
 * @returns EngineResult with ordered chain entries
 *
 * @epic T4959
 * @task T1573
 */
export async function sessionChainShow(
  projectRoot: string,
  sessionId: string,
): Promise<
  EngineResult<
    Array<{
      id: string;
      status: string;
      startedAt: string;
      endedAt: string | null;
      agentIdentifier: string | null;
      position: number;
    }>
  >
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const sessionMap = new Map(sessions.map((s: Session) => [s.id, s]));

    const target = sessionMap.get(sessionId);
    if (!target) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    // Walk backward to chain start
    const chain: string[] = [sessionId];
    const visited = new Set<string>([sessionId]);
    let current = target.previousSessionId;
    while (current && !visited.has(current)) {
      chain.unshift(current);
      visited.add(current);
      const s = sessionMap.get(current);
      current = s?.previousSessionId ?? undefined;
    }

    // Walk forward from target
    current = target.nextSessionId;
    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      const s = sessionMap.get(current);
      current = s?.nextSessionId ?? undefined;
    }

    const result = chain.map((id, idx) => {
      const s = sessionMap.get(id);
      return {
        id,
        status: s?.status ?? 'unknown',
        startedAt: s?.startedAt ?? '',
        endedAt: s?.endedAt ?? null,
        agentIdentifier: s?.agentIdentifier ?? null,
        position: idx + 1,
      };
    });

    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to show session chain');
  }
}

/**
 * Inject context protocol content.
 *
 * @param protocolType - The protocol type to inject
 * @param params - Optional taskId and variant
 * @param projectRoot - Optional project root
 * @returns EngineResult with injected context data
 *
 * @task T1573
 */
export function sessionContextInject(
  protocolType: string,
  params?: { taskId?: string; variant?: string },
  projectRoot?: string,
): EngineResult<ContextInjectionData> {
  try {
    const result = injectContext(protocolType, params, projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    return toEngineError(err, 'E_INTERNAL', 'Failed to inject context');
  }
}
