/**
 * SQLite-backed session store operations.
 *
 * CRUD operations for sessions and task work tracking backed by tasks.db.
 *
 * @epic T4454
 * @task W1-T4
 */
import type { Session } from '../types/session.js';
/** Create a new session. */
export declare function createSession(session: Session, cwd?: string): Promise<Session>;
/** Get a session by ID. */
export declare function getSession(sessionId: string, cwd?: string): Promise<Session | null>;
/** Update a session. */
export declare function updateSession(sessionId: string, updates: Partial<Session>, cwd?: string): Promise<Session | null>;
/** List sessions with optional filters. */
export declare function listSessions(filters?: {
    active?: boolean;
    limit?: number;
}, cwd?: string): Promise<Session[]>;
/** End a session. */
export declare function endSession(sessionId: string, note?: string, cwd?: string): Promise<Session | null>;
/** Start working on a task within a session. */
export declare function startTask(sessionId: string, taskId: string, cwd?: string): Promise<void>;
/** Get current task for a session. */
export declare function getCurrentTask(sessionId: string, cwd?: string): Promise<{
    taskId: string | null;
    since: string | null;
}>;
/** Stop working on the current task for a session. */
export declare function stopTask(sessionId: string, cwd?: string): Promise<void>;
/** Get work history for a session. */
export declare function workHistory(sessionId: string, limit?: number, cwd?: string): Promise<Array<{
    taskId: string;
    setAt: string;
    clearedAt: string | null;
}>>;
/** Garbage collect old sessions (mark ended sessions as orphaned after threshold). */
export declare function gcSessions(maxAgeDays?: number, cwd?: string): Promise<number>;
/** Get the currently active session (if any). */
export declare function getActiveSession(cwd?: string): Promise<Session | null>;
//# sourceMappingURL=session-store.d.ts.map