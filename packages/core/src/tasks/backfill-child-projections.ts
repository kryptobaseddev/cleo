/**
 * PM-Core V2 backfill: create child_task AC projections for all existing
 * parent-child relationships.
 *
 * The add-task path has created parent-owned child_task projections since
 * T10569, but tasks created before that migration have zero typed child
 * AC rows. This backfill retroactively populates them.
 *
 * Works directly against the tasks.db SQLite file for efficient batch
 * operations, with an accessor-only fallback for programmatic use.
 *
 * @saga T10538 (SG-PM-CORE-V2)
 * @task T10639
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { installSchemaWriteGuard } from '../store/worktree-build-guard.js';
import { withWriterLease } from '../store/writer-lease.js';
import {
  auditChildProjectionAcRows,
  type ChildProjectionAuditInput,
  rebuildChildProjectionAc,
} from './ac-table.js';

const _require = createRequire(import.meta.url ?? 'file:///');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillChildProjectionOptions {
  /** Preview only — do not write to DB. Default: false. */
  dryRun?: boolean;
  /** Restrict to specific parent task IDs. Default: all parents. */
  parentIds?: string[];
}

export interface BackfillChildProjectionChange {
  parentId: string;
  childCount: number;
  rebuilt: boolean;
  auditBeforeStatus: string;
  auditAfterStatus: string;
}

export interface BackfillChildProjectionResult {
  dryRun: boolean;
  parentsScanned: number;
  parentsChanged: number;
  changes: BackfillChildProjectionChange[];
}

// ---------------------------------------------------------------------------
// Low-level DB types
// ---------------------------------------------------------------------------

interface NativeDb {
  prepare: (sql: string) => {
    all: (...params: any[]) => any[];
    get: (...params: any[]) => any;
    run: (...params: any[]) => any;
  };
  exec: (sql: string) => void;
  close: () => void;
}

interface AcDbRow {
  id: string;
  task_id: string;
  ordinal: number;
  kind: string;
  source_key: string | null;
  target_task_id: string | null;
  projection: string;
  text: string;
  created_at: string;
  updated_at: string | null;
  content_hash: string | null;
}

interface ChildTaskRow {
  id: string;
  title: string;
}

interface ParentRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Core backfill — direct DB path
// ---------------------------------------------------------------------------

export async function backfillChildProjections(
  projectRoot: string,
  options: BackfillChildProjectionOptions = {},
): Promise<BackfillChildProjectionResult> {
  const { dryRun = false, parentIds } = options;
  const now = new Date().toISOString();

  const tasksDbPath = resolve(projectRoot, '.cleo', 'tasks.db');
  const { DatabaseSync } = _require('node:sqlite') as {
    DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync;
  };

  // db-open-allowed — T10648 backfill is a one-shot maintenance script
  // that must write directly to tasks.db outside the openCleoDb chokepoint.
  const raw = new DatabaseSync(tasksDbPath); // db-open-allowed: T10648 one-shot CLI
  installSchemaWriteGuard(raw); // T12687
  const db = raw as NativeDb;

  try {
    // Query all parent tasks with children
    let parentSql = `
      SELECT DISTINCT t.parent_id as id
      FROM tasks t
      JOIN tasks t2 ON t.parent_id = t2.id
      WHERE t.status != 'archived'
        AND t2.status != 'archived'
    `;
    if (parentIds && parentIds.length > 0) {
      const placeholders = parentIds.map(() => '?').join(',');
      parentSql += ` AND t.parent_id IN (${placeholders})`;
      parentSql += ' ORDER BY t.parent_id';
    } else {
      parentSql += ' ORDER BY t.parent_id';
    }

    const parentRows = db.prepare(parentSql).all(...(parentIds ?? [])) as ParentRow[];

    // Get children SQL template
    const childrenStmt = db.prepare(
      `SELECT id, title FROM tasks WHERE parent_id = ? AND status != 'archived' ORDER BY id`,
    );

    // Get AC rows SQL template
    const acRowsStmt = db.prepare(
      `SELECT id, task_id, ordinal, kind, source_key, target_task_id, projection,
              text, created_at, updated_at, content_hash
       FROM task_acceptance_criteria WHERE task_id = ? ORDER BY ordinal`,
    );

    const changes: BackfillChildProjectionChange[] = [];

    for (const parentRow of parentRows) {
      const parentId = parentRow.id;

      // Get children
      const childRows = childrenStmt.all(parentId) as ChildTaskRow[];
      if (childRows.length === 0) continue;

      const children: ChildProjectionAuditInput[] = childRows.map((c) => ({
        id: c.id,
        title: c.title,
      }));

      // Get existing AC rows
      const existingDbRows = acRowsStmt.all(parentId) as AcDbRow[];
      const existing = existingDbRows.map(dbToAcRow);

      // Audit
      const auditBefore = auditChildProjectionAcRows(parentId, children, existing);

      changes.push({
        parentId,
        childCount: children.length,
        rebuilt: auditBefore.dirty,
        auditBeforeStatus: auditBefore.status,
        auditAfterStatus: auditBefore.dirty
          ? dryRun
            ? 'clean (would rebuild)'
            : 'clean'
          : auditBefore.status,
      });

      if (dryRun || !auditBefore.dirty) continue;

      // Build transaction accessor for this parent
      const tx = buildDbTransactionAccessor(db, parentId);

      // Rebuild inside transaction. Cast through `any` because
      // buildDbTransactionAccessor implements the subset of TransactionAccessor
      // that rebuildChildProjectionAc actually calls at runtime (getAcRows,
      // insertAcRows, deleteAcRowsForTask, appendAcHistory, updateTaskFields).
      // Seam 3 (T11627): this raw tasks.db writer sidesteps the chokepoint, so
      // hold the project `bulk` lease around the write txn. `off` → pass-through.
      // T12044 (E6-L12d): pin the lease to the exact project cleo.db path resolved
      // from the projectRoot parameter so concurrent projects route to their own rows.
      await withWriterLease(
        'project',
        'bulk',
        async () => {
          db.exec('BEGIN');
          try {
            await rebuildChildProjectionAc(tx as any, parentId, children, now);
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        },
        { dbPath: resolve(projectRoot, '.cleo', 'cleo.db') },
      );

      // Re-audit
      const rebuiltDbRows = acRowsStmt.all(parentId) as AcDbRow[];
      const rebuilt = rebuiltDbRows.map(dbToAcRow);
      const auditAfter = auditChildProjectionAcRows(parentId, children, rebuilt);

      // Update the change record with actual after status
      const changeIndex = changes.findIndex((c) => c.parentId === parentId);
      if (changeIndex >= 0) {
        changes[changeIndex] = {
          parentId,
          childCount: children.length,
          rebuilt: true,
          auditBeforeStatus: auditBefore.status,
          auditAfterStatus: auditAfter.status,
        };
      }
    }

    const parentsChanged = changes.filter((c) => c.rebuilt).length;

    return {
      dryRun,
      parentsScanned: parentRows.length,
      parentsChanged,
      changes,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dbToAcRow(dbRow: AcDbRow) {
  return {
    id: dbRow.id,
    taskId: dbRow.task_id,
    ordinal: dbRow.ordinal,
    kind: (dbRow.kind as 'text' | 'child_task' | 'evidence_bound') ?? 'text',
    sourceKey: dbRow.source_key ?? '',
    targetTaskId: dbRow.target_task_id,
    projection: (dbRow.projection as string) ?? 'legacy',
    text: dbRow.text,
    createdAt: dbRow.created_at,
    updatedAt: dbRow.updated_at,
    contentHash: dbRow.content_hash,
  };
}

/**
 * The one AC row write of the backfill: insert a row, or update it in place
 * when the SAME task already owns that id. Returns the number of rows written.
 *
 * Never `INSERT OR REPLACE` (T12787): the bare `task_acceptance_criteria` is
 * the parent of `evidence_ac_bindings.ac_id ... ON DELETE CASCADE` and this
 * handle enforces foreign keys (node:sqlite's default), so REPLACE's implicit
 * delete would cascade-delete the row's evidence bindings. Ids are
 * sha256(taskId, key), so an id conflict with ANOTHER task's row means a
 * corrupt or hand-seeded row: the `WHERE` refuses to take it over and 0 is
 * returned, so the caller fails and the rebuild transaction rolls back.
 */
function upsertOwnedAcRow(db: NativeDb, row: any): number {
  const result = db
    .prepare(
      `INSERT INTO task_acceptance_criteria
       (id, task_id, ordinal, kind, source_key, target_task_id, projection, text, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ordinal = excluded.ordinal,
         kind = excluded.kind,
         source_key = excluded.source_key,
         target_task_id = excluded.target_task_id,
         projection = excluded.projection,
         text = excluded.text,
         content_hash = excluded.content_hash,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE task_acceptance_criteria.task_id = excluded.task_id`,
    )
    .run(
      row.id,
      row.taskId,
      row.ordinal,
      row.kind ?? 'text',
      row.sourceKey ?? null,
      row.targetTaskId ?? null,
      row.projection ?? 'legacy',
      row.text,
      row.contentHash ?? null,
    );
  return Number(result.changes);
}

function buildDbTransactionAccessor(db: NativeDb, _parentId: string) {
  return {
    getAcRows: async (taskId: string) => {
      const rows = db
        .prepare(
          `SELECT id, task_id, ordinal, kind, source_key, target_task_id, projection,
                  text, created_at, updated_at, content_hash
           FROM task_acceptance_criteria WHERE task_id = ? ORDER BY ordinal`,
        )
        .all(taskId) as AcDbRow[];
      return rows.map(dbToAcRow);
    },

    insertAcRows: async (rows: any[]) => {
      for (const row of rows) {
        if (upsertOwnedAcRow(db, row) === 0) {
          throw new Error(
            `E_AC_ID_FOREIGN_OWNER: acceptance criterion id ${row.id} for task ${row.taskId} ` +
              'is already owned by another task; refusing to take it over',
          );
        }
      }
    },

    updateAcRows: async (rows: any[]) => {
      const owner = db.prepare('SELECT task_id FROM task_acceptance_criteria WHERE id = ?');
      for (const row of rows) {
        const current = owner.get(row.id) as { task_id: string } | undefined;
        if (current?.task_id !== row.taskId || upsertOwnedAcRow(db, row) === 0) {
          throw new Error(
            `E_AC_ROW_MISSING: acceptance criterion ${row.id} does not exist on task ${row.taskId}`,
          );
        }
      }
    },

    deleteAcRowsByIds: async (taskId: string, ids: readonly string[]) => {
      const stmt = db.prepare('DELETE FROM task_acceptance_criteria WHERE task_id = ? AND id = ?');
      for (const id of ids) stmt.run(taskId, id);
    },

    appendAcHistory: async (_history: any[]) => {
      // No-op — history table writes are optional for backfill correctness
    },

    updateTaskFields: async (taskId: string, fields: any) => {
      const setClauses: string[] = [];
      const values: any[] = [];
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'acceptanceJson') {
          setClauses.push('acceptance_json = ?');
          values.push(value);
        } else if (key === 'updatedAt') {
          setClauses.push('updated_at = ?');
          values.push(value);
        }
      }
      if (setClauses.length > 0) {
        values.push(taskId);
        db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
      }
    },
  };
}
