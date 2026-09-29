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

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
      // A pinned backup (T12535) is never rotated and does not count toward the cap.
      .filter((f) => !isPinnedBackup(backupDir, f, backupType))
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
  /**
   * Never rotated (T12535): the snapshot a twin collapse took before it
   * changed the store. It is the only copy of any row the collapse replaced,
   * so it outlives the rotation cap until an owner removes it.
   */
  readonly pinned?: boolean;
  /** Why it is pinned (shown by `cleo backup list`). */
  readonly pinnedReason?: string;
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

/**
 * The backup id (`<type>-<timestamp>`) of a backup file named
 * `<file>.<type>-<timestamp>`, or `null` when the name has no such suffix.
 */
function backupIdOf(fileName: string, backupType: string): string | null {
  const at = fileName.indexOf(`.${backupType}-`);
  return at < 0 ? null : fileName.slice(at + 1);
}

/** Read a backup's sidecar, or `null` when it is missing or unreadable. */
function readSidecar(backupDir: string, backupId: string): BackupSidecar | null {
  try {
    return JSON.parse(
      readFileSync(join(backupDir, `${backupId}.meta.json`), 'utf-8'),
    ) as BackupSidecar;
  } catch {
    return null;
  }
}

/**
 * Whether a backup file is pinned (its sidecar says `pinned: true`).
 *
 * @param backupDir - The backup directory.
 * @param fileName - The backup file (`<file>.<type>-<timestamp>`).
 * @param backupType - Its backup type.
 * @returns `true` when pinned.
 * @task T12535
 */
export function isPinnedBackup(backupDir: string, fileName: string, backupType: string): boolean {
  const id = backupIdOf(fileName, backupType);
  return id !== null && readSidecar(backupDir, id)?.pinned === true;
}

/**
 * Pin the backup a file belongs to, so rotation never deletes it. Writes the
 * sidecar (`pinned: true`, `pinnedReason`), creating it for a snapshot that has
 * none. Idempotent and best effort: returns whether the backup is pinned now.
 *
 * @param snapshotPath - The backup file (`<dir>/<file>.<type>-<timestamp>`).
 * @param backupType - Its backup type (`migration` for twin-collapse snapshots).
 * @param reason - Why it is pinned.
 * @returns `true` when the backup is pinned after the call.
 * @task T12535
 */
export function pinBackup(snapshotPath: string, backupType: string, reason: string): boolean {
  try {
    if (!existsSync(snapshotPath)) return false;
    const backupDir = dirname(snapshotPath);
    const file = basename(snapshotPath);
    const id = backupIdOf(file, backupType);
    if (id === null) return false;
    const current = readSidecar(backupDir, id);
    if (current?.pinned === true) return true;
    writeBackupSidecar(backupDir, {
      backupId: id,
      type: current?.type ?? backupType,
      timestamp: current?.timestamp ?? statSync(snapshotPath).mtime.toISOString(),
      ...(current?.note !== undefined ? { note: current.note } : {}),
      files: current?.files ?? [file.slice(0, file.length - id.length - 1)],
      pinned: true,
      pinnedReason: reason,
    });
    return true;
  } catch {
    return false;
  }
}
