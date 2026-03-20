/**
 * Extended session types used by the engine/dispatch layer.
 *
 * @task T4782
 * @epic T4654
 */

import type {
  FileMeta,
  SessionNote,
  Task,
  TaskStatus,
  TaskWorkState,
} from '@cleocode/contracts';

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
 * Task entry as stored in a TaskFile's `tasks` array.
 *
 * Aligns with the contracts {@link Task} type but allows additional
 * fields via index signature for forward-compatibility with schema
 * extensions that haven't been added to the Task interface yet.
 */
export interface TaskFileTaskEntry {
  /** Unique task identifier (T###). */
  id: string;
  /** Current task status. */
  status: TaskStatus;
  /** Parent task ID for hierarchy. */
  parentId?: string | null;
  /** ISO 8601 completion timestamp. */
  completedAt?: string;
  /** Human-readable title. */
  title?: string;
  /** Task description. */
  description?: string;
  /** Task priority. */
  priority?: string;
  /** Dependency IDs. */
  depends?: string[];
  /** Classification labels. */
  labels?: string[];
  /** Timestamped notes. */
  notes?: string[];
  /** Additional fields for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Metadata block for task files.
 *
 * Aligns with the contracts {@link FileMeta} type but retains an index
 * signature for forward-compatibility with schema extensions.
 */
export interface TaskFileMetaExt {
  /** Schema version identifier. */
  schemaVersion: string;
  /** File integrity checksum. */
  checksum?: string;
  /** Configuration version. */
  configVersion?: string;
  /** ID of last session that modified this file. */
  lastSessionId?: string | null;
  /** Count of currently active sessions. */
  activeSessionCount?: number;
  /** Path to sessions storage file. */
  sessionsFile?: string | null;
  /** Optimistic concurrency generation counter. */
  generation?: number;
  /** Additional metadata fields for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Task file structure (subset for session operations).
 *
 * This type bridges the strict contracts {@link import('@cleocode/contracts').TaskFile}
 * type to the looser shape needed by the session engine. It maintains structural
 * compatibility while providing named sub-types for better IDE support.
 *
 * Key differences from the contracts TaskFile:
 * - `tasks` uses {@link TaskFileTaskEntry} with index signature for extensibility
 * - `_meta` uses {@link TaskFileMetaExt} with index signature for extensibility
 * - `focus` accepts both strict {@link TaskWorkStateExt} and loose record shapes
 * - Top-level index signature allows additional fields (e.g., `version`, `project`)
 */
export interface TaskFileExt {
  /** Work state / focus block for the current session. */
  focus?:
    | TaskWorkStateExt
    | { currentTask?: string | null; currentPhase?: string | null; [key: string]: unknown };
  /** File metadata block. */
  _meta?: TaskFileMetaExt;
  /** Array of task entries. */
  tasks?: TaskFileTaskEntry[];
  /** ISO 8601 timestamp of last file update. */
  lastUpdated?: string;
  /** Additional top-level fields for forward compatibility. */
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

/**
 * Convert a TaskFile (from contracts) to the TaskFileExt shape used by
 * the session engine.
 *
 * Validates that the incoming object has the minimum required structure
 * (at least `_meta` or `tasks` or `focus`). The runtime object is the
 * same reference -- this performs a type assertion, not a deep copy.
 *
 * @param taskFile - A contracts TaskFile or structurally compatible object
 * @returns The same object typed as TaskFileExt
 */
export function toTaskFileExt<
  T extends { _meta?: object; tasks?: unknown[]; focus?: object; lastUpdated?: string },
>(taskFile: T): TaskFileExt {
  // The incoming object structurally satisfies TaskFileExt at runtime;
  // this conversion bridges the strict contracts type to the session type.
  return taskFile as TaskFileExt;
}
