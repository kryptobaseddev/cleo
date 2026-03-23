/**
 * Session Domain Operations (9 operations)
 *
 * Query operations: 4
 * Mutate operations: 5
 *
 * SYNC: Canonical type definitions live in the CLI package at:
 *   src/types/session.ts (Session, SessionScope, etc.)
 * These MCP operation types are the API contract (wire format).
 */

/**
 * Common session types
 */
export interface SessionOp {
  id: string;
  name: string;
  scope: string;
  started: string;
  ended?: string;
  startedTask?: string;
  status: 'active' | 'suspended' | 'ended';
  notes?: string[];
}

/**
 * Query Operations
 */

// session.status
export type SessionStatusParams = Record<string, never>;
export interface SessionStatusResult {
  current: SessionOp | null;
  hasStartedTask: boolean;
  startedTask?: string;
}

// session.list
export interface SessionListParams {
  active?: boolean;
  status?: string;
  limit?: number;
  offset?: number;
}
export interface SessionListResult {
  sessions: SessionOp[];
  total: number;
  filtered: number;
}

// session.show
export interface SessionShowParams {
  sessionId: string;
}
export type SessionShowResult = SessionOp;

// session.history
export interface SessionHistoryParams {
  limit?: number;
}
export interface SessionHistoryEntry {
  sessionId: string;
  name: string;
  started: string;
  ended: string;
  tasksCompleted: number;
  duration: string;
}
export type SessionHistoryResult = SessionHistoryEntry[];

/**
 * Mutate Operations
 */

// session.start
export interface SessionStartParams {
  scope: string;
  name?: string;
  autoStart?: boolean;
  startTask?: string;
}
export type SessionStartResult = SessionOp;

// session.end
export interface SessionEndParams {
  notes?: string;
  /**
   * Structured session summary for direct ingestion into brain.db.
   * When provided, CLEO persists key learnings, decisions, patterns, and next actions.
   * @task T140 @epic T134
   */
  sessionSummary?: import('../config.js').SessionSummaryInput;
}
export interface SessionEndResult {
  session: SessionOp;
  summary: {
    duration: string;
    tasksCompleted: number;
    tasksCreated: number;
  };
  /**
   * A summarization prompt built from this session's debrief data.
   * Populated when `brain.summarization.enabled` is true.
   * @task T140 @epic T134
   */
  memoryPrompt?: string;
}

// session.resume
export interface SessionResumeParams {
  sessionId: string;
}
export type SessionResumeResult = SessionOp;

// session.suspend
export interface SessionSuspendParams {
  notes?: string;
}
export interface SessionSuspendResult {
  sessionId: string;
  suspended: string;
}

// session.gc
export interface SessionGcParams {
  olderThan?: string;
}
export interface SessionGcResult {
  cleaned: number;
  sessionIds: string[];
}
