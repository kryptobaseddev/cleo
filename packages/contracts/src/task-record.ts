/**
 * TaskRecord — string-widened version of Task for JSON serialization in dispatch/LAFS layer.
 *
 * Union-typed fields (status, priority, origin, etc.) are widened to string
 * so that the dispatch layer does not need to validate enum membership.
 *
 * @task T4657
 * @epic T4654
 */

import type { TaskVerification } from './task.js';

/** A single task relation entry (string-widened version). */
export interface TaskRecordRelation {
  taskId: string;
  type: string;
  reason?: string;
}

/** Validation history entry. */
export interface ValidationHistoryEntry {
  round: number;
  agent: string;
  result: string;
  timestamp: string;
}

/** String-widened Task for JSON serialization in dispatch/LAFS layer. */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  depends?: string[];
  relates?: TaskRecordRelation[];
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  size?: string | null;
  epicLifecycle?: string | null;
  noAutoComplete?: boolean | null;
  verification?: TaskVerification | null;
  origin?: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  testedBy?: string | null;
  lifecycleState?: string | null;
  validationHistory?: ValidationHistoryEntry[];
  blockedBy?: string[];
  cancellationReason?: string;
  /** RCASD-IVTR+C pipeline stage. @task T060 */
  pipelineStage?: string | null;
  /**
   * Task role axis — intent of work (string-widened from {@link TaskRole}).
   * Values: work | research | experiment | bug | spike | release
   * @task T944
   */
  role?: string | null;
  /**
   * Task scope axis — granularity of work (string-widened from {@link TaskScope}).
   * Values: project | feature | unit
   * @task T944
   */
  scope?: string | null;
  /**
   * Bug severity (string-widened from {@link TaskSeverity}).
   * Only valid when role='bug'. OWNER-WRITE-ONLY.
   * Values: P0 | P1 | P2 | P3
   * @task T944
   */
  severity?: string | null;
}

/**
 * Minimal task representation for find results.
 *
 * Includes depends, type, and size by default so agents can determine
 * task readiness without N+1 show calls.
 * @task T091
 */
export interface MinimalTaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  parentId?: string | null;
  /** Dependency IDs — agents need this to determine task readiness. @task T091 */
  depends?: string[];
  /** Task type — epic (coordinate), task (execute), or subtask (detail). @task T091 */
  type?: string;
  /** Scope size estimate — helps agents decide if decomposition is needed. @task T091 */
  size?: string;
}
