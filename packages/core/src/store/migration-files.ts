/**
 * Memoized `readMigrationFiles` (T13126).
 *
 * drizzle's `readMigrationFiles` reads every `migration.sql` in a lineage and
 * hashes it. A single store open reconciles its journal through several helpers
 * that each read the same lineage (and its sibling lineage) again, so one
 * command read and hashed the same ~1.4 MB of SQL about a dozen times. This
 * reads a lineage once per process and re-reads it whenever the folder's
 * contents change: the cache key includes each migration's name, size and
 * mtime, so a test (or a dev rebuild) that rewrites a migration never sees a
 * stale answer. The one change it cannot see is an in-place rewrite to the
 * same length within the same mtime tick; shipped migrations never change
 * while a process runs.
 *
 * @task T13126
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/** One lineage's migrations, as drizzle's `readMigrationFiles` returns them. */
export type MigrationFiles = ReturnType<typeof readMigrationFiles>;

const cache = new Map<string, { signature: string; migrations: MigrationFiles }>();

/** Name, size and mtime of every migration in `folder`; `null` when unreadable. */
function folderSignature(folder: string): string | null {
  try {
    const parts: string[] = [];
    for (const entry of readdirSync(folder).sort()) {
      try {
        const st = statSync(join(folder, entry, 'migration.sql'));
        parts.push(`${entry}:${st.size}:${st.mtimeMs}`);
      } catch {
        // Not a migration folder (README, meta): drizzle skips it too.
      }
    }
    return parts.join('\n');
  } catch {
    return null;
  }
}

/**
 * The migrations of one lineage folder, read and hashed once per content state.
 *
 * @param migrationsFolder - The lineage folder (`.../migrations/drizzle-<set>`).
 * @returns A fresh array of drizzle's migration entries. Entries are shared
 *   between calls; callers must not mutate them.
 * @throws Whatever drizzle's `readMigrationFiles` throws (missing folder,
 *   legacy `meta/_journal.json` layout). Failures are not cached.
 */
export function readMigrationFilesCached(migrationsFolder: string): MigrationFiles {
  const signature = folderSignature(migrationsFolder);
  const hit = cache.get(migrationsFolder);
  if (signature !== null && hit && hit.signature === signature) return [...hit.migrations];
  const migrations = readMigrationFiles({ migrationsFolder });
  if (signature !== null) cache.set(migrationsFolder, { signature, migrations });
  return [...migrations];
}
