/**
 * SQLite-backed session store operations.
 *
 * CRUD operations for sessions and task work tracking backed by cleo.db.
 * Every entry captures project ownership before awaiting; global mirrors and
 * detached producers retain their independent lifecycle contracts.
 *
 * @epic T4454
 * @task W1-T4
 * @task T1609 insertHandoffEntry — write-once INSERT path for handoff data
 */

import type { Session } from '@cleocode/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { captureProjectScope, getProjectRoot, worktreeScope } from '../project-scope.js';
import { getCurrentConnectionSessionId } from '../sessions/connection-session-handle.js';
import { resolveSessionIdFromEnv } from '../sessions/session-id.js';
import { resolveTerminalKeys, type TerminalKey } from '../sessions/terminal-identity.js';
import { rowToSession } from './converters.js';
import { sessionTerminalBindings } from './session-binding-schema.js';
import { getDb } from './sqlite.js';
import * as schema from './tasks-schema.js';

// === CRUD OPERATIONS ===

/** Create a new session. */
export async function createSession(session: Session, cwd?: string): Promise<Session> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const tw = session.taskWork;
    db.insert(schema.sessions)
      .values({
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
        // Fork-tree parent edge (T11639) — sourced from CLEO_PARENT_SESSION_ID at start.
        parentSessionId: session.parentSessionId ?? null,
      })
      .run();

    return session;
  });
}

/** Get a session by ID. */
export async function getSession(sessionId: string, cwd?: string): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .all();

    if (rows.length === 0) return null;
    return rowToSession(rows[0]!);
  });
}

/** Update a session. */
export async function updateSession(
  sessionId: string,
  updates: Partial<Session>,
  cwd?: string,
): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const existing = await getSession(sessionId, scope.worktreeRoot);
    if (!existing) return null;

    const updateRow: Record<string, unknown> = {};

    if (updates.name !== undefined) updateRow.name = updates.name;
    if (updates.status !== undefined) updateRow.status = updates.status;
    if (updates.scope !== undefined) updateRow.scopeJson = JSON.stringify(updates.scope);
    if (updates.endedAt !== undefined) updateRow.endedAt = updates.endedAt;
    if (updates.agent !== undefined) updateRow.agent = updates.agent;
    if (updates.notes !== undefined) updateRow.notesJson = JSON.stringify(updates.notes);
    if (updates.tasksCompleted !== undefined)
      updateRow.tasksCompletedJson = JSON.stringify(updates.tasksCompleted);
    if (updates.tasksCreated !== undefined)
      updateRow.tasksCreatedJson = JSON.stringify(updates.tasksCreated);
    // Session chain fields (T4959)
    if (updates.previousSessionId !== undefined)
      updateRow.previousSessionId = updates.previousSessionId;
    if (updates.nextSessionId !== undefined) updateRow.nextSessionId = updates.nextSessionId;
    // Fork-tree parent edge (T11639)
    if (updates.parentSessionId !== undefined) updateRow.parentSessionId = updates.parentSessionId;
    if (updates.agentIdentifier !== undefined) updateRow.agentIdentifier = updates.agentIdentifier;
    if (updates.handoffConsumedAt !== undefined)
      updateRow.handoffConsumedAt = updates.handoffConsumedAt;
    if (updates.handoffConsumedBy !== undefined)
      updateRow.handoffConsumedBy = updates.handoffConsumedBy;
    if (updates.debriefJson !== undefined) updateRow.debriefJson = updates.debriefJson;
    if (updates.handoffJson !== undefined) updateRow.handoffJson = updates.handoffJson;

    db.update(schema.sessions).set(updateRow).where(eq(schema.sessions.id, sessionId)).run();

    return getSession(sessionId, scope.worktreeRoot);
  });
}

/**
 * Insert a handoff entry for a session (write-once, append-only).
 *
 * The underlying `session_handoff_entries` table enforces:
 *   - UNIQUE on `session_id` — only one handoff per session.
 *   - BEFORE UPDATE trigger — rows are immutable after insertion.
 *   - AFTER INSERT trigger — mirrors value to `sessions.handoff_json`
 *     so existing read paths continue to work without change.
 *
 * Throws a SQLite `SQLITE_CONSTRAINT_UNIQUE` error (message contains
 * "UNIQUE constraint failed") if a handoff already exists for this session.
 * Callers should catch and surface as `E_HANDOFF_ALREADY_PERSISTED`.
 *
 * @param sessionId - The session that is being handed off.
 * @param handoffJson - Serialised HandoffData or DebriefData JSON string.
 * @param cwd - Optional working directory (resolves tasks.db location).
 * @task T1609
 */
export async function insertHandoffEntry(
  sessionId: string,
  handoffJson: string,
  cwd?: string,
): Promise<void> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    db.insert(schema.sessionHandoffEntries).values({ sessionId, handoffJson }).run();
  });
}

/** List sessions with optional filters. */
export async function listSessions(
  filters?: {
    active?: boolean;
    limit?: number;
  },
  cwd?: string,
): Promise<Session[]> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);

    const conditions = [];
    if (filters?.active) {
      conditions.push(eq(schema.sessions.status, 'active'));
    }

    const query = db
      .select()
      .from(schema.sessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.sessions.startedAt));

    const rows = filters?.limit ? await query.limit(filters.limit).all() : await query.all();
    return rows.map(rowToSession);
  });
}

/** End a session. */
export async function endSession(
  sessionId: string,
  note?: string,
  cwd?: string,
): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const session = await getSession(sessionId, scope.worktreeRoot);
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

    return updateSession(sessionId, updates, scope.worktreeRoot);
  });
}

// === TASK WORK OPERATIONS ===

/** Start working on a task within a session. */
export async function startTask(sessionId: string, taskId: string, cwd?: string): Promise<void> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const now = new Date().toISOString();

    // Clear previous work history entry (set clearedAt)
    db.update(schema.taskWorkHistory)
      .set({ clearedAt: now })
      .where(
        and(
          eq(schema.taskWorkHistory.sessionId, sessionId),
          isNull(schema.taskWorkHistory.clearedAt),
        ),
      )
      .run();

    // Record new task work in history
    db.insert(schema.taskWorkHistory).values({ sessionId, taskId, setAt: now }).run();

    // Update session's current task
    db.update(schema.sessions)
      .set({ currentTask: taskId, taskStartedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  });
}

/** Get current task for a session. */
export async function getCurrentTask(
  sessionId: string,
  cwd?: string,
): Promise<{ taskId: string | null; since: string | null }> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const rows = await db
      .select({
        currentTask: schema.sessions.currentTask,
        taskStartedAt: schema.sessions.taskStartedAt,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .all();

    if (rows.length === 0) return { taskId: null, since: null };
    return { taskId: rows[0]!.currentTask, since: rows[0]!.taskStartedAt };
  });
}

/** Stop working on the current task for a session. */
export async function stopTask(sessionId: string, cwd?: string): Promise<void> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const now = new Date().toISOString();

    // Close current work history entry
    db.update(schema.taskWorkHistory)
      .set({ clearedAt: now })
      .where(
        and(
          eq(schema.taskWorkHistory.sessionId, sessionId),
          isNull(schema.taskWorkHistory.clearedAt),
        ),
      )
      .run();

    // Clear session's current task
    db.update(schema.sessions)
      .set({ currentTask: null, taskStartedAt: null })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  });
}

/** Get work history for a session. */
export async function workHistory(
  sessionId: string,
  limit: number = 50,
  cwd?: string,
): Promise<Array<{ taskId: string; setAt: string; clearedAt: string | null }>> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const rows = await db
      .select()
      .from(schema.taskWorkHistory)
      .where(eq(schema.taskWorkHistory.sessionId, sessionId))
      .orderBy(desc(schema.taskWorkHistory.setAt), desc(schema.taskWorkHistory.id))
      .limit(limit)
      .all();

    return rows.map((r) => ({
      taskId: r.taskId,
      setAt: r.setAt,
      clearedAt: r.clearedAt,
    }));
  });
}

// === SESSION LIFECYCLE ===

/** Garbage collect old sessions (mark ended sessions as orphaned after threshold). */
export async function gcSessions(maxAgeDays: number = 30, cwd?: string): Promise<number> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - maxAgeDays);

    // Count how many will be affected
    const before = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.status, 'ended')))
      .all();

    const toUpdate = before;

    if (toUpdate.length > 0) {
      db.update(schema.sessions)
        .set({ status: 'orphaned' })
        .where(eq(schema.sessions.status, 'ended'))
        .run();
    }

    return toUpdate.length;
  });
}

/**
 * Get the currently active session — the most-recent `status='active'` row.
 *
 * @internal LEGACY single-process TTY fallback ONLY (T11640 · Epic T11638).
 *
 * This resolves "whoever wrote an active session to the DB most recently",
 * which is the WRONG identity in any multi-tenant context: under the warm
 * daemon (many concurrent connections) and under multi-agent spawn isolation
 * (many worktrees writing the same DB) it collapses every caller's identity
 * onto the last writer, causing session-bleed and memory scope-leakage.
 *
 * Identity-meaning callers — anything that means "the session of whoever is
 * calling THIS request" — MUST use {@link resolveCurrentSession} /
 * {@link resolveCurrentSessionId}, which resolve, in order:
 *   1. the daemon connection handle ({@link getCurrentConnectionSessionId}),
 *   2. the env-named session (`CLEO_SESSION_ID`, via
 *      {@link resolveSessionIdFromEnv}),
 *   3. and only THEN fall back to this most-recent-active row.
 *
 * `getActiveSession` survives as that final tier-3 fallback and for genuine
 * SCAN-meaning callers (e.g. "is there any active session at all?",
 * `gcSessions`, the data-accessor pass-throughs). The
 * `lint-no-bare-get-active-session.mjs` gate bans NEW bare callsites so the
 * identity-vs-scan split cannot silently regress — annotate a justified scan
 * callsite with a trailing `// get-active-session-allowed: <reason>`.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The most-recent active session, or `null`.
 */
export async function getActiveSession(cwd?: string): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.status, 'active'))
      .orderBy(desc(schema.sessions.startedAt))
      .limit(1)
      .all();

    if (rows.length === 0) return null;
    return rowToSession(rows[0]!);
  });
}

// === TERMINAL BINDINGS (T12499) ===

/**
 * Bind the calling terminal to a session (T12499 · epic T12497).
 *
 * Upserts one `session_terminal_bindings` row per identity key of the calling
 * terminal ({@link resolveTerminalKeys}: provider harness id, multiplexer pane,
 * terminal tab, or the ppid-chain fallback), each pointing at `sessionId`. A
 * later short-lived `cleo` call from the same terminal resolves this session
 * through {@link resolveTerminalBoundSession} before any newest-active fallback.
 *
 * Refuses to bind a session id that has no row, so a binding can never name a
 * session this project does not hold. Re-binding a key moves it to the newer
 * session (the terminal started another session).
 *
 * @param sessionId - The session the terminal just started or resumed.
 * @param cwd - Working directory for DB resolution.
 * @param keys - Identity keys to bind (defaults to the live terminal's keys).
 * @returns The keys that were bound; empty when there were none or the session
 *   row does not exist.
 * @task T12499
 */
export async function bindTerminalToSession(
  sessionId: string,
  cwd?: string,
  keys: readonly TerminalKey[] = resolveTerminalKeys(),
): Promise<TerminalKey[]> {
  if (keys.length === 0) return [];
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const session = await getSession(sessionId, scope.worktreeRoot);
    if (!session) return [];
    const db = await getDb(scope.worktreeRoot);
    const boundAt = new Date().toISOString();
    for (const key of keys) {
      db.insert(sessionTerminalBindings)
        .values({
          bindingKey: key.key,
          keySource: key.source,
          keyKind: key.kind,
          sessionId,
          boundAt,
        })
        .onConflictDoUpdate({
          target: sessionTerminalBindings.bindingKey,
          set: { keySource: key.source, keyKind: key.kind, sessionId, boundAt },
        })
        .run();
    }
    return [...keys];
  });
}

/**
 * Resolve the session bound to the calling terminal (T12499).
 *
 * Walks the terminal's identity keys in precedence order and returns the first
 * bound session whose row still exists and is `active`. A binding to an ended
 * or deleted session is ignored (the terminal has no live session), so the
 * caller falls through to its next tier.
 *
 * @param cwd - Working directory for DB resolution.
 * @param keys - Identity keys to look up (defaults to the live terminal's keys).
 * @returns The bound active session, or `null`.
 * @task T12499
 */
export async function resolveTerminalBoundSession(
  cwd?: string,
  keys: readonly TerminalKey[] = resolveTerminalKeys(),
): Promise<Session | null> {
  if (keys.length === 0) return null;
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    for (const key of keys) {
      let boundId: string | undefined;
      try {
        const rows = await db
          .select({ sessionId: sessionTerminalBindings.sessionId })
          .from(sessionTerminalBindings)
          .where(eq(sessionTerminalBindings.bindingKey, key.key))
          .limit(1)
          .all();
        boundId = rows[0]?.sessionId;
      } catch {
        // A store opened before the T12499 migration has no binding table: the
        // binding tier is advisory, so resolution continues to the next tier.
        return null;
      }
      if (!boundId) continue;
      const session = await getSession(boundId, scope.worktreeRoot);
      if (session && session.status === 'active') return session;
    }
    return null;
  });
}

/**
 * Remove every terminal binding that points at `sessionId` (T12499).
 *
 * Called when a session ends so a terminal stops resolving it.
 *
 * @param sessionId - The session whose bindings to drop.
 * @param cwd - Working directory for DB resolution.
 * @returns Number of bindings removed.
 * @task T12499
 */
export async function unbindSessionTerminals(sessionId: string, cwd?: string): Promise<number> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const result = db
      .delete(sessionTerminalBindings)
      .where(eq(sessionTerminalBindings.sessionId, sessionId))
      .run();
    return Number(result.changes);
  });
}

/**
 * Resolve the CALLER's current session (T11344/T11640 · Epics T11284, T11638).
 *
 * THE canonical identity-resolution helper. Replaces bare {@link getActiveSession}
 * for any consumer that means "the session of whoever is calling THIS request".
 * Resolution precedence (first hit wins):
 *
 * 1. **Daemon connection handle** ({@link getCurrentConnectionSessionId}) — when
 *    dispatching a request frame on a warm-daemon connection, the connection's
 *    accept-time-bound session is authoritative. A row with that id is honoured
 *    when present; when the bound id has no row yet, resolution proceeds (the
 *    connection asserted an identity that the env/active tiers may still
 *    satisfy). This is the seam that gives the multi-connection daemon a stable
 *    per-connection identity (T11640).
 * 2. **Env-named session** — `resolveSessionIdFromEnv()` (`CLEO_SESSION_ID`
 *    injected by spawn isolation, T11343); the spawned agent's OWN session.
 *    An env id with no row is rejected and resolution continues.
 * 3. **Terminal binding** — {@link resolveTerminalBoundSession}: the active
 *    session that this terminal / harness started (T12499).
 * 4. **Most-recent active row** — {@link getActiveSession}, the legacy
 *    single-process fallback (removal tracked by T12500).
 *
 * Making most-recent-active the FALLBACK rather than the default identity is
 * what dissolves multi-agent session-bleed AND memory scope-leakage: a
 * short-lived `cleo` call in agent A's worktree no longer resolves agent B's
 * session just because B wrote to the DB more recently.
 *
 * The connection-handle and env-named sessions are honoured even when their
 * status is not `active` (the caller explicitly asserted that id), so callers
 * that need an active-only guarantee should check `.status` on the result.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The resolved session, or `null` when none can be resolved.
 * @task T11344
 * @task T11640
 */
export async function resolveCurrentSession(cwd?: string): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const connId = getCurrentConnectionSessionId();
    if (connId) {
      const byConn = await getSession(connId, scope.worktreeRoot);
      if (byConn) return byConn;
      // connection named a session with no row yet — fall through to env/active.
    }
    const envId = resolveSessionIdFromEnv();
    if (envId) {
      const byEnv = await getSession(envId, scope.worktreeRoot);
      if (byEnv) return byEnv;
      // env id named a session that does not exist — fall through to the binding.
    }
    // T12499: the session this terminal started wins over the newest active row.
    const byTerminal = await resolveTerminalBoundSession(scope.worktreeRoot);
    if (byTerminal) return byTerminal;
    return getActiveSession(scope.worktreeRoot);
  });
}

/**
 * Resolve the CALLER's current session id (T11344/T11640).
 *
 * Thin id-only convenience over {@link resolveCurrentSession} sharing its
 * connection-handle → env → terminal-binding → most-recent-active precedence. Prefer this over
 * `(await getActiveSession())?.id` in identity-resolution hot paths.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The resolved session id, or `null`.
 * @task T11344
 * @task T11640
 */
export async function resolveCurrentSessionId(cwd?: string): Promise<string | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const connId = getCurrentConnectionSessionId();
    if (connId) {
      const byConn = await getSession(connId, scope.worktreeRoot);
      if (byConn) return byConn.id;
    }
    const envId = resolveSessionIdFromEnv();
    if (envId) {
      const byEnv = await getSession(envId, scope.worktreeRoot);
      if (byEnv) return byEnv.id;
    }
    // T12499: the session this terminal started wins over the newest active row.
    const byTerminal = await resolveTerminalBoundSession(scope.worktreeRoot);
    if (byTerminal) return byTerminal.id;
    const active = await getActiveSession(scope.worktreeRoot);
    return active?.id ?? null;
  });
}
