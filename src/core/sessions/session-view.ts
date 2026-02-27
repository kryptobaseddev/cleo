/**
 * SessionView — typed wrapper over Session[] with collection helpers.
 *
 * Provides discoverable query methods for common session lookups.
 * Does NOT change the DataAccessor interface — consumers create views from Session[].
 *
 * Usage:
 *   const sessions = await accessor.loadSessions();
 *   const view = SessionView.from(sessions);
 *   const active = view.findActive();
 *
 * @epic T4454
 */

import type { Session } from '../../store/validation-schemas.js';
import type { SessionStatus } from '../../store/status-registry.js';

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
