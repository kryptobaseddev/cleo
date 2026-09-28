/**
 * The `.cleo/backups/sqlite/` system-backup file scheme shared by manual
 * backups (`system/backup.ts#createBackup`) and the store's own migration
 * snapshots (`store/pre-repair-snapshot.ts`): the `YYYYMMDD-HHmmss`
 * timestamp, the per-type rotation, and the `.meta.json` sidecar that
 * `cleo backup list` reads.
 *
 * A leaf module (node:fs only), so store code that runs inside a domain bind
 * can write an inventoried snapshot without importing `system/backup.ts`,
 * which imports the domain binders.
 *
 * @module
 * @task T10315
 * @task T12535 — extracted from `system/backup.ts`
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Format a Date as `YYYYMMDD-HHmmss` (local time) — mirrors the helper of
 * the same name in `sqlite-backup.ts` so both auto-snapshot and manual
 * snapshot files in `.cleo/backups/sqlite/` share one timestamp convention.
 *
 * @task T10315 — unified with `sqlite-backup.ts:formatTimestamp`.
 */
export function formatBackupTimestamp(d: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Rotate backups in a directory: delete the oldest files until
 * fewer than `maxSnapshots` non-meta files remain.
 *
 * Only rotates files matching the `createBackup` filename scheme
 * (`<file>.<type>-YYYYMMDD-HHmmss` for the canonical timestamp shape OR
 * `<file>.<type>-<iso-with-dashes>` for backward compatibility) so it never
 * touches files produced by `vacuumIntoBackupAll` in the same directory.
 * Non-fatal — filesystem errors are silently swallowed.
 *
 * @task T9194
 * @task T10315 — added scoping predicate so rotation never reaches
 *                vacuum-snapshot files that share `.cleo/backups/sqlite/`.
 */
export function rotateBackupDir(backupDir: string, maxSnapshots: number, backupType: string): void {
  try {
    // Match `<anything>.${backupType}-<timestamp>` where timestamp is either
    // canonical (`YYYYMMDD-HHmmss`) or legacy-ISO (`YYYY-MM-DDTHH-MM-SS-mmmZ`).
    // Excludes:
    //   - `.meta.json` sidecars (filtered explicitly below)
    //   - `.tmp` partial writes
    //   - vacuum-snapshot files (`tasks-YYYYMMDD-HHmmss.db`, `brain-...`) —
    //     those start with the prefix, not `.<file>.${backupType}-`.
    const escapedType = backupType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ownedPattern = new RegExp(`\\.${escapedType}-`);
    const files = readdirSync(backupDir)
      .filter((f) => !f.endsWith('.meta.json') && !f.endsWith('.tmp') && ownedPattern.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    while (files.length > maxSnapshots) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
        // Also delete the corresponding .meta.json sidecar if it exists.
        const metaPath = `${oldest.path}.meta.json`;
        if (existsSync(metaPath)) unlinkSync(metaPath);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // non-fatal — rotation failures must never block the backup operation
  }
}

/** Contents of a `<backupId>.meta.json` sidecar, as `cleo backup list` reads it. */
export interface BackupSidecar {
  /** `<type>-YYYYMMDD-HHmmss`. */
  readonly backupId: string;
  /** Backup category (`snapshot`, `safety`, `migration`). */
  readonly type: string;
  /** ISO-8601 creation time. */
  readonly timestamp: string;
  /** Free-text note shown by `cleo backup list`. */
  readonly note?: string;
  /** Files captured, each stored as `<file>.<backupId>` next to the sidecar. */
  readonly files: readonly string[];
}

/**
 * Write a `.meta.json` sidecar atomically (tmp file, then rename).
 *
 * @param backupDir - The `.cleo/backups/sqlite/` directory.
 * @param sidecar - The sidecar contents.
 * @task T12535
 */
export function writeBackupSidecar(backupDir: string, sidecar: BackupSidecar): void {
  const dest = join(backupDir, `${sidecar.backupId}.meta.json`);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(sidecar, null, 2));
  renameSync(tmp, dest);
}
