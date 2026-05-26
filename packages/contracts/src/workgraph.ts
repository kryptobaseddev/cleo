/**
 * Public WorkGraph contracts for PM-Core V2.
 *
 * The WorkGraph is the product boundary for task containment and non-containment
 * relations. These contracts intentionally describe graph-shaped projections
 * only; persistence, SQL tables, and CLI rendering stay behind core adapters.
 *
 * @task T10575
 * @saga T10538
 */

import type { TaskPriority, TaskStatus, TaskType } from './task.js';

/** Stable relation categories exposed by the WorkGraph public API. */
export type WorkGraphRelationKind =
  | 'contains'
  | 'depends_on'
  | 'blocks'
  | 'relates_to'
  | 'groups'
  | 'satisfies';

/** Direction to traverse from a starting WorkGraph node. */
export type WorkGraphTraversalDirection = 'ancestors' | 'descendants' | 'upstream' | 'downstream';

/** Stable identifier for a task-like WorkGraph vertex. */
export interface WorkGraphNodeRef {
  /** Task, Saga, Epic, or Subtask ID. */
  readonly id: string;
  /** Hierarchy discriminator for this graph vertex. */
  readonly type: TaskType;
}

/** Public task vertex shape returned by WorkGraph readers. */
export interface WorkGraphNode extends WorkGraphNodeRef {
  /** Human-readable task title. */
  readonly title: string;
  /** Current lifecycle status of the task row. */
  readonly status: TaskStatus;
  /** Priority copied from the task row for queueing and display. */
  readonly priority: TaskPriority;
  /** Optional direct containment parent. Omitted for root nodes. */
  readonly parentId?: string;
}

/** Directed edge between two WorkGraph nodes. */
export interface WorkGraphEdge {
  /** Source task ID. */
  readonly fromId: string;
  /** Target task ID. */
  readonly toId: string;
  /** Public relation kind; storage-specific relation names are not exposed. */
  readonly kind: WorkGraphRelationKind;
}

/** A fully materialized WorkGraph projection. */
export interface WorkGraphSnapshot {
  /** Graph vertices keyed externally by `id`. */
  readonly nodes: readonly WorkGraphNode[];
  /** Directed graph edges between nodes. */
  readonly edges: readonly WorkGraphEdge[];
}

/** Options shared by WorkGraph traversal readers. */
export interface WorkGraphTraversalOptions {
  /** Starting node ID for the traversal. */
  readonly rootId: string;
  /** Direction to traverse from `rootId`. */
  readonly direction: WorkGraphTraversalDirection;
  /** Optional maximum edge depth; omitted means unbounded. */
  readonly maxDepth?: number;
  /** Include non-containment relation edges in addition to containment edges. */
  readonly includeRelations?: boolean;
}

/** Minimal public reader facade for future WorkGraph implementations. */
export interface WorkGraphReader {
  /** Read a graph snapshot for the current project context. */
  snapshot(): Promise<WorkGraphSnapshot> | WorkGraphSnapshot;
  /** Traverse from a root node using storage-hidden graph semantics. */
  traverse(options: WorkGraphTraversalOptions): Promise<WorkGraphSnapshot> | WorkGraphSnapshot;
}
