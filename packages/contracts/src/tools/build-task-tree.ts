/**
 * Contract types for the buildTaskTree SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional
 * @task T10068
 * @epic T9835
 */

import type { TaskPriority } from '../task.js';
import type { TaskTreeNode } from '../tasks.js';

export type { TaskTreeNode };

/** Minimal task shape required by buildTaskTree. */
export interface BuildTaskTreeInput {
  /** Unique task identifier. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Current task status. */
  status: string;
  /** Task type classification. */
  type?: string;
  /** Task priority level. */
  priority: TaskPriority;
  /** ID of the parent task (null for root). */
  parentId?: string | null;
  /** Sort position within sibling scope. */
  position?: number | null;
  /** Dependency IDs. */
  depends?: string[];
  /** Additional labels. */
  labels?: string[];
}

/** Options for buildTaskTree. */
export interface BuildTaskTreeOptions {
  /** When true, annotate each node with transitive blocker chains. */
  withBlockers?: boolean;
}

/** Result of buildTaskTree. */
export interface BuildTaskTreeResult {
  /** Root-level tree nodes. */
  tree: TaskTreeNode[];
  /** Total number of nodes across all levels. */
  totalNodes: number;
}
