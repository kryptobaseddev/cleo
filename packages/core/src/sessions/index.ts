/**
 * Session management operations.
 * @task T4463
 * @epic T4454
 */

import { randomBytes } from 'node:crypto';
import type { Session, SessionScope } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

// Auto-register hook handlers
import '../hooks/handlers/index.js';

/** Options for starting a session. */
export interface StartSessionOptions {
  name: string;
  scope: string; // e.g. "epic:T001" or "global"
  autoStart?: boolean;
  startTask?: string;
  focus?: string;
  agent?: string;
  /** Enable full query+mutation audit logging for this session (behavioral grading). */
  grade?: boolean;
  /** Provider adapter ID active for this session (T5240). */
  providerId?: string;
}

/** Options for ending a session. */
export interface EndSessionOptions {
  sessionId?: string;
  note?: string;
}

/** Options for listing sessions. */
export interface ListSessionsOptions {
  status?: string;
  limit?: number;
}

/**
 * Parse a scope string into a SessionScope.
 * @task T4463
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
 * @task T4463
 */
export async function readSessions(cwd?: string, accessor?: DataAccessor): Promise<Session[]> {
  const acc = accessor ?? (await getAccessor(cwd));
  return acc.loadSessions();
}

/**
 * Save sessions via accessor or JSON file.
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
 * @task T4463
 */
export async function startSession(
  options: StartSessionOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Session> {
  const scope = parseScope(options.scope);
  const sessions = await readSessions(cwd, accessor);

  // Check for conflicting active sessions
  const activeSessions = sessions.filter((s: Session) => s.status === 'active');
  for (const active of activeSessions) {
    if (active.scope.type === scope.type && active.scope.epicId === scope.epicId) {
      throw new CleoError(
        ExitCode.SCOPE_CONFLICT,
        `Active session already exists for scope ${options.scope}: ${active.id}`,
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
    name: options.name,
    status: 'active',
    scope,
    taskWork: {
      taskId: options.startTask ?? null,
      setAt: options.startTask ? new Date().toISOString() : null,
    },
    startedAt: new Date().toISOString(),
    agent: options.agent ?? undefined,
    notes: [],
    tasksCompleted: [],
    tasksCreated: [],
    providerId: options.providerId ?? detectedProviderId ?? null,
  };

  // If grade mode enabled, mark session and set env vars for audit middleware
  if (options.grade) {
    session.notes = ['[grade-mode:enabled]', ...(session.notes ?? [])];
    process.env.CLEO_SESSION_GRADE = 'true';
    process.env.CLEO_SESSION_ID = session.id;
    process.env.CLEO_SESSION_GRADE_ID = session.id;
  }

  sessions.push(session);
  const acc = accessor ?? (await getAccessor(cwd));
  await acc.upsertSingleSession(session);

  // Best-effort adapter activation based on detected provider (T5240)
  if (session.providerId) {
    import('../adapters/index.js')
      .then(({ AdapterManager }) => {
        const mgr = AdapterManager.getInstance(cwd ?? process.cwd());
        mgr.discover();
        return mgr.activate(session.providerId!);
      })
      .catch(() => {
        /* Adapter activation is best-effort */
      });
  }

  // Dispatch onSessionStart hook (best-effort, don't await)
  const { hooks } = await import('../hooks/registry.js');
  hooks
    .dispatch('onSessionStart', cwd ?? process.cwd(), {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      name: options.name,
      scope,
      agent: options.agent,
      providerId: session.providerId ?? undefined,
    })
    .catch(() => {
      /* Hooks are best-effort */
    });

  return session;
}

/**
 * End a session.
 * @task T4463
 */
export async function endSession(
  options: EndSessionOptions = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Session> {
  const sessions = await readSessions(cwd, accessor);

  let session: Session | undefined;

  if (options.sessionId) {
    session = sessions.find((s: Session) => s.id === options.sessionId);
  } else {
    // Find most recent active session
    session = sessions
      .filter((s: Session) => s.status === 'active')
      .sort(
        (a: Session, b: Session) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )[0];
  }

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      options.sessionId ? `Session not found: ${options.sessionId}` : 'No active session found',
      { fix: "Use 'cleo session list' to see available sessions" },
    );
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

  // Dispatch onSessionEnd hook (best-effort, don't await)
  const { hooks } = await import('../hooks/registry.js');
  hooks
    .dispatch('onSessionEnd', cwd ?? process.cwd(), {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      duration,
      tasksCompleted: session.tasksCompleted || [],
      providerId: session.providerId ?? undefined,
    })
    .catch(() => {
      /* Hooks are best-effort */
    });

  // Bridge session data to brain.db as an observation (best-effort)
  const { bridgeSessionToMemory } = await import('./session-memory-bridge.js');
  bridgeSessionToMemory(cwd ?? process.cwd(), {
    sessionId: session.id,
    scope: options.sessionId
      ? session.scope.type
      : session.scope.epicId
        ? `epic:${session.scope.epicId}`
        : session.scope.type,
    tasksCompleted: session.tasksCompleted || [],
    duration,
  }).catch(() => {
    /* Memory bridge is best-effort */
  });

  // NOTE: Memory bridge refresh is now handled by the onSessionEnd hook
  // via memory-bridge-refresh.ts (T138). No direct call needed here.

  // NOTE: Do NOT clear grade mode env vars here — gradeSession() needs them
  // to query audit entries after the session ends. The caller (admin.grade handler
  // or sessionEnd engine) is responsible for cleanup after evaluation completes.

  if (options.note) {
    if (!session.notes) session.notes = [];
    session.notes.push(options.note);
  }

  const acc = accessor ?? (await getAccessor(cwd));
  await acc.upsertSingleSession(session);

  return session;
}

/**
 * Get current session status.
 * @task T4463
 */
export async function sessionStatus(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Session | null> {
  const sessions = await readSessions(cwd, accessor);

  const active = sessions
    .filter((s: Session) => s.status === 'active')
    .sort(
      (a: Session, b: Session) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];

  return active ?? null;
}

/**
 * Resume an existing session.
 * @task T4463
 */
export async function resumeSession(
  sessionId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Session> {
  const sessions = await readSessions(cwd, accessor);

  const session = sessions.find((s: Session) => s.id === sessionId);
  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`, {
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

    const acc = accessor ?? (await getAccessor(cwd));
    await acc.upsertSingleSession(session);
  }

  return session;
}

/**
 * List sessions with optional filtering.
 * @task T4463
 */
export async function listSessions(
  options: ListSessionsOptions = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Session[]> {
  let sessions = await readSessions(cwd, accessor);

  if (options.status) {
    sessions = sessions.filter((s: Session) => s.status === options.status);
  }

  // Sort by start time, most recent first
  sessions.sort(
    (a: Session, b: Session) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  if (options.limit) {
    sessions = sessions.slice(0, options.limit);
  }

  return sessions;
}

/**
 * Garbage collect old sessions.
 * Marks orphaned sessions that have been active too long.
 * @task T4463
 */
export async function gcSessions(
  maxAgeHours: number = 24,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ orphaned: string[]; removed: string[] }> {
  let sessions = await readSessions(cwd, accessor);
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

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

  const acc = accessor ?? (await getAccessor(cwd));

  // Upsert orphaned sessions individually
  for (const session of sessions) {
    if (orphaned.includes(session.id)) {
      await acc.upsertSingleSession(session);
    }
  }

  // Remove old sessions individually
  for (const id of removed) {
    await acc.removeSingleSession(id);
  }

  return { orphaned, removed };
}

export type { Session as SessionRecord } from '@cleocode/contracts';
export type { RecordAssumptionParams } from './assumptions.js';
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
export type { DecisionLogParams, RecordDecisionParams } from './decisions.js';
export { getDecisionLog, recordDecision } from './decisions.js';
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
} from './handoff.js';
export { archiveSessions } from './session-archive.js';
export { cleanupSessions } from './session-cleanup.js';
export type { ContextDriftResult } from './session-drift.js';
export { getContextDrift } from './session-drift.js';
export type { SessionHistoryEntry, SessionHistoryParams } from './session-history.js';
export { getSessionHistory } from './session-history.js';
export type { SessionBridgeData } from './session-memory-bridge.js';
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
