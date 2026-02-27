/**
 * Session management operations.
 * @task T4463
 * @epic T4454
 */

import { randomBytes } from 'node:crypto';
import { readJson, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session, SessionsFile, SessionScope, SessionScopeType } from '../../types/session.js';
import { getSessionsPath, getBackupDir } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

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
    return { type: 'global' as SessionScopeType };
  }
  const match = scopeStr.match(/^epic:(T\d+)$/);
  if (match) {
    return { type: 'epic' as SessionScopeType, epicId: match[1] };
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
 * Read or create sessions file.
 * @task T4463
 */
async function readSessions(cwd?: string, accessor?: DataAccessor): Promise<SessionsFile> {
  if (accessor) {
    const data = await accessor.loadSessions() as SessionsFile;
    if (data && data.sessions) return data;
    return {
      version: '1.0.0',
      sessions: [],
      _meta: {
        schemaVersion: '1.0.0',
        lastUpdated: new Date().toISOString(),
      },
    };
  }
  const sessionsPath = getSessionsPath(cwd);
  const data = await readJson<SessionsFile>(sessionsPath);
  if (data) return data;

  return {
    version: '1.0.0',
    sessions: [],
    _meta: {
      schemaVersion: '1.0.0',
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Save sessions file.
 * @task T4463
 */
async function saveSessions(data: SessionsFile, cwd?: string, accessor?: DataAccessor): Promise<void> {
  data._meta.lastUpdated = new Date().toISOString();
  if (accessor) {
    await accessor.saveSessions(data);
    return;
  }
  const sessionsPath = getSessionsPath(cwd);
  const backupDir = getBackupDir(cwd);
  await saveJson(sessionsPath, data, { backupDir });
}

/**
 * Start a new session.
 * @task T4463
 */
export async function startSession(options: StartSessionOptions, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const scope = parseScope(options.scope);
  const data = await readSessions(cwd, accessor);

  // Check for conflicting active sessions
  const activeSessions = data.sessions.filter(s => s.status === 'active');
  for (const active of activeSessions) {
    if (
      active.scope.type === scope.type &&
      active.scope.epicId === scope.epicId
    ) {
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

  const focusTaskId = options.focus ?? options.startTask ?? null;
  const session: Session = {
    id: generateSessionId(),
    name: options.name,
    status: 'active',
    scope,
    taskWork: {
      taskId: options.startTask ?? null,
      setAt: options.startTask ? new Date().toISOString() : null,
    },
    focus: {
      taskId: focusTaskId,
      setAt: focusTaskId ? new Date().toISOString() : null,
    },
    startedAt: new Date().toISOString(),
    agent: options.agent ?? null,
    notes: [],
    tasksCompleted: [],
    tasksCreated: [],
  };

  // If grade mode enabled, mark session and set env vars for audit middleware
  if (options.grade) {
    session.notes = ['[grade-mode:enabled]', ...(session.notes ?? [])];
    process.env.CLEO_SESSION_GRADE = 'true';
    process.env.CLEO_SESSION_ID = session.id;
  }

  data.sessions.push(session);
  await saveSessions(data, cwd, accessor);

  return session;
}

/**
 * End a session.
 * @task T4463
 */
export async function endSession(options: EndSessionOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const data = await readSessions(cwd, accessor);

  let session: Session | undefined;

  if (options.sessionId) {
    session = data.sessions.find(s => s.id === options.sessionId);
  } else {
    // Find most recent active session
    session = data.sessions
      .filter(s => s.status === 'active')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  }

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      options.sessionId
        ? `Session not found: ${options.sessionId}`
        : 'No active session found',
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

  // Clear grade mode env vars when session ends
  if (process.env.CLEO_SESSION_GRADE === 'true') {
    delete process.env.CLEO_SESSION_GRADE;
    delete process.env.CLEO_SESSION_ID;
  }

  if (options.note) {
    if (!session.notes) session.notes = [];
    session.notes.push(options.note);
  }

  await saveSessions(data, cwd, accessor);

  return session;
}

/**
 * Get current session status.
 * @task T4463
 */
export async function sessionStatus(cwd?: string, accessor?: DataAccessor): Promise<Session | null> {
  const data = await readSessions(cwd, accessor);

  const active = data.sessions
    .filter(s => s.status === 'active')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

  return active ?? null;
}

/**
 * Resume an existing session.
 * @task T4463
 */
export async function resumeSession(sessionId: string, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const data = await readSessions(cwd, accessor);

  const session = data.sessions.find(s => s.id === sessionId);
  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session not found: ${sessionId}`,
      { fix: "Use 'cleo session list' to see available sessions" },
    );
  }

  if (session.status === 'active') {
    return session; // Already active
  }

  if (session.status === 'orphaned' || session.status === 'ended') {
    session.status = 'active';
    session.endedAt = null;
    if (!session.notes) session.notes = [];
    session.notes.push(`Resumed at ${new Date().toISOString()}`);

    await saveSessions(data, cwd, accessor);
  }

  return session;
}

/**
 * List sessions with optional filtering.
 * @task T4463
 */
export async function listSessions(options: ListSessionsOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<Session[]> {
  const data = await readSessions(cwd, accessor);

  let sessions = data.sessions;

  if (options.status) {
    sessions = sessions.filter(s => s.status === options.status);
  }

  // Sort by start time, most recent first
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

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
export async function gcSessions(maxAgeHours: number = 24, cwd?: string, accessor?: DataAccessor): Promise<{ orphaned: string[]; removed: string[] }> {
  const data = await readSessions(cwd, accessor);
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  const orphaned: string[] = [];
  const removed: string[] = [];

  for (const session of data.sessions) {
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
  data.sessions = data.sessions.filter(s => {
    if (s.status === 'active') return true;
    const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.startedAt).getTime();
    if (now - endedAt > thirtyDaysMs) {
      removed.push(s.id);
      return false;
    }
    return true;
  });

  if (orphaned.length > 0 || removed.length > 0) {
    await saveSessions(data, cwd, accessor);
  }

  return { orphaned, removed };
}

// Re-export extended session modules (engine-compatible)
export { isMultiSession } from './multi-session.js';
export { showSession } from './session-show.js';
export { suspendSession } from './session-suspend.js';
export { getSessionHistory } from './session-history.js';
export type { SessionHistoryEntry, SessionHistoryParams } from './session-history.js';
export { cleanupSessions } from './session-cleanup.js';
export { getSessionStats } from './session-stats.js';
export type { SessionStatsResult } from './session-stats.js';
export { switchSession } from './session-switch.js';
export { archiveSessions } from './session-archive.js';
export { getContextDrift } from './session-drift.js';
export type { ContextDriftResult } from './session-drift.js';
export { recordDecision, getDecisionLog } from './decisions.js';
export type { RecordDecisionParams, DecisionLogParams } from './decisions.js';
export { recordAssumption } from './assumptions.js';
export type { RecordAssumptionParams } from './assumptions.js';
export { computeHandoff, persistHandoff, getHandoff, getLastHandoff, computeDebrief } from './handoff.js';
export type { HandoffData, ComputeHandoffOptions, DebriefData, ComputeDebriefOptions, GitState, DebriefDecision } from './handoff.js';
export { computeBriefing } from './briefing.js';
export type { SessionBriefing, BriefingOptions, BriefingTask, BriefingBug, BriefingBlockedTask, BriefingEpic, CurrentTaskInfo, CurrentFocus, LastSessionInfo, PipelineStageInfo } from './briefing.js';
export type { SessionRecord, TaskWorkStateExt, FocusState, SessionsFileExt, TaskFileExt, DecisionRecord, AssumptionRecord } from './types.js';

// =============================================================================
// CROSS-SESSION RESUME INTEGRATION
// @task T4805 - SQLite-backed resume flow integration
// =============================================================================

import { checkSessionResume, SessionResumeCheckResult } from '../lifecycle/resume.js';

/** Options for starting a session with resume check. */
export interface StartSessionWithResumeOptions extends StartSessionOptions {
  /** Whether to check for resumable pipelines on start */
  checkResume?: boolean;
  /** Whether to auto-resume if single candidate found */
  autoResume?: boolean;
  /** Minimum priority for resume candidates */
  minResumePriority?: 'critical' | 'high' | 'medium' | 'low';
}

/** Result of starting a session with resume check. */
export interface StartSessionWithResumeResult {
  /** The created/resumed session */
  session: Session;
  /** Resume check result if checkResume was enabled */
  resumeCheck?: SessionResumeCheckResult;
  /** Whether a pipeline was auto-resumed */
  autoResumed: boolean;
}

/**
 * Start a new session with optional resume check.
 *
 * This enhanced version of startSession integrates with the lifecycle
 * resume flow (T4805) to check for active pipelines and optionally
 * auto-resume work from a previous session.
 *
 * @param options - Session options with resume check configuration
 * @param cwd - Working directory
 * @param accessor - Data accessor for testing
 * @returns Promise resolving to session and resume check results
 *
 * @example
 * ```typescript
 * // Start session and check for resumable work
 * const result = await startSessionWithResume({
 *   name: 'Development Session',
 *   scope: 'epic:T4805',
 *   checkResume: true,
 *   autoResume: true
 * });
 *
 * if (result.autoResumed) {
 *   console.log(`Auto-resumed ${result.resumeCheck?.resumedTaskId}`);
 * } else if (result.resumeCheck?.requiresUserChoice) {
 *   console.log('Choose a pipeline to resume:', result.resumeCheck.options);
 * }
 * ```
 *
 * @task T4805
 * @integration Session Start Hook
 */
export async function startSessionWithResume(
  options: StartSessionWithResumeOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<StartSessionWithResumeResult> {
  // First, start the session normally
  const session = await startSession(options, cwd, accessor);

  // If resume check not enabled, return just the session
  if (!options.checkResume) {
    return { session, autoResumed: false };
  }

  // Check for resumable pipelines
  const scope = options.scope.startsWith('epic:')
    ? { type: 'epic' as const, epicId: options.scope.replace('epic:', '') }
    : { type: 'global' as const };

  const resumeCheck = await checkSessionResume(
    {
      autoResume: options.autoResume,
      scope,
      minPriority: options.minResumePriority,
      includeBlocked: true,
    },
    cwd,
  );

  return {
    session,
    resumeCheck,
    autoResumed: resumeCheck.didResume,
  };
}
