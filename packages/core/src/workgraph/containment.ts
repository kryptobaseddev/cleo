/**
 * Batched WorkGraph containment queries backed by the canonical tasks.parent_id
 * hierarchy.
 *
 * This service intentionally reads only the `tasks` table. Saga membership and
 * other non-containment links remain relation-backed and are not consulted here.
 *
 * @task T10577
 * @saga T10538
 */

import type {
  VerificationGate,
  WorkGraphContainmentAncestorsResult,
  WorkGraphContainmentChildrenResult,
  WorkGraphContainmentNode,
  WorkGraphContainmentQueryService,
  WorkGraphEdge,
  WorkGraphNode,
  WorkGraphPageInfo,
  WorkGraphProjectionMismatch,
  WorkGraphReadyFrontierBlockedBy,
  WorkGraphReadyFrontierOptions,
  WorkGraphReadyFrontierResult,
  WorkGraphReadyFrontierTask,
  WorkGraphRollupCounts,
  WorkGraphSubtreePercentages,
  WorkGraphSubtreeSummaryOptions,
  WorkGraphSubtreeSummaryResult,
  WorkGraphTraversalOptions,
  WorkGraphTraversalResult,
  WorkGraphTreeNode,
  WorkGraphTreeOptions,
  WorkGraphTreeResult,
} from '@cleocode/contracts';

type TaskRow = {
  id: string;
  title: string;
  type: WorkGraphNode['type'];
  status: WorkGraphNode['status'];
  priority: WorkGraphNode['priority'];
  parent_id: string | null;
};

type AncestorTaskRow = TaskRow & {
  root_id: string;
  depth: number;
};

type ChildTaskRow = TaskRow & {
  root_id: string;
};

type DescendantTaskRow = TaskRow & {
  root_id: string;
  depth: number;
  sort_cursor: string;
};

type ReadyFrontierRow = TaskRow & {
  root_id: string;
  role: string | null;
  verification_json: string | null;
  depends_on: string | null;
  dep_status: WorkGraphNode['status'] | null;
};

type WorkGraphTaskStatus = WorkGraphNode['status'];
type WorkGraphTaskType = WorkGraphNode['type'];

const PERCENT_DENOMINATOR_DESCRIPTION =
  'percentages use subtree.total as the denominator, include archived descendants, and exclude the root node';
const TASK_STATUS_ORDER: readonly WorkGraphTaskStatus[] = [
  'pending',
  'active',
  'blocked',
  'done',
  'cancelled',
  'archived',
  'proposed',
];
const TASK_TYPE_ORDER: readonly WorkGraphTaskType[] = ['saga', 'epic', 'task', 'subtask'];
const VERIFICATION_GATE_ORDER: readonly VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
  'nexusImpact',
];
const DEPENDENCY_READY_STATUSES: ReadonlySet<WorkGraphTaskStatus> = new Set(['done', 'cancelled']);

export interface SqliteWorkGraphContainmentReader {
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
  };
}

const TASK_COLUMNS = 't.id, t.title, t.type, t.status, t.priority, t.parent_id';

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function emptyResults<T>(rootIds: readonly string[], key: 'ancestors' | 'children'): T[] {
  return uniqueIds(rootIds).map((rootId) => ({ rootId, [key]: [] }) as T);
}

function valuesCte(ids: readonly string[]): string {
  return ids.map(() => '(?)').join(', ');
}

function toNode(row: TaskRow): WorkGraphContainmentNode {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    priority: row.priority,
    parentId: row.parent_id ?? undefined,
  };
}

function toTreeNode(row: DescendantTaskRow): WorkGraphTreeNode {
  return { ...toNode(row), depth: row.depth };
}

function parseGateBlockers(verificationJson: string | null): { gate: VerificationGate }[] {
  if (verificationJson === null || verificationJson.trim() === '') return [];
  try {
    const parsed = JSON.parse(verificationJson) as {
      gates?: Partial<Record<VerificationGate, boolean | null>>;
    };
    const gates = parsed.gates ?? {};
    return VERIFICATION_GATE_ORDER.filter((gate) => gate in gates && gates[gate] !== true).map(
      (gate) => ({ gate }),
    );
  } catch {
    return [];
  }
}

function rollupBlockedBy(
  tasks: readonly WorkGraphReadyFrontierTask[],
): WorkGraphReadyFrontierBlockedBy[] {
  const dependencies = new Map<string, string[]>();
  const gates = new Map<VerificationGate, string[]>();

  for (const task of tasks) {
    for (const blocker of task.dependencyBlockers) {
      const blocks = dependencies.get(blocker.taskId) ?? [];
      blocks.push(task.id);
      dependencies.set(blocker.taskId, blocks);
    }
    for (const blocker of task.gateBlockers) {
      const blocks = gates.get(blocker.gate) ?? [];
      blocks.push(task.id);
      gates.set(blocker.gate, blocks);
    }
  }

  return [
    ...[...dependencies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([blockerId, blocks]) => ({ kind: 'dependency' as const, blockerId, blocks })),
    ...[...gates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gate, blocks]) => ({ kind: 'gate' as const, gate, blocks })),
  ];
}

function groupReadyFrontierRows(
  rootId: string,
  role: string | undefined,
  rows: readonly ReadyFrontierRow[],
): WorkGraphReadyFrontierResult {
  const byTask = new Map<string, WorkGraphReadyFrontierTask>();

  for (const row of rows) {
    const existing = byTask.get(row.id);
    const task =
      existing ??
      ({
        ...toNode(row),
        role: row.role ?? undefined,
        dependencyBlockers: [],
        gateBlockers: parseGateBlockers(row.verification_json),
      } satisfies WorkGraphReadyFrontierTask);

    if (
      row.depends_on !== null &&
      row.dep_status !== null &&
      !DEPENDENCY_READY_STATUSES.has(row.dep_status) &&
      !task.dependencyBlockers.some((blocker) => blocker.taskId === row.depends_on)
    ) {
      byTask.set(row.id, {
        ...task,
        dependencyBlockers: [
          ...task.dependencyBlockers,
          { taskId: row.depends_on, status: row.dep_status },
        ],
      });
      continue;
    }

    byTask.set(row.id, task);
  }

  const tasks = [...byTask.values()];
  const ready = tasks.filter((task) => task.dependencyBlockers.length === 0);
  const blocked = tasks.filter((task) => task.dependencyBlockers.length > 0);

  return { rootId, role, groups: { ready, blocked, blockedBy: rollupBlockedBy(tasks) } };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 500);
}

function normalizeMaxDepth(maxDepth: number | undefined): number | null {
  if (maxDepth === undefined) return null;
  if (!Number.isFinite(maxDepth)) return null;
  return Math.max(0, Math.floor(maxDepth));
}

function pageInfo(rows: readonly DescendantTaskRow[], limit: number): WorkGraphPageInfo {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = pageRows.at(-1)?.sort_cursor;
  return hasMore && nextCursor !== undefined ? { hasMore, nextCursor } : { hasMore };
}

function incrementBucket<T extends string>(bucket: Partial<Record<T, number>>, key: T): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function rollupRows(rows: readonly DescendantTaskRow[]): WorkGraphRollupCounts {
  const byStatus: Partial<Record<WorkGraphTaskStatus, number>> = {};
  const byType: Partial<Record<WorkGraphTaskType, number>> = {};
  for (const row of rows) {
    incrementBucket(byStatus, row.status);
    incrementBucket(byType, row.type);
  }
  return { total: rows.length, byStatus, byType };
}

function percentage(count: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((count / denominator) * 10000) / 100;
}

function subtreePercentages(rollup: WorkGraphRollupCounts): WorkGraphSubtreePercentages {
  return {
    active: percentage(rollup.byStatus.active ?? 0, rollup.total),
    blocked: percentage(rollup.byStatus.blocked ?? 0, rollup.total),
    cancelled: percentage(rollup.byStatus.cancelled ?? 0, rollup.total),
    done: percentage(rollup.byStatus.done ?? 0, rollup.total),
    pending: percentage(rollup.byStatus.pending ?? 0, rollup.total),
  };
}

function compareProjectedRollup(
  actual: WorkGraphRollupCounts,
  expected: WorkGraphRollupCounts | undefined,
): WorkGraphProjectionMismatch[] {
  if (expected === undefined) return [];
  const mismatches: WorkGraphProjectionMismatch[] = [];
  if (actual.total !== expected.total) {
    mismatches.push({ field: 'total', expected: expected.total, actual: actual.total });
  }
  for (const status of TASK_STATUS_ORDER) {
    const actualCount = actual.byStatus[status] ?? 0;
    const expectedCount = expected.byStatus[status] ?? 0;
    if (actualCount !== expectedCount) {
      mismatches.push({ field: `status:${status}`, expected: expectedCount, actual: actualCount });
    }
  }
  for (const type of TASK_TYPE_ORDER) {
    const actualCount = actual.byType[type] ?? 0;
    const expectedCount = expected.byType[type] ?? 0;
    if (actualCount !== expectedCount) {
      mismatches.push({ field: `type:${type}`, expected: expectedCount, actual: actualCount });
    }
  }
  return mismatches;
}

function containmentEdge(parentId: string, childId: string): WorkGraphEdge {
  return { fromId: parentId, toId: childId, kind: 'contains' };
}

function resultBuckets(rootIds: readonly string[]): Map<string, WorkGraphContainmentNode[]> {
  return new Map(uniqueIds(rootIds).map((rootId) => [rootId, []]));
}

/** SQLite implementation of batched containment lookups for WorkGraph callers. */
export class SqliteWorkGraphContainmentQueryService implements WorkGraphContainmentQueryService {
  readonly #db: SqliteWorkGraphContainmentReader;

  constructor(db: SqliteWorkGraphContainmentReader) {
    this.#db = db;
  }

  /**
   * Load ancestor chains for many roots using a single recursive CTE over
   * `tasks.parent_id`.
   *
   * Results are ordered root-first within each ancestor chain.
   */
  getAncestors(rootIds: readonly string[]): readonly WorkGraphContainmentAncestorsResult[] {
    const ids = uniqueIds(rootIds);
    if (ids.length === 0) return emptyResults(ids, 'ancestors');

    const sql = `WITH RECURSIVE input(root_id) AS (VALUES ${valuesCte(ids)}),
ancestor_edges(root_id, id, depth) AS (
  SELECT input.root_id, root.parent_id, 1
  FROM input
  JOIN tasks_tasks root ON root.id = input.root_id
  WHERE root.parent_id IS NOT NULL
  UNION ALL
  SELECT ancestor_edges.root_id, parent.parent_id, ancestor_edges.depth + 1
  FROM ancestor_edges
  JOIN tasks_tasks parent ON parent.id = ancestor_edges.id
  WHERE parent.parent_id IS NOT NULL
)
SELECT ancestor_edges.root_id, ancestor_edges.depth, ${TASK_COLUMNS}
FROM ancestor_edges
JOIN tasks_tasks t ON t.id = ancestor_edges.id
ORDER BY ancestor_edges.root_id ASC, ancestor_edges.depth DESC`;

    const rows = this.#db.prepare(sql).all(...ids) as AncestorTaskRow[];
    const buckets = resultBuckets(ids);
    for (const row of rows) buckets.get(row.root_id)?.push(toNode(row));

    return ids.map((rootId) => ({ rootId, ancestors: buckets.get(rootId) ?? [] }));
  }

  /**
   * Load direct children for many parents using one `parent_id IN (...)` query.
   * Descendants are intentionally not expanded here.
   */
  getChildren(parentIds: readonly string[]): readonly WorkGraphContainmentChildrenResult[] {
    const ids = uniqueIds(parentIds);
    if (ids.length === 0) return emptyResults(ids, 'children');

    const placeholders = ids.map(() => '?').join(', ');
    const sql = `SELECT t.parent_id AS root_id, ${TASK_COLUMNS}
FROM tasks_tasks t
WHERE t.parent_id IN (${placeholders})
ORDER BY t.parent_id ASC, t.position ASC, t.created_at ASC, t.id ASC`;

    const rows = this.#db.prepare(sql).all(...ids) as ChildTaskRow[];
    const buckets = resultBuckets(ids);
    for (const row of rows) buckets.get(row.root_id)?.push(toNode(row));

    return ids.map((rootId) => ({ rootId, children: buckets.get(rootId) ?? [] }));
  }

  /**
   * Read a paginated descendant tree using one recursive CTE.
   *
   * The final row order is breadth-first and stable, and `limit + 1` rows are
   * fetched so callers can page without issuing per-node child lookups.
   */
  tree(options: WorkGraphTreeOptions): WorkGraphTreeResult {
    const limit = normalizeLimit(options.limit);
    const maxDepth = normalizeMaxDepth(options.maxDepth);
    if (maxDepth === 0) {
      return { rootId: options.rootId, nodes: [], edges: [], pageInfo: { hasMore: false } };
    }

    const sql = `WITH RECURSIVE descendants(root_id, id, depth) AS (
  SELECT ? AS root_id, child.id, 1
  FROM tasks_tasks child
  WHERE child.parent_id = ?
  UNION ALL
  SELECT descendants.root_id, child.id, descendants.depth + 1
  FROM descendants
  JOIN tasks_tasks parent ON parent.id = descendants.id
  JOIN tasks_tasks child ON child.parent_id = parent.id
  WHERE (? IS NULL OR descendants.depth < ?)
), ordered AS (
  SELECT descendants.root_id,
         descendants.depth,
         printf('%08d:%s', descendants.depth, t.id) AS sort_cursor,
         ${TASK_COLUMNS}
  FROM descendants
  JOIN tasks_tasks t ON t.id = descendants.id
)
SELECT *
FROM ordered
WHERE (? IS NULL OR sort_cursor > ?)
ORDER BY sort_cursor ASC
LIMIT ?`;

    const cursor = options.cursor ?? null;
    const rows = this.#db
      .prepare(sql)
      .all(
        options.rootId,
        options.rootId,
        maxDepth,
        maxDepth,
        cursor,
        cursor,
        limit + 1,
      ) as DescendantTaskRow[];
    const info = pageInfo(rows, limit);
    const pageRows = info.hasMore ? rows.slice(0, limit) : rows;
    const nodes = pageRows.map(toTreeNode);
    const edges = pageRows.map((row) => containmentEdge(row.parent_id ?? options.rootId, row.id));

    return { rootId: options.rootId, nodes, edges, pageInfo: info };
  }

  /**
   * Summarize direct and full-subtree descendant counts for one root.
   *
   * Percentages are intentionally tied to the full subtree denominator and the
   * optional direct projection comparison lets callers detect stale cached child
   * rollups without trusting any derived storage column.
   */
  summarizeSubtree(options: WorkGraphSubtreeSummaryOptions): WorkGraphSubtreeSummaryResult {
    const sql = `WITH RECURSIVE summary_descendants(root_id, id, depth) AS (
  SELECT ? AS root_id, child.id, 1
  FROM tasks_tasks child
  WHERE child.parent_id = ?
  UNION ALL
  SELECT summary_descendants.root_id, child.id, summary_descendants.depth + 1
  FROM summary_descendants
  JOIN tasks_tasks parent ON parent.id = summary_descendants.id
  JOIN tasks_tasks child ON child.parent_id = parent.id
)
SELECT summary_descendants.root_id,
       summary_descendants.depth,
       printf('%08d:%s', summary_descendants.depth, t.id) AS sort_cursor,
       ${TASK_COLUMNS}
FROM summary_descendants
JOIN tasks_tasks t ON t.id = summary_descendants.id
ORDER BY sort_cursor ASC`;

    const rows = this.#db.prepare(sql).all(options.rootId, options.rootId) as DescendantTaskRow[];
    const direct = rollupRows(rows.filter((row) => row.depth === 1));
    const subtree = rollupRows(rows);
    const projectionMismatches = compareProjectedRollup(direct, options.expectedDirectRollup);

    return {
      rootId: options.rootId,
      direct,
      subtree,
      percentDenominator: {
        basis: 'subtree-total',
        total: subtree.total,
        description: PERCENT_DENOMINATOR_DESCRIPTION,
      },
      percentages: subtreePercentages(subtree),
      staleProjection: projectionMismatches.length > 0,
      projectionMismatches,
    };
  }

  /**
   * Group runnable frontier descendants by dependency readiness while preserving
   * gate metadata for verification diagnostics.
   */
  readyFrontier(options: WorkGraphReadyFrontierOptions): WorkGraphReadyFrontierResult {
    const roleFilter = options.role === undefined ? '' : 'AND t.role = ?';
    const sql = `WITH RECURSIVE ready_frontier_scope(root_id, id) AS (
  SELECT ? AS root_id, child.id
  FROM tasks_tasks child
  WHERE child.parent_id = ?
  UNION ALL
  SELECT ready_frontier_scope.root_id, child.id
  FROM ready_frontier_scope
  JOIN tasks_tasks parent ON parent.id = ready_frontier_scope.id
  JOIN tasks_tasks child ON child.parent_id = parent.id
)
SELECT ready_frontier_scope.root_id,
       t.id,
       t.title,
       t.type,
       t.status,
       t.priority,
       t.parent_id,
       t.role,
       t.verification_json,
       td.depends_on,
       dep.status AS dep_status
FROM ready_frontier_scope
JOIN tasks_tasks t ON t.id = ready_frontier_scope.id
LEFT JOIN tasks_task_dependencies td ON td.task_id = t.id
LEFT JOIN tasks_tasks dep ON dep.id = td.depends_on
WHERE t.status IN ('pending', 'active', 'blocked', 'proposed')
${roleFilter}
ORDER BY t.priority ASC, t.created_at ASC, t.id ASC, td.depends_on ASC`;

    const params =
      options.role === undefined
        ? [options.rootId, options.rootId]
        : [options.rootId, options.rootId, options.role];
    const rows = this.#db.prepare(sql).all(...params) as ReadyFrontierRow[];
    return groupReadyFrontierRows(options.rootId, options.role, rows);
  }

  /** Traverse descendant containment from a root with cursor/limit and max depth support. */
  traverse(options: WorkGraphTraversalOptions): WorkGraphTraversalResult {
    if (options.direction !== 'descendants') {
      return {
        rootId: options.rootId,
        direction: options.direction,
        nodes: [],
        edges: [],
        pageInfo: { hasMore: false },
      };
    }

    const tree = this.tree(options);
    return {
      rootId: options.rootId,
      direction: options.direction,
      nodes: tree.nodes,
      edges: tree.edges,
      pageInfo: tree.pageInfo,
    };
  }
}

/** Create a WorkGraph containment query service over an already-open SQLite DB. */
export function createSqliteWorkGraphContainmentQueryService(
  db: SqliteWorkGraphContainmentReader,
): WorkGraphContainmentQueryService {
  return new SqliteWorkGraphContainmentQueryService(db);
}
