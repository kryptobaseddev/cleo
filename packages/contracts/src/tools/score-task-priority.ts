/**
 * Contract types for the scoreTask SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional
 * @task T10068
 * @epic T9835
 */

import type { TaskPriority } from '../task.js';

/** Minimal task shape required by scoreTask. */
export interface ScoreTaskInput {
  /** Unique task identifier. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Task priority level. */
  priority: TaskPriority;
  /** Phase slug this task belongs to. */
  phase?: string;
  /** Dependency IDs. */
  depends?: string[];
  /** ISO timestamp of task creation. */
  createdAt?: string;
  /** Labels for pattern matching. */
  labels?: string[];
}

/** Context provided to scoreTask to enable phase-aware and dependency-aware scoring. */
export interface ScoreTaskContext {
  /** Current project phase slug (used for phase alignment bonus). */
  currentPhase?: string | null;
  /** Map of all task IDs to their statuses (used for dep readiness check). */
  taskStatuses?: Map<string, string>;
  /** Current timestamp (ms since epoch) — defaults to Date.now() when omitted. */
  nowMs?: number;
  /** Matched success patterns from BRAIN (optional bonus scoring). */
  successPatterns?: Array<{ pattern: string }>;
  /** Matched failure patterns from BRAIN (optional penalty scoring). */
  failurePatterns?: Array<{ pattern: string }>;
}

/** A scoring factor contributing to the final score. */
export interface ScoreFactor {
  /** Factor name (e.g. "priority", "phaseAlignment"). */
  name: string;
  /** Numeric contribution (positive = bonus, negative = penalty). */
  delta: number;
  /** Human-readable explanation. */
  detail: string;
}

/** Result of scoreTask. */
export interface ScoreTaskResult {
  /** Final computed score. */
  score: number;
  /** Individual scoring factors. */
  factors: ScoreFactor[];
}
