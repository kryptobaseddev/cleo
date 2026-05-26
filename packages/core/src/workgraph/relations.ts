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

/** Stable error code for relation rows that duplicate parent_id hierarchy. */
export const E_WORKGRAPH_GROUPS_AS_HIERARCHY = 'E_WORKGRAPH_GROUPS_AS_HIERARCHY';

/** Stable error code for relation rows whose human rationale is absent. */
export const E_WORKGRAPH_RELATION_REASON_MISSING = 'E_WORKGRAPH_RELATION_REASON_MISSING';

/** Stable error code for pairs modeled as both scheduler dependencies and advisory relations. */
export const E_WORKGRAPH_DEPENDS_RELATES_MISUSE = 'E_WORKGRAPH_DEPENDS_RELATES_MISUSE';

/** Minimal relation row accepted by relation-quality validation. */
export interface WorkGraphRelationQualityRelationInput {
  readonly fromId: string;
  readonly toId: string;
  readonly relationType: WorkGraphTaskRelationType;
  readonly reason?: string | null;
}

/** Minimal dependency row accepted by relation-quality validation. */
export interface WorkGraphRelationQualityDependencyInput {
  readonly fromId: string;
  readonly toId: string;
}

/** Minimal containment row accepted by relation-quality validation. */
export interface WorkGraphRelationQualityContainmentInput {
  readonly id: string;
  readonly type: 'saga' | 'epic' | 'task' | 'subtask';
  readonly parentId?: string | null;
}

/** Diagnostic for a `groups` relation that mirrors parent_id containment. */
export interface WorkGraphGroupsAsHierarchyFinding {
  readonly code: typeof E_WORKGRAPH_GROUPS_AS_HIERARCHY;
  readonly fromId: string;
  readonly toId: string;
  readonly relationType: 'groups';
  readonly message: string;
}

/** Diagnostic for a relation edge missing a useful human-authored reason. */
export interface WorkGraphRelationReasonMissingFinding {
  readonly code: typeof E_WORKGRAPH_RELATION_REASON_MISSING;
  readonly fromId: string;
  readonly toId: string;
  readonly relationType: WorkGraphTaskRelationType;
  readonly message: string;
}

/** Diagnostic for the same task pair modeled as both dependency and relation. */
export interface WorkGraphDependsRelatesMisuseFinding {
  readonly code: typeof E_WORKGRAPH_DEPENDS_RELATES_MISUSE;
  readonly fromId: string;
  readonly toId: string;
  readonly dependencyFromId: string;
  readonly dependencyToId: string;
  readonly relationType: WorkGraphTaskRelationType;
  readonly message: string;
}

/** Typed diagnostic returned by relation-quality validation. */
export type WorkGraphRelationQualityFinding =
  | WorkGraphGroupsAsHierarchyFinding
  | WorkGraphRelationReasonMissingFinding
  | WorkGraphDependsRelatesMisuseFinding;

/** Options for validating non-containment relation edge semantics. */
export interface WorkGraphRelationQualityValidationOptions {
  readonly nodes: readonly WorkGraphRelationQualityContainmentInput[];
  readonly relations: readonly WorkGraphRelationQualityRelationInput[];
  readonly dependencies?: readonly WorkGraphRelationQualityDependencyInput[];
}

/** Result returned by relation-quality validation. */
export interface WorkGraphRelationQualityValidationResult {
  readonly valid: boolean;
  readonly findings: readonly WorkGraphRelationQualityFinding[];
}

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
      throw new Error(`Unsupported WorkGraph edge direction: ${String(direction)}`);
  }
}

function queryParams(rootId: string, indexes: readonly number[]): string[] {
  return indexes.map(() => rootId);
}

function edgeKey(fromId: string, toId: string): string {
  return `${fromId}\u0000${toId}`;
}

function unorderedEdgeKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join('\u0000');
}

function hasUsefulReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length > 0;
}

function collectGroupsAsHierarchyFindings(
  options: WorkGraphRelationQualityValidationOptions,
): WorkGraphGroupsAsHierarchyFinding[] {
  const containmentEdges = new Set<string>();
  for (const node of options.nodes) {
    const parentId = node.parentId ?? null;
    if (parentId === null) continue;
    containmentEdges.add(edgeKey(parentId, node.id));
    containmentEdges.add(edgeKey(node.id, parentId));
  }

  return options.relations.flatMap((relation) => {
    if (relation.relationType !== 'groups') return [];
    if (!containmentEdges.has(edgeKey(relation.fromId, relation.toId))) return [];
    return [
      {
        code: E_WORKGRAPH_GROUPS_AS_HIERARCHY,
        fromId: relation.fromId,
        toId: relation.toId,
        relationType: 'groups' as const,
        message: `Relation ${relation.fromId} -> ${relation.toId} uses groups between containment-linked nodes; hierarchy must use parent_id, not task_relations.groups`,
      },
    ];
  });
}

function collectReasonMissingFindings(
  relations: readonly WorkGraphRelationQualityRelationInput[],
): WorkGraphRelationReasonMissingFinding[] {
  return relations.flatMap((relation) => {
    if (hasUsefulReason(relation.reason)) return [];
    return [
      {
        code: E_WORKGRAPH_RELATION_REASON_MISSING,
        fromId: relation.fromId,
        toId: relation.toId,
        relationType: relation.relationType,
        message: `Relation ${relation.fromId} -> ${relation.toId} (${relation.relationType}) is missing a non-empty reason`,
      },
    ];
  });
}

function collectDependsRelatesMisuseFindings(
  options: WorkGraphRelationQualityValidationOptions,
): WorkGraphDependsRelatesMisuseFinding[] {
  const dependenciesByPair = new Map<string, WorkGraphRelationQualityDependencyInput>();
  for (const dependency of options.dependencies ?? []) {
    dependenciesByPair.set(unorderedEdgeKey(dependency.fromId, dependency.toId), dependency);
  }

  return options.relations.flatMap((relation) => {
    const dependency = dependenciesByPair.get(unorderedEdgeKey(relation.fromId, relation.toId));
    if (dependency === undefined) return [];
    return [
      {
        code: E_WORKGRAPH_DEPENDS_RELATES_MISUSE,
        fromId: relation.fromId,
        toId: relation.toId,
        dependencyFromId: dependency.fromId,
        dependencyToId: dependency.toId,
        relationType: relation.relationType,
        message: `Task pair ${relation.fromId} <-> ${relation.toId} is modeled as task_relations.${relation.relationType} and task_dependencies ${dependency.fromId} -> ${dependency.toId}; scheduler blockers must use dependencies while advisory links stay distinct`,
      },
    ];
  });
}

/**
 * Validate non-containment relation rows for semantic drift and reason quality.
 *
 * This intentionally does not validate parent_id containment shape. It catches
 * relation-specific hazards: `groups` rows that mirror hierarchy, missing human
 * reasons, and task pairs represented as both dependencies and advisory links.
 */
export function validateWorkGraphRelationQuality(
  options: WorkGraphRelationQualityValidationOptions,
): WorkGraphRelationQualityValidationResult {
  const findings: WorkGraphRelationQualityFinding[] = [
    ...collectGroupsAsHierarchyFindings(options),
    ...collectReasonMissingFindings(options.relations),
    ...collectDependsRelatesMisuseFindings(options),
  ];
  return { valid: findings.length === 0, findings };
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
