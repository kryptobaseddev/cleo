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
  WorkGraphContainmentAncestorsResult,
  WorkGraphContainmentChildrenResult,
  WorkGraphContainmentNode,
  WorkGraphContainmentQueryService,
  WorkGraphEdge,
  WorkGraphNode,
  WorkGraphPageInfo,
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
  JOIN tasks root ON root.id = input.root_id
  WHERE root.parent_id IS NOT NULL
  UNION ALL
  SELECT ancestor_edges.root_id, parent.parent_id, ancestor_edges.depth + 1
  FROM ancestor_edges
  JOIN tasks parent ON parent.id = ancestor_edges.id
  WHERE parent.parent_id IS NOT NULL
)
SELECT ancestor_edges.root_id, ancestor_edges.depth, ${TASK_COLUMNS}
FROM ancestor_edges
JOIN tasks t ON t.id = ancestor_edges.id
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
FROM tasks t
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
  FROM tasks child
  WHERE child.parent_id = ?
  UNION ALL
  SELECT descendants.root_id, child.id, descendants.depth + 1
  FROM descendants
  JOIN tasks parent ON parent.id = descendants.id
  JOIN tasks child ON child.parent_id = parent.id
  WHERE (? IS NULL OR descendants.depth < ?)
), ordered AS (
  SELECT descendants.root_id,
         descendants.depth,
         printf('%08d:%s', descendants.depth, t.id) AS sort_cursor,
         ${TASK_COLUMNS}
  FROM descendants
  JOIN tasks t ON t.id = descendants.id
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
