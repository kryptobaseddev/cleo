/**
 * WorkGraph scaffold validation — dry-run validator for saga/epic/task scaffold proposals.
 *
 * Validates YAML/JSON scaffold payloads before they are applied to storage.
 * Runs hierarchy, structural, and edge-reference checks and returns structured
 * diagnostics that consumers can use to preview and gate scaffold mutations.
 *
 * @task T10632
 * @saga T10538
 * @epic T10547
 */

import type {
  WorkGraphDirectEdge,
  WorkGraphHierarchyInputNode,
  WorkGraphHierarchyValidationResult,
  WorkGraphScaffoldValidateParams,
  WorkGraphScaffoldValidateResult,
  WorkGraphScaffoldValidationIssue,
} from '@cleocode/contracts';
import { validateWorkGraphHierarchy } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable error code for scaffold nodes with missing or empty IDs. */
export const E_WORKGRAPH_SCAFFOLD_MISSING_ID = 'E_WORKGRAPH_SCAFFOLD_MISSING_ID';

/** Stable error code for scaffold nodes with an invalid type. */
export const E_WORKGRAPH_SCAFFOLD_INVALID_TYPE = 'E_WORKGRAPH_SCAFFOLD_INVALID_TYPE';

/** Stable error code for edge endpoints that don't reference any scaffold node. */
export const E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT = 'E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT';

/** Stable error code for edges that connect a node to itself. */
export const E_WORKGRAPH_SCAFFOLD_SELF_LOOP = 'E_WORKGRAPH_SCAFFOLD_SELF_LOOP';

/** Stable error code for duplicate node IDs within a single scaffold payload. */
export const E_WORKGRAPH_SCAFFOLD_DUPLICATE_ID = 'E_WORKGRAPH_SCAFFOLD_DUPLICATE_ID';

/** Stable error code for invalid edge kind values. */
export const E_WORKGRAPH_SCAFFOLD_INVALID_EDGE_KIND = 'E_WORKGRAPH_SCAFFOLD_INVALID_EDGE_KIND';

/** Stable error code for edge/edge fanout exceeding the configured limit. */
export const E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED = 'E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED';

/** Valid task types for scaffold nodes. */
const VALID_TASK_TYPES = new Set(['saga', 'epic', 'task', 'subtask']);

/** Valid WorkGraph relation kinds for scaffold edges. */
const VALID_EDGE_KINDS = new Set([
  'contains',
  'depends_on',
  'blocks',
  'relates_to',
  'groups',
  'satisfies',
]);

/** Default max fanout when none is configured. */
const DEFAULT_MAX_FANOUT = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeIssue(
  code: string,
  message: string,
  taskId?: string,
  severity: 'error' | 'warning' = 'error',
): WorkGraphScaffoldValidationIssue {
  return { code, message, taskId, severity };
}

function validateNodeIds(
  nodes: readonly WorkGraphHierarchyInputNode[],
): WorkGraphScaffoldValidationIssue[] {
  const issues: WorkGraphScaffoldValidationIssue[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node.id || node.id.trim() === '') {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_MISSING_ID,
          'Scaffold node has a missing or empty id field',
          undefined,
          'error',
        ),
      );
      continue;
    }

    if (seen.has(node.id)) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_DUPLICATE_ID,
          `Duplicate node ID "${node.id}" in scaffold payload`,
          node.id,
          'error',
        ),
      );
    }
    seen.add(node.id);
  }

  return issues;
}

function validateNodeTypes(
  nodes: readonly WorkGraphHierarchyInputNode[],
): WorkGraphScaffoldValidationIssue[] {
  const issues: WorkGraphScaffoldValidationIssue[] = [];

  for (const node of nodes) {
    if (!VALID_TASK_TYPES.has(node.type)) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_INVALID_TYPE,
          `Node "${node.id}" has invalid type "${node.type}". Must be one of: ${[...VALID_TASK_TYPES].join(', ')}`,
          node.id,
          'error',
        ),
      );
    }
  }

  return issues;
}

function validateEdges(
  nodes: readonly WorkGraphHierarchyInputNode[],
  edges: readonly WorkGraphDirectEdge[] | undefined,
): WorkGraphScaffoldValidationIssue[] {
  if (!edges || edges.length === 0) return [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const issues: WorkGraphScaffoldValidationIssue[] = [];

  for (const edge of edges) {
    // Check both endpoints exist
    if (!nodeIds.has(edge.fromId)) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT,
          `Edge from "${edge.fromId}" to "${edge.toId}" references missing source node "${edge.fromId}"`,
          edge.fromId,
          'error',
        ),
      );
    }
    if (!nodeIds.has(edge.toId)) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT,
          `Edge from "${edge.fromId}" to "${edge.toId}" references missing target node "${edge.toId}"`,
          edge.toId,
          'error',
        ),
      );
    }

    // Check for self-loops
    if (edge.fromId === edge.toId) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_SELF_LOOP,
          `Edge self-loop detected: "${edge.fromId}" cannot reference itself`,
          edge.fromId,
          'error',
        ),
      );
    }

    // Check valid edge kind
    if (!VALID_EDGE_KINDS.has(edge.kind)) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_INVALID_EDGE_KIND,
          `Edge from "${edge.fromId}" to "${edge.toId}" has invalid kind "${String(edge.kind)}"`,
          edge.fromId,
          'error',
        ),
      );
    }
  }

  return issues;
}

function validateFanout(
  nodes: readonly WorkGraphHierarchyInputNode[],
  maxFanout: number,
): WorkGraphScaffoldValidationIssue[] {
  if (!Number.isFinite(maxFanout)) return [];

  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    if (parentId === null) continue;
    childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
  }

  const issues: WorkGraphScaffoldValidationIssue[] = [];
  for (const [parentId, count] of childCounts) {
    if (count > maxFanout) {
      issues.push(
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED,
          `Parent "${parentId}" has ${count} direct children, exceeding max fanout of ${maxFanout}`,
          parentId,
          'warning',
        ),
      );
    }
  }

  return issues;
}

/**
 * Options for scaffold validation beyond the standard params.
 */
export interface WorkGraphScaffoldValidateOptions {
  /** Maximum allowed direct children per parent. Defaults to unlimited. */
  readonly maxFanout?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a WorkGraph scaffold proposal before applying it to storage.
 *
 * Checks:
 * - Every node has a non-empty ID and a valid type (saga|epic|task|subtask)
 * - No duplicate node IDs in the payload
 * - Hierarchy parent/type matrix via {@link validateWorkGraphHierarchy}
 * - Edge endpoints reference existing scaffold nodes
 * - No self-loops in edge definitions
 * - Edge kinds are valid WorkGraph relation kinds
 * - Optional fanout limits on direct children per parent
 *
 * When `dryRun` is `true` (the default), the validator runs in preview mode
 * that echoes the flag back to callers so they can share validate/apply plumbing.
 *
 * @param params - Scaffold payload to validate.
 * @param options - Optional validation tuning (maxFanout).
 * @returns Structured validation result with validity flag, issues, and hierarchy diagnostics.
 */
export function validateWorkGraphScaffold(
  params: WorkGraphScaffoldValidateParams,
  options: WorkGraphScaffoldValidateOptions = {},
): WorkGraphScaffoldValidateResult {
  const { rootId, nodes, edges } = params;
  const dryRun = params.dryRun !== false; // default true (AC3)

  const maxFanout = options.maxFanout ?? DEFAULT_MAX_FANOUT;

  // Phase 1: ID and type validation
  const idIssues = validateNodeIds(nodes);
  const typeIssues = validateNodeTypes(nodes);

  // Phase 2: Hierarchy validation (parent/type matrix)
  let hierarchyResult: WorkGraphHierarchyValidationResult;
  try {
    hierarchyResult = validateWorkGraphHierarchy(nodes);
  } catch {
    hierarchyResult = {
      valid: false,
      violations: [
        {
          code: 'E_WORKGRAPH_PARENT_TYPE_MATRIX' as const,
          taskId: '<unknown>',
          taskType: 'task',
          parentId: null,
          message: 'Hierarchy validation threw an unexpected error',
        },
      ],
    };
  }

  // Phase 3: Edge validation
  const edgeIssues = validateEdges(nodes, edges);

  // Phase 4: Fanout
  const fanoutIssues = validateFanout(nodes, maxFanout);

  // Collect all issues — hierarchy violations become scaffold issues
  const hierarchyIssues: WorkGraphScaffoldValidationIssue[] = hierarchyResult.violations.map(
    (v) => ({
      code: v.code,
      message: v.message,
      taskId: v.taskId,
      severity: 'error' as const,
    }),
  );

  const allIssues: WorkGraphScaffoldValidationIssue[] = [
    ...idIssues,
    ...typeIssues,
    ...hierarchyIssues,
    ...edgeIssues,
    ...fanoutIssues,
  ];

  const valid = allIssues.length === 0 || allIssues.every((issue) => issue.severity !== 'error');

  return {
    rootId,
    valid,
    dryRun,
    issues: allIssues,
    hierarchy: hierarchyResult,
  };
}
