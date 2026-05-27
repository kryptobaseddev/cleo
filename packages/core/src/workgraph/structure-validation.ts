/**
 * WorkGraph structural validation checks.
 *
 * Produces typed, paginated diagnostics for whole-graph integrity audits: parent
 * cycles, orphaned parent references, maximum containment depth, parent fanout,
 * and missing Wave 0 bootstrap coverage.
 *
 * @task T10583
 * @saga T10538
 */

import type { TaskType, WorkGraphPageInfo } from '@cleocode/contracts';
import {
  E_WORKGRAPH_CONTAINMENT_CYCLE,
  E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
} from './reparent-preflight.js';

/** Stable error code for nodes whose parent_id points at a missing task. */
export const E_WORKGRAPH_ORPHANED_NODE = 'E_WORKGRAPH_ORPHANED_NODE';

/** Stable error code for parents with too many direct children. */
export const E_WORKGRAPH_FANOUT_EXCEEDED = 'E_WORKGRAPH_FANOUT_EXCEEDED';

/** Stable error code for wave-partitioned scopes with no Wave 0 row. */
export const E_WORKGRAPH_MISSING_WAVE_ZERO = 'E_WORKGRAPH_MISSING_WAVE_ZERO';

/** Minimal task row accepted by structural WorkGraph validation. */
export interface WorkGraphStructureInputNode {
  /** Stable task, saga, epic, or subtask identifier. */
  readonly id: string;
  /** Canonical hierarchy discriminator for the node. */
  readonly type: TaskType;
  /** Direct containment parent; absent/null means root. */
  readonly parentId?: string | null;
  /** Optional orchestration wave number copied from task metadata/projections. */
  readonly wave?: number | null;
}

/** Cycle diagnostic returned by structural WorkGraph validation. */
export interface WorkGraphStructureCycleFinding {
  readonly code: typeof E_WORKGRAPH_CONTAINMENT_CYCLE;
  readonly taskId: string;
  /** Containment path showing the cycle, starting and ending at `taskId`. */
  readonly path: readonly string[];
  readonly message: string;
}

/** Orphan diagnostic returned by structural WorkGraph validation. */
export interface WorkGraphStructureOrphanFinding {
  readonly code: typeof E_WORKGRAPH_ORPHANED_NODE;
  readonly taskId: string;
  readonly parentId: string;
  readonly message: string;
}

/** Depth diagnostic returned by structural WorkGraph validation. */
export interface WorkGraphStructureDepthFinding {
  readonly code: typeof E_WORKGRAPH_MAX_DEPTH_EXCEEDED;
  readonly taskId: string;
  /** Containment depth measured as edges from hierarchy root to task. */
  readonly depth: number;
  readonly maxDepth: number;
  /** Root-to-task containment path. */
  readonly path: readonly string[];
  readonly message: string;
}

/** Fanout diagnostic returned by structural WorkGraph validation. */
export interface WorkGraphStructureFanoutFinding {
  readonly code: typeof E_WORKGRAPH_FANOUT_EXCEEDED;
  readonly parentId: string;
  readonly fanout: number;
  readonly maxFanout: number;
  /** Direct child IDs in stable input order. */
  readonly childIds: readonly string[];
  readonly message: string;
}

/** Missing Wave 0 diagnostic returned by structural WorkGraph validation. */
export interface WorkGraphStructureMissingWaveZeroFinding {
  readonly code: typeof E_WORKGRAPH_MISSING_WAVE_ZERO;
  readonly scopeId?: string;
  /** Distinct waves present in the validated scope. */
  readonly waves: readonly number[];
  readonly message: string;
}

/** Typed diagnostic returned by structural WorkGraph validation. */
export type WorkGraphStructureFinding =
  | WorkGraphStructureCycleFinding
  | WorkGraphStructureOrphanFinding
  | WorkGraphStructureDepthFinding
  | WorkGraphStructureFanoutFinding
  | WorkGraphStructureMissingWaveZeroFinding;

/** Options for structural WorkGraph validation. */
export interface WorkGraphStructureValidationOptions {
  /** Scope ID to echo on scope-wide findings such as missing Wave 0. */
  readonly scopeId?: string;
  /** Maximum allowed containment depth. Defaults to CLEO's epic→task→subtask depth (2). */
  readonly maxDepth?: number;
  /** Maximum allowed direct children per parent. Defaults to unlimited. */
  readonly maxFanout?: number;
  /** Opaque finding cursor returned by the previous page. */
  readonly cursor?: string;
  /** Maximum findings to return. Defaults to 100 and clamps to 500. */
  readonly limit?: number;
}

/** Result returned by structural WorkGraph validation. */
export interface WorkGraphStructureValidationResult {
  readonly valid: boolean;
  readonly findings: readonly WorkGraphStructureFinding[];
  /** Total findings before pagination is applied. */
  readonly totalFindings: number;
  /** Page metadata for follow-up reads over large finding sets. */
  readonly pageInfo: WorkGraphPageInfo;
}

const DEFAULT_MAX_DEPTH = 2;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 500);
}

function normalizeOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor.trim() === '') return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pageFindings(
  findings: readonly WorkGraphStructureFinding[],
  options: WorkGraphStructureValidationOptions,
): { findings: readonly WorkGraphStructureFinding[]; pageInfo: WorkGraphPageInfo } {
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.cursor);
  const page = findings.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < findings.length;
  return {
    findings: page,
    pageInfo: hasMore ? { hasMore, nextCursor: String(nextOffset) } : { hasMore },
  };
}

function parentIdOf(node: WorkGraphStructureInputNode): string | null {
  return node.parentId ?? null;
}

function findCyclePath(
  node: WorkGraphStructureInputNode,
  byId: ReadonlyMap<string, WorkGraphStructureInputNode>,
): readonly string[] | null {
  const path: string[] = [];
  const seenIndex = new Map<string, number>();
  let cursor: WorkGraphStructureInputNode | undefined = node;

  while (cursor !== undefined) {
    const existingIndex = seenIndex.get(cursor.id);
    if (existingIndex !== undefined) return [...path.slice(existingIndex), cursor.id];

    seenIndex.set(cursor.id, path.length);
    path.push(cursor.id);

    const parentId = parentIdOf(cursor);
    if (parentId === null) return null;
    cursor = byId.get(parentId);
  }

  return null;
}

function cycleKey(path: readonly string[]): string {
  return [...new Set(path.slice(0, -1))].sort().join('\u0000');
}

function rootToTaskPath(
  node: WorkGraphStructureInputNode,
  byId: ReadonlyMap<string, WorkGraphStructureInputNode>,
): readonly string[] | null {
  const reversed: string[] = [];
  const seen = new Set<string>();
  let cursor: WorkGraphStructureInputNode | undefined = node;

  while (cursor !== undefined) {
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    reversed.push(cursor.id);

    const parentId = parentIdOf(cursor);
    if (parentId === null) return reversed.reverse();
    cursor = byId.get(parentId);
  }

  return null;
}

function collectCycleFindings(
  nodes: readonly WorkGraphStructureInputNode[],
  byId: ReadonlyMap<string, WorkGraphStructureInputNode>,
): WorkGraphStructureCycleFinding[] {
  const emitted = new Set<string>();
  const findings: WorkGraphStructureCycleFinding[] = [];

  for (const node of nodes) {
    const path = findCyclePath(node, byId);
    if (path === null) continue;
    const key = cycleKey(path);
    if (emitted.has(key)) continue;
    emitted.add(key);
    findings.push({
      code: E_WORKGRAPH_CONTAINMENT_CYCLE,
      taskId: path[0] ?? node.id,
      path,
      message: `Containment parent_id chain contains a cycle: ${path.join(' -> ')}`,
    });
  }

  return findings;
}

function collectOrphanFindings(
  nodes: readonly WorkGraphStructureInputNode[],
  byId: ReadonlyMap<string, WorkGraphStructureInputNode>,
): WorkGraphStructureOrphanFinding[] {
  return nodes.flatMap((node) => {
    const parentId = parentIdOf(node);
    if (parentId === null || byId.has(parentId)) return [];
    return [
      {
        code: E_WORKGRAPH_ORPHANED_NODE,
        taskId: node.id,
        parentId,
        message: `Task ${node.id} references missing parent_id ${parentId}`,
      },
    ];
  });
}

function collectDepthFindings(
  nodes: readonly WorkGraphStructureInputNode[],
  byId: ReadonlyMap<string, WorkGraphStructureInputNode>,
  maxDepth: number,
): WorkGraphStructureDepthFinding[] {
  const findings: WorkGraphStructureDepthFinding[] = [];

  for (const node of nodes) {
    const path = rootToTaskPath(node, byId);
    if (path === null) continue;
    const depth = Math.max(0, path.length - 1);
    if (depth <= maxDepth) continue;
    findings.push({
      code: E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
      taskId: node.id,
      depth,
      maxDepth,
      path,
      message: `Task ${node.id} has containment depth ${depth}, exceeding max depth ${maxDepth}`,
    });
  }

  return findings;
}

function collectFanoutFindings(
  nodes: readonly WorkGraphStructureInputNode[],
  maxFanout: number | undefined,
): WorkGraphStructureFanoutFinding[] {
  if (maxFanout === undefined || !Number.isFinite(maxFanout) || maxFanout < 0) return [];
  const limit = Math.floor(maxFanout);
  const childIdsByParent = new Map<string, string[]>();

  for (const node of nodes) {
    const parentId = parentIdOf(node);
    if (parentId === null) continue;
    const childIds = childIdsByParent.get(parentId) ?? [];
    childIds.push(node.id);
    childIdsByParent.set(parentId, childIds);
  }

  return [...childIdsByParent.entries()].flatMap(([parentId, childIds]) => {
    if (childIds.length <= limit) return [];
    return [
      {
        code: E_WORKGRAPH_FANOUT_EXCEEDED,
        parentId,
        fanout: childIds.length,
        maxFanout: limit,
        childIds,
        message: `Parent ${parentId} has fanout ${childIds.length}, exceeding max fanout ${limit}`,
      },
    ];
  });
}

function collectMissingWaveZeroFinding(
  nodes: readonly WorkGraphStructureInputNode[],
  scopeId: string | undefined,
): WorkGraphStructureMissingWaveZeroFinding[] {
  const waves = [
    ...new Set(
      nodes.map((node) => node.wave).filter((wave): wave is number => typeof wave === 'number'),
    ),
  ].sort((left, right) => left - right);
  if (waves.length === 0 || waves.includes(0)) return [];
  return [
    {
      code: E_WORKGRAPH_MISSING_WAVE_ZERO,
      scopeId,
      waves,
      message: `WorkGraph scope${scopeId === undefined ? '' : ` ${scopeId}`} has waves ${waves.join(', ')} but no Wave 0`,
    },
  ];
}

/**
 * Validate a WorkGraph snapshot for structural integrity.
 *
 * Findings are computed in deterministic groups (cycles, orphans, depth, fanout,
 * scope-wide wave diagnostics) and then paginated so large graph audits can be
 * consumed incrementally without changing the total diagnostic count.
 */
export function validateWorkGraphStructure(
  nodes: readonly WorkGraphStructureInputNode[],
  options: WorkGraphStructureValidationOptions = {},
): WorkGraphStructureValidationResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const allFindings: WorkGraphStructureFinding[] = [
    ...collectCycleFindings(nodes, byId),
    ...collectOrphanFindings(nodes, byId),
    ...collectDepthFindings(nodes, byId, maxDepth),
    ...collectFanoutFindings(nodes, options.maxFanout),
    ...collectMissingWaveZeroFinding(nodes, options.scopeId),
  ];
  const paged = pageFindings(allFindings, options);

  return {
    valid: allFindings.length === 0,
    findings: paged.findings,
    totalFindings: allFindings.length,
    pageInfo: paged.pageInfo,
  };
}
