/**
 * WorkGraph scaffold apply engine — applies validated scaffold proposals to storage.
 *
 * Takes a validated scaffold proposal (saga/epic/tasks + edges/relations) and
 * writes them to the SQLite database in a single transaction. Idempotent —
 * re-applying the same scaffold does not create duplicates.
 *
 * @task T10633
 * @saga T10538
 * @epic T10547
 */

import type {
  WorkGraphScaffoldApplyParams,
  WorkGraphScaffoldApplyResult,
  WorkGraphScaffoldValidationIssue,
} from '@cleocode/contracts';
import { getDb, getNativeDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import { validateWorkGraphScaffold } from './scaffold-validate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable error code for apply failures where the scaffold is invalid. */
export const E_WORKGRAPH_SCAFFOLD_APPLY_INVALID = 'E_WORKGRAPH_SCAFFOLD_APPLY_INVALID';

/** Stable error code for apply failures where a referenced parent does not exist. */
export const E_WORKGRAPH_SCAFFOLD_APPLY_MISSING_PARENT =
  'E_WORKGRAPH_SCAFFOLD_APPLY_MISSING_PARENT';

/** Stable error code for apply failures where the database is not initialized. */
export const E_WORKGRAPH_SCAFFOLD_APPLY_NO_DB = 'E_WORKGRAPH_SCAFFOLD_APPLY_NO_DB';

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

/**
 * Convert a scaffold hierarchy node into a drizzle-ready task insert row.
 * Generates sensible defaults for required task fields not present in the
 * minimal scaffold node shape.
 */
function nodeToInsertRow(node: { id: string; type: string; parentId?: string | null }) {
  return {
    id: node.id,
    title: node.id,
    description: `Scaffold-generated ${node.type}`,
    status: 'pending' as const,
    priority: 'medium' as const,
    type: node.type as 'saga' | 'epic' | 'task' | 'subtask',
    parentId: node.parentId ?? null,
    kind: 'work' as const,
    scope: 'feature' as const,
  };
}

/**
 * Determine the relation type mapping from a scaffold edge kind to the
 * canonical task_relations.relation_type enum value.
 */
function edgeKindToRelationType(
  kind: string,
):
  | 'related'
  | 'blocks'
  | 'duplicates'
  | 'absorbs'
  | 'fixes'
  | 'extends'
  | 'supersedes'
  | 'groups'
  | undefined {
  switch (kind) {
    case 'contains':
      return 'groups';
    case 'blocks':
      return 'blocks';
    case 'relates_to':
      return 'related';
    case 'groups':
      return 'groups';
    case 'satisfies':
      return 'extends'; // closest semantic match
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a validated WorkGraph scaffold proposal to storage.
 *
 * Runs validation first using {@link validateWorkGraphScaffold}. When the
 * scaffold is valid and `params.apply` is `true`, all nodes and edges are
 * written to the database inside a single transaction.
 *
 * **AC1 — transactional**: all writes succeed or none do. If any insert
 * fails, the entire transaction is rolled back.
 *
 * **AC2 — idempotency**: uses `ON CONFLICT DO NOTHING` for task, dependency,
 * and relation inserts. Re-applying the same scaffold produces the same
 * result without duplicates.
 *
 * **AC3 — docs and relations created consistently**: all task rows (docs)
 * and their dependency/relation edges are written in the same atomic
 * transaction, so consumers never see a partially-applied scaffold.
 *
 * @param params - Scaffold payload to apply. Must include `apply: true` to
 *   perform writes; omit or set `false` for dry-run preview.
 * @returns Structured apply result with validity, applied status, and change
 *   counts.
 */
export async function applyWorkGraphScaffold(
  params: WorkGraphScaffoldApplyParams,
): Promise<WorkGraphScaffoldApplyResult> {
  // Step 1: validate
  const validation = validateWorkGraphScaffold(params);

  // Always return validation issues, even when applying
  const baseResult = {
    rootId: validation.rootId,
    valid: validation.valid,
    dryRun: validation.dryRun,
    issues: validation.issues,
    hierarchy: validation.hierarchy,
  };

  // Dry-run or invalid — return preview without writing
  if (!params.apply || !validation.valid) {
    return {
      ...baseResult,
      applied: false,
      nodesChanged: 0,
      edgesChanged: 0,
    };
  }

  // Step 2: apply to storage in a transaction
  const db = await getDb();
  const nativeDb = getNativeDb();

  if (!nativeDb) {
    return {
      ...baseResult,
      applied: false,
      nodesChanged: 0,
      edgesChanged: 0,
      issues: [
        ...baseResult.issues,
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_APPLY_NO_DB,
          'Database not initialized — cannot apply scaffold',
        ),
      ],
    };
  }

  nativeDb.exec('BEGIN IMMEDIATE');

  try {
    let nodesChanged = 0;
    let edgesChanged = 0;

    // Insert nodes — onConflictDoNothing for idempotency (AC2)
    for (const node of params.nodes) {
      const row = nodeToInsertRow(node);
      const result = db.insert(schema.tasks).values(row).onConflictDoNothing().run();
      if (result.changes > 0) {
        nodesChanged++;
      }
    }

    // Insert edges
    if (params.edges && params.edges.length > 0) {
      for (const edge of params.edges) {
        if (edge.source === 'dependency') {
          // Dependency edge → task_dependencies
          const result = db
            .insert(schema.taskDependencies)
            .values({ taskId: edge.fromId, dependsOn: edge.toId })
            .onConflictDoNothing()
            .run();
          if (result.changes > 0) {
            edgesChanged++;
          }
        } else {
          // Relation edge → task_relations
          const relationType = edge.relationType ?? edgeKindToRelationType(edge.kind) ?? 'related';
          const result = db
            .insert(schema.taskRelations)
            .values({
              taskId: edge.fromId,
              relatedTo: edge.toId,
              relationType,
              reason: edge.reason ?? null,
            })
            .onConflictDoNothing()
            .run();
          if (result.changes > 0) {
            edgesChanged++;
          }
        }
      }
    }

    nativeDb.exec('COMMIT');

    return {
      ...baseResult,
      applied: true,
      nodesChanged,
      edgesChanged,
    };
  } catch (err) {
    nativeDb.exec('ROLLBACK');

    const message = err instanceof Error ? err.message : String(err);
    return {
      ...baseResult,
      applied: false,
      nodesChanged: 0,
      edgesChanged: 0,
      issues: [
        ...baseResult.issues,
        makeIssue(
          E_WORKGRAPH_SCAFFOLD_APPLY_INVALID,
          `Apply failed and was rolled back: ${message}`,
        ),
      ],
    };
  }
}
