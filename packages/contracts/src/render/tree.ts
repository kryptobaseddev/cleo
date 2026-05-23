/**
 * Typed render contracts — tree (flattened hierarchy).
 *
 * Part of the Human Render Contract (Epic T10114, ADR-077). The flat-tree shape
 * is the canonical wire format for hierarchical task / saga / epic listings —
 * presenters re-materialise the parent/child structure from `parentId` + `depth`.
 *
 * @epic T10114
 * @task T10138
 */

/**
 * Discriminator for a node's place in the task hierarchy.
 *
 * Matches the CLEO 4-tier task model (Saga → Epic → Task → Subtask).
 */
export type TreeNodeKind = 'saga' | 'epic' | 'task' | 'subtask';

/**
 * Lifecycle status of a tree node.
 *
 * Mirrors the canonical task status union used across CLEO.
 */
export type TreeNodeStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'archived';

/**
 * One row in a flattened tree response.
 *
 * `parentId === null` identifies the root. `depth` is the integer distance
 * from the root (root is `0`). `metadata` is the caller-defined payload —
 * presenters MUST NOT assume any specific shape beyond `T`.
 *
 * @typeParam T — caller-defined metadata payload attached to the node.
 */
export interface FlatTreeNode<T> {
  /** Stable, unique identifier (typically a CLEO task ID such as `T1234`). */
  readonly id: string;
  /** Parent identifier, or `null` if this row is the root. */
  readonly parentId: string | null;
  /** Integer distance from the root (root = `0`). */
  readonly depth: number;
  /** Discriminator slot in the CLEO 4-tier model. */
  readonly kind: TreeNodeKind;
  /** Lifecycle status. */
  readonly status: TreeNodeStatus;
  /** Display title — short enough to render on a single line. */
  readonly title: string;
  /** Caller-defined metadata payload. */
  readonly metadata: T;
}

/**
 * Top-level envelope returned by a tree-shaped renderer.
 *
 * @typeParam T — caller-defined metadata payload attached to each node.
 */
export interface TreeResponse<T> {
  /** Flattened list of nodes in pre-order traversal. */
  readonly tree: ReadonlyArray<FlatTreeNode<T>>;
  /** Identifier of the root node — must match a node in `tree` with `parentId === null`. */
  readonly root: string;
  /** Total number of nodes — equal to `tree.length`. */
  readonly totalNodes: number;
  /** Maximum `depth` seen across `tree`. `0` for a single-node tree. */
  readonly maxDepth: number;
}

/**
 * Caller-supplied options that shape a tree response.
 *
 * All fields are optional. Presenters interpret unset fields as "no constraint"
 * (e.g. unset `depth` means render the full tree).
 */
export interface RenderTreeOptions {
  /** Cap the maximum depth rendered. */
  readonly depth?: number;
  /** Restrict the rendered node kinds. */
  readonly kinds?: ReadonlyArray<TreeNodeKind>;
  /** When `true`, presenters may emit unicode icons next to each row. */
  readonly icons?: boolean;
  /** When set, collapse subtrees beyond this child-count threshold. */
  readonly foldAt?: number;
  /** When `true`, presenters MAY annotate inter-task dependencies. */
  readonly withDeps?: boolean;
  /** When `true`, presenters MAY annotate blocker relationships. */
  readonly withBlockers?: boolean;
}

/**
 * Runtime type guard for `TreeResponse<T>`.
 *
 * Verifies the envelope shape without inspecting node payloads — the generic
 * `T` cannot be checked at runtime, so callers must layer per-node validation
 * separately if they need stronger guarantees.
 *
 * @param value — candidate value to inspect.
 * @returns `true` iff `value` matches the `TreeResponse<T>` envelope shape.
 */
export function isTreeResponse<T>(value: unknown): value is TreeResponse<T> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.tree) &&
    typeof v.root === 'string' &&
    typeof v.totalNodes === 'number' &&
    typeof v.maxDepth === 'number'
  );
}
