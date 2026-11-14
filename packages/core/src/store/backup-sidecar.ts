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
import { snapshotRecoveryReason } from './recover-malformed-db.js';

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
 * Recovery rows absent or older in live pin their whole backup group past the cap.
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
  const retained: Record<string, string> = {};
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
            retained,
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
        if (!name.startsWith('cleo.db.')) continue;
        const reason = snapshotRecoveryReason(
          join(backupDir, '..', '..', 'cleo.db'),
          join(backupDir, name),
        );
        if (reason) retained[name] = reason;
      }
      if (oldest.names.some((name) => retained[name])) {
        getLogger('backup-rotation').warn(
          { backupDir, retained },
          'Keeping recovery snapshots past the rotation cap',
        );
        continue;
      }
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
    retained,
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
  /** Snapshots kept past the count cap because their recovery rows are not in the live store. */
  readonly retained: Readonly<Record<string, string>>;
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

/**
 * The directory under `.cleo/` whose JSON and JSONL receipts name rollback
 * points (`backupReceiptPath` of a docs doctor prune or repair, …).
 */
const RECEIPT_DIR = 'audit';

/** The backups the receipts under `.cleo/audit/` name, as rotation reads them. */
export interface ReceiptReferences {
  /** Backup file name or backup id → the `<receipt file>:<field>` that names it. */
  readonly refs: ReadonlyMap<string, string>;
  /** Why a receipt could not be read, or `null`. */
  readonly error: string | null;
}

/**
 * The rollback points the receipts under `<root>/.cleo/audit/` name (T14278):
 * a receipt field whose value is one of `names` (a backup id) or a path whose
 * file name is one of them. Such a snapshot holds the state before a repair,
 * which no newer copy has, so the byte cap keeps it. A line that does not
 * parse refers to every name it contains. Free text inside a parsed field
 * (a note) is not a reference: a repair names its backup in a field.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @param names - The backup file names and backup ids to look for.
 * @returns Each referenced name with the first receipt field naming it, and any read error.
 * @task T14278
 */
export function readReceiptReferences(
  backupDir: string,
  names: ReadonlySet<string>,
): ReceiptReferences {
  const cleoDir = join(backupDir, '..', '..');
  const refs = new Map<string, string>();
  const note = (name: string, where: string) => {
    if (!refs.has(name)) refs.set(name, where);
  };
  const visit = (value: unknown, field: string, where: string): void => {
    if (typeof value === 'string') {
      const hit = names.has(value) ? value : basename(value);
      if (names.has(hit)) note(hit, `${where}:${field}`);
    } else if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) visit(v, `${field}[${i}]`, where);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value))
        visit(v, field === '' ? k : `${field}.${k}`, where);
    }
  };
  const record = (text: string, where: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      for (const name of names) if (text.includes(name)) note(name, `${where} (unparsed)`);
      return;
    }
    visit(parsed, '', where);
  };
  const walk = (rel: string): void => {
    const abs = join(cleoDir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.jsonl')) {
        readFileSync(join(cleoDir, child), 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            if (line.trim() !== '') record(line, `${child}#${i + 1}`);
          });
      } else if (entry.name.endsWith('.json')) {
        record(readFileSync(join(cleoDir, child), 'utf-8'), child);
      }
    }
  };
  if (!existsSync(join(cleoDir, RECEIPT_DIR))) return { refs, error: null };
  try {
    walk(RECEIPT_DIR);
    return { refs, error: null };
  } catch (error) {
    return { refs, error: error instanceof Error ? error.message : String(error) };
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

/** Vacuum-snapshot prefixes managed by the cap (one snapshot run each). */
const VACUUM_PREFIXES = new Set(['tasks', 'brain', 'conduit']);

/** Backup types whose sets the cap manages. */
const CAPPED_TYPES = new Set(['snapshot', 'migration']);

/**
 * The store role a file copies, or `null` for a sidecar. `tasks-*.db` and
 * `cleo.db.<type>-*` are both copies of the project `cleo.db`; every other
 * file is its own role (`brain-*` and `conduit-*` included, whether or not a
 * run hard-linked them to the project store).
 */
function roleOf(kind: string, base: string): string | null {
  if (kind === 'meta') return null;
  if (kind === 'vacuum') return base === 'tasks' ? 'cleo.db' : `${base}.db`;
  return base;
}

/** The `coveredBy` entry of a role whose copy in the set is empty: nothing is lost. */
export const EMPTY_COPY = '(empty copy: nothing to lose)';

/** One file of a backup set. */
interface SetFile {
  readonly name: string;
  /** The store role it copies, or `null` for a sidecar. */
  readonly role: string | null;
}

/** One backup set: every file of one snapshot run. */
interface BackupSet {
  /** `vacuum-<stamp>` or `<type>-<stamp>`. */
  readonly key: string;
  /** `YYYYMMDD-HHmmss`. */
  readonly stamp: string;
  /** `vacuum`, `snapshot` or `migration`. */
  readonly kind: string;
  readonly files: SetFile[];
  bytes: number;
}

/** One set the cap removes (or would), with the newer verified copy of each role it held. */
export interface ByteCapRemoval {
  readonly set: string;
  readonly files: readonly string[];
  readonly bytes: number;
  /** Per store role in the set: the newer snapshot of that same role that verifies. */
  readonly coveredBy: Readonly<Record<string, string>>;
}

/** A set the cap keeps although it is over the cap, and why. */
export interface ByteCapKept {
  readonly set: string;
  readonly bytes: number;
  readonly reason: string;
}

/** The cap's plan, or what it did. */
export interface ByteCapResult {
  readonly maxBytes: number;
  readonly totalBefore: number;
  readonly totalAfter: number;
  readonly removed: readonly ByteCapRemoval[];
  /** Older sets kept while the directory is still over the cap, with the reason. */
  readonly kept: readonly ByteCapKept[];
  /** Still over the cap: nothing more is provably redundant. */
  readonly overCap: boolean;
  /** True for a plan (nothing deleted). */
  readonly dryRun: boolean;
}

/**
 * What a snapshot file holds (T14278): `ok` when it is a usable copy of its
 * role (a database opens read-only with at least one schema object; a JSON
 * file parses; any other file is non-empty), `empty` when it holds nothing
 * (zero bytes, or a database with no schema object: the copy of an empty
 * store), `bad` when it cannot be read.
 *
 * @param path - The snapshot file.
 * @returns `ok`, `empty` or `bad`.
 */
export function probeSnapshot(path: string): 'ok' | 'empty' | 'bad' {
  const name = basename(path);
  let bytes: number;
  try {
    bytes = statSync(path).size;
  } catch {
    return 'bad';
  }
  if (bytes === 0) return 'empty';
  const isDb = /\.db(\.|-|$)/.test(name);
  if (!isDb && /\.json(\.|$)/.test(name)) {
    try {
      JSON.parse(readFileSync(path, 'utf-8'));
      return 'ok';
    } catch {
      return 'bad';
    }
  }
  if (!isDb) return 'ok';
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: Ctor } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, opts: { readOnly: boolean }) => DatabaseSync;
    };
    db = new Ctor(path, { readOnly: true }); // db-open-allowed: leaf module; read-only probe that a snapshot opens before older ones are pruned
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number };
    return row.n > 0 ? 'ok' : 'empty';
  } catch {
    return 'bad';
  } finally {
    db?.close();
  }
}

/**
 * Whether a snapshot file is a usable copy of its role ({@link probeSnapshot} `ok`).
 *
 * @param path - The snapshot file.
 * @returns True when it verifies.
 */
export function snapshotOpens(path: string): boolean {
  return probeSnapshot(path) === 'ok';
}

/** Group a backup directory's files into capped sets; other files belong to none. */
function backupSets(names: readonly string[]): Map<string, BackupSet> {
  const sets = new Map<string, BackupSet>();
  const add = (key: string, stamp: string, kind: string, file: SetFile): void => {
    let set = sets.get(key);
    if (set === undefined) {
      set = { key, stamp, kind, files: [], bytes: 0 };
      sets.set(key, set);
    }
    set.files.push(file);
  };
  for (const name of names) {
    const vacuum = /^([a-z][a-z0-9_]*)-(\d{8}-\d{6})\.db$/.exec(name);
    if (vacuum && VACUUM_PREFIXES.has(vacuum[1] ?? '')) {
      add(`vacuum-${vacuum[2]}`, vacuum[2] ?? '', 'vacuum', {
        name,
        role: roleOf('vacuum', vacuum[1] ?? ''),
      });
      continue;
    }
    const typed = /^(.+)\.(snapshot|migration)-(\d{8}-\d{6})$/.exec(name);
    if (typed && CAPPED_TYPES.has(typed[2] ?? '')) {
      add(`${typed[2]}-${typed[3]}`, typed[3] ?? '', typed[2] ?? '', {
        name,
        role: roleOf(typed[2] ?? '', typed[1] ?? ''),
      });
      continue;
    }
    const meta = /^(snapshot|migration)-(\d{8}-\d{6})\.meta\.json$/.exec(name);
    if (meta) add(`${meta[1]}-${meta[2]}`, meta[2] ?? '', meta[1] ?? '', { name, role: null });
  }
  return sets;
}

/**
 * Plan, and unless `dryRun` apply, the byte cap on `.cleo/backups/sqlite`
 * (T14278): one policy over every snapshot family in the directory
 * (session-end `tasks-*`, `backup add` `*.snapshot-*`, and the store's own
 * `*.migration-*` snapshots, which join the rotation here).
 *
 * Coverage is proven per store role (the 2026-10-19 lesson: a newer snapshot
 * of one store never covers another store's only copy). A set may go only
 * when, for EVERY store role it holds (the project `cleo.db`, `brain`,
 * `conduit`, the blob manifest, the attachments index, each JSON copy …), a
 * strictly newer copy of that same role exists and verifies, or the set's
 * copy of it is empty (zero bytes, or a database with no schema object:
 * nothing to lose; recorded as {@link EMPTY_COPY}). So the newest
 * verified copy of every role is never removed. Project-store recovery rows must
 * also be present in live before their snapshot can go. Also never removed: a pinned
 * backup (T12535), a pre-collapse snapshot a twin-collapse marker references,
 * any migration set while the markers cannot be read, a rollback point a
 * receipt under `.cleo/audit/` names ({@link readReceiptReferences}), and
 * every set while a receipt cannot be read. Oldest sets go
 * first, only while the directory is over the cap; each removal is appended
 * to `<backupDir>/rotation.jsonl` with its covering file per role.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @param maxBytes - The cap.
 * @param opts - `dryRun` plans only; `probe` overrides {@link probeSnapshot} (tests).
 * @returns The removals (planned or done) and the sets kept over the cap, with reasons.
 * @task T14278
 */
export function enforceBackupByteCap(
  backupDir: string,
  maxBytes: number,
  opts: { dryRun?: boolean; probe?: (path: string) => 'ok' | 'empty' | 'bad' } = {},
): ByteCapResult {
  const dryRun = opts.dryRun === true;
  const probe = opts.probe ?? probeSnapshot;
  const probed = new Map<string, 'ok' | 'empty' | 'bad'>();
  const state = (name: string): 'ok' | 'empty' | 'bad' => {
    let result = probed.get(name);
    if (result === undefined) {
      result = probe(join(backupDir, name));
      probed.set(name, result);
    }
    return result;
  };
  const opens = (name: string): boolean => state(name) === 'ok';
  // Sorted: readdir order differs by filesystem, and the plan must not.
  const names = readdirSync(backupDir)
    .filter((n) => !n.endsWith('.tmp'))
    .sort();
  const size = (name: string): number => {
    try {
      return lstatSync(join(backupDir, name)).size;
    } catch {
      return 0;
    }
  };
  const sets = backupSets(names);
  let total = 0;
  for (const name of names) total += size(name);
  for (const set of sets.values()) set.bytes = set.files.reduce((n, f) => n + size(f.name), 0);
  const totalBefore = total;
  const removed: ByteCapRemoval[] = [];
  const kept: ByteCapKept[] = [];
  const finish = (): ByteCapResult => ({
    maxBytes,
    totalBefore,
    totalAfter: total,
    removed,
    kept,
    overCap: total > maxBytes,
    dryRun,
  });
  if (total <= maxBytes) return finish();

  // Every copy of each role, newest first.
  const copiesOf = new Map<string, Array<{ name: string; stamp: string }>>();
  for (const set of sets.values()) {
    for (const f of set.files) {
      if (f.role === null) continue;
      const list = copiesOf.get(f.role) ?? [];
      list.push({ name: f.name, stamp: set.stamp });
      copiesOf.set(f.role, list);
    }
  }
  for (const list of copiesOf.values()) list.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));

  const markers = readMarkerSnapshots(backupDir);
  const markersUnreadable = markers.error !== null || markers.unreadable.length > 0;
  const lookFor = new Set<string>();
  for (const set of sets.values()) {
    if (set.kind !== 'vacuum') lookFor.add(set.key);
    for (const f of set.files) lookFor.add(f.name);
  }
  const receipts = readReceiptReferences(backupDir, lookFor);
  const oldestFirst = [...sets.values()].sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
  for (const set of oldestFirst) {
    if (total <= maxBytes) break;
    const keep = (reason: string) => kept.push({ set: set.key, bytes: set.bytes, reason });
    if (set.kind === PRE_COLLAPSE_BACKUP_TYPE && markersUnreadable) {
      keep('twin-collapse markers unreadable: every migration set is kept');
      continue;
    }
    if (receipts.error !== null) {
      keep(`receipts unreadable (${receipts.error}): every set is kept`);
      continue;
    }
    const ref =
      receipts.refs.get(set.key) ??
      set.files.map((f) => receipts.refs.get(f.name)).find((r) => r !== undefined);
    if (ref !== undefined) {
      keep(`referenced by ${ref}`);
      continue;
    }
    const marked = set.files.find((f) => markers.names.has(f.name));
    if (marked) {
      keep(`a twin-collapse marker references ${marked.name}`);
      continue;
    }
    if (
      set.kind !== 'vacuum' &&
      set.files.some((f) => isPinnedBackup(backupDir, f.name, set.kind))
    ) {
      keep('pinned');
      continue;
    }
    const recovery = set.files
      .filter((f) => f.role === 'cleo.db' && state(f.name) !== 'empty')
      .map((f) =>
        snapshotRecoveryReason(join(backupDir, '..', '..', 'cleo.db'), join(backupDir, f.name)),
      )
      .find((reason) => reason !== undefined);
    if (recovery) {
      keep(recovery);
      continue;
    }
    const coveredBy: Record<string, string> = {};
    let uncovered: string | null = null;
    for (const f of set.files) {
      if (f.role === null) continue;
      // An empty copy (a run whose source was empty) holds nothing to lose.
      if (state(f.name) === 'empty') {
        coveredBy[f.role] = EMPTY_COPY;
        continue;
      }
      const cover = (copiesOf.get(f.role) ?? []).find((c) => c.stamp > set.stamp && opens(c.name));
      if (cover === undefined) {
        uncovered = f.role;
        break;
      }
      coveredBy[f.role] = cover.name;
    }
    if (uncovered !== null) {
      keep(`no newer verified snapshot of ${uncovered}`);
      continue;
    }
    if (Object.keys(coveredBy).length === 0) {
      keep('holds no store copy (sidecars only)');
      continue;
    }
    let freed = 0;
    for (const f of set.files) {
      const bytes = size(f.name);
      if (dryRun) {
        freed += bytes;
        continue;
      }
      try {
        unlinkSync(join(backupDir, f.name));
        freed += bytes;
      } catch {
        // vanished or locked: counted as kept
      }
    }
    total -= freed;
    const removal: ByteCapRemoval = {
      set: set.key,
      files: set.files.map((f) => f.name),
      bytes: freed,
      coveredBy,
    };
    removed.push(removal);
    if (!dryRun) {
      try {
        appendFileSync(
          join(backupDir, 'rotation.jsonl'),
          `${JSON.stringify({ at: new Date().toISOString(), reason: 'byte-cap', maxBytes, ...removal })}\n`,
        );
      } catch {
        // the result still names it
      }
    }
  }
  if (total > maxBytes && !dryRun) {
    getLogger('backup-rotation').warn(
      { backupDir, total, maxBytes, kept: kept.length },
      'backups over the byte cap: nothing more is provably redundant',
    );
  }
  return finish();
}

/**
 * The byte cap for a backup directory (T14278): `backup.maxBytes` from the
 * project's `.cleo/config.json`, else {@link DEFAULT_BACKUP_MAX_BYTES_FACTOR}
 * times the live store's size; `null` when neither can be read.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @returns The cap in bytes, or `null`.
 * @task T14278
 */
export function resolveBackupMaxBytes(backupDir: string): number | null {
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
  if (typeof configured === 'number' && configured > 0) return configured;
  try {
    const maxBytes = DEFAULT_BACKUP_MAX_BYTES_FACTOR * statSync(join(cleoDir, 'cleo.db')).size;
    return maxBytes > 0 ? maxBytes : null;
  } catch {
    return null;
  }
}

/**
 * Apply the byte cap after a snapshot (T14278), or plan it (`dryRun`, what
 * `cleo backup list --rotation` prints). Synchronous, so every snapshot writer
 * (the migration snapshot included) runs it right after writing. Non-fatal:
 * any failure leaves every backup in place.
 *
 * @param backupDir - `<root>/.cleo/backups/sqlite`.
 * @param opts - `dryRun` plans only.
 * @returns The cap's outcome, or `null` when it could not run.
 * @task T14278
 */
export function applyBackupByteCap(
  backupDir: string,
  opts: { dryRun?: boolean } = {},
): ByteCapResult | null {
  try {
    const maxBytes = resolveBackupMaxBytes(backupDir);
    if (maxBytes === null) return null;
    return enforceBackupByteCap(backupDir, maxBytes, { dryRun: opts.dryRun === true });
  } catch {
    return null;
  }
}
