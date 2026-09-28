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
import { ExitCode } from '@cleocode/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { CleoError } from '../errors.js';
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

/** The calling terminal's identity keys split by what they identify (T12500). */
interface TerminalKeyTiers {
  /** Agent-harness process (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …). */
  readonly provider: TerminalKey | undefined;
  /** Multiplexer pane (`TMUX_PANE`, `ZELLIJ_PANE_ID`, `WEZTERM_PANE`). */
  readonly pane: TerminalKey | undefined;
  /** Terminal tab (`TERM_SESSION_ID`, `ITERM_SESSION_ID`, `WT_SESSION`, …) or the ppid fallback. */
  readonly tab: TerminalKey | undefined;
}

/**
 * Split identity keys (most specific first) into provider / pane / tab tiers.
 *
 * @param keys - Keys from {@link resolveTerminalKeys}.
 * @returns The first key of each tier.
 */
function splitTerminalKeys(keys: readonly TerminalKey[]): TerminalKeyTiers {
  return {
    provider: keys.find((k) => k.kind === 'provider'),
    pane: keys.find((k) => k.kind === 'multiplexer'),
    tab: keys.find((k) => k.kind === 'terminal' || k.kind === 'ppid'),
  };
}

/**
 * Upsert one binding row (T12499 · T12500).
 *
 * @param db - Project DB handle.
 * @param key - Identity key.
 * @param sessionId - Bound session.
 * @param boundByProvider - See `session_terminal_bindings.bound_by_provider`.
 */
function upsertBinding(
  db: Awaited<ReturnType<typeof getDb>>,
  key: TerminalKey,
  sessionId: string,
  boundByProvider: boolean,
): void {
  const boundAt = new Date().toISOString();
  db.insert(sessionTerminalBindings)
    .values({
      bindingKey: key.key,
      keySource: key.source,
      keyKind: key.kind,
      sessionId,
      boundByProvider,
      boundAt,
    })
    .onConflictDoUpdate({
      target: sessionTerminalBindings.bindingKey,
      set: { keySource: key.source, keyKind: key.kind, sessionId, boundByProvider, boundAt },
    })
    .run();
}

/**
 * Bind the calling terminal to a session (T12499 · T12500 · epic T12497).
 *
 * Keys are bound per tier ({@link resolveTerminalKeys} → provider / pane / tab):
 *
 * - the **provider** key (an agent process — `CLAUDE_CODE_SESSION_ID`, …), when present;
 * - the **pane** key (`TMUX_PANE`, …), when present;
 * - the **tab** key (`TERM_SESSION_ID`, …, or the ppid fallback) only when there
 *   is NO pane key — a pane is its own identity and never shares its tab's.
 *
 * Every row records `bound_by_provider` = "a provider key was present". That is
 * what lets an agent in a tab adopt a session a HUMAN started in that tab while
 * two agents that each started their own session stay isolated (see
 * {@link resolveTerminalBoundSession}).
 *
 * Refuses to bind a session id that has no row. Re-binding a key moves it to
 * the newer session.
 *
 * @param sessionId - The session the terminal just started, resumed or switched to.
 * @param cwd - Working directory for DB resolution.
 * @param keys - Identity keys, most specific first (defaults to the live terminal's).
 * @returns The keys that were bound.
 * @task T12499
 * @task T12500
 */
export async function bindTerminalToSession(
  sessionId: string,
  cwd?: string,
  keys: readonly TerminalKey[] = resolveTerminalKeys(),
): Promise<TerminalKey[]> {
  const { provider, pane, tab } = splitTerminalKeys(keys);
  const toBind = [provider, pane, pane ? undefined : tab].filter(
    (k): k is TerminalKey => k !== undefined,
  );
  if (toBind.length === 0) return [];
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const session = await getSession(sessionId, scope.worktreeRoot);
    if (!session) return [];
    const db = await getDb(scope.worktreeRoot);
    for (const key of toBind) upsertBinding(db, key, sessionId, provider !== undefined);
    return toBind;
  });
}

/**
 * Bind the calling terminal to a session it just started, resumed or switched
 * to (T12499 · T12500). Best-effort: a binding failure never fails the
 * lifecycle command.
 *
 * Skipped only when the process already carries an env session id that NAMES
 * AN EXISTING ROW (e.g. a spawned worker's `CLEO_SESSION_ID`): that identity
 * already governs the process, and binding would let a worker sharing its
 * harness's `CLAUDE_CODE_SESSION_ID` overwrite the orchestrator's binding. A
 * harness that exports `CLAUDE_SESSION_ID` / `AIDER_SESSION_ID` holding a
 * non-CLEO id still binds — otherwise every later mutation from it would be
 * refused with `E_SESSION_UNBOUND`.
 *
 * @param sessionId - The started / resumed / switched-to session.
 * @param cwd - Working directory for DB resolution.
 * @returns `true` when at least one binding row was written.
 * @task T12500
 */
export async function bindCallingTerminal(sessionId: string, cwd?: string): Promise<boolean> {
  try {
    const envId = resolveSessionIdFromEnv();
    if (envId !== null && (await getSession(envId, cwd)) !== null) return false;
    return (await bindTerminalToSession(sessionId, cwd)).length > 0;
  } catch {
    // Best-effort — without a binding, mutations from this terminal are
    // refused with E_SESSION_UNBOUND until it binds another way.
    return false;
  }
}

/**
 * Resolve the session bound to the calling terminal (T12499 · T12500).
 *
 * 1. **Provider key bound** → that session (the agent's own).
 * 2. Else the **pane** key, when present. A pane never falls through to its
 *    tab: a sibling pane sharing the tab id resolves nothing.
 * 3. Else the **tab** key (or ppid fallback).
 *
 * Steps 2-3 are unconditional for a caller WITHOUT a provider key (a human
 * shell: it may end a session an agent started in its tab). For a caller WITH
 * a provider key, a coarse binding is adopted only when it was written without
 * a provider key (a human-started session, `bound_by_provider = 0`) AND no
 * other provider key owns an explicit binding to that session. On adoption the
 * provider key is bound too (`bound_by_provider = 0`: adopted, not owned) so
 * later calls resolve directly. Two agents that each started their own session
 * stay isolated because their tab binding is `bound_by_provider = 1`.
 *
 * Only `active` sessions are returned; a binding to an ended session is ignored.
 *
 * @param cwd - Working directory for DB resolution.
 * @param keys - Identity keys, most specific first (defaults to the live terminal's).
 * @returns The bound active session, or `null`.
 * @task T12499
 * @task T12500
 */
export async function resolveTerminalBoundSession(
  cwd?: string,
  keys: readonly TerminalKey[] = resolveTerminalKeys(),
): Promise<Session | null> {
  const { provider, pane, tab } = splitTerminalKeys(keys);
  if (!provider && !pane && !tab) return null;
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    type BindingRow = { sessionId: string; boundByProvider: boolean };
    const lookup = async (key: TerminalKey): Promise<BindingRow | undefined> => {
      const rows = await db
        .select({
          sessionId: sessionTerminalBindings.sessionId,
          boundByProvider: sessionTerminalBindings.boundByProvider,
        })
        .from(sessionTerminalBindings)
        .where(eq(sessionTerminalBindings.bindingKey, key.key))
        .limit(1)
        .all();
      return rows[0];
    };
    const activeSession = async (id: string): Promise<Session | null> => {
      const session = await getSession(id, scope.worktreeRoot);
      return session && session.status === 'active' ? session : null;
    };
    /** Another provider key explicitly started/resumed this session. */
    const ownedByOtherProvider = async (sessionId: string, own: TerminalKey): Promise<boolean> => {
      const rows = await db
        .select({ bindingKey: sessionTerminalBindings.bindingKey })
        .from(sessionTerminalBindings)
        .where(
          and(
            eq(sessionTerminalBindings.sessionId, sessionId),
            eq(sessionTerminalBindings.keyKind, 'provider'),
            eq(sessionTerminalBindings.boundByProvider, true),
          ),
        )
        .all();
      return rows.some((r) => r.bindingKey !== own.key);
    };

    try {
      if (provider) {
        const own = await lookup(provider);
        if (own) {
          const session = await activeSession(own.sessionId);
          if (session) return session;
        }
      }
      const coarse = pane ?? tab;
      if (!coarse) return null;
      const row = await lookup(coarse);
      if (!row) return null;
      if (provider) {
        if (row.boundByProvider) return null;
        if (await ownedByOtherProvider(row.sessionId, provider)) return null;
      }
      const session = await activeSession(row.sessionId);
      if (session && provider) {
        try {
          upsertBinding(db, provider, session.id, false);
        } catch {
          // Adoption is an optimisation; resolution already succeeded.
        }
      }
      return session;
    } catch {
      // A store opened before the T12499/T12500 migrations lacks the table or
      // column: the binding tier is advisory, so resolution continues.
      return null;
    }
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
 *    single-process fallback. READ-ONLY consumers only (T12500): from an
 *    unbound terminal this is another agent's session. Mutations resolve
 *    through {@link resolveBoundSession} / {@link requireBoundSession}, and
 *    read surfaces that want to label the guess use {@link resolveSessionForRead}.
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
  return (await resolveSessionForRead(cwd)).session;
}

/**
 * Resolve the CALLER's current session id (T11344/T11640).
 *
 * Thin id-only convenience over {@link resolveCurrentSession} sharing its
 * connection-handle → env → terminal-binding → most-recent-active precedence.
 * READ-ONLY consumers only: the last tier may name another agent's session. A
 * caller that attributes or mutates must use {@link resolveBoundSessionId}.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The resolved session id, or `null`.
 * @task T11344
 * @task T11640
 */
export async function resolveCurrentSessionId(cwd?: string): Promise<string | null> {
  return (await resolveSessionForRead(cwd)).session?.id ?? null;
}

/** Which identity tier bound the caller to its session (T12500). */
export type SessionBindingSource = 'connection' | 'env' | 'terminal';

/** A session the caller is provably bound to (T12500). */
export interface BoundSessionResolution {
  /** The caller's own session row. */
  readonly session: Session;
  /** The identity tier that named it. */
  readonly via: SessionBindingSource;
}

/**
 * Resolve the session the CALLER is bound to — never a guess (T12500 · epic T12497).
 *
 * Tiers 1-3 of {@link resolveCurrentSession} only: the daemon connection
 * handle, an env-named session (`CLEO_SESSION_ID` & co.) whose row exists, and
 * the terminal binding written by `session start` / `session resume`. The
 * newest-active-row fallback is deliberately absent: from an unbound terminal
 * it names whichever agent wrote the DB last, so a mutation resolved through it
 * ends, attributes to, or suspends ANOTHER agent's session.
 *
 * Every mutation that means "the caller's session" resolves through this (or
 * {@link requireBoundSession}); only read-only surfaces may use the fallback,
 * and they label it via {@link resolveSessionForRead}.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The bound session and the tier that bound it, or `null` when unbound.
 * @task T12500
 */
export async function resolveBoundSession(cwd?: string): Promise<BoundSessionResolution | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const connId = getCurrentConnectionSessionId();
    if (connId) {
      const byConn = await getSession(connId, scope.worktreeRoot);
      if (byConn) return { session: byConn, via: 'connection' as const };
      // connection named a session with no row yet — fall through to env.
    }
    const envId = resolveSessionIdFromEnv();
    if (envId) {
      const byEnv = await getSession(envId, scope.worktreeRoot);
      if (byEnv) return { session: byEnv, via: 'env' as const };
      // env id named a session that does not exist — fall through to the binding.
    }
    // T12499: the session this terminal started / resumed.
    const byTerminal = await resolveTerminalBoundSession(scope.worktreeRoot);
    if (byTerminal) return { session: byTerminal, via: 'terminal' as const };
    return null;
  });
}

/**
 * Id-only form of {@link resolveBoundSession} (T12500).
 *
 * For attribution (audit rows, decisions, memory writes): an unbound caller is
 * attributed to NO session rather than to the newest active one.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The bound session id, or `null` when the caller is unbound.
 * @task T12500
 */
export async function resolveBoundSessionId(cwd?: string): Promise<string | null> {
  return (await resolveBoundSession(cwd))?.session.id ?? null;
}

/** Result of a read-only session resolution (T12500). */
export interface ReadSessionResolution {
  /** The resolved session, or `null` when no session exists at all. */
  readonly session: Session | null;
  /**
   * `true` when the caller is NOT bound and `session` is merely the newest
   * active row — possibly another agent's. Read-only envelopes surface this as
   * `unbound: true` so the reader does not mistake it for its own session.
   */
  readonly unbound: boolean;
}

/**
 * Resolve a session for a READ-ONLY surface, labelling a guess (T12500).
 *
 * Bound tiers first ({@link resolveBoundSession}); when the caller is unbound,
 * falls back to the newest active row and reports `unbound: true`. Status,
 * briefing and show may display that row — they change nothing — but must
 * pass the label through to their envelope.
 *
 * @param cwd - Working directory for DB resolution.
 * @returns The session (bound or newest-active) plus the `unbound` label.
 * @task T12500
 */
export async function resolveSessionForRead(cwd?: string): Promise<ReadSessionResolution> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const bound = await resolveBoundSession(scope.worktreeRoot);
    if (bound) return { session: bound.session, unbound: false };
    const newest = await getActiveSession(scope.worktreeRoot);
    return { session: newest, unbound: newest !== null };
  });
}

/**
 * How recently an `active` session must have started or recorded activity to
 * make an unbound caller ambiguous (T12500). Sessions leak `active` — an agent
 * that crashes never ends its own — so an ancient row must not turn every
 * unbound call into `E_SESSION_UNBOUND` forever.
 */
export const SESSION_LIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether any LIVE session is active in this project (T12500).
 *
 * An existence scan, not an identity: it decides whether an unbound caller is
 * ambiguous (`E_SESSION_UNBOUND`) or simply has no session to act on. Only
 * sessions whose newest of `lastActivity` / `startedAt` falls within
 * {@link SESSION_LIVE_TTL_MS} count; a stale, never-ended row does not.
 *
 * @param cwd - Working directory for DB resolution.
 * @param nowMs - Clock override for tests.
 * @returns `true` when at least one live session row is `active`.
 * @task T12500
 */
export async function hasActiveSession(cwd?: string, nowMs: number = Date.now()): Promise<boolean> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const db = await getDb(scope.worktreeRoot);
    const rows = await db
      .select({
        startedAt: schema.sessions.startedAt,
        lastActivity: schema.sessions.lastActivity,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.status, 'active'))
      .all();
    const cutoff = nowMs - SESSION_LIVE_TTL_MS;
    return rows.some((row) => {
      const seen = Math.max(
        Date.parse(row.startedAt ?? '') || 0,
        Date.parse(row.lastActivity ?? '') || 0,
      );
      return seen >= cutoff;
    });
  });
}

/** How to bind a caller to a session — shared by every E_SESSION_UNBOUND (T12500). */
export const SESSION_UNBOUND_FIX =
  "Bind this terminal to a session: run 'cleo session start --scope <scope> --name <name>' " +
  "(or 'cleo session resume <id>' for an existing one), or set CLEO_SESSION_ID=<id>. " +
  "To act on a specific session without binding, pass it explicitly (e.g. 'cleo session end --session <id>').";

/** Copy-paste remedies attached to every E_SESSION_UNBOUND (T12500). */
export const SESSION_UNBOUND_ALTERNATIVES: ReadonlyArray<{ action: string; command: string }> = [
  {
    action: 'Start and bind a session',
    command: 'cleo session start --scope global --name "<name>"',
  },
  { action: 'Bind an existing session', command: 'cleo session resume <sessionId>' },
  { action: 'Name the session for this shell', command: 'export CLEO_SESSION_ID=<sessionId>' },
  { action: 'List active sessions', command: 'cleo session list --status active' },
];

/**
 * Message for an E_SESSION_UNBOUND refusal (T12500).
 *
 * @param operation - What the caller tried to do (e.g. `end the session`).
 * @returns Human-readable refusal naming why the newest session was not used.
 * @task T12500
 */
export function sessionUnboundMessage(operation: string): string {
  return (
    `Cannot ${operation}: no session is bound to this caller (no CLEO_SESSION_ID naming a session, ` +
    'and this terminal has not started or resumed one). Refusing to guess the newest active ' +
    'session, which may belong to another agent.'
  );
}

/**
 * Resolve the caller's bound session for a MUTATION, refusing to guess (T12500).
 *
 * - Bound → the caller's session.
 * - Unbound and NO session is active → `null` (nothing is ambiguous; callers
 *   keep their existing "no session" behaviour).
 * - Unbound while some session IS active → throws `E_SESSION_UNBOUND`
 *   ({@link ExitCode.SESSION_UNBOUND}) — the legacy fallback would have picked
 *   that other session.
 *
 * @param operation - What the caller is attempting, for the error message.
 * @param cwd - Working directory for DB resolution.
 * @returns The bound session, or `null` when no session is active at all.
 * @throws CleoError with `ExitCode.SESSION_UNBOUND` when unbound but sessions exist.
 * @task T12500
 */
export async function requireBoundSession(
  operation: string,
  cwd?: string,
): Promise<Session | null> {
  const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
  return worktreeScope.run(scope, async () => {
    const bound = await resolveBoundSession(scope.worktreeRoot);
    if (bound) return bound.session;
    if (!(await hasActiveSession(scope.worktreeRoot))) return null;
    throw new CleoError(ExitCode.SESSION_UNBOUND, sessionUnboundMessage(operation), {
      fix: SESSION_UNBOUND_FIX,
      alternatives: [...SESSION_UNBOUND_ALTERNATIVES],
    });
  });
}
