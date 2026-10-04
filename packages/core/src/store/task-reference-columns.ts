/**
 * The columns that hold a task's display id, for a rename to rewrite.
 *
 * A leaf: the display-id rename (`./display-id-alias.ts`) and the reconcile's
 * legacy-task renumbering (`./exodus/task-id-remap.ts`, T13172) share it, and
 * the reconcile must not pull the whole alias module onto its write path.
 *
 * @module
 * @task T12341
 * @task T13172
 */

import type { DatabaseSync } from 'node:sqlite';
import { ROW_IDENTITY } from './row-identity-registry.js';
import type { TaskReferenceColumn } from './sqlite-data-accessor.js';

/**
 * Every local column that holds a task's display id: declared foreign keys to
 * the tasks table, and the ROW_IDENTITY refs, key refs, owners and JSON-array
 * refs that point at it.
 *
 * @param db - Connection on the database holding the columns.
 * @param localName - Maps a consolidated table name to its name in `db`, or
 *   `null` when `db` has no such table. Identity for a `cleo.db`; a legacy
 *   `tasks.db` copy passes its unprefixed names (T13172).
 * @returns The columns, limited to tables present in `db`.
 * @task T12341
 */
export function taskReferenceColumns(
  db: DatabaseSync,
  localName: (consolidated: string) => string | null = (name) => name,
): TaskReferenceColumn[] {
  const found = new Map<string, TaskReferenceColumn>();
  const add = (table: string, column: string, jsonArray: boolean) => {
    found.set(`${table}.${column}`, { table, column, jsonArray });
  };
  const tasksTable = localName('tasks_tasks');
  const fks = db
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col
         FROM main.sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = ?
          AND (f."to" IS NULL OR f."to" = 'id')`,
    )
    .all(tasksTable ?? 'tasks_tasks') as { tbl: string; col: string }[];
  for (const fk of fks) add(fk.tbl, fk.col, false);
  for (const spec of ROW_IDENTITY.project) {
    const table = localName(spec.table);
    if (table === null) continue;
    for (const ref of [...(spec.refs ?? []), ...(spec.keyRefs ?? []), ...(spec.owners ?? [])]) {
      if (ref.table === 'tasks_tasks') add(table, ref.column, false);
    }
    for (const ref of spec.jsonArrayRefs ?? []) {
      if (ref.table === 'tasks_tasks') add(table, ref.column, true);
    }
  }
  const tables = new Set(
    (
      db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  // A legacy store's table can predate a column the registry names.
  const columns = new Map<string, Set<string>>();
  const hasColumn = (table: string, column: string): boolean => {
    let names = columns.get(table);
    if (names === undefined) {
      names = new Set(
        (
          db.prepare(`PRAGMA main.table_info("${table.replaceAll('"', '""')}")`).all() as {
            name: string;
          }[]
        ).map((c) => c.name),
      );
      columns.set(table, names);
    }
    return names.has(column);
  };
  return [...found.values()].filter(
    (ref) => tables.has(ref.table) && hasColumn(ref.table, ref.column),
  );
}
