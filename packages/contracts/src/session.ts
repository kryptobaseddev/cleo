/**
 * Session type definitions for CLEO V2.
 *
 * Plain TypeScript interfaces derived from the Drizzle/Zod schemas
 * in src/store/validation-schemas.ts. Contracts must not depend on Zod/Drizzle.
 *
 * @epic T4454
 */

import type { SessionStatus } from './status-registry.js';

export type { SessionStatus };

/** Session scope JSON blob shape. */
export interface SessionScope {
  type: string;
  epicId?: string;
  rootTaskId?: string;
  includeDescendants?: boolean;
  phaseFilter?: string | null;
  labelFilter?: string[] | null;
  maxDepth?: number | null;
  explicitTaskIds?: string[] | null;
  excludeTaskIds?: string[] | null;
  computedTaskIds?: string[];
  computedAt?: string;
}

/** Session statistics. */
export interface SessionStats {
  tasksCompleted: number;
  tasksCreated: number;
  tasksUpdated: number;
  focusChanges: number;
  totalActiveMinutes: number;
  suspendCount: number;
}

/** Active task work state within a session. */
export interface SessionTaskWork {
  taskId: string | null;
  setAt: string | null;
}

/** Session domain type — plain interface aligned with Drizzle sessions table. */
export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  scope: SessionScope;
  taskWork: SessionTaskWork;
  startedAt: string;
  endedAt?: string;
  agent?: string;
  notes?: string[];
  tasksCompleted?: string[];
  tasksCreated?: string[];
  handoffJson?: string | null;
  previousSessionId?: string | null;
  nextSessionId?: string | null;
  agentIdentifier?: string | null;
  handoffConsumedAt?: string | null;
  handoffConsumedBy?: string | null;
  debriefJson?: string | null;
  stats?: SessionStats;
  resumeCount?: number;
  gradeMode?: boolean;
  providerId?: string | null;
}

/**
 * Result of a session start operation.
 *
 * The `sessionId` field is a convenience alias for `session.id`,
 * provided for consumers that expect it at the top level of the result.
 */
export interface SessionStartResult {
  session: Session;
  sessionId: string;
}

/**
 * SessionView — typed wrapper over Session[] with collection helpers.
 *
 * Provides discoverable query methods for common session lookups.
 * Does NOT change the DataAccessor interface — consumers create views from Session[].
 */
export class SessionView {
  private readonly _sessions: Session[];

  constructor(sessions: Session[]) {
    this._sessions = sessions;
  }

  /** Create a SessionView from a Session array. */
  static from(sessions: Session[]): SessionView {
    return new SessionView(sessions);
  }

  /** All sessions in the view (readonly). */
  get all(): readonly Session[] {
    return this._sessions;
  }

  /** Number of sessions. */
  get length(): number {
    return this._sessions.length;
  }

  /** Find the currently active session (if any). */
  findActive(): Session | undefined {
    return this._sessions.find((s) => s.status === 'active');
  }

  /** Find a session by ID. */
  findById(id: string): Session | undefined {
    return this._sessions.find((s) => s.id === id);
  }

  /** Filter sessions by one or more statuses. */
  filterByStatus(...statuses: SessionStatus[]): Session[] {
    return this._sessions.filter((s) => (statuses as string[]).includes(s.status));
  }

  /** Find sessions matching a scope type and optional rootTaskId. */
  findByScope(type: string, rootTaskId?: string): Session[] {
    return this._sessions.filter((s) => {
      if (s.scope?.type !== type) return false;
      if (rootTaskId && s.scope?.rootTaskId !== rootTaskId) return false;
      return true;
    });
  }

  /** Sort sessions by a date field. Returns a new array (does not mutate). */
  sortByDate(field: 'startedAt' | 'endedAt', descending = true): Session[] {
    return [...this._sessions].sort((a, b) => {
      const aDate = new Date(a[field] || '').getTime();
      const bDate = new Date(b[field] || '').getTime();
      return descending ? bDate - aDate : aDate - bDate;
    });
  }

  /** Get the most recently started session. */
  mostRecent(): Session | undefined {
    if (this._sessions.length === 0) return undefined;
    return this.sortByDate('startedAt', true)[0];
  }

  /** Convert back to a plain Session array (shallow copy). */
  toArray(): Session[] {
    return [...this._sessions];
  }

  /** Support for-of iteration. */
  [Symbol.iterator](): Iterator<Session> {
    return this._sessions[Symbol.iterator]();
  }
}
