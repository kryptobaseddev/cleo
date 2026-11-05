/**
 * The `.cleo/backups/sqlite/` system-backup file scheme shared by manual
 * backups (`system/backup.ts#createBackup`) and the store's own migration
 * snapshots (`store/pre-repair-snapshot.ts`): the `YYYYMMDD-HHmmss`
 * timestamp, the per-type rotation, and the `.meta.json` sidecar that
 * `cleo backup list` reads.
 *
 * A leaf module (node:fs, the logger, and a read-only node:sqlite read of the
 * twin-collapse markers during rotation), so store code that runs inside a domain bind
 * can write an inventoried snapshot without importing `system/backup.ts`,
 * which imports the domain binders.
 *
 * @module
 * @task T10315
 * @task T12535 — extracted from `system/backup.ts`
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
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
import { getLogger } from '../logger.js';

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
 * Rotate backups in a directory: delete the oldest BACKUPS until no more than
 * `maxSnapshots` remain. Files are grouped by backup id (`<file>.<backupId>`),
 * and a backup's files are kept or deleted together (T13710: counting files
 * let one backup with many payloads delete its own store snapshot).
 *
 * Only rotates files matching the `createBackup` filename scheme
 * (`<file>.<type>-YYYYMMDD-HHmmss` for the canonical timestamp shape OR
 * `<file>.<type>-<iso-with-dashes>` for backward compatibility) so it never
 * touches files produced by `vacuumIntoBackupAll` in the same directory.
 * Non-fatal — filesystem errors are silently swallowed.
 *
 * A pinned backup, and a pre-collapse snapshot a twin-collapse marker of the
 * project store references (pinned or not: 2026.9.21 wrote them without a
 * pin), is never rotated and does not count toward the cap. When a marker
 * cannot be read (malformed, or the store busy), which snapshot it names is
 * unknown: every `migration` backup is kept and a warning is logged, while
 * other backup types still rotate (pre-collapse snapshots are always
 * `migration` backups). `cleo doctor` names an unreadable marker.
 *
 * @task T9194
 * @task T10315 — added scoping predicate so rotation never reaches
 *                vacuum-snapshot files that share `.cleo/backups/sqlite/`.
 * @task T12727 — marker-referenced snapshots are never rotated.
 * @task T12770 — an unreadable marker keeps only `migration` backups, and says so.
 * @task T12729 — a rotated backup's `<backupId>.meta.json` sidecar goes with it.
 * @task T13710 — the cap counts backups, not files.
 * @returns The files and sidecars deleted, and why rotation kept backups past the cap.
 */
export function rotateBackupDir(
  backupDir: string,
  maxSnapshots: number,
  backupType: string,
): BackupRotation {
  const deleted: string[] = [];
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
    const groups = new Map<string, { names: string[]; mtimeMs: number }>();
    for (const f of readdirSync(backupDir)) {
      if (f.endsWith('.meta.json') || f.endsWith('.tmp') || !ownedPattern.test(f)) continue;
      // A pinned backup (T12535) is never rotated and does not count toward the cap.
      if (isPinnedBackup(backupDir, f, backupType)) continue;
      const id = backupIdOf(f, backupType) ?? f;
      const mtimeMs = statSync(join(backupDir, f)).mtimeMs;
      const group = groups.get(id);
      if (group === undefined) groups.set(id, { names: [f], mtimeMs });
      else {
        group.names.push(f);
        group.mtimeMs = Math.max(group.mtimeMs, mtimeMs);
      }
    }
    const files = [...groups.values()].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    if (files.length > maxSnapshots) {
      const markers = readMarkerSnapshots(backupDir);
      const unreadable = markers.error !== null || markers.unreadable.length > 0;
      if (unreadable) {
        const skipped = backupType === PRE_COLLAPSE_BACKUP_TYPE;
        getLogger('backup-rotation').warn(
          { backupDir, backupType, unreadable: markers.unreadable, error: markers.error, skipped },
          skipped
            ? 'twin-collapse marker unreadable: keeping every migration backup (run cleo doctor)'
            : 'twin-collapse marker unreadable: rotating (a pre-collapse snapshot is a migration backup)',
        );
        if (skipped)
          return {
            deleted,
            sidecars: sweepOrphanSidecars(backupDir, backupType),
            keptAll: markers.error !== null ? 'store-unreadable' : 'marker-unreadable',
            unreadable: markers.unreadable,
            error: markers.error,
          };
      }
      for (let i = files.length - 1; i >= 0; i--)
        if (files[i]?.names.some((n) => markers.names.has(n))) files.splice(i, 1);
    }

    while (files.length > maxSnapshots) {
      const oldest = files.shift();
      if (!oldest) break;
      for (const name of oldest.names) {
        try {
          unlinkSync(join(backupDir, name));
          deleted.push(name);
        } catch {
          /* non-fatal */
        }
      }
    }
  } catch {
    // non-fatal — rotation failures must never block the backup operation
  }
  // A rotated backup's sidecar (`<backupId>.meta.json`) goes once none of its
  // files is left, and so does any earlier orphan (T12729).
  return {
    deleted,
    sidecars: sweepOrphanSidecars(backupDir, backupType),
    keptAll: null,
    unreadable: [],
    error: null,
  };
}

/**
 * Remove the `<backupId>.meta.json` sidecars of `backupType` whose backup has
 * no file left (`<file>.<backupId>` for each file the sidecar lists), so
 * `cleo backup list` stops listing them (T12729). Builds before T12729
 * deleted `<file>.<backupId>.meta.json` on rotation, a name no sidecar has,
 * so every rotated backup left one behind. A pinned sidecar, one that does
 * not parse (it cannot be shown unpinned) and one listing no files are never
 * removed.
 * Non-fatal.
 *
 * @param backupDir - The backup directory.
 * @param backupType - The backup type whose sidecars are swept.
 * @returns The sidecar files removed.
 */
export function sweepOrphanSidecars(backupDir: string, backupType: string): string[] {
  const removed: string[] = [];
  try {
    const names = readdirSync(backupDir);
    const present = new Set(names);
    for (const name of names) {
      if (!name.startsWith(`${backupType}-`) || !name.endsWith('.meta.json')) continue;
      const id = name.slice(0, -'.meta.json'.length);
      const sidecar = readSidecar(backupDir, id);
      if (sidecar === null || sidecar.pinned === true || sidecar.backupId !== id) continue;
      // A backup that captured nothing has no file to lose.
      if (sidecar.files.length === 0) continue;
      if (sidecar.files.some((f) => present.has(`${f}.${id}`))) continue;
      try {
        unlinkSync(join(backupDir, name));
        removed.push(name);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // non-fatal — a sweep failure must never block the backup operation
  }
  return removed;
}

/** What {@link rotateBackupDir} did. */
export interface BackupRotation {
  /** Backup files deleted. */
  readonly deleted: readonly string[];
  /** Sidecars removed because their backup has no file left (T12729). */
  readonly sidecars: readonly string[];
  /**
   * Why every backup of the type was kept past the cap: a marker that does
   * not parse, or a store that could not be read (busy, corrupt). `null` when
   * rotation ran.
   */
  readonly keptAll: 'marker-unreadable' | 'store-unreadable' | null;
  /** The unreadable marker keys (`<kvTable>:twin_collapse:<table>`). */
  readonly unreadable: readonly string[];
  /** The error reading the store (for example `database is locked`), or `null`. */
  readonly error: string | null;
}

/** The backup type every pre-collapse snapshot is written as. */
const PRE_COLLAPSE_BACKUP_TYPE = 'migration';

/** Key prefix of a twin-collapse marker (`twin_collapse:<table>`) in a kv table. */
const MARKER_PREFIX = 'twin_collapse:';

/** The twin-collapse markers of a project store, as rotation reads them. */
export interface MarkerSnapshots {
  /** File names of the pre-collapse snapshots the readable markers reference. */
  readonly names: ReadonlySet<string>;
  /** Marker keys whose value does not parse (`<kvTable>:twin_collapse:<table>`). */
  readonly unreadable: readonly string[];
  /** Why the store could not be read at all (busy, corrupt), or `null`. */
  readonly error: string | null;
}

/**
 * The pre-collapse snapshots the twin-collapse markers of the project store
 * (`<backupDir>/../../cleo.db`) reference, and the markers that cannot be
 * read. No store there: no markers.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @returns The referenced file names, the unreadable marker keys, and any read error.
 * @task T12727
 * @task T12770
 */
export function readMarkerSnapshots(backupDir: string): MarkerSnapshots {
  const store = join(backupDir, '..', '..', 'cleo.db');
  const names = new Set<string>();
  const unreadable: string[] = [];
  if (!existsSync(store)) return { names, unreadable, error: null };
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
        .prepare(`SELECT key, value FROM ${table} WHERE substr(key, 1, ?) = ?`)
        .all(MARKER_PREFIX.length, MARKER_PREFIX) as Array<{ key: string; value: string }>;
      for (const { key, value } of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = undefined;
        }
        const snapshot =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { snapshot?: unknown }).snapshot
            : Symbol.for('unreadable');
        if (snapshot === undefined || snapshot === null) continue;
        if (typeof snapshot === 'string' && snapshot.length > 0) names.add(basename(snapshot));
        else unreadable.push(`${table}:${key}`);
      }
    }
    return { names, unreadable, error: null };
  } catch (error) {
    return { names, unreadable, error: error instanceof Error ? error.message : String(error) };
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

// ---------------------------------------------------------------------------
// The byte cap (T14278): one policy over every snapshot family in the dir
// ---------------------------------------------------------------------------

/** The default `backup.maxBytes`: this many times the live store's size. */
export const DEFAULT_BACKUP_MAX_BYTES_FACTOR = 5;

/** Vacuum-snapshot prefixes that are copies of the project `cleo.db`. */
const STORE_COPY_PREFIXES = new Set(['tasks', 'brain', 'conduit']);

/** Backup types whose sets hold a `cleo.db.<type>-<stamp>` copy of the store. */
const STORE_SET_TYPES = new Set(['snapshot', 'migration']);

/** One backup set: every file of one snapshot run (a store copy, sidecars, JSON copies). */
interface BackupSet {
  /** `vacuum-<stamp>` or `<type>-<stamp>`. */
  readonly key: string;
  /** `YYYYMMDD-HHmmss`. */
  readonly stamp: string;
  /** `vacuum`, `snapshot` or `migration`. */
  readonly kind: string;
  /** Every file name in the set. */
  readonly files: string[];
  /** The set's copy of the project store, when it has one. */
  store: string | null;
  /** Bytes of every file in the set. */
  bytes: number;
}

/** One set the byte cap removed, with the newer verified snapshot that covers it. */
export interface ByteCapRemoval {
  readonly set: string;
  readonly files: readonly string[];
  readonly bytes: number;
  /** File name of the newest verified store snapshot, which holds everything this set held and more. */
  readonly coveredBy: string;
}

/** Outcome of {@link enforceBackupByteCap}. */
export interface ByteCapResult {
  readonly maxBytes: number;
  readonly totalBefore: number;
  readonly totalAfter: number;
  /** File name of the newest store snapshot that opens, or `null` when none does. */
  readonly newestVerified: string | null;
  readonly removed: readonly ByteCapRemoval[];
  /** Still over the cap: nothing more is provably redundant (pinned, marked or uncovered). */
  readonly overCap: boolean;
}

/**
 * Whether a store snapshot opens as a SQLite database with a schema.
 *
 * @param path - The snapshot file.
 * @returns True when it opens read-only and has at least one schema object.
 */
export function snapshotOpens(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: Ctor } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, opts: { readOnly: boolean }) => DatabaseSync;
    };
    db = new Ctor(path, { readOnly: true }); // db-open-allowed: leaf module; read-only probe that a snapshot opens before older ones are pruned
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number };
    return row.n > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Group a backup directory's files into sets; files of no set are returned too. */
function backupSets(names: readonly string[]): { sets: Map<string, BackupSet>; loose: string[] } {
  const sets = new Map<string, BackupSet>();
  const loose: string[] = [];
  const add = (key: string, stamp: string, kind: string, name: string): BackupSet => {
    let set = sets.get(key);
    if (set === undefined) {
      set = { key, stamp, kind, files: [], store: null, bytes: 0 };
      sets.set(key, set);
    }
    set.files.push(name);
    return set;
  };
  for (const name of names) {
    const vacuum = /^([a-z][a-z0-9_]*)-(\d{8}-\d{6})\.db$/.exec(name);
    if (vacuum && STORE_COPY_PREFIXES.has(vacuum[1] ?? '')) {
      const set = add(`vacuum-${vacuum[2]}`, vacuum[2] ?? '', 'vacuum', name);
      if (vacuum[1] === 'tasks') set.store = name;
      continue;
    }
    const typed = /^(.+)\.(snapshot|migration)-(\d{8}-\d{6})$/.exec(name);
    if (typed && STORE_SET_TYPES.has(typed[2] ?? '')) {
      const set = add(`${typed[2]}-${typed[3]}`, typed[3] ?? '', typed[2] ?? '', name);
      if (typed[1] === 'cleo.db') set.store = name;
      continue;
    }
    const meta = /^(snapshot|migration)-(\d{8}-\d{6})\.meta\.json$/.exec(name);
    if (meta) {
      add(`${meta[1]}-${meta[2]}`, meta[2] ?? '', meta[1] ?? '', name);
      continue;
    }
    loose.push(name);
  }
  return { sets, loose };
}

/**
 * Keep `.cleo/backups/sqlite` at or under `maxBytes` (T14278): one policy over
 * every snapshot family in the directory (session-end `tasks-*`, `backup add`
 * `*.snapshot-*`, and the store's own `*.migration-*` snapshots, which join
 * the rotation here).
 *
 * Every removal is proven redundant first (the 2026-10-19 lesson): a set is
 * removed only when it is strictly older than the newest store snapshot that
 * opens, which holds everything the older set held. That newest verified
 * snapshot is never removed, nor any set newer than or as new as it, a pinned
 * backup (T12535), or a pre-collapse snapshot a twin-collapse marker
 * references; when the markers cannot be read, no migration set is removed.
 * With no snapshot that opens, nothing is removed. Oldest sets go first, only
 * while the directory is over the cap, and each removal is appended to
 * `<backupDir>/rotation.jsonl` with the snapshot that covers it.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @param maxBytes - The cap.
 * @param opts - `opens` overrides the verification probe (tests).
 * @returns What was removed and why the directory may still be over the cap.
 * @task T14278
 */
export function enforceBackupByteCap(
  backupDir: string,
  maxBytes: number,
  opts: { opens?: (path: string) => boolean } = {},
): ByteCapResult {
  const opens = opts.opens ?? snapshotOpens;
  const names = readdirSync(backupDir).filter((n) => !n.endsWith('.tmp'));
  const size = (name: string): number => {
    try {
      return lstatSync(join(backupDir, name)).size;
    } catch {
      return 0;
    }
  };
  const { sets } = backupSets(names);
  let total = 0;
  for (const name of names) total += size(name);
  for (const set of sets.values()) set.bytes = set.files.reduce((n, f) => n + size(f), 0);
  const totalBefore = total;

  const withStore = [...sets.values()]
    .filter((s) => s.store !== null)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)); // newest first
  const newest = withStore.find((s) => opens(join(backupDir, s.store as string))) ?? null;
  const removed: ByteCapRemoval[] = [];
  if (newest === null || total <= maxBytes) {
    return {
      maxBytes,
      totalBefore,
      totalAfter: total,
      newestVerified: newest?.store ?? null,
      removed,
      overCap: total > maxBytes,
    };
  }

  const markers = readMarkerSnapshots(backupDir);
  const markersUnreadable = markers.error !== null || markers.unreadable.length > 0;
  const candidates = [...sets.values()]
    .filter((s) => s.stamp < newest.stamp)
    .filter((s) => !(s.kind === PRE_COLLAPSE_BACKUP_TYPE && markersUnreadable))
    .filter((s) => !s.files.some((f) => markers.names.has(f)))
    .filter(
      (s) => s.kind === 'vacuum' || !s.files.some((f) => isPinnedBackup(backupDir, f, s.kind)),
    )
    .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0)); // oldest first
  const coveredBy = newest.store as string;
  for (const set of candidates) {
    if (total <= maxBytes) break;
    let freed = 0;
    for (const file of set.files) {
      const bytes = size(file);
      try {
        unlinkSync(join(backupDir, file));
        freed += bytes;
      } catch {
        // vanished or locked: counted as kept
      }
    }
    total -= freed;
    const removal: ByteCapRemoval = { set: set.key, files: set.files, bytes: freed, coveredBy };
    removed.push(removal);
    try {
      appendFileSync(
        join(backupDir, 'rotation.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), reason: 'byte-cap', maxBytes, ...removal })}\n`,
      );
    } catch {
      // the result still names it
    }
  }
  if (total > maxBytes) {
    getLogger('backup-rotation').warn(
      { backupDir, total, maxBytes },
      'backups over the byte cap: nothing more is provably redundant (pinned, marked or uncovered)',
    );
  }
  return {
    maxBytes,
    totalBefore,
    totalAfter: total,
    newestVerified: coveredBy,
    removed,
    overCap: total > maxBytes,
  };
}

/**
 * Apply the byte cap after a snapshot (T14278): `backup.maxBytes` from the
 * project's `.cleo/config.json`, else {@link DEFAULT_BACKUP_MAX_BYTES_FACTOR}
 * times the live store's size. Synchronous, so every snapshot writer (the
 * migration snapshot included) runs it right after writing. Non-fatal: any
 * failure leaves every backup in place.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @returns The cap's outcome, or `null` when it could not run.
 * @task T14278
 */
export function applyBackupByteCap(backupDir: string): ByteCapResult | null {
  try {
    const cleoDir = join(backupDir, '..', '..');
    let configured: unknown;
    try {
      const config = JSON.parse(readFileSync(join(cleoDir, 'config.json'), 'utf-8')) as {
        backup?: { maxBytes?: unknown };
      };
      configured = config.backup?.maxBytes;
    } catch {
      configured = undefined;
    }
    const maxBytes =
      typeof configured === 'number' && configured > 0
        ? configured
        : DEFAULT_BACKUP_MAX_BYTES_FACTOR * statSync(join(cleoDir, 'cleo.db')).size;
    if (!(maxBytes > 0)) return null;
    return enforceBackupByteCap(backupDir, maxBytes);
  } catch {
    return null;
  }
}
