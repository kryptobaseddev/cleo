/**
 * WorkGraph containment reparent preflight checks.
 *
 * Evaluates proposed `tasks.parent_id` mutations before callers touch storage so
 * they can surface typed diagnostics for containment cycles, depth violations,
 * and hierarchy parent/type matrix breaches.
 *
 * @task T10578
 * @saga T10538
 */

import type {
  TaskType,
  WorkGraphHierarchyInputNode,
  WorkGraphHierarchyViolation,
} from '@cleocode/contracts';
import {
  type E_WORKGRAPH_PARENT_TYPE_MATRIX,
  validateWorkGraphHierarchy,
} from '@cleocode/contracts';

/** Stable error code for proposed containment cycles. */
export const E_WORKGRAPH_CONTAINMENT_CYCLE = 'E_WORKGRAPH_CONTAINMENT_CYCLE';

/** Stable error code for proposals exceeding the configured containment depth. */
export const E_WORKGRAPH_MAX_DEPTH_EXCEEDED = 'E_WORKGRAPH_MAX_DEPTH_EXCEEDED';

/** Stable error code for malformed reparent proposals. */
export const E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND = 'E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND';

/** Cycle diagnostic returned by WorkGraph reparent preflight. */
export interface WorkGraphContainmentCycleFinding {
  readonly code: typeof E_WORKGRAPH_CONTAINMENT_CYCLE;
  readonly taskId: string;
  readonly parentId: string;
  /** Containment path showing the proposed cycle, starting and ending at `taskId`. */
  readonly path: readonly string[];
  readonly message: string;
}

/** Depth diagnostic returned by WorkGraph reparent preflight. */
export interface WorkGraphMaxDepthFinding {
  readonly code: typeof E_WORKGRAPH_MAX_DEPTH_EXCEEDED;
  readonly taskId: string;
  readonly parentId: string | null;
  /** Proposed containment depth, measured as edges from hierarchy root to task. */
  readonly depth: number;
  readonly maxDepth: number;
  /** Proposed root-to-task containment path. */
  readonly path: readonly string[];
  readonly message: string;
}

/** Missing node diagnostic returned by WorkGraph reparent preflight. */
export interface WorkGraphReparentTargetNotFoundFinding {
  readonly code: typeof E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND;
  readonly taskId: string;
  readonly parentId: string | null;
  readonly missingId: string;
  readonly message: string;
}

/** Parent/type matrix diagnostic adapted from the hierarchy validator. */
export type WorkGraphReparentParentTypeFinding = WorkGraphHierarchyViolation & {
  readonly code: typeof E_WORKGRAPH_PARENT_TYPE_MATRIX;
};

/** Typed diagnostic returned by {@link preflightWorkGraphReparent}. */
export type WorkGraphReparentFinding =
  | WorkGraphContainmentCycleFinding
  | WorkGraphMaxDepthFinding
  | WorkGraphReparentTargetNotFoundFinding
  | WorkGraphReparentParentTypeFinding;

/** Input accepted by WorkGraph reparent preflight. */
export interface WorkGraphReparentPreflightInput {
  /** Current hierarchy snapshot. */
  readonly nodes: readonly WorkGraphHierarchyInputNode[];
  /** Node whose direct containment parent would change. */
  readonly taskId: string;
  /** Proposed direct containment parent; null/undefined means reparent to root. */
  readonly newParentId?: string | null;
  /** Maximum allowed containment depth. Defaults to CLEO's epic→task→subtask depth (2). */
  readonly maxDepth?: number;
}

/** Result returned by WorkGraph reparent preflight. */
export interface WorkGraphReparentPreflightResult {
  readonly taskId: string;
  readonly proposedParentId: string | null;
  readonly allowed: boolean;
  readonly findings: readonly WorkGraphReparentFinding[];
}

const DEFAULT_MAX_DEPTH = 2;

function makeNodeIndex(
  nodes: readonly WorkGraphHierarchyInputNode[],
): Map<string, WorkGraphHierarchyInputNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function proposedParentOf(
  node: WorkGraphHierarchyInputNode,
  taskId: string,
  proposedParentId: string | null,
): string | null {
  return node.id === taskId ? proposedParentId : (node.parentId ?? null);
}

function findCyclePath(
  input: WorkGraphReparentPreflightInput,
  byId: ReadonlyMap<string, WorkGraphHierarchyInputNode>,
): readonly string[] | null {
  const proposedParentId = input.newParentId ?? null;
  if (proposedParentId === null) return null;
  if (proposedParentId === input.taskId) return [input.taskId, input.taskId];

  const path = [input.taskId, proposedParentId];
  const seen = new Set<string>([input.taskId]);
  let cursorId: string | null = proposedParentId;

  while (cursorId !== null) {
    if (seen.has(cursorId)) return path;
    seen.add(cursorId);

    const cursor = byId.get(cursorId);
    if (!cursor) return null;

    cursorId = proposedParentOf(cursor, input.taskId, proposedParentId);
    if (cursorId !== null) path.push(cursorId);
    if (cursorId === input.taskId) return path;
  }

  return null;
}

function rootToTaskPath(
  input: WorkGraphReparentPreflightInput,
  byId: ReadonlyMap<string, WorkGraphHierarchyInputNode>,
): readonly string[] {
  const proposedParentId = input.newParentId ?? null;
  const reversed = [input.taskId];
  const seen = new Set<string>();
  let cursorId: string | null = proposedParentId;

  while (cursorId !== null && !seen.has(cursorId)) {
    seen.add(cursorId);
    reversed.push(cursorId);
    const cursor = byId.get(cursorId);
    if (!cursor) break;
    cursorId = proposedParentOf(cursor, input.taskId, proposedParentId);
  }

  return reversed.reverse();
}

function withProposedParent(
  nodes: readonly WorkGraphHierarchyInputNode[],
  taskId: string,
  proposedParentId: string | null,
): WorkGraphHierarchyInputNode[] {
  return nodes.map((node) => (node.id === taskId ? { ...node, parentId: proposedParentId } : node));
}

function missingTargetFindings(
  input: WorkGraphReparentPreflightInput,
  byId: ReadonlyMap<string, WorkGraphHierarchyInputNode>,
): WorkGraphReparentTargetNotFoundFinding[] {
  const proposedParentId = input.newParentId ?? null;
  const findings: WorkGraphReparentTargetNotFoundFinding[] = [];
  if (!byId.has(input.taskId)) {
    findings.push({
      code: E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND,
      taskId: input.taskId,
      parentId: proposedParentId,
      missingId: input.taskId,
      message: `Cannot preflight reparent for missing task ${input.taskId}`,
    });
  }
  if (proposedParentId !== null && !byId.has(proposedParentId)) {
    findings.push({
      code: E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND,
      taskId: input.taskId,
      parentId: proposedParentId,
      missingId: proposedParentId,
      message: `Cannot preflight reparent to missing parent ${proposedParentId}`,
    });
  }
  return findings;
}

function parentTypeFindings(
  input: WorkGraphReparentPreflightInput,
  proposedParentId: string | null,
): WorkGraphReparentParentTypeFinding[] {
  return validateWorkGraphHierarchy(withProposedParent(input.nodes, input.taskId, proposedParentId))
    .violations.filter((violation) => violation.taskId === input.taskId)
    .map((violation) => ({ ...violation }));
}

/**
 * Preflight a proposed WorkGraph containment reparent mutation.
 *
 * The function is storage-agnostic: callers pass the relevant hierarchy rows and
 * receive typed findings without mutating `tasks.parent_id`. It intentionally
 * combines graph checks with the existing hierarchy parent/type matrix so CLI,
 * API, and future adapters can return one deterministic diagnostic envelope.
 */
export function preflightWorkGraphReparent(
  input: WorkGraphReparentPreflightInput,
): WorkGraphReparentPreflightResult {
  const byId = makeNodeIndex(input.nodes);
  const proposedParentId = input.newParentId ?? null;
  const findings: WorkGraphReparentFinding[] = missingTargetFindings(input, byId);

  if (findings.length === 0) {
    const cyclePath = findCyclePath(input, byId);
    if (cyclePath) {
      findings.push({
        code: E_WORKGRAPH_CONTAINMENT_CYCLE,
        taskId: input.taskId,
        parentId: proposedParentId as string,
        path: cyclePath,
        message: `Reparenting ${input.taskId} under ${proposedParentId} would create a containment cycle`,
      });
    }

    const path = rootToTaskPath(input, byId);
    const depth = Math.max(0, path.length - 1);
    const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (depth > maxDepth) {
      findings.push({
        code: E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
        taskId: input.taskId,
        parentId: proposedParentId,
        depth,
        maxDepth,
        path,
        message: `Reparenting ${input.taskId} would create depth ${depth}, exceeding max depth ${maxDepth}`,
      });
    }

    findings.push(...parentTypeFindings(input, proposedParentId));
  }

  return {
    taskId: input.taskId,
    proposedParentId,
    allowed: findings.length === 0,
    findings,
  };
}

/** Task type alias retained here to keep generated API docs linking this module to TaskType. */
export type WorkGraphReparentNodeType = TaskType;
