/**
 * The `.cleo/backups/sqlite/` system-backup file scheme shared by manual
 * backups (`system/backup.ts#createBackup`) and the store's own migration
 * snapshots (`store/pre-repair-snapshot.ts`): the `YYYYMMDD-HHmmss`
 * timestamp, the per-type rotation, and the `.meta.json` sidecar that
 * `cleo backup list` reads.
 *
 * A leaf module (node:fs, plus a read-only node:sqlite read of the twin-collapse
 * markers during rotation), so store code that runs inside a domain bind
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
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

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
 * A pinned backup, and a pre-collapse snapshot a twin-collapse marker of the
 * project store references (pinned or not: 2026.9.21 wrote them without a
 * pin), is never rotated and does not count toward the cap. When the markers
 * cannot be read, nothing is deleted.
 *
 * @task T9194
 * @task T10315 — added scoping predicate so rotation never reaches
 *                vacuum-snapshot files that share `.cleo/backups/sqlite/`.
 * @task T12727 — marker-referenced snapshots are never rotated.
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

    if (files.length > maxSnapshots) {
      const referenced = markerReferencedSnapshots(backupDir);
      if (referenced === null) return; // unreadable markers: delete nothing
      for (let i = files.length - 1; i >= 0; i--)
        if (referenced.has(files[i]?.name ?? '')) files.splice(i, 1);
    }

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

/** Key prefix of a twin-collapse marker (`twin_collapse:<table>`) in a kv table. */
const MARKER_PREFIX = 'twin_collapse:';

/**
 * File names of the pre-collapse snapshots the twin-collapse markers of the
 * project store (`<backupDir>/../../cleo.db`) reference; empty when there is
 * no store there. `null` when the markers cannot be read (busy, corrupt).
 *
 * @task T12727
 */
export function markerReferencedSnapshots(backupDir: string): Set<string> | null {
  const store = join(backupDir, '..', '..', 'cleo.db');
  const names = new Set<string>();
  if (!existsSync(store)) return names;
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: Ctor } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, opts: { readOnly: boolean }) => DatabaseSync;
    };
    db = new Ctor(store, { readOnly: true }); // db-open-allowed: leaf module; read-only marker read during rotation
    for (const table of ['tasks_schema_meta', 'brain_schema_meta']) {
      const present = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (present === undefined) continue;
      const rows = db
        .prepare(`SELECT value FROM ${table} WHERE substr(key, 1, ?) = ?`)
        .all(MARKER_PREFIX.length, MARKER_PREFIX) as Array<{ value: string }>;
      for (const { value } of rows) {
        let snapshot: unknown;
        try {
          snapshot = (JSON.parse(value) as { snapshot?: unknown }).snapshot;
        } catch {
          return null; // a marker we cannot read may name a snapshot
        }
        if (typeof snapshot === 'string' && snapshot.length > 0) names.add(basename(snapshot));
      }
    }
    return names;
  } catch {
    return null;
  } finally {
    db?.close();
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
  /** When an owner released the pin (T12767); rotation treats it as any backup. */
  readonly releasedAt?: string;
  /** Why it was released. */
  readonly releasedReason?: string;
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

/**
 * Shape of a `.meta.json` sidecar as read back from disk. Unknown fields are
 * kept (older and newer builds add their own); a sidecar that does not match
 * reads as absent, so a malformed file can never pin (or unpin) a backup.
 */
const backupSidecarSchema = z
  .object({
    backupId: z.string().min(1),
    type: z.string().min(1),
    timestamp: z.string().min(1),
    note: z.string().optional(),
    files: z.array(z.string()),
    pinned: z.boolean().optional(),
    pinnedReason: z.string().optional(),
    releasedAt: z.string().optional(),
    releasedReason: z.string().optional(),
  })
  .passthrough();

/** Read a backup's sidecar, or `null` when it is missing, unreadable or malformed. */
function readSidecar(backupDir: string, backupId: string): BackupSidecar | null {
  try {
    const parsed = backupSidecarSchema.safeParse(
      JSON.parse(readFileSync(join(backupDir, `${backupId}.meta.json`), 'utf-8')),
    );
    return parsed.success ? (parsed.data as BackupSidecar) : null;
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

/**
 * Release a backup's pin (T12767) so rotation treats it as any other backup:
 * rewrites its sidecar with `pinned: false`, `releasedAt` and
 * `releasedReason`, dropping `pinnedReason`. Writes the sidecar only, never
 * the backup; creates the sidecar when there is none.
 *
 * @param snapshotPath - The backup file (`<dir>/<file>.<type>-<timestamp>`).
 * @param backupType - Its backup type.
 * @param reason - Why it is released.
 * @returns The sidecar as written.
 * @throws When the backup name does not carry `backupType`, or the write fails.
 * @task T12767
 */
export function unpinBackup(
  snapshotPath: string,
  backupType: string,
  reason: string,
): BackupSidecar {
  const backupDir = dirname(snapshotPath);
  const file = basename(snapshotPath);
  const id = backupIdOf(file, backupType);
  if (id === null) throw new Error(`${file} is not a ${backupType} backup`);
  const current = readSidecar(backupDir, id);
  const { pinnedReason: _dropped, ...kept } = current ?? {
    backupId: id,
    type: backupType,
    timestamp: existsSync(snapshotPath)
      ? statSync(snapshotPath).mtime.toISOString()
      : new Date().toISOString(),
    files: [file.slice(0, file.length - id.length - 1)],
  };
  const sidecar: BackupSidecar = {
    ...kept,
    pinned: false,
    releasedAt: new Date().toISOString(),
    releasedReason: reason,
  };
  writeBackupSidecar(backupDir, sidecar);
  return sidecar;
}

/**
 * Put back a sidecar exactly as it was before {@link unpinBackup} (or remove
 * it when there was none). Best effort, for a release that is rolled back.
 *
 * @param snapshotPath - The backup file.
 * @param backupType - Its backup type.
 * @param previous - The sidecar before the release, or `null`.
 * @task T12767
 */
export function restoreBackupSidecar(
  snapshotPath: string,
  backupType: string,
  previous: BackupSidecar | null,
): void {
  try {
    const backupDir = dirname(snapshotPath);
    const id = backupIdOf(basename(snapshotPath), backupType);
    if (id === null) return;
    if (previous !== null) writeBackupSidecar(backupDir, previous);
    else unlinkSync(join(backupDir, `${id}.meta.json`));
  } catch {
    /* best effort */
  }
}

/**
 * A backup's sidecar as read back, or `null` (missing, unreadable, malformed).
 *
 * @param snapshotPath - The backup file.
 * @param backupType - Its backup type.
 * @task T12767
 */
export function readBackupSidecar(snapshotPath: string, backupType: string): BackupSidecar | null {
  const id = backupIdOf(basename(snapshotPath), backupType);
  return id === null ? null : readSidecar(dirname(snapshotPath), id);
}
