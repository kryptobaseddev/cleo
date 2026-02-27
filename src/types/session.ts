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
  /** Root task ID (engine-layer alias for epicId). Both are kept in sync. */
  rootTaskId?: string;
  /** Whether to include descendant tasks in scope. */
  includeDescendants?: boolean;
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
  /** Serialized handoff data (JSON string), persisted at session end. */
  handoffJson?: string | null;
  // Session chain fields (T4959)
  /** Soft FK to predecessor session. */
  previousSessionId?: string | null;
  /** Soft FK to successor session. */
  nextSessionId?: string | null;
  /** LLM agent/conversation identifier (e.g., MCP process ID, agent name). */
  agentIdentifier?: string | null;
  /** When the successor read this session's handoff/debrief. */
  handoffConsumedAt?: string | null;
  /** Who consumed the handoff (session ID or agent identifier). */
  handoffConsumedBy?: string | null;
  /** Rich debrief data (superset of handoffJson). */
  debriefJson?: string | null;
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
