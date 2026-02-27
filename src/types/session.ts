/**
 * Session type definitions for CLEO V2.
 * Multi-agent session tracking with epic-bound scopes.
 * @epic T4454
 * @task T4456
 */

/** Session status. */
import type { SessionStatus } from '../store/status-registry.js';
export type { SessionStatus };

/** Session scope type. */
export type SessionScopeType = 'epic' | 'global';

/** Session scope definition. */
export interface SessionScope {
  type: SessionScopeType;
  epicId?: string;
}

/** Active task work state within a session. */
export interface SessionTaskWork {
  taskId: string | null;
  setAt: string | null;
}

/** @deprecated Use SessionTaskWork instead. */
export type SessionFocus = SessionTaskWork;

/** A CLEO session. */
export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  scope: SessionScope;
  taskWork: SessionTaskWork;
  /** @deprecated Use taskWork instead. */
  focus?: SessionTaskWork;
  startedAt: string;
  endedAt?: string | null;
  agent?: string | null;
  notes?: string[];
  tasksCompleted?: string[];
  tasksCreated?: string[];
}

/** Sessions registry file structure. */
export interface SessionsFile {
  version: string;
  sessions: Session[];
  _meta: {
    schemaVersion: string;
    lastUpdated: string;
  };
}
