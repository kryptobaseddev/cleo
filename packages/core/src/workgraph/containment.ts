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
  WorkGraphNode,
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

export interface SqliteWorkGraphContainmentReader {
  prepare(sql: string): {
    all(...params: readonly string[]): unknown[];
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
}

/** Create a WorkGraph containment query service over an already-open SQLite DB. */
export function createSqliteWorkGraphContainmentQueryService(
  db: SqliteWorkGraphContainmentReader,
): WorkGraphContainmentQueryService {
  return new SqliteWorkGraphContainmentQueryService(db);
}
