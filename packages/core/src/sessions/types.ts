/**
 * Extended session types used by the engine/dispatch layer.
 *
 * @task T4782
 * @epic T4654
 */

import type { SessionNote, TaskWorkState } from '@cleocode/contracts';

/**
 * Session object (engine-compatible).
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
  // Session chain fields (T4959)
  /** Soft FK to predecessor session. */
  previousSessionId?: string | null;
  /** Soft FK to successor session. */
  nextSessionId?: string | null;
  /** LLM agent/conversation identifier. */
  agentIdentifier?: string | null;
  /** When the successor read this session's handoff/debrief. */
  handoffConsumedAt?: string | null;
  /** Who consumed the handoff. */
  handoffConsumedBy?: string | null;
  /** Rich debrief data (superset of handoffJson). */
  debriefJson?: string | null;
}

/**
 * Task work state from the task store.
 *
 * Extends the strict contracts {@link TaskWorkState} with required-null
 * fields for session engine compatibility. The engine layer always expects
 * these fields to be present (even if null), whereas the contracts type
 * marks them as optional.
 */
export interface TaskWorkStateExt extends TaskWorkState {
  currentTask: string | null;
  currentPhase: string | null;
  blockedUntil: string | null;
  sessionNote: string | null;
  sessionNotes: SessionNote[];
  nextAction: string | null;
  primarySession: string | null;
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
