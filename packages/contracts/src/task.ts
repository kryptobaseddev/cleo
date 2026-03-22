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
  round: number;
  agent: string;
  reason: string;
  timestamp: string;
}

/** Task verification state. */
export interface TaskVerification {
  passed: boolean;
  round: number;
  gates: Partial<Record<VerificationGate, boolean | null>>;
  lastAgent: VerificationAgent | null;
  lastUpdated: string | null;
  failureLog: VerificationFailure[];
  /** ISO timestamp set when verification was first initialized on task creation (T061). */
  initializedAt?: string | null;
}

/** Task provenance tracking. */
export interface TaskProvenance {
  createdBy: string | null;
  modifiedBy: string | null;
  sessionId: string | null;
}

/** A single task relation entry. */
export interface TaskRelation {
  taskId: string;
  type: string;
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

  /** Task type in hierarchy. Inferred from parent context if not specified. */
  type?: TaskType;

  /** ID of the parent task. `null` for root-level tasks. */
  parentId?: string | null;

  /** Sort position within sibling scope. */
  position?: number | null;

  /** Optimistic concurrency version for position changes. */
  positionVersion?: number;

  /** Relative scope sizing (small/medium/large). NOT a time estimate. */
  size?: TaskSize | null;

  /** Phase slug this task belongs to. */
  phase?: string;

  /** File paths associated with this task. */
  files?: string[];

  /** Acceptance criteria for completion. */
  acceptance?: string[];

  /** IDs of tasks this task depends on. */
  depends?: string[];

  /** Related task entries (non-dependency relationships). */
  relates?: TaskRelation[];

  /** Epic lifecycle state. Only meaningful when `type = 'epic'`. */
  epicLifecycle?: EpicLifecycle | null;

  /** When true, epic will not auto-complete when all children are done. */
  noAutoComplete?: boolean | null;

  /** Reason the task is blocked (free-form text). */
  blockedBy?: string;

  /** Timestamped notes appended during task lifecycle. */
  notes?: string[];

  /** Classification labels for filtering and grouping. */
  labels?: string[];

  /** Task origin/provenance category. */
  origin?: TaskOrigin | null;

  /** ISO 8601 timestamp of task creation. Must not be in the future. */
  createdAt: string;

  /** ISO 8601 timestamp of last update. Set automatically on mutation. */
  updatedAt?: string | null;

  /**
   * ISO 8601 timestamp of task completion. Set when `status` transitions to `'done'`.
   * See {@link CompletedTask} for the status-narrowed type where this is required.
   */
  completedAt?: string;

  /**
   * ISO 8601 timestamp of task cancellation. Set when `status` transitions to `'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   */
  cancelledAt?: string;

  /**
   * Reason for cancellation. Required when `status = 'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   */
  cancellationReason?: string;

  /** Verification pipeline state. */
  verification?: TaskVerification | null;

  /** Provenance tracking (who created/modified, which session). */
  provenance?: TaskProvenance | null;

  /**
   * RCASD-IVTR+C pipeline stage this task is associated with.
   *
   * Valid values: research, consensus, architecture_decision, specification,
   * decomposition, implementation, validation, testing, release, contribution.
   *
   * Auto-assigned on creation; only moves forward through stages.
   * @task T060
   */
  pipelineStage?: string | null;
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

  /** Initial status. Defaults to `'pending'`. */
  status?: TaskStatus;

  /** Priority level. Defaults to `'medium'`. */
  priority?: TaskPriority;

  /** Task type. Inferred from parent context if not specified. */
  type?: TaskType;

  /** Parent task ID for hierarchy placement. */
  parentId?: string | null;

  /** Relative scope sizing. Defaults to `'medium'`. */
  size?: TaskSize;

  /** Phase slug to assign. Inherited from project.currentPhase if not specified. */
  phase?: string;

  /** Classification labels. */
  labels?: string[];

  /** File paths associated with this task. */
  files?: string[];

  /** Acceptance criteria. */
  acceptance?: string[];

  /** IDs of tasks this task depends on. */
  depends?: string[];

  /** Initial note to attach. */
  notes?: string;

  /** Sort position. Auto-calculated if not specified. */
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
  order: number;
  name: string;
  description?: string;
  status: PhaseStatus;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** Phase transition record. */
export interface PhaseTransition {
  phase: string;
  transitionType: 'started' | 'completed' | 'rollback';
  timestamp: string;
  taskCount: number;
  fromPhase?: string | null;
  reason?: string;
}

/** Release status. */
export type ReleaseStatus = 'planned' | 'active' | 'released';

/** Release definition. */
export interface Release {
  version: string;
  status: ReleaseStatus;
  targetDate?: string | null;
  releasedAt?: string | null;
  tasks: string[];
  notes?: string | null;
  changelog?: string | null;
}

/** Project metadata. */
export interface ProjectMeta {
  name: string;
  currentPhase?: string | null;
  phases: Record<string, Phase>;
  phaseHistory?: PhaseTransition[];
  releases?: Release[];
}

/** File metadata (_meta block). */
export interface FileMeta {
  schemaVersion: string;
  specVersion?: string;
  checksum: string;
  configVersion: string;
  lastSessionId?: string | null;
  activeSession?: string | null;
  activeSessionCount?: number;
  sessionsFile?: string | null;
  generation?: number;
}

/** Session note in taskWork block. */
export interface SessionNote {
  note: string;
  timestamp: string;
  conversationId?: string | null;
  agent?: string | null;
}

/** Task work state. */
export interface TaskWorkState {
  currentTask?: string | null;
  currentPhase?: string | null;
  blockedUntil?: string | null;
  sessionNote?: string | null;
  sessionNotes?: SessionNote[];
  nextAction?: string | null;
  primarySession?: string | null;
}
