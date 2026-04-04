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
  /** Scope type (e.g. `"global"`, `"epic"`, `"task"`, `"custom"`). */
  type: string;
  /**
   * Epic ID when scope type is `"epic"`.
   * @defaultValue undefined
   */
  epicId?: string;
  /**
   * Root task ID when scope is narrowed to a subtree.
   * @defaultValue undefined
   */
  rootTaskId?: string;
  /**
   * Whether to include descendant tasks of the root task.
   * @defaultValue undefined
   */
  includeDescendants?: boolean;
  /**
   * Phase slug to filter tasks by.
   * @defaultValue undefined
   */
  phaseFilter?: string | null;
  /**
   * Label filter to narrow the scope to specific labels.
   * @defaultValue undefined
   */
  labelFilter?: string[] | null;
  /**
   * Maximum hierarchy depth to include.
   * @defaultValue undefined
   */
  maxDepth?: number | null;
  /**
   * Explicit task IDs to include regardless of other filters.
   * @defaultValue undefined
   */
  explicitTaskIds?: string[] | null;
  /**
   * Task IDs to exclude from the scope.
   * @defaultValue undefined
   */
  excludeTaskIds?: string[] | null;
  /**
   * Task IDs computed from the scope definition at resolution time.
   * @defaultValue undefined
   */
  computedTaskIds?: string[];
  /**
   * ISO 8601 timestamp of when computed task IDs were last resolved.
   * @defaultValue undefined
   */
  computedAt?: string;
}

/** Session statistics. */
export interface SessionStats {
  /** Number of tasks completed during this session. */
  tasksCompleted: number;
  /** Number of new tasks created during this session. */
  tasksCreated: number;
  /** Number of task updates performed during this session. */
  tasksUpdated: number;
  /** Number of times the focus task was changed. */
  focusChanges: number;
  /** Total minutes the session was in active status. */
  totalActiveMinutes: number;
  /** Number of times the session was suspended and resumed. */
  suspendCount: number;
}

/** Active task work state within a session. */
export interface SessionTaskWork {
  /** ID of the task currently being worked on, or `null` if none. */
  taskId: string | null;
  /** ISO 8601 timestamp of when the current task was set, or `null`. */
  setAt: string | null;
}

/** Session domain type — plain interface aligned with Drizzle sessions table. */
export interface Session {
  /** Unique session identifier (e.g. `"ses_20260401..."`) . */
  id: string;
  /** Human-readable session name. */
  name: string;
  /** Current session lifecycle status. */
  status: SessionStatus;
  /** Scope definition controlling which tasks are visible. */
  scope: SessionScope;
  /** Active task work state within the session. */
  taskWork: SessionTaskWork;
  /** ISO 8601 timestamp of when the session started. */
  startedAt: string;
  /** ISO 8601 timestamp of when the session ended. @defaultValue undefined */
  endedAt?: string;
  /** Agent identifier that owns this session. @defaultValue undefined */
  agent?: string;
  /** Timestamped notes appended during the session. @defaultValue undefined */
  notes?: string[];
  /** IDs of tasks completed during this session. @defaultValue undefined */
  tasksCompleted?: string[];
  /** IDs of tasks created during this session. @defaultValue undefined */
  tasksCreated?: string[];
  /** Serialized handoff JSON for session continuity. @defaultValue undefined */
  handoffJson?: string | null;
  /** ID of the session that preceded this one. @defaultValue undefined */
  previousSessionId?: string | null;
  /** ID of the session that follows this one. @defaultValue undefined */
  nextSessionId?: string | null;
  /** Provider-specific agent identifier string. @defaultValue undefined */
  agentIdentifier?: string | null;
  /** ISO 8601 timestamp of when the handoff was consumed. @defaultValue undefined */
  handoffConsumedAt?: string | null;
  /** Agent that consumed the handoff. @defaultValue undefined */
  handoffConsumedBy?: string | null;
  /** Serialized debrief JSON from session end. @defaultValue undefined */
  debriefJson?: string | null;
  /** Aggregate session statistics. @defaultValue undefined */
  stats?: SessionStats;
  /** Number of times this session has been resumed. @defaultValue undefined */
  resumeCount?: number;
  /** Whether this session is in grade/evaluation mode. @defaultValue undefined */
  gradeMode?: boolean;
  /** ID of the provider adapter used for this session. @defaultValue undefined */
  providerId?: string | null;
}

/**
 * Result of a session start operation.
 *
 * The `sessionId` field is a convenience alias for `session.id`,
 * provided for consumers that expect it at the top level of the result.
 */
export interface SessionStartResult {
  /** The newly created or resumed session. */
  session: Session;
  /** Convenience alias for `session.id`. */
  sessionId: string;
}

/**
 * SessionView — typed wrapper over Session[] with collection helpers.
 *
 * Provides discoverable query methods for common session lookups.
 * Does NOT change the DataAccessor interface — consumers create views from Session[].
 *
 * @remarks
 * SessionView is a read-only collection wrapper that provides convenience
 * methods for filtering, searching, and sorting sessions. It does not own
 * the data and performs no mutations on the underlying array.
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
