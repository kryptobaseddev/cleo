/**
 * Task type definitions matching todo.schema.json (v2.10.0).
 *
 * Consolidates types from src/types/task.ts and packages/contracts/src/task-types.ts.
 *
 * ## Type Safety Design
 *
 * - {@link Task} represents a fully-materialized task as stored in the database.
 *   Fields that CLEO's anti-hallucination rules require at runtime are marked as
 *   required (non-optional) so the type system enforces what the business rules demand.
 *
 * - {@link TaskCreate} represents the input for creating a new task. Only fields the
 *   caller MUST supply are required; everything else has sensible defaults applied
 *   by the `addTask` function.
 *
 * - {@link CompletedTask} and {@link CancelledTask} are discriminated union types
 *   that narrow `Task` for status-specific contexts where additional fields become
 *   required (e.g., `completedAt` is required when `status = 'done'`).
 *
 * @epic T4454
 * @task T4456
 */

import type { TaskStatus } from './status-registry.js';

export type { TaskStatus };

/** Task priority levels. */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/** Task type in hierarchy. */
export type TaskType = 'epic' | 'task' | 'subtask';

/** Task size (scope, NOT time). */
export type TaskSize = 'small' | 'medium' | 'large';

/** Epic lifecycle states. */
export type EpicLifecycle = 'backlog' | 'planning' | 'active' | 'review' | 'released' | 'archived';

/** Task origin (provenance). */
export type TaskOrigin =
  | 'internal'
  | 'bug-report'
  | 'feature-request'
  | 'security'
  | 'technical-debt'
  | 'dependency'
  | 'regression';

/** Verification agent types. */
export type VerificationAgent =
  | 'planner'
  | 'coder'
  | 'testing'
  | 'qa'
  | 'cleanup'
  | 'security'
  | 'docs';

/** Verification gate names. */
export type VerificationGate =
  | 'implemented'
  | 'testsPassed'
  | 'qaPassed'
  | 'cleanupDone'
  | 'securityPassed'
  | 'documented';

/** Verification failure log entry. */
export interface VerificationFailure {
  /** Verification round number when the failure occurred. */
  round: number;
  /** Agent that performed the verification and reported the failure. */
  agent: string;
  /** Human-readable description of why verification failed. */
  reason: string;
  /** ISO 8601 timestamp of when the failure was recorded. */
  timestamp: string;
}

/** Task verification state. */
export interface TaskVerification {
  /** Whether all required verification gates have passed. */
  passed: boolean;
  /** Current verification round number (starts at 1). */
  round: number;
  /** Gate pass/fail/pending status for each verification gate. */
  gates: Partial<Record<VerificationGate, boolean | null>>;
  /** The last agent that performed a verification check, or `null`. */
  lastAgent: VerificationAgent | null;
  /** ISO 8601 timestamp of the most recent verification update, or `null`. */
  lastUpdated: string | null;
  /** Ordered log of all verification failures across rounds. */
  failureLog: VerificationFailure[];
  /**
   * ISO timestamp set when verification was first initialized on task creation (T061).
   * @defaultValue undefined
   */
  initializedAt?: string | null;
}

/** Task provenance tracking. */
export interface TaskProvenance {
  /** Agent or user that created this task, or `null` if unknown. */
  createdBy: string | null;
  /** Agent or user that last modified this task, or `null` if unknown. */
  modifiedBy: string | null;
  /** Session ID during which this task was created, or `null`. */
  sessionId: string | null;
}

/** A single task relation entry. */
export interface TaskRelation {
  /** ID of the related task. */
  taskId: string;
  /** Relation type (e.g. `"blocks"`, `"related-to"`, `"duplicates"`). */
  type: string;
  /**
   * Optional reason explaining the relationship.
   * @defaultValue undefined
   */
  reason?: string;
}

/**
 * A single CLEO task as stored in the database.
 *
 * Fields marked as required are enforced by CLEO's anti-hallucination validation
 * at runtime. Making them required here ensures the type system catches violations
 * at compile time rather than deferring to runtime checks.
 */
export interface Task {
  /** Unique task identifier. Must match pattern `T\d{3,}` (e.g., T001, T5800). */
  id: string;

  /** Human-readable task title. Required, max 120 characters. */
  title: string;

  /**
   * Task description. **Required** — CLEO's anti-hallucination rules reject tasks
   * without a description, and require it to differ from the title.
   */
  description: string;

  /** Current task status. Must be a valid {@link TaskStatus} enum value. */
  status: TaskStatus;

  /** Task priority level. Defaults to `'medium'` on creation. */
  priority: TaskPriority;

  /** Task type in hierarchy. Inferred from parent context if not specified. @defaultValue undefined */
  type?: TaskType;

  /** ID of the parent task. `null` for root-level tasks. @defaultValue undefined */
  parentId?: string | null;

  /** Sort position within sibling scope. @defaultValue undefined */
  position?: number | null;

  /** Optimistic concurrency version for position changes. @defaultValue undefined */
  positionVersion?: number;

  /** Relative scope sizing (small/medium/large). NOT a time estimate. @defaultValue undefined */
  size?: TaskSize | null;

  /** Phase slug this task belongs to. @defaultValue undefined */
  phase?: string;

  /** File paths associated with this task. @defaultValue undefined */
  files?: string[];

  /** Acceptance criteria for completion. @defaultValue undefined */
  acceptance?: string[];

  /** IDs of tasks this task depends on. @defaultValue undefined */
  depends?: string[];

  /** Related task entries (non-dependency relationships). @defaultValue undefined */
  relates?: TaskRelation[];

  /** Epic lifecycle state. Only meaningful when `type = 'epic'`. @defaultValue undefined */
  epicLifecycle?: EpicLifecycle | null;

  /** When true, epic will not auto-complete when all children are done. @defaultValue undefined */
  noAutoComplete?: boolean | null;

  /** Reason the task is blocked (free-form text). @defaultValue undefined */
  blockedBy?: string;

  /** Timestamped notes appended during task lifecycle. @defaultValue undefined */
  notes?: string[];

  /** Classification labels for filtering and grouping. @defaultValue undefined */
  labels?: string[];

  /** Task origin/provenance category. @defaultValue undefined */
  origin?: TaskOrigin | null;

  /** ISO 8601 timestamp of task creation. Must not be in the future. */
  createdAt: string;

  /** ISO 8601 timestamp of last update. Set automatically on mutation. @defaultValue undefined */
  updatedAt?: string | null;

  /**
   * ISO 8601 timestamp of task completion. Set when `status` transitions to `'done'`.
   * See {@link CompletedTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  completedAt?: string;

  /**
   * ISO 8601 timestamp of task cancellation. Set when `status` transitions to `'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  cancelledAt?: string;

  /**
   * Reason for cancellation. Required when `status = 'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  cancellationReason?: string;

  /** Verification pipeline state. @defaultValue undefined */
  verification?: TaskVerification | null;

  /** Provenance tracking (who created/modified, which session). @defaultValue undefined */
  provenance?: TaskProvenance | null;

  /**
   * RCASD-IVTR+C pipeline stage this task is associated with.
   *
   * Valid values: research, consensus, architecture_decision, specification,
   * decomposition, implementation, validation, testing, release, contribution.
   *
   * Auto-assigned on creation; only moves forward through stages.
   * @task T060
   * @defaultValue undefined
   */
  pipelineStage?: string | null;

  /** Agent ID that has claimed/is assigned to this task. Null when unclaimed. @defaultValue undefined */
  assignee?: string | null;
}

// ---------------------------------------------------------------------------
// Input types for task creation
// ---------------------------------------------------------------------------

/**
 * Input type for creating a new task via `addTask()`.
 *
 * Only the fields the caller MUST provide are required. All other fields
 * have sensible defaults applied by the creation logic:
 * - `status` defaults to `'pending'`
 * - `priority` defaults to `'medium'`
 * - `type` is inferred from parent context
 * - `size` defaults to `'medium'`
 */
export interface TaskCreate {
  /** Human-readable task title. Required, max 120 characters. */
  title: string;

  /**
   * Task description. **Required** — CLEO's anti-hallucination rules reject tasks
   * without a description, and require it to differ from the title.
   */
  description: string;

  /** Initial status. Defaults to `'pending'`. @defaultValue 'pending' */
  status?: TaskStatus;

  /** Priority level. Defaults to `'medium'`. @defaultValue 'medium' */
  priority?: TaskPriority;

  /** Task type. Inferred from parent context if not specified. @defaultValue undefined */
  type?: TaskType;

  /** Parent task ID for hierarchy placement. @defaultValue undefined */
  parentId?: string | null;

  /** Relative scope sizing. Defaults to `'medium'`. @defaultValue 'medium' */
  size?: TaskSize;

  /** Phase slug to assign. Inherited from project.currentPhase if not specified. @defaultValue undefined */
  phase?: string;

  /** Classification labels. @defaultValue undefined */
  labels?: string[];

  /** File paths associated with this task. @defaultValue undefined */
  files?: string[];

  /** Acceptance criteria. @defaultValue undefined */
  acceptance?: string[];

  /** IDs of tasks this task depends on. @defaultValue undefined */
  depends?: string[];

  /** Initial note to attach. @defaultValue undefined */
  notes?: string;

  /** Sort position. Auto-calculated if not specified. @defaultValue undefined */
  position?: number;
}

// ---------------------------------------------------------------------------
// Status-narrowed types (discriminated unions)
// ---------------------------------------------------------------------------

/**
 * A task with `status = 'done'`. Narrows {@link Task} to require `completedAt`.
 *
 * Use this type when you need to guarantee a completed task has its completion
 * timestamp — for example, in cycle-time calculations or archive operations.
 */
export type CompletedTask = Task & {
  /** Discriminant: status is always `'done'` for a completed task. */
  status: 'done';
  /** ISO 8601 timestamp of completion. Required for done tasks. */
  completedAt: string;
};

/**
 * A task with `status = 'cancelled'`. Narrows {@link Task} to require
 * `cancelledAt` and `cancellationReason`.
 *
 * Use this type when processing cancelled tasks where the cancellation
 * metadata is guaranteed to be present.
 */
export type CancelledTask = Task & {
  /** Discriminant: status is always `'cancelled'` for a cancelled task. */
  status: 'cancelled';
  /** ISO 8601 timestamp of cancellation. Required for cancelled tasks. */
  cancelledAt: string;
  /** Reason for cancellation. Required for cancelled tasks (min 5 chars). */
  cancellationReason: string;
};

/** Phase status. */
export type PhaseStatus = 'pending' | 'active' | 'completed';

/** Phase definition. */
export interface Phase {
  /** Sort order of this phase in the project lifecycle. */
  order: number;
  /** Human-readable phase name. */
  name: string;
  /** Phase description. @defaultValue undefined */
  description?: string;
  /** Current phase lifecycle status. */
  status: PhaseStatus;
  /** ISO 8601 timestamp of when the phase started. @defaultValue undefined */
  startedAt?: string | null;
  /** ISO 8601 timestamp of when the phase completed. @defaultValue undefined */
  completedAt?: string | null;
}

/** Phase transition record. */
export interface PhaseTransition {
  /** Slug of the phase that transitioned. */
  phase: string;
  /** Type of transition that occurred. */
  transitionType: 'started' | 'completed' | 'rollback';
  /** ISO 8601 timestamp of the transition. */
  timestamp: string;
  /** Number of tasks in the phase at transition time. */
  taskCount: number;
  /** Previous phase slug for rollback transitions. @defaultValue undefined */
  fromPhase?: string | null;
  /** Optional reason for the transition. @defaultValue undefined */
  reason?: string;
}

/** Release status. */
export type ReleaseStatus = 'planned' | 'active' | 'released';

/** Release definition. */
export interface Release {
  /** Semantic version string (e.g. `"v2026.4.0"`). */
  version: string;
  /** Current release lifecycle status. */
  status: ReleaseStatus;
  /** Target release date in ISO 8601. @defaultValue undefined */
  targetDate?: string | null;
  /** Actual release date in ISO 8601. @defaultValue undefined */
  releasedAt?: string | null;
  /** Task IDs included in this release. */
  tasks: string[];
  /** Release notes text. @defaultValue undefined */
  notes?: string | null;
  /** Generated changelog content. @defaultValue undefined */
  changelog?: string | null;
}

/** Project metadata. */
export interface ProjectMeta {
  /** Project name from `.cleo/project-context.json`. */
  name: string;
  /** Slug of the currently active phase. @defaultValue undefined */
  currentPhase?: string | null;
  /** Phase definitions keyed by slug. */
  phases: Record<string, Phase>;
  /** Ordered history of phase transitions. @defaultValue undefined */
  phaseHistory?: PhaseTransition[];
  /** Release definitions for the project. @defaultValue undefined */
  releases?: Release[];
}

/** File metadata (_meta block). */
export interface FileMeta {
  /** Schema version of the task data file. */
  schemaVersion: string;
  /** Spec version for forward compatibility. @defaultValue undefined */
  specVersion?: string;
  /** Integrity checksum of the data file. */
  checksum: string;
  /** Configuration version used when the file was last written. */
  configVersion: string;
  /** ID of the last session that modified this file. @defaultValue undefined */
  lastSessionId?: string | null;
  /** ID of the currently active session. @defaultValue undefined */
  activeSession?: string | null;
  /** Number of active sessions at last write. @defaultValue undefined */
  activeSessionCount?: number;
  /** Path to the sessions storage file. @defaultValue undefined */
  sessionsFile?: string | null;
  /** Monotonically increasing file generation counter. @defaultValue undefined */
  generation?: number;
}

/** Session note in taskWork block. */
export interface SessionNote {
  /** Note text content. */
  note: string;
  /** ISO 8601 timestamp of when the note was recorded. */
  timestamp: string;
  /** Conversation ID for multi-turn context. @defaultValue undefined */
  conversationId?: string | null;
  /** Agent that recorded this note. @defaultValue undefined */
  agent?: string | null;
}

/** Task work state. */
export interface TaskWorkState {
  /** ID of the task currently being worked on. @defaultValue undefined */
  currentTask?: string | null;
  /** Slug of the current project phase. @defaultValue undefined */
  currentPhase?: string | null;
  /** ISO 8601 timestamp until which work is blocked. @defaultValue undefined */
  blockedUntil?: string | null;
  /** Most recent session note (legacy, use sessionNotes). @defaultValue undefined */
  sessionNote?: string | null;
  /** Ordered list of session notes. @defaultValue undefined */
  sessionNotes?: SessionNote[];
  /** Suggested next action for the agent. @defaultValue undefined */
  nextAction?: string | null;
  /** ID of the primary session managing this work state. @defaultValue undefined */
  primarySession?: string | null;
}
