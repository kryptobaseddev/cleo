/**
 * Extended session types used by the MCP engine layer.
 *
 * These types represent the actual on-disk format for sessions.json
 * which is richer than the core Session type in types/session.ts.
 *
 * @task T4782
 * @epic T4654
 */

/**
 * Session object matching sessions.schema.json (engine-compatible).
 */
export interface SessionRecord {
  id: string;
  status: 'active' | 'suspended' | 'ended' | 'archived';
  agentId?: string;
  name?: string;
  scope: {
    type: string;
    rootTaskId: string;
    phaseFilter?: string | null;
    labelFilter?: string[] | null;
    includeDescendants?: boolean;
    maxDepth?: number | null;
    explicitTaskIds?: string[] | null;
    excludeTaskIds?: string[] | null;
    computedTaskIds?: string[];
    computedAt?: string;
  };
  focus: {
    currentTask?: string | null;
    currentPhase?: string | null;
    previousTask?: string | null;
    sessionNote?: string | null;
    nextAction?: string | null;
    blockedReason?: string | null;
    focusHistory?: Array<{ taskId: string; timestamp: string }>;
  };
  startedAt: string;
  lastActivity: string;
  suspendedAt?: string | null;
  endedAt?: string | null;
  archivedAt?: string | null;
  resumeCount?: number;
  /** Whether full query+mutation audit logging is enabled (behavioral grading). */
  gradeMode?: boolean;
  stats?: {
    tasksCompleted: number;
    tasksCreated: number;
    tasksUpdated: number;
    focusChanges: number;
    totalActiveMinutes: number;
    suspendCount: number;
  };
}

/**
 * Task work state from tasks.json (single-session mode).
 */
export interface TaskWorkStateExt {
  currentTask: string | null;
  currentPhase: string | null;
  blockedUntil: string | null;
  sessionNote: string | null;
  sessionNotes: unknown[];
  nextAction: string | null;
  primarySession: string | null;
}

/** @deprecated Use TaskWorkStateExt instead. */
export type FocusState = TaskWorkStateExt;

/**
 * Extended sessions.json structure (engine-compatible).
 */
export interface SessionsFileExt {
  version?: string;
  project?: string;
  _meta?: {
    schemaVersion: string;
    checksum: string;
    lastModified: string;
    totalSessionsCreated?: number;
    lastSessionId?: string | null;
  };
  config?: Record<string, unknown>;
  sessions: SessionRecord[];
  sessionHistory?: SessionRecord[];
}

/**
 * Task file structure (subset for session operations).
 */
export interface TaskFileExt {
  focus?: FocusState;
  _meta?: {
    schemaVersion: string;
    checksum?: string;
    configVersion?: string;
    lastSessionId?: string | null;
    activeSession?: string | null;
    multiSessionEnabled?: boolean;
    activeSessionCount?: number;
    sessionsFile?: string | null;
    generation?: number;
    [key: string]: unknown;
  };
  tasks?: Array<{ id: string; status: string; parentId?: string; completedAt?: string; [key: string]: unknown }>;
  lastUpdated?: string;
  [key: string]: unknown;
}

/**
 * Decision record stored in decisions.jsonl.
 */
export interface DecisionRecord {
  id: string;
  sessionId: string;
  taskId: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  timestamp: string;
}

/**
 * Assumption record stored in assumptions.jsonl.
 */
export interface AssumptionRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  assumption: string;
  confidence: 'high' | 'medium' | 'low';
  validatedAt: string | null;
  timestamp: string;
}
