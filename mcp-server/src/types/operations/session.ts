/**
 * Session Domain Operations (12 operations)
 *
 * Query operations: 5
 * Mutate operations: 7
 */

/**
 * Common session types
 */
export interface Session {
  id: string;
  name: string;
  scope: string;
  started: string;
  ended?: string;
  activeTask?: string;
  status: 'active' | 'suspended' | 'ended';
  notes?: string[];
}

/**
 * Query Operations
 */

// session.status
export type SessionStatusParams = Record<string, never>;
export interface SessionStatusResult {
  current: Session | null;
  hasActiveTask: boolean;
  activeTask?: string;
}

// session.list
export interface SessionListParams {
  active?: boolean;
  limit?: number;
}
export type SessionListResult = Session[];

// session.show
export interface SessionShowParams {
  sessionId: string;
}
export type SessionShowResult = Session;

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
export type SessionStartResult = Session;

// session.end
export interface SessionEndParams {
  notes?: string;
}
export interface SessionEndResult {
  session: Session;
  summary: {
    duration: string;
    tasksCompleted: number;
    tasksCreated: number;
  };
}

// session.resume
export interface SessionResumeParams {
  sessionId: string;
}
export type SessionResumeResult = Session;

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
