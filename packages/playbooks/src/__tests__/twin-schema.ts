/**
 * Test helper: the playbook twins (`tasks_playbook_runs`,
 * `tasks_playbook_approvals`) exactly as a project store creates them, read
 * from the consolidation migration plus the uid migration, so the state layer
 * is tested against the tables it writes (T12535).
 *
 * @task T12535
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../core/migrations/drizzle-cleo-project',
);

/** Create both playbook twins (with their uid columns) on `db`. */
export function applyPlaybookTwinSchema(db: DatabaseSync): void {
  const consolidation = readFileSync(
    resolve(MIGRATIONS, '20260531000001_t11363-consolidation-cleo-project/migration.sql'),
    'utf8',
  );
  for (const table of ['tasks_playbook_runs', 'tasks_playbook_approvals']) {
    const ddl = consolidation.match(new RegExp(`CREATE TABLE \`${table}\` \\([\\s\\S]*?\\n\\);`));
    if (!ddl) throw new Error(`no CREATE TABLE for ${table} in the consolidation migration`);
    db.exec(ddl[0]);
  }
  const uids = readFileSync(
    resolve(MIGRATIONS, '20261016120000_t12535-playbook-row-uids/migration.sql'),
    'utf8',
  );
  for (const stmt of uids.split('--> statement-breakpoint')) {
    if (stmt.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('--'))) db.exec(stmt);
  }
}
