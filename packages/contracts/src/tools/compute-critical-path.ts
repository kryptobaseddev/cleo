/**
 * Contract types for the computeCriticalPath SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional
 * @task T10068
 * @epic T9835
 */

/** A node in the dependency DAG. */
export interface CriticalPathNode {
  /** Unique task identifier. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Current task status. */
  status: string;
  /** Dependency IDs (scoped to the same set of nodes). */
  depends: string[];
}

/** A directed edge in the dependency DAG (dependency → dependent). */
export interface CriticalPathEdge {
  /** Source node ID (the dependency). */
  from: string;
  /** Target node ID (the dependent). */
  to: string;
}

/** Result of computeCriticalPath. */
export interface CriticalPathResult {
  /** Ordered task IDs from path start to end (empty when graph has cycles). */
  path: string[];
  /** Length of the critical path. */
  length: number;
}
