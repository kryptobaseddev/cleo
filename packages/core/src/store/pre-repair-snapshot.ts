/**
 * Full-store snapshot taken before an in-place repair or migration of the
 * project `cleo.db`.
 *
 * The repairs that run while a domain binds (the T12346 legacy-lineage
 * rebuild, the T12535 twin collapses) are synchronous and run before any
 * caller sees the handle, so they cannot use the async, debounced snapshot
 * gate (`snapshot-gate.ts`): a `routine` request inside the debounce window
 * would be skipped, and a skipped snapshot is exactly the case a repair must
 * never proceed under. They take one unconditional `VACUUM INTO` instead,
 * the same primitive the gate's snapshots use.
 *
 * @module
 * @task T12346
 * @task T12535
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Write a `VACUUM INTO` snapshot of the whole database next to it, under
 * `<dir of dbPath>/backups/cleo-pre-<label>-<timestamp>.db`.
 *
 * Throws when the snapshot cannot be written, so the caller never repairs
 * without it. Must run outside a transaction (`VACUUM INTO` requires it).
 *
 * @param nativeDb - Connection on the database to snapshot.
 * @param dbPath - Path of that database file (locates the backup directory).
 * @param label - Short kebab-case tag naming the repair.
 * @returns The snapshot's absolute path.
 * @task T12535
 */
export function writePreRepairSnapshot(
  nativeDb: DatabaseSync,
  dbPath: string,
  label: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const snapshotPath = join(backupDir, `cleo-pre-${label}-${stamp}.db`);
  nativeDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  return snapshotPath;
}
