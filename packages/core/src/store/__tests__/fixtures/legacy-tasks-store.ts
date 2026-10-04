/**
 * A minimal legacy project store: `.cleo/tasks.db` in the pre-consolidation
 * shape, holding rows exodus-on-open must migrate (T13158).
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Task ids seeded by {@link seedLegacyTasksStore}. */
export const LEGACY_TASK_IDS = ['T1', 'T2', 'T3'] as const;

/**
 * Write a legacy `tasks.db` with {@link LEGACY_TASK_IDS} into `cleoDir`.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @returns The legacy file's path.
 */
export function seedLegacyTasksStore(cleoDir: string): string {
  const path = join(cleoDir, 'tasks.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium', type TEXT, parent_id TEXT REFERENCES tasks(id),
        pipeline_stage TEXT, archive_reason TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES
        ('T1', 'legacy epic', 'active',  'high',   'epic', NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
        ('T2', 'legacy task', 'pending', 'medium', 'task', 'T1', NULL, NULL, '2026-01-02T00:00:00Z'),
        ('T3', 'legacy done', 'done',    'low',    'task', 'T1', NULL, NULL, '2026-01-03T00:00:00Z');
    `);
  } finally {
    db.close();
  }
  return path;
}

/**
 * Row count of `table` in the SQLite file at `path`, read on a fresh read-only
 * connection (so per-connection state such as temp triggers is not involved).
 *
 * @param path - Database file.
 * @param table - Table name.
 * @returns The row count.
 */
export function countRowsInFile(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    return typeof row?.n === 'number' ? row.n : -1;
  } finally {
    db.close();
  }
}
