/**
 * Detect project stores stranded inside CLEO worktrees (T12460).
 *
 * ## The failure this reports
 *
 * Before T12460, a `cleo` command run inside an orchestrate worktree
 * (`<cleoHome>/worktrees/<projectHash>/<taskId>/`) resolved the WORKTREE's own
 * `.cleo/` as the project directory: the nearest-`.cleo` walk (and the
 * `CLEO_WORKTREE_ROOT` scope) won before the gitlink step. The worktree store
 * opened empty, `autoRecoverFromBackup` copied the parent project's newest
 * snapshot into it (~1.25 GB on this repo), and `createSafetyBackup` added a
 * same-size `.bak` beside it. Every later write from that worktree landed in the
 * copy. Nothing merges it back, and worktree prune deletes or quarantines it.
 *
 * Path resolution now maps a worktree to its parent project's store, so no new
 * copies are created. Copies made before the fix are still on disk and may hold
 * the only record of writes made from inside the worktree. This scan finds them
 * and reports, per table, whether a copy holds rows the parent does not.
 *
 * ## Read-only contract
 *
 * Nothing is deleted, moved, or written. Every SQLite file is opened with
 * `readOnly: true`. To import rows a copy holds that the parent lacks, use
 * `cleo doctor split-brain --source <copy>` after reviewing this report.
 *
 * @task T12460
 * @see ADR-055 — worktree-by-default
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';

/** File name of the consolidated project store. */
const PROJECT_STORE_FILENAME = 'cleo.db';

/** First 16 bytes of every SQLite 3 database file. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * Tables compared between a stranded copy and the parent store, each with the
 * single-column primary key and the timestamp column that best reflects a write.
 */
const COMPARED_TABLES: readonly {
  readonly table: string;
  readonly key: string;
  readonly time: string;
}[] = [
  { table: 'tasks_tasks', key: 'id', time: 'updated_at' },
  { table: 'tasks_sessions', key: 'id', time: 'started_at' },
  { table: 'tasks_audit_log', key: 'id', time: 'timestamp' },
  { table: 'tasks_lifecycle_evidence', key: 'id', time: 'recorded_at' },
  { table: 'pipeline_manifest', key: 'id', time: 'created_at' },
  { table: 'brain_observations', key: 'id', time: 'created_at' },
  { table: 'brain_decisions', key: 'id', time: 'created_at' },
  { table: 'brain_learnings', key: 'id', time: 'created_at' },
  { table: 'brain_patterns', key: 'id', time: 'extracted_at' },
  { table: 'conduit_messages', key: 'id', time: 'created_at' },
];

/** Per-table comparison of a stranded copy against the parent store. */
export interface WorktreeStoreTableDiff {
  /** Table name, e.g. `tasks_tasks`. */
  readonly table: string;
  /** Rows in the stranded copy. */
  readonly rowsInCopy: number;
  /** Rows of the copy whose primary key is ABSENT from the parent table. */
  readonly missingInParent: number;
  /**
   * Rows present in both whose timestamp in the copy is later than the parent's
   * timestamp for the SAME key: updates made in the worktree that the parent's
   * version of the row does not reflect.
   */
  readonly newerThanParent: number;
  /** Newest timestamp in the copy's column, or `null` when the table is empty. */
  readonly newestInCopy: string | null;
  /** Newest timestamp in the parent's column, or `null` when the table is empty. */
  readonly newestInParent: string | null;
}

/** One database-like file found under a worktree's `.cleo/`. */
export interface WorktreeStoreFile {
  /** Absolute path of the file. */
  readonly path: string;
  /** Bare file name, e.g. `cleo.db` or `cleo-pre-cleo.db.bak`. */
  readonly name: string;
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** Last modification time, ISO 8601. */
  readonly modifiedAt: string;
  /** Whether the file carries the SQLite 3 header. */
  readonly isSqlite: boolean;
  /**
   * `true` when at least one compared table holds a row the parent lacks by
   * key, or one newer than the parent's newest; `false` when every compared
   * table is covered by the parent; `null` when no comparison was possible.
   */
  readonly hasRowsNewerThanParent: boolean | null;
  /** Per-table comparison; empty when no comparison was possible. */
  readonly tables: readonly WorktreeStoreTableDiff[];
  /** Why the comparison was skipped or failed, when it was. */
  readonly note?: string;
}

/** One worktree whose `.cleo/` holds at least one store file. */
export interface WorktreeStoreEntry {
  /** Absolute worktree path. */
  readonly worktreePath: string;
  /** Whether git still lists the worktree (`git worktree list`). */
  readonly registeredWithGit: boolean;
  /** Store files found directly under `<worktree>/.cleo/`. */
  readonly files: readonly WorktreeStoreFile[];
}

/** Result of {@link scanWorktreeStores}. */
export interface WorktreeStoreScanResult {
  /** Absolute parent project root that was scanned. */
  readonly projectRoot: string;
  /** Absolute path of the parent project's store. */
  readonly parentStorePath: string;
  /** Whether the parent store exists; comparisons are skipped when it does not. */
  readonly parentStoreExists: boolean;
  /** Canonical worktree directory for this project (`<cleoHome>/worktrees/<hash>`). */
  readonly worktreeBase: string;
  /** Number of worktree directories inspected. */
  readonly worktreesScanned: number;
  /** Worktrees holding store files, sorted by path. */
  readonly entries: readonly WorktreeStoreEntry[];
  /** Total store files found across all worktrees. */
  readonly strandedFileCount: number;
  /** Total bytes those files occupy. */
  readonly strandedBytes: number;
  /** Paths of files that hold rows the parent store does not. */
  readonly filesWithNewerRows: readonly string[];
}

/** Options for {@link scanWorktreeStores}. */
export interface WorktreeStoreScanOptions {
  /** Override the canonical worktree base (tests). */
  readonly worktreeBase?: string;
  /** Skip row comparisons; list files only. Default `false`. */
  readonly skipCompare?: boolean;
}

/**
 * Canonicalise a path through symlinks so git's spelling and the directory
 * listing's spelling of one worktree compare equal.
 *
 * @param p - Path to canonicalise.
 * @returns The real path, or the resolved path when it does not exist.
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * List linked worktrees of `projectRoot` via `git worktree list --porcelain`.
 *
 * @param projectRoot - Main repository root.
 * @returns Absolute worktree paths, excluding the main checkout itself.
 */
function listGitLinkedWorktrees(projectRoot: string): string[] {
  const result = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) return [];
  const main = canonicalPath(projectRoot);
  const paths: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = canonicalPath(line.slice('worktree '.length).trim());
    if (p !== main) paths.push(p);
  }
  return paths;
}

/**
 * List child directories of the canonical worktree base.
 *
 * @param base - `<cleoHome>/worktrees/<projectHash>`.
 * @returns Absolute child directory paths; empty when the base is absent.
 */
function listCanonicalWorktreeDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => canonicalPath(join(base, d.name)));
  } catch {
    return [];
  }
}

/**
 * Report whether a file begins with the SQLite 3 header.
 *
 * @param path - File to probe.
 * @returns `true` for a SQLite database file.
 */
function hasSqliteHeader(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return read === buf.length && buf.toString('latin1') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Open a SQLite file for inspection without leaving anything behind on disk.
 *
 * A plain read-only open of a WAL-mode file creates `-wal`/`-shm` sidecars that
 * a read-only connection cannot remove. When no `-wal` exists there is nothing
 * uncheckpointed to read, so the file is opened `immutable=1`, which creates no
 * sidecar at all. When a `-wal` exists it holds committed rows the main file
 * lacks, so the file is opened read-only through the normal path to include them.
 *
 * @param path - SQLite file to open.
 * @returns A read-only handle.
 */
function openForInspection(path: string): DatabaseSync {
  let hasWal = false;
  try {
    hasWal = statSync(`${path}-wal`).size > 0;
  } catch {
    hasWal = false;
  }
  if (hasWal) {
    // db-open-allowed: read-only forensic probe; a chokepoint open would run migrations and take a writer lease for a report
    return new DatabaseSync(path, { readOnly: true }); // db-open-allowed: read-only forensic probe
  }
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  // db-open-allowed: read-only forensic probe; immutable so no sidecar is created beside a stranded copy
  return new DatabaseSync(url, { readOnly: true }); // db-open-allowed: read-only forensic probe
}

/**
 * Report whether a table and both named columns exist in `db`.
 *
 * @param db - Open handle.
 * @param table - Table name.
 * @param columns - Columns that must exist.
 * @returns `true` when the table carries every column.
 */
function hasColumns(db: DatabaseSync, table: string, columns: readonly string[]): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    return columns.every((c) => names.has(c));
  } catch {
    return false;
  }
}

/**
 * Coerce a SQLite scalar to a display string.
 *
 * @param value - Scalar from a `MAX()` aggregate.
 * @returns String form, or `null` for SQL NULL.
 */
function scalarToString(value: string | number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Compare one table of a stranded copy against the parent store.
 *
 * @param copy - Read-only handle on the stranded copy.
 * @param parent - Read-only handle on the parent store.
 * @param spec - Table, key and timestamp column.
 * @returns The diff, or `null` when either side lacks the table or columns.
 */
function compareTable(
  copy: DatabaseSync,
  parent: DatabaseSync,
  spec: (typeof COMPARED_TABLES)[number],
): WorktreeStoreTableDiff | null {
  const { table, key, time } = spec;
  if (!hasColumns(copy, table, [key, time]) || !hasColumns(parent, table, [key, time])) return null;

  type MaxRow = { newest: string | number | bigint | null };
  const parentNewestRaw = (
    parent.prepare(`SELECT MAX("${time}") AS newest FROM "${table}"`).get() as MaxRow
  ).newest;
  const copyNewestRaw = (
    copy.prepare(`SELECT MAX("${time}") AS newest FROM "${table}"`).get() as MaxRow
  ).newest;
  type KeyTimeRow = { k: string | number; t: string | number | bigint | null };
  const parentTimes = new Map<string, string | number | bigint | null>();
  for (const row of parent
    .prepare(`SELECT "${key}" AS k, "${time}" AS t FROM "${table}"`)
    .iterate() as Iterable<KeyTimeRow>) {
    parentTimes.set(String(row.k), row.t);
  }
  let rowsInCopy = 0;
  let missingInParent = 0;
  let newerThanParent = 0;
  for (const row of copy
    .prepare(`SELECT "${key}" AS k, "${time}" AS t FROM "${table}"`)
    .iterate() as Iterable<KeyTimeRow>) {
    rowsInCopy++;
    const k = String(row.k);
    if (!parentTimes.has(k)) {
      missingInParent++;
      continue;
    }
    const parentTime = parentTimes.get(k) ?? null;
    if (row.t !== null && (parentTime === null || row.t > parentTime)) newerThanParent++;
  }

  return {
    table,
    rowsInCopy,
    missingInParent,
    newerThanParent,
    newestInCopy: scalarToString(copyNewestRaw),
    newestInParent: scalarToString(parentNewestRaw),
  };
}

/**
 * Compare a stranded SQLite copy against the parent store, read-only.
 *
 * @param copyPath - Stranded copy.
 * @param parent - Read-only parent handle, or `null` when the parent is absent.
 * @returns Per-table diffs plus the aggregate verdict and an optional note.
 */
function compareCopy(
  copyPath: string,
  parent: DatabaseSync | null,
): Pick<WorktreeStoreFile, 'hasRowsNewerThanParent' | 'tables' | 'note'> {
  if (parent === null) {
    return { hasRowsNewerThanParent: null, tables: [], note: 'parent store not found' };
  }
  let copy: DatabaseSync | undefined;
  try {
    const handle = openForInspection(copyPath);
    copy = handle;
    const tables = COMPARED_TABLES.map((spec) => compareTable(handle, parent, spec)).filter(
      (d): d is WorktreeStoreTableDiff => d !== null,
    );
    if (tables.length === 0) {
      return { hasRowsNewerThanParent: null, tables, note: 'no comparable tables' };
    }
    return {
      hasRowsNewerThanParent: tables.some((t) => t.missingInParent > 0 || t.newerThanParent > 0),
      tables,
    };
  } catch (err) {
    return {
      hasRowsNewerThanParent: null,
      tables: [],
      note: `comparison failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    copy?.close();
  }
}

/**
 * Report whether a `.cleo/` entry name looks like a database or database backup.
 *
 * @param name - File name.
 * @returns `true` for `*.db`, `*.bak` and `*.db.*` files other than WAL/SHM sidecars.
 */
function isStoreLikeName(name: string): boolean {
  if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) return false;
  return name.endsWith('.db') || name.endsWith('.bak') || name.includes('.db.');
}

/**
 * Find project stores stranded inside the worktrees of `projectRoot`.
 *
 * Worktrees are discovered from both `git worktree list` and the canonical
 * worktree base, so a worktree git no longer tracks is still inspected. For
 * each, every database-like file directly under `<worktree>/.cleo/` is listed;
 * SQLite files are compared against the parent's `.cleo/cleo.db` table by table.
 *
 * @param projectRoot - Parent project root (the main checkout).
 * @param options - Optional worktree-base override and compare switch.
 * @returns The scan result. Never throws for a missing directory or unreadable file.
 * @remarks Strictly read-only: nothing is created, moved, or deleted.
 * @example
 * ```ts
 * const result = scanWorktreeStores('/home/u/project');
 * for (const path of result.filesWithNewerRows) console.log(path);
 * ```
 * @task T12460
 */
export function scanWorktreeStores(
  projectRoot: string,
  options: WorktreeStoreScanOptions = {},
): WorktreeStoreScanResult {
  const root = canonicalPath(projectRoot);
  const parentStorePath = join(root, '.cleo', PROJECT_STORE_FILENAME);
  const parentStoreExists = existsSync(parentStorePath);
  const worktreeBase = options.worktreeBase ?? resolveWorktreeRootForHash(computeProjectHash(root));

  const registered = new Set(listGitLinkedWorktrees(root));
  const candidates = new Set<string>([...registered, ...listCanonicalWorktreeDirs(worktreeBase)]);
  candidates.delete(root);

  let parent: DatabaseSync | null = null;
  if (parentStoreExists && options.skipCompare !== true) {
    try {
      parent = openForInspection(parentStorePath);
    } catch {
      parent = null;
    }
  }

  const entries: WorktreeStoreEntry[] = [];
  try {
    for (const worktreePath of [...candidates].sort()) {
      const cleoDir = join(worktreePath, '.cleo');
      if (!existsSync(cleoDir)) continue;
      let names: string[];
      try {
        names = readdirSync(cleoDir).filter(isStoreLikeName).sort();
      } catch {
        continue;
      }
      const files: WorktreeStoreFile[] = [];
      for (const name of names) {
        const path = join(cleoDir, name);
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const isSqlite = hasSqliteHeader(path);
        const comparison =
          options.skipCompare === true
            ? { hasRowsNewerThanParent: null, tables: [], note: 'comparison skipped' }
            : isSqlite
              ? compareCopy(path, parent)
              : { hasRowsNewerThanParent: null, tables: [], note: 'not a SQLite database' };
        files.push({
          path,
          name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isSqlite,
          ...comparison,
        });
      }
      if (files.length > 0) {
        entries.push({
          worktreePath,
          registeredWithGit: registered.has(worktreePath),
          files,
        });
      }
    }
  } finally {
    parent?.close();
  }

  const allFiles = entries.flatMap((e) => e.files);
  return {
    projectRoot: root,
    parentStorePath,
    parentStoreExists,
    worktreeBase,
    worktreesScanned: candidates.size,
    entries,
    strandedFileCount: allFiles.length,
    strandedBytes: allFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    filesWithNewerRows: allFiles
      .filter((f) => f.hasRowsNewerThanParent === true)
      .map((f) => f.path),
  };
}
