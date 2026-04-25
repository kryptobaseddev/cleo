/**
 * Tasks Domain Operations (Wave 1 refactor — T1435)
 *
 * This file now contains ONLY:
 * - Shared wire format types (TaskStatus, TaskPriority, TaskOp, MinimalTask)
 * - Documentation of TasksOps inference pattern
 *
 * Per-operation Params and Result types have been REMOVED in T1445 (Wave 1 of T1435).
 * Dispatch layer imports are now inferred directly from Core function signatures via
 * OpsFromCore<typeof coreOps>. This eliminates the three-place-to-update pattern and
 * makes drift structurally impossible.
 *
 * The TasksOps type is defined in the dispatch layer as:
 *   type TasksOps = OpsFromCore<typeof coreOps>;
 *
 * where coreOps is a registry mapping operation names to Core functions.
 *
 * @epic T1435 — Dispatch refactor (eliminate per-op type imports)
 * @task T1445 — Tasks domain Wave 1
 * @see packages/cleo/src/dispatch/domains/tasks.ts — TasksOps definition and coreOps registry
 * @see packages/cleo/src/dispatch/adapters/typed.ts — OpsFromCore inference helper
 */

import type { TaskStatus } from '../status-registry.js';

export type { TaskStatus };
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Shared task record (wire format).
 *
 * Matches CLI src/types/task.ts canonical definition.
 * Used across multiple operations for consistent task representation.
 */
export interface TaskOp {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority?: TaskPriority;
  parent?: string;
  depends?: string[];
  labels?: string[];
  created: string;
  updated: string;
  completed?: string;
  notes?: string[];
}

/**
 * Minimal task record (wire format).
 *
 * Lightweight representation for list/search operations.
 */
export interface MinimalTask {
  id: string;
  title: string;
  status: TaskStatus;
  parent?: string;
}
