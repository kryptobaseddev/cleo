/**
 * SQLite-backed session store operations.
 *
 * CRUD operations for sessions and task work tracking backed by tasks.db.
 *
 * @epic T4454
 * @task W1-T4
 */

import { eq, and, desc, isNull } from 'drizzle-orm';
import { getDb, saveToFile } from './sqlite.js';
import * as schema from './schema.js';
import type { SessionRow } from './schema.js';
import type { Session, SessionScope, SessionStatus } from '../types/session.js';

// === ROW <-> DOMAIN CONVERSION ===

function rowToSession(row: SessionRow): Session {
  const taskWork = {
    taskId: row.currentTask,
    setAt: row.taskStartedAt,
  };
  return {
    id: row.id,
    name: row.name,
    status: row.status as SessionStatus,
    scope: parseJson<SessionScope>(row.scopeJson) ?? { type: 'global' },
    taskWork,
    focus: taskWork,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    agent: row.agent,
    notes: parseJson<string[]>(row.notesJson),
    tasksCompleted: parseJson<string[]>(row.tasksCompletedJson),
    tasksCreated: parseJson<string[]>(row.tasksCreatedJson),
  };
}

function parseJson<T>(jsonStr: string | null | undefined): T | undefined {
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr) as T;
    if (Array.isArray(parsed) && parsed.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// === CRUD OPERATIONS ===

/** Create a new session. */
export async function createSession(session: Session, cwd?: string): Promise<Session> {
  const db = await getDb(cwd);
  const tw = session.taskWork ?? session.focus;
  db.insert(schema.sessions).values({
    id: session.id,
    name: session.name,
    status: session.status,
    scopeJson: JSON.stringify(session.scope),
    currentTask: tw?.taskId,
    taskStartedAt: tw?.setAt,
    agent: session.agent,
    notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
    tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
    tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  }).run();

  saveToFile();
  return session;
}

/** Get a session by ID. */
export async function getSession(sessionId: string, cwd?: string): Promise<Session | null> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .all();

  if (rows.length === 0) return null;
  return rowToSession(rows[0]!);
}

/** Update a session. */
export async function updateSession(
  sessionId: string,
  updates: Partial<Session>,
  cwd?: string,
): Promise<Session | null> {
  const db = await getDb(cwd);
  const existing = await getSession(sessionId, cwd);
  if (!existing) return null;

  const updateRow: Record<string, unknown> = {};

  if (updates.name !== undefined) updateRow.name = updates.name;
  if (updates.status !== undefined) updateRow.status = updates.status;
  if (updates.scope !== undefined) updateRow.scopeJson = JSON.stringify(updates.scope);
  if (updates.endedAt !== undefined) updateRow.endedAt = updates.endedAt;
  if (updates.agent !== undefined) updateRow.agent = updates.agent;
  if (updates.notes !== undefined) updateRow.notesJson = JSON.stringify(updates.notes);
  if (updates.tasksCompleted !== undefined) updateRow.tasksCompletedJson = JSON.stringify(updates.tasksCompleted);
  if (updates.tasksCreated !== undefined) updateRow.tasksCreatedJson = JSON.stringify(updates.tasksCreated);

  db.update(schema.sessions).set(updateRow).where(eq(schema.sessions.id, sessionId)).run();
  saveToFile();

  return getSession(sessionId, cwd);
}

/** List sessions with optional filters. */
export async function listSessions(
  filters?: {
    active?: boolean;
    limit?: number;
  },
  cwd?: string,
): Promise<Session[]> {
  const db = await getDb(cwd);

  const conditions = [];
  if (filters?.active) {
    conditions.push(eq(schema.sessions.status, 'active'));
  }

  const query = db.select().from(schema.sessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.sessions.startedAt));

  const rows = filters?.limit ? query.limit(filters.limit).all() : query.all();
  return rows.map(rowToSession);
}

/** End a session. */
export async function endSession(
  sessionId: string,
  note?: string,
  cwd?: string,
): Promise<Session | null> {
  const session = await getSession(sessionId, cwd);
  if (!session) return null;

  const updates: Partial<Session> = {
    status: 'ended',
    endedAt: new Date().toISOString(),
  };

  if (note) {
    const notes = session.notes ?? [];
    notes.push(note);
    updates.notes = notes;
  }

  return updateSession(sessionId, updates, cwd);
}

// === TASK WORK OPERATIONS ===

/** Start working on a task within a session. */
export async function startTask(
  sessionId: string,
  taskId: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();

  // Clear previous work history entry (set clearedAt)
  db.update(schema.taskWorkHistory)
    .set({ clearedAt: now })
    .where(and(
      eq(schema.taskWorkHistory.sessionId, sessionId),
      isNull(schema.taskWorkHistory.clearedAt),
    ))
    .run();

  // Record new task work in history
  db.insert(schema.taskWorkHistory)
    .values({ sessionId, taskId, setAt: now })
    .run();

  // Update session's current task
  db.update(schema.sessions)
    .set({ currentTask: taskId, taskStartedAt: now })
    .where(eq(schema.sessions.id, sessionId))
    .run();

  saveToFile();
}

/** Get current task for a session. */
export async function getCurrentTask(
  sessionId: string,
  cwd?: string,
): Promise<{ taskId: string | null; since: string | null }> {
  const db = await getDb(cwd);
  const rows = db.select({
    currentTask: schema.sessions.currentTask,
    taskStartedAt: schema.sessions.taskStartedAt,
  }).from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .all();

  if (rows.length === 0) return { taskId: null, since: null };
  return { taskId: rows[0]!.currentTask, since: rows[0]!.taskStartedAt };
}

/** Stop working on the current task for a session. */
export async function stopTask(sessionId: string, cwd?: string): Promise<void> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();

  // Close current work history entry
  db.update(schema.taskWorkHistory)
    .set({ clearedAt: now })
    .where(and(
      eq(schema.taskWorkHistory.sessionId, sessionId),
      isNull(schema.taskWorkHistory.clearedAt),
    ))
    .run();

  // Clear session's current task
  db.update(schema.sessions)
    .set({ currentTask: null, taskStartedAt: null })
    .where(eq(schema.sessions.id, sessionId))
    .run();

  saveToFile();
}

/** Get work history for a session. */
export async function workHistory(
  sessionId: string,
  limit: number = 50,
  cwd?: string,
): Promise<Array<{ taskId: string; setAt: string; clearedAt: string | null }>> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.taskWorkHistory)
    .where(eq(schema.taskWorkHistory.sessionId, sessionId))
    .orderBy(desc(schema.taskWorkHistory.setAt))
    .limit(limit)
    .all();

  return rows.map(r => ({
    taskId: r.taskId,
    setAt: r.setAt,
    clearedAt: r.clearedAt,
  }));
}

// === SESSION LIFECYCLE ===

/** Garbage collect old sessions (mark ended sessions as orphaned after threshold). */
export async function gcSessions(
  maxAgeDays: number = 30,
  cwd?: string,
): Promise<number> {
  const db = await getDb(cwd);
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - maxAgeDays);

  // Count how many will be affected
  const before = db.select({ id: schema.sessions.id }).from(schema.sessions)
    .where(and(
      eq(schema.sessions.status, 'ended'),
    ))
    .all();

  const toUpdate = before;

  if (toUpdate.length > 0) {
    db.update(schema.sessions)
      .set({ status: 'orphaned' })
      .where(eq(schema.sessions.status, 'ended'))
      .run();
    saveToFile();
  }

  return toUpdate.length;
}

/** Get the currently active session (if any). */
export async function getActiveSession(cwd?: string): Promise<Session | null> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.sessions)
    .where(eq(schema.sessions.status, 'active'))
    .orderBy(desc(schema.sessions.startedAt))
    .limit(1)
    .all();

  if (rows.length === 0) return null;
  return rowToSession(rows[0]!);
}

// ---- Backward-compatible focus aliases (deprecated) ----

/** @deprecated Use startTask() instead. */
export const setFocus = startTask;

/** @deprecated Use getCurrentTask() instead. */
export const getFocus = getCurrentTask;

/** @deprecated Use stopTask() instead. */
export const clearFocus = stopTask;

/** @deprecated Use workHistory() instead. */
export const focusHistory = workHistory;
