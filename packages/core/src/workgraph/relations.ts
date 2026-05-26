/**
 * Direct WorkGraph relation-edge queries backed by task_relations.
 *
 * This service keeps advisory relation rows separate from scheduler dependency
 * rows. Dependencies are only returned when explicitly requested, and every edge
 * is tagged with its storage source so callers cannot confuse the semantics.
 *
 * @task T10582
 * @saga T10538
 */

import type {
  WorkGraphDependencyEdge,
  WorkGraphDirectEdge,
  WorkGraphEdgeDirection,
  WorkGraphRelationEdge,
  WorkGraphRelationEdgesOptions,
  WorkGraphRelationEdgesResult,
  WorkGraphRelationKind,
  WorkGraphRelationQueryService,
  WorkGraphTaskRelationType,
} from '@cleocode/contracts';

export interface SqliteWorkGraphRelationReader {
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
  };
}

type RelationRow = {
  task_id: string;
  related_to: string;
  relation_type: WorkGraphTaskRelationType;
  reason: string | null;
};

type DependencyRow = {
  task_id: string;
  depends_on: string;
};

const DEFAULT_DIRECTION: WorkGraphEdgeDirection = 'both';

function normalizeDirection(direction: WorkGraphEdgeDirection | undefined): WorkGraphEdgeDirection {
  return direction ?? DEFAULT_DIRECTION;
}

function relationKind(relationType: WorkGraphTaskRelationType): WorkGraphRelationKind {
  switch (relationType) {
    case 'blocks':
      return 'blocks';
    case 'groups':
      return 'groups';
    default:
      return 'relates_to';
  }
}

function directionWhere(
  direction: WorkGraphEdgeDirection,
  sourceColumn: string,
  targetColumn: string,
): { clause: string; params: readonly number[] } {
  switch (direction) {
    case 'out':
      return { clause: `${sourceColumn} = ?`, params: [0] };
    case 'in':
      return { clause: `${targetColumn} = ?`, params: [0] };
    case 'both':
      return { clause: `(${sourceColumn} = ? OR ${targetColumn} = ?)`, params: [0, 0] };
    default:
      throw new Error(`Unsupported WorkGraph edge direction: ${direction satisfies never}`);
  }
}

function queryParams(rootId: string, indexes: readonly number[]): string[] {
  return indexes.map(() => rootId);
}

function relationEdge(row: RelationRow): WorkGraphRelationEdge {
  return {
    fromId: row.task_id,
    toId: row.related_to,
    kind: relationKind(row.relation_type),
    source: 'relation',
    relationType: row.relation_type,
    reason: row.reason ?? undefined,
  };
}

function dependencyEdge(row: DependencyRow): WorkGraphDependencyEdge {
  return {
    fromId: row.task_id,
    toId: row.depends_on,
    kind: 'depends_on',
    source: 'dependency',
  };
}

/** SQLite implementation of direct relation-edge lookups for WorkGraph callers. */
export class SqliteWorkGraphRelationQueryService implements WorkGraphRelationQueryService {
  readonly #db: SqliteWorkGraphRelationReader;

  constructor(db: SqliteWorkGraphRelationReader) {
    this.#db = db;
  }

  /**
   * List direct edges around one root. `task_relations.reason` is surfaced on
   * relation edges, while dependency rows stay opt-in and reasonless.
   */
  listRelationEdges(options: WorkGraphRelationEdgesOptions): WorkGraphRelationEdgesResult {
    const direction = normalizeDirection(options.direction);
    const relationFilter = directionWhere(direction, 'task_id', 'related_to');
    const relationSql = `SELECT task_id, related_to, relation_type, reason
FROM task_relations
WHERE ${relationFilter.clause}
ORDER BY task_id ASC, related_to ASC, relation_type ASC`;

    const relationRows = this.#db
      .prepare(relationSql)
      .all(...queryParams(options.rootId, relationFilter.params)) as RelationRow[];
    const edges: WorkGraphDirectEdge[] = relationRows.map(relationEdge);

    if (options.includeDependencies === true) {
      const dependencyFilter = directionWhere(direction, 'task_id', 'depends_on');
      const dependencySql = `SELECT task_id, depends_on
FROM task_dependencies
WHERE ${dependencyFilter.clause}
ORDER BY task_id ASC, depends_on ASC`;
      const dependencyRows = this.#db
        .prepare(dependencySql)
        .all(...queryParams(options.rootId, dependencyFilter.params)) as DependencyRow[];
      edges.push(...dependencyRows.map(dependencyEdge));
    }

    return { rootId: options.rootId, direction, edges };
  }
}

/** Create a WorkGraph relation query service over an already-open SQLite DB. */
export function createSqliteWorkGraphRelationQueryService(
  db: SqliteWorkGraphRelationReader,
): WorkGraphRelationQueryService {
  return new SqliteWorkGraphRelationQueryService(db);
}
