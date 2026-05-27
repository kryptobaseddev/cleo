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
    DatabaseSync: new (path: string) => NativeDb;
  };

  // db-open-allowed — T10648 backfill is a one-shot maintenance script
  // that must write directly to tasks.db outside the openCleoDb chokepoint.
  const db = new DatabaseSync(tasksDbPath) as NativeDb; // db-open-allowed: T10648 one-shot CLI

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
      db.exec('BEGIN');
      try {
        await rebuildChildProjectionAc(tx as any, parentId, children, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

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
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO task_acceptance_criteria
         (id, task_id, ordinal, kind, source_key, target_task_id, projection, text, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        stmt.run(
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
      }
    },

    deleteAcRowsForTask: async (taskId: string) => {
      db.prepare('DELETE FROM task_acceptance_criteria WHERE task_id = ?').run(taskId);
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
