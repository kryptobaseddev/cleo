/**
 * Session management operations.
 * @task T4463
 * @epic T4454
 * @task T1450 — Contracts-driven refactor
 */

import { randomBytes } from 'node:crypto';
import type { Session, SessionScope } from '@cleocode/contracts';
import {
  ExitCode,
  type SessionEndParams,
  type SessionGcParams,
  type SessionListParams,
  type SessionResumeParams,
  type SessionStartParams,
  type SessionStatusParams,
} from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { sessionListItemNext, sessionStartNext } from '../mvi-helpers.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import type { AgentSessionHandle } from './agent-session-adapter.js';
import { closeAgentSession, openAgentSession } from './agent-session-adapter.js';

// Auto-register hook handlers
import '../hooks/handlers/index.js';

/**
 * In-process registry of open llmtxt AgentSession handles, keyed by
 * CLEO session id. `startSession` opens a handle; `endSession` closes
 * and persists the receipt. A Map (not a single slot) is used so
 * parallel sessions — a legitimate operational mode per the Worktree
 * Protocol — do not step on each other.
 *
 * Intentionally process-local: adapter state is re-created on every
 * CLI invocation because `cleo complete` / `cleo session end` run in
 * fresh processes. The llmtxt backend is file-backed, so durability
 * survives process boundaries.
 *
 * @task T947
 */
const AGENT_SESSION_HANDLES = new Map<string, AgentSessionHandle>();

/**
 * Parse a scope string into a SessionScope.
 * @task T4463
 *
 * @example
 * ```ts
 * // Global scope
 * const global = parseScope('global');
 * console.assert(global.type === 'global', 'global scope type');
 *
 * // Epic scope with task ID
 * const epic = parseScope('epic:T123');
 * console.assert(epic.type === 'epic', 'epic scope type');
 * console.assert(epic.epicId === 'T123', 'epic scope ID');
 *
 * // Invalid scope throws
 * let threw = false;
 * try { parseScope('invalid'); } catch { threw = true; }
 * console.assert(threw, 'invalid scope throws CleoError');
 * ```
 */
export function parseScope(scopeStr: string): SessionScope {
  if (scopeStr === 'global') {
    return { type: 'global' };
  }
  const match = scopeStr.match(/^epic:(T\d+)$/);
  if (match) {
    return { type: 'epic', epicId: match[1], rootTaskId: match[1] };
  }
  throw new CleoError(
    ExitCode.SCOPE_INVALID,
    `Invalid scope format: ${scopeStr}. Use 'epic:T###' or 'global'.`,
  );
}

/**
 * Generate a session ID.
 * @task T4463
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

/**
 * Read sessions from accessor or JSON file.
 * Internal helper — not exposed via dispatch contracts.
 * @task T4463
 */
export async function readSessions(cwd?: string, accessor?: DataAccessor): Promise<Session[]> {
  const acc = accessor ?? (await getAccessor(cwd));
  return acc.loadSessions();
}

/**
 * Save sessions via accessor or JSON file.
 * Internal helper — not exposed via dispatch contracts.
 * @task T4463
 */
export async function saveSessions(
  sessions: Session[],
  cwd?: string,
  accessor?: DataAccessor,
): Promise<void> {
  const acc = accessor ?? (await getAccessor(cwd));
  await acc.saveSessions(sessions);
}

/**
 * Start a new session.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function startSession(
  projectRoot: string,
  params: SessionStartParams,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const scope = parseScope(params.scope);
  const sessions = await readSessions(projectRoot, accessor);

  // Check for conflicting active sessions
  const activeSessions = sessions.filter((s: Session) => s.status === 'active');
  for (const active of activeSessions) {
    if (active.scope.type === scope.type && active.scope.epicId === scope.epicId) {
      throw new CleoError(
        ExitCode.SCOPE_CONFLICT,
        `Active session already exists for scope ${params.scope}: ${active.id}`,
        {
          fix: `Resume with 'cleo session resume ${active.id}' or end it first`,
          alternatives: [
            { action: 'Resume existing', command: `cleo session resume ${active.id}` },
            { action: 'End existing', command: `cleo session end` },
          ],
        },
      );
    }
  }

  // Auto-detect runtime provider for session tracking (T5240)
  let detectedProviderId: string | null = null;
  try {
    const { detectRuntimeProviderContext } = await import('../metrics/provider-detection.js');
    const ctx = detectRuntimeProviderContext();
    detectedProviderId = ctx.runtimeProviderId ?? null;
  } catch {
    // Provider detection is best-effort
  }

  const session: Session = {
    id: generateSessionId(),
    name: params.name ?? `session-${Date.now()}`,
    status: 'active',
    scope,
    taskWork: {
      taskId: params.startTask ?? null,
      setAt: params.startTask ? new Date().toISOString() : null,
    },
    startedAt: new Date().toISOString(),
    notes: [],
    tasksCompleted: [],
    tasksCreated: [],
  };

  // If grade mode enabled, mark session and set env vars for audit middleware
  if (params.grade) {
    session.notes = ['[grade-mode:enabled]', ...(session.notes ?? [])];
    process.env.CLEO_SESSION_GRADE = 'true';
    process.env.CLEO_SESSION_ID = session.id;
    process.env.CLEO_SESSION_GRADE_ID = session.id;
  }

  sessions.push(session);
  await accessor.upsertSingleSession(session);

  // T947 Step 2: open a corresponding llmtxt AgentSession for audit
  // receipts. Best-effort — peer-dep absence yields `null` and leaves
  // observable behaviour unchanged. The handle is cached on an
  // in-process Map so `endSession` can release it; cross-process
  // completions (e.g. `cleo complete` in a new shell) re-open a
  // transient handle via `wrapWithAgentSession` and do not rely on
  // this registry.
  try {
    const handle = await openAgentSession({
      sessionId: session.id,
      agentId: process.env.CLEO_AGENT_ID ?? 'cleo',
      projectRoot,
      label: `session:${session.name}`,
    });
    if (handle !== null) {
      AGENT_SESSION_HANDLES.set(session.id, handle);
    }
  } catch {
    /* AgentSession is best-effort; never block session start */
  }

  // Best-effort adapter activation based on detected provider (T5240)
  if (detectedProviderId) {
    import('../adapters/index.js')
      .then(({ AdapterManager }) => {
        const mgr = AdapterManager.getInstance(projectRoot);
        mgr.discover();
        return mgr.activate(detectedProviderId!);
      })
      .catch(() => {
        /* Adapter activation is best-effort */
      });
  }

  // Dispatch SessionStart hook (best-effort, don't await)
  const { hooks } = await import('../hooks/registry.js');
  hooks
    .dispatch('SessionStart', projectRoot, {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      name: params.name ?? session.name,
      scope,
      providerId: detectedProviderId ?? undefined,
    })
    .catch(() => {
      /* Hooks are best-effort */
    });

  // T1263: Append session_start journal entry (best-effort)
  import('./session-journal.js')
    .then(async ({ appendSessionJournalEntry }) => {
      const { SESSION_JOURNAL_SCHEMA_VERSION } = await import('@cleocode/contracts');
      const agentIdentifier =
        process.env.CLEO_AGENT_ID ?? process.env.CLAUDE_CODE_AGENT_ID ?? undefined;
      await appendSessionJournalEntry(projectRoot, {
        schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        eventType: 'session_start',
        agentIdentifier,
        providerId: detectedProviderId ?? undefined,
        scope: params.scope,
      });
    })
    .catch(() => {
      /* Journal write is best-effort — never block session start */
    });

  // Attach _next progressive disclosure directives
  Object.assign(session, { _next: sessionStartNext() });

  return session;
}

/**
 * End a session.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function endSession(projectRoot: string, params: SessionEndParams): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const sessions = await readSessions(projectRoot, accessor);

  let session: Session | undefined;

  // Find most recent active session (sessionId no longer supported in params)
  session = sessions
    .filter((s: Session) => s.status === 'active')
    .sort(
      (a: Session, b: Session) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];

  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, 'No active session found', {
      fix: "Use 'cleo session list' to see available sessions",
    });
  }

  if (session.status !== 'active') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session ${session.id} is already ${session.status}`,
    );
  }

  session.status = 'ended';
  session.endedAt = new Date().toISOString();

  const duration = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000);

  // Dispatch SessionEnd hook — await to ensure memory bridge refreshes before CLI exits
  const { hooks } = await import('../hooks/registry.js');
  await hooks
    .dispatch('SessionEnd', projectRoot, {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      duration,
      tasksCompleted: session.tasksCompleted || [],
    })
    .catch(() => {
      /* Hooks are best-effort */
    });

  // Bridge session data to brain.db as a 'session-summary' observation — await for CLI mode.
  // Also links the observation to all tasks completed/created via brain_task_observations.
  // T1615: enables cleo memory find queries to surface session context by task ID.
  const { bridgeSessionToMemory } = await import('./session-memory-bridge.js');
  await bridgeSessionToMemory(projectRoot, {
    sessionId: session.id,
    scope: session.scope.epicId ? `epic:${session.scope.epicId}` : session.scope.type,
    tasksCompleted: session.tasksCompleted || [],
    tasksCreated: session.tasksCreated || [],
    duration,
    note: params.note,
  }).catch(() => {
    /* Memory bridge is best-effort */
  });

  // NOTE: Do NOT clear grade mode env vars here — gradeSession() needs them
  // to query audit entries after the session ends. The caller (admin.grade handler
  // or sessionEnd engine) is responsible for cleanup after evaluation completes.

  if (params.note) {
    if (!session.notes) session.notes = [];
    session.notes.push(params.note);
  }

  await accessor.upsertSingleSession(session);

  // T947 Step 2: close the matching llmtxt AgentSession (if any) and
  // persist the ContributionReceipt to `.cleo/audit/receipts.jsonl`.
  // Best-effort — failures NEVER block CLEO session teardown.
  const agentHandle = AGENT_SESSION_HANDLES.get(session.id);
  if (agentHandle) {
    AGENT_SESSION_HANDLES.delete(session.id);
    try {
      await closeAgentSession(agentHandle);
    } catch {
      /* AgentSession teardown is best-effort */
    }
  }

  // Direct memory bridge refresh AFTER session is saved to DB
  try {
    const { refreshMemoryBridge } = await import('../memory/memory-bridge.js');
    await refreshMemoryBridge(projectRoot);
  } catch {
    // best-effort
  }

  return session;
}

/**
 * Get current session status.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function sessionStatus(
  projectRoot: string,
  _params: SessionStatusParams,
): Promise<Session | null> {
  // SessionStatusParams is `Record<string, never>` per the contract — there are
  // no fields to read. The parameter is declared to satisfy ADR-057 D1's uniform
  // `(projectRoot, params)` Core API surface; the underscore prefix is the
  // documented TypeScript convention for an intentionally-unused parameter
  // required by an API contract (TS6133 honors `_`-prefix exemption).
  const accessor = await getAccessor(projectRoot);
  const sessions = await readSessions(projectRoot, accessor);

  const active = sessions
    .filter((s: Session) => s.status === 'active')
    .sort(
      (a: Session, b: Session) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];

  return active ?? null;
}

/**
 * Resume an existing session.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function resumeSession(
  projectRoot: string,
  params: SessionResumeParams,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const sessions = await readSessions(projectRoot, accessor);

  const session = sessions.find((s: Session) => s.id === params.sessionId);
  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session not found: ${params.sessionId}`, {
      fix: "Use 'cleo session list' to see available sessions",
    });
  }

  if (session.status === 'active') {
    return session; // Already active
  }

  if (session.status === 'orphaned' || session.status === 'ended') {
    session.status = 'active';
    session.endedAt = undefined;
    if (!session.notes) session.notes = [];
    session.notes.push(`Resumed at ${new Date().toISOString()}`);

    await accessor.upsertSingleSession(session);
  }

  return session;
}

/**
 * List sessions with optional filtering.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function listSessions(
  projectRoot: string,
  params: SessionListParams,
): Promise<Session[]> {
  const accessor = await getAccessor(projectRoot);
  let sessions = await readSessions(projectRoot, accessor);

  if (params.status) {
    sessions = sessions.filter((s: Session) => s.status === params.status);
  }

  // Sort by start time, most recent first
  sessions.sort(
    (a: Session, b: Session) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  if (params.limit) {
    sessions = sessions.slice(0, params.limit);
  }

  // Attach _next progressive disclosure directives to each session
  for (const s of sessions) {
    Object.assign(s, { _next: sessionListItemNext(s.id) });
  }

  return sessions;
}

/**
 * Garbage collect old sessions.
 * Marks orphaned sessions that have been active too long.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function gcSessions(
  projectRoot: string,
  params: SessionGcParams,
): Promise<{ orphaned: string[]; removed: string[] }> {
  const accessor = await getAccessor(projectRoot);
  let sessions = await readSessions(projectRoot, accessor);
  const now = Date.now();
  const maxAgeMs = (params.maxAgeDays ?? 1) * 24 * 60 * 60 * 1000;

  const orphaned: string[] = [];
  const removed: string[] = [];

  for (const session of sessions) {
    if (session.status === 'active') {
      const age = now - new Date(session.startedAt).getTime();
      if (age > maxAgeMs) {
        session.status = 'orphaned';
        session.endedAt = new Date().toISOString();
        orphaned.push(session.id);
      }
    }
  }

  // Remove very old ended/orphaned sessions (> 30 days)
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  sessions = sessions.filter((s: Session) => {
    if (s.status === 'active') return true;
    const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.startedAt).getTime();
    if (now - endedAt > thirtyDaysMs) {
      removed.push(s.id);
      return false;
    }
    return true;
  });

  // Upsert orphaned sessions individually
  for (const session of sessions) {
    if (orphaned.includes(session.id)) {
      await accessor.upsertSingleSession(session);
    }
  }

  // Remove old sessions individually
  for (const id of removed) {
    await accessor.removeSingleSession(id);
  }

  return { orphaned, removed };
}

export type {
  AgentSessionAdapterOptions,
  AgentSessionHandle,
  WrappedResult,
} from './agent-session-adapter.js';
export {
  closeAgentSession,
  getReceiptsAuditPath,
  openAgentSession,
  wrapWithAgentSession,
} from './agent-session-adapter.js';
export { recordAssumption } from './assumptions.js';
export type {
  BriefingBlockedTask,
  BriefingBug,
  BriefingEpic,
  BriefingOptions,
  BriefingTask,
  CurrentTaskInfo,
  LastSessionInfo,
  PipelineStageInfo,
  SessionBriefing,
} from './briefing.js';
export { computeBriefing } from './briefing.js';
export { getDecisionLog, recordDecision } from './decisions.js';
export type {
  DetectSessionDriftOptions,
  DriftAuditEntry,
  DriftReport,
} from './drift-watchdog.js';
export {
  DEFAULT_PIVOT_THRESHOLD,
  DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC,
  DRIFT_WATCHDOG_INTERVAL_ENV,
  detectSessionDrift,
  GLOBAL_AUDIT_RELPATH,
  getDriftWatchdogIntervalSec,
  LOCAL_AUDIT_RELPATH,
  resolveDriftAuditPath,
} from './drift-watchdog.js';
export type { FindSessionsParams, MinimalSessionRecord } from './find.js';
export { findSessions } from './find.js';
export type {
  ComputeDebriefOptions,
  ComputeHandoffOptions,
  DebriefData,
  DebriefDecision,
  GitState,
  HandoffData,
} from './handoff.js';
export {
  computeDebrief,
  computeHandoff,
  getHandoff,
  getLastHandoff,
  persistHandoff,
  sessionHandoffShow,
} from './handoff.js';
export type { HandoffMarkdownContext } from './handoff-markdown.js';
export { emitHandoffMarkdown, renderHandoffMarkdown } from './handoff-markdown.js';
export { archiveSessions } from './session-archive.js';
export { cleanupSessions } from './session-cleanup.js';
export type { ContextDriftResult } from './session-drift.js';
export { getContextDrift } from './session-drift.js';
export type { SessionHistoryEntry, SessionHistoryParams } from './session-history.js';
export { getSessionHistory } from './session-history.js';
export type { SessionBridgeData, SessionBridgeResult } from './session-memory-bridge.js';
export { bridgeSessionToMemory } from './session-memory-bridge.js';
// Re-export extended session modules (engine-compatible)
export { showSession } from './session-show.js';
export type { SessionStatsResult } from './session-stats.js';
export { getSessionStats } from './session-stats.js';
export { suspendSession } from './session-suspend.js';
export { switchSession } from './session-switch.js';
export { SessionView } from './session-view.js';
export type {
  AssumptionRecord,
  DecisionRecord,
  TaskWorkStateExt,
} from './types.js';
