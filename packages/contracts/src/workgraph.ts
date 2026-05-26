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

/** Stable error code for WorkGraph parent/type matrix violations. */
export const E_WORKGRAPH_PARENT_TYPE_MATRIX = 'E_WORKGRAPH_PARENT_TYPE_MATRIX';

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

/** Cursor/limit controls shared by WorkGraph paginated readers. */
export interface WorkGraphPaginationOptions {
  /** Opaque cursor returned by the previous page. Omitted starts at the first row. */
  readonly cursor?: string;
  /** Maximum number of nodes to return. Implementations clamp invalid values. */
  readonly limit?: number;
}

/** Page metadata returned by WorkGraph paginated readers. */
export interface WorkGraphPageInfo {
  /** Cursor to pass to the next request when more rows exist. */
  readonly nextCursor?: string;
  /** True when additional rows are available after this page. */
  readonly hasMore: boolean;
}

/** Options shared by WorkGraph traversal readers. */
export interface WorkGraphTraversalOptions extends WorkGraphPaginationOptions {
  /** Starting node ID for the traversal. */
  readonly rootId: string;
  /** Direction to traverse from `rootId`. */
  readonly direction: WorkGraphTraversalDirection;
  /** Optional maximum edge depth; omitted means unbounded. */
  readonly maxDepth?: number;
  /** Include non-containment relation edges in addition to containment edges. */
  readonly includeRelations?: boolean;
}

/** Paginated traversal projection with explicit page metadata. */
export interface WorkGraphTraversalResult extends WorkGraphSnapshot {
  /** Requested traversal root. */
  readonly rootId: string;
  /** Direction traversed from the requested root. */
  readonly direction: WorkGraphTraversalDirection;
  /** Page metadata for cursor-based follow-up calls. */
  readonly pageInfo: WorkGraphPageInfo;
}

/** Options for descendant tree readers. */
export interface WorkGraphTreeOptions extends WorkGraphPaginationOptions {
  /** Starting parent ID whose descendants should be projected. */
  readonly rootId: string;
  /** Optional maximum descendant depth; omitted means unbounded. */
  readonly maxDepth?: number;
}

/** Node returned by a paginated descendant tree projection. */
export interface WorkGraphTreeNode extends WorkGraphNode {
  /** One-based edge depth from the requested root. */
  readonly depth: number;
}

/** Paginated descendant tree projection. */
export interface WorkGraphTreeResult {
  /** Requested tree root. */
  readonly rootId: string;
  /** Descendant nodes ordered breadth-first by depth, position, creation time, and ID. */
  readonly nodes: readonly WorkGraphTreeNode[];
  /** Containment edges connecting the returned nodes to the requested root or page peers. */
  readonly edges: readonly WorkGraphEdge[];
  /** Page metadata for cursor-based follow-up calls. */
  readonly pageInfo: WorkGraphPageInfo;
}

/** Sparse status/type bucket counts returned by WorkGraph subtree rollups. */
export interface WorkGraphRollupCounts {
  /** Total nodes counted for this bucket. */
  readonly total: number;
  /** Counts by canonical task status. Statuses with zero rows may be omitted. */
  readonly byStatus: Partial<Record<TaskStatus, number>>;
  /** Counts by canonical task type. Types with zero rows may be omitted. */
  readonly byType: Partial<Record<TaskType, number>>;
}

/** Explicit denominator contract used for percentage fields in subtree summaries. */
export interface WorkGraphPercentDenominator {
  /** Stable denominator basis. */
  readonly basis: 'subtree-total';
  /** Numeric denominator used to compute every percentage in the result. */
  readonly total: number;
  /** Human-readable rule statement for CLIs and APIs. */
  readonly description: string;
}

/** Completion-style percentages derived from a subtree summary. */
export interface WorkGraphSubtreePercentages {
  /** Done descendants divided by `percentDenominator.total`. */
  readonly done: number;
  /** Active descendants divided by `percentDenominator.total`. */
  readonly active: number;
  /** Blocked descendants divided by `percentDenominator.total`. */
  readonly blocked: number;
  /** Pending descendants divided by `percentDenominator.total`. */
  readonly pending: number;
  /** Cancelled descendants divided by `percentDenominator.total`. */
  readonly cancelled: number;
}

/** Field-level mismatch proving a cached direct-child projection is stale. */
export interface WorkGraphProjectionMismatch {
  /** Compared rollup field. */
  readonly field: 'total' | `status:${TaskStatus}` | `type:${TaskType}`;
  /** Count supplied by the caller's projection. */
  readonly expected: number;
  /** Count observed from current WorkGraph storage. */
  readonly actual: number;
}

/** Options for storage-backed subtree summary and rollup reads. */
export interface WorkGraphSubtreeSummaryOptions {
  /** Root node whose descendants are summarized. The root node itself is excluded. */
  readonly rootId: string;
  /** Optional direct-child projection to compare against current storage. */
  readonly expectedDirectRollup?: WorkGraphRollupCounts;
}

/** Direct-child and full-subtree rollup summary for one WorkGraph root. */
export interface WorkGraphSubtreeSummaryResult {
  /** Requested summary root. */
  readonly rootId: string;
  /** Counts for depth=1 descendants only. */
  readonly direct: WorkGraphRollupCounts;
  /** Counts for all descendants below the root. */
  readonly subtree: WorkGraphRollupCounts;
  /** Explicit denominator rules used by `percentages`. */
  readonly percentDenominator: WorkGraphPercentDenominator;
  /** Percentage values rounded to two decimals. */
  readonly percentages: WorkGraphSubtreePercentages;
  /** True when `expectedDirectRollup` disagrees with current storage. */
  readonly staleProjection: boolean;
  /** Field-level projection drift details. */
  readonly projectionMismatches: readonly WorkGraphProjectionMismatch[];
}

/** Minimal public reader facade for future WorkGraph implementations. */
export interface WorkGraphReader {
  /** Read a graph snapshot for the current project context. */
  snapshot(): Promise<WorkGraphSnapshot> | WorkGraphSnapshot;
  /** Traverse from a root node using storage-hidden graph semantics. */
  traverse(
    options: WorkGraphTraversalOptions,
  ): Promise<WorkGraphTraversalResult> | WorkGraphTraversalResult;
  /** Read a paginated descendant tree rooted at a task-like node. */
  tree(options: WorkGraphTreeOptions): Promise<WorkGraphTreeResult> | WorkGraphTreeResult;
  /** Read direct and full-subtree rollup counts rooted at a task-like node. */
  summarizeSubtree(
    options: WorkGraphSubtreeSummaryOptions,
  ): Promise<WorkGraphSubtreeSummaryResult> | WorkGraphSubtreeSummaryResult;
}

/** Task vertex returned by containment-only WorkGraph queries. */
export type WorkGraphContainmentNode = WorkGraphNode;

/** Ancestor chain for one requested WorkGraph root. */
export interface WorkGraphContainmentAncestorsResult {
  /** Requested task ID. */
  readonly rootId: string;
  /** Ancestors ordered from hierarchy root down to direct parent. */
  readonly ancestors: readonly WorkGraphContainmentNode[];
}

/** Direct children for one requested WorkGraph parent. */
export interface WorkGraphContainmentChildrenResult {
  /** Requested parent task ID. */
  readonly rootId: string;
  /** Direct children ordered by task position/creation order. */
  readonly children: readonly WorkGraphContainmentNode[];
}

/**
 * Storage-backed containment lookup facade.
 *
 * Implementations MUST answer from `tasks.parent_id` only. They MUST NOT read
 * `task_relations`, including `groups`, because Saga membership is not direct
 * containment.
 */
export interface WorkGraphContainmentQueryService {
  /** Load ancestor chains for many roots in one batched query. */
  getAncestors(rootIds: readonly string[]): readonly WorkGraphContainmentAncestorsResult[];
  /** Load direct children for many parents in one batched query. */
  getChildren(parentIds: readonly string[]): readonly WorkGraphContainmentChildrenResult[];
}

/** Minimal task hierarchy row accepted by the WorkGraph invariant validator. */
export interface WorkGraphHierarchyInputNode {
  /** Stable task, saga, epic, or subtask identifier. */
  readonly id: string;
  /** Canonical hierarchy discriminator for the node. */
  readonly type: TaskType;
  /** Direct containment parent; absent/null means root. */
  readonly parentId?: string | null;
}

/** Structured hierarchy invariant violation for CLI/API callers. */
export interface WorkGraphHierarchyViolation {
  /** Stable machine-readable error code. */
  readonly code: typeof E_WORKGRAPH_PARENT_TYPE_MATRIX;
  /** Child node that violates the parent/type matrix. */
  readonly taskId: string;
  /** Child node type. */
  readonly taskType: TaskType;
  /** Parent ID when present; null for invalid root/non-root shape. */
  readonly parentId: string | null;
  /** Parent type when parent row is known. */
  readonly parentType?: TaskType;
  /** Human-readable remediation summary. */
  readonly message: string;
}

/** Result returned by the WorkGraph hierarchy invariant validator. */
export interface WorkGraphHierarchyValidationResult {
  /** True when every node satisfies the parent/type matrix. */
  readonly valid: boolean;
  /** Ordered list of matrix violations in input order. */
  readonly violations: readonly WorkGraphHierarchyViolation[];
}

/** Options for WorkGraph hierarchy invariant validation. */
export interface WorkGraphHierarchyValidationOptions {
  /** Throw on the first violation instead of returning all diagnostics. */
  readonly throwOnViolation?: boolean;
}

const PARENT_TYPE_MATRIX: Readonly<Record<TaskType, readonly TaskType[]>> = {
  saga: [],
  epic: [],
  task: ['epic'],
  subtask: ['epic', 'task'],
};

function describeAllowedParents(type: TaskType): string {
  const allowed = PARENT_TYPE_MATRIX[type];
  return allowed.length === 0 ? 'root only' : allowed.join('|');
}

function formatHierarchyViolation(violation: WorkGraphHierarchyViolation): string {
  return `${violation.code}: task ${violation.taskId} type=${violation.taskType} parent=${violation.parentId ?? '<root>'} parentType=${violation.parentType ?? '<missing>'}; ${violation.message}`;
}

/** Error thrown by fail-fast WorkGraph hierarchy validation. */
export class WorkGraphHierarchyInvariantError extends Error {
  /** Stable machine-readable code for the invariant breach. */
  readonly code = E_WORKGRAPH_PARENT_TYPE_MATRIX;

  /** Structured diagnostic for the first hierarchy invariant violation. */
  readonly violation: WorkGraphHierarchyViolation;

  /**
   * Build a WorkGraph hierarchy invariant error from a structured violation.
   * @param violation - The first violation encountered by the validator.
   */
  constructor(violation: WorkGraphHierarchyViolation) {
    super(formatHierarchyViolation(violation));
    this.name = 'WorkGraphHierarchyInvariantError';
    this.violation = violation;
  }
}

function makeViolation(
  node: WorkGraphHierarchyInputNode,
  parent: WorkGraphHierarchyInputNode | undefined,
): WorkGraphHierarchyViolation {
  const parentId = node.parentId ?? null;
  const parentType = parent?.type;
  const expected = describeAllowedParents(node.type);
  const actual = parentId === null ? 'root' : (parentType ?? 'missing parent');
  return {
    code: E_WORKGRAPH_PARENT_TYPE_MATRIX,
    taskId: node.id,
    taskType: node.type,
    parentId,
    parentType,
    message: `tasks.parent_id must follow saga/epic roots, epic->task|subtask, and task->subtask; expected ${node.type} parent ${expected}, got ${actual}`,
  };
}

/**
 * Validate WorkGraph hierarchy rows against CLEO's canonical type/parent matrix.
 *
 * The validator mirrors the SQLite trigger invariant in a storage-agnostic form
 * for core adapters, projections, and API callers: sagas and epics are roots,
 * epics may contain tasks or subtasks, tasks may contain subtasks, and subtasks
 * are leaves. Saga membership remains a `groups` relation, never `parentId`.
 *
 * @param nodes - Task-like hierarchy rows to validate.
 * @param options - Optional fail-fast behavior for enforcement call sites.
 * @returns Structured validation result with all violations in input order.
 * @task T10576
 * @saga T10538
 */
export function validateWorkGraphHierarchy(
  nodes: readonly WorkGraphHierarchyInputNode[],
  options: WorkGraphHierarchyValidationOptions = {},
): WorkGraphHierarchyValidationResult {
  const byId = new Map<string, WorkGraphHierarchyInputNode>();
  for (const node of nodes) byId.set(node.id, node);

  const violations: WorkGraphHierarchyViolation[] = [];
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    const parent = parentId === null ? undefined : byId.get(parentId);
    const allowedParents = PARENT_TYPE_MATRIX[node.type];
    const valid =
      parentId === null
        ? allowedParents.length === 0
        : parent !== undefined && allowedParents.includes(parent.type);

    if (!valid) {
      const violation = makeViolation(node, parent);
      if (options.throwOnViolation) throw new WorkGraphHierarchyInvariantError(violation);
      violations.push(violation);
    }
  }

  return { valid: violations.length === 0, violations };
}
