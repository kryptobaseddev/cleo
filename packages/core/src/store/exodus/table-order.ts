/**
 * Parent-first table ordering for legacy copies — a dependency-free leaf.
 *
 * Lives outside `migrate.ts` so the tasks-domain store (`sqlite.ts` →
 * `legacy-tasks-lineage.ts`) can use it without pulling the exodus engine —
 * whose recovery module loads `node:sqlite` at import — into the store's
 * module graph (T1331 lazy-init contract; T12355).
 *
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';

/** List a database's user tables (no `sqlite_*` / drizzle journal), by name. */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Order a legacy DB's tables so every referenced (parent) table is copied
 * before the tables that reference it, using the SOURCE schema's foreign keys.
 *
 * `foreign_keys=OFF` defers FK enforcement during the bulk copy, but it does NOT
 * defer triggers. The consolidated project schema carries `BEFORE INSERT` guards
 * that look the parent up in `tasks_tasks` — e.g.
 * `tasks_task_acceptance_child_target_insert` raises
 * `E_CHILD_TASK_TARGET_CONTAINMENT` unless the criterion's child task already
 * exists. Alphabetical order copied `task_acceptance_criteria` BEFORE `tasks`,
 * so every legitimate `child_task` criterion was rejected and the whole
 * migration aborted, leaving `cleo.db` empty (T12319: 493 valid criteria in
 * llmtxt, zero actual violations in the source).
 *
 * Kahn's algorithm with alphabetical tie-breaking keeps the order deterministic;
 * self-references and references to tables outside the set are ignored, and a
 * cycle releases its alphabetically-first member so progress continues.
 *
 * @param db - Read-only handle on the legacy source DB.
 * @returns Table names, parents before children.
 * @task T12319
 */
export function orderTablesForCopy(db: DatabaseSync): string[] {
  const tables = listTables(db);
  const present = new Set(tables);
  const parentsOf = new Map<string, Set<string>>();
  for (const table of tables) {
    const refs = db
      .prepare(`SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list(?)`)
      .all(table) as Array<{ parent: string }>;
    parentsOf.set(
      table,
      new Set(refs.map((r) => r.parent).filter((p) => p !== table && present.has(p))),
    );
  }
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) =>
      [...(parentsOf.get(t) ?? [])].every((p) => !remaining.has(p)),
    );
    const next = ready.length > 0 ? ready : [[...remaining].sort()[0]];
    for (const table of next.sort()) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}
