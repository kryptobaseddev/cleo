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
  focusedTask?: string;
  status: 'active' | 'suspended' | 'ended';
  notes?: string[];
}

export interface FocusInfo {
  taskId: string | null;
  since?: string;
  sessionId?: string;
}

/**
 * Query Operations
 */

// session.status
export type SessionStatusParams = Record<string, never>;
export interface SessionStatusResult {
  current: Session | null;
  hasFocus: boolean;
  focusedTask?: string;
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

// session.focus.get
export type SessionFocusGetParams = Record<string, never>;
export type SessionFocusGetResult = FocusInfo;

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
  autoFocus?: boolean;
  focus?: string;
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

// session.focus.set
export interface SessionFocusSetParams {
  taskId: string;
}
export interface SessionFocusSetResult {
  taskId: string;
  sessionId: string;
  timestamp: string;
}

// session.focus.clear
export type SessionFocusClearParams = Record<string, never>;
export interface SessionFocusClearResult {
  cleared: true;
  previousTask?: string;
}

// session.gc
export interface SessionGcParams {
  olderThan?: string;
}
export interface SessionGcResult {
  cleaned: number;
  sessionIds: string[];
}
