/**
 * Session type definitions for CLEO V2.
 * Multi-agent session tracking with epic-bound scopes.
 * @epic T4454
 * @task T4456
 */

/** Session status. */
export type SessionStatus = 'active' | 'ended' | 'orphaned';

/** Session scope type. */
export type SessionScopeType = 'epic' | 'global';

/** Session scope definition. */
export interface SessionScope {
  type: SessionScopeType;
  epicId?: string;
}

/** Focus state within a session. */
export interface SessionFocus {
  taskId: string | null;
  setAt: string | null;
}

/** A CLEO session. */
export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  scope: SessionScope;
  focus: SessionFocus;
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
