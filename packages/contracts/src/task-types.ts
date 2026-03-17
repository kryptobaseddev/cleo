/**
 * Task type definitions shared across all CLEO layers.
 *
 * These are self-contained type aliases and interfaces that do not
 * depend on store-level code. The full Task interface remains in
 * src/types/task.ts due to its dependency on TaskStatus from the store.
 *
 * @epic T4454
 * @task T4456
 * @task T5710
 */

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

/** Phase status. */
export type PhaseStatus = 'pending' | 'active' | 'completed';

/** Release status. */
export type ReleaseStatus = 'planned' | 'active' | 'released';
