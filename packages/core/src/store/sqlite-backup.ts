/**
 * SQLite backup via VACUUM INTO with snapshot rotation.
 *
 * Produces self-contained, WAL-free copies of CLEO SQLite databases
 * (tasks.db and brain.db) into `.cleo/backups/sqlite/` with a configurable
 * rotation limit. All errors are swallowed — backup failure must never
 * interrupt normal operation.
 *
 * @task T4873
 * @task T5158 — extended to cover brain.db
 * @epic T4867
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { getBrainNativeDb } from './brain-sqlite.js';
import { getNativeDb } from './sqlite.js';

/** Maximum number of snapshots retained per database (oldest rotated out). */
const MAX_SNAPSHOTS = 10;
/** Debounce window (ms) during which duplicate snapshot requests are suppressed. */
const DEBOUNCE_MS = 30_000; // 30 seconds

/**
 * Per-database snapshot book-keeping: last snapshot timestamp (epoch ms)
 * keyed by the canonical snapshot prefix (e.g. `"tasks"` / `"brain"`).
 */
const _lastBackupEpoch: Record<string, number> = {};

/**
 * Registered snapshot target — each one maps a logical key (prefix used in
 * snapshot filenames) to a function returning the live {@link DatabaseSync}
 * handle. `null` means the database has not been initialized in the current
 * process and its snapshot step should be skipped.
 */
interface SnapshotTarget {
  /** Canonical name used in snapshot filenames, e.g. `"tasks"` or `"brain"`. */
  prefix: string;
  /** Resolves the live native handle, or `null` if not yet initialized. */
  getDb: () => { exec: (sql: string) => void } | null;
}

/**
 * Canonical list of snapshot targets. Ordering is insertion order — tasks.db
 * snapshots first (highest-value operational state), then brain.db.
 */
const SNAPSHOT_TARGETS: SnapshotTarget[] = [
  { prefix: 'tasks', getDb: getNativeDb },
  { prefix: 'brain', getDb: getBrainNativeDb },
];

/**
 * Format a Date as `YYYYMMDD-HHmmss` (local time) for snapshot filenames.
 *
 * Matches the regex `/^(?:tasks|brain)-\d{8}-\d{6}\.db$/` used by the rotation
 * and listing logic below.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Build the regex that matches snapshot filenames for the given prefix.
 * Isolated so both {@link rotateSnapshots} and {@link listSqliteBackupsForPrefix}
 * share a single source of truth.
 */
function snapshotPattern(prefix: string): RegExp {
  // Escape the prefix in case it ever contains regex metacharacters.
  const safe = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${safe}-\\d{8}-\\d{6}\\.db$`);
}

/**
 * Rotate snapshots for a single prefix: delete the oldest files until fewer
 * than {@link MAX_SNAPSHOTS} remain. Non-fatal on any filesystem error.
 */
function rotateSnapshots(backupDir: string, prefix: string): void {
  try {
    const pattern = snapshotPattern(prefix);
    const files = readdirSync(backupDir)
      .filter((f) => pattern.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    while (files.length >= MAX_SNAPSHOTS) {
      const oldest = files.shift();
      if (!oldest) break;
      unlinkSync(oldest.path);
    }
  } catch {
    // non-fatal
  }
}

/** Options accepted by {@link vacuumIntoBackup} and {@link vacuumIntoBackupAll}. */
export interface VacuumOptions {
  /**
   * Working directory used to resolve the project-local `.cleo/backups/sqlite/`
   * directory. Defaults to `process.cwd()` (delegated to {@link getCleoDir}).
   */
  cwd?: string;
  /** When true, bypass the {@link DEBOUNCE_MS} debounce window. */
  force?: boolean;
}

/**
 * Create a VACUUM INTO snapshot of a single SQLite database.
 *
 * Runs `PRAGMA wal_checkpoint(TRUNCATE)` first to flush the WAL for a
 * consistent snapshot, then issues `VACUUM INTO '<dest>'` which SQLite
 * implements as an atomic, fully defragmented clone.
 *
 * Non-fatal: all errors are swallowed via the outer try in
 * {@link vacuumIntoBackupAll}; failures here must never block normal
 * operation.
 *
 * @param target — snapshot target descriptor (prefix + native DB getter)
 * @param backupDir — absolute path to `.cleo/backups/sqlite/`
 * @param now — reference timestamp for the filename
 */
function snapshotOne(target: SnapshotTarget, backupDir: string, now: Date): void {
  const db = target.getDb();
  if (!db) return; // DB not initialized in this process — skip silently

  const dest = join(backupDir, `${target.prefix}-${formatTimestamp(now)}.db`);

  // TRUNCATE checkpoint: flushes all WAL frames to the main DB and truncates
  // the WAL file to zero bytes, ensuring a consistent DB state before the
  // VACUUM INTO snapshot (ADR-013, section 3 point 7). This is safe because
  // the .db files are excluded from project git tracking (.gitignore + git
  // rm --cached), so git operations cannot restore a stale WAL. The root
  // cause of the 2026-02-25 data loss was that WAL files were still tracked
  // in the project git index; that has been resolved (T4894, T5158).
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  rotateSnapshots(backupDir, target.prefix);

  // Escape single quotes in path (path is programmatic, but be safe).
  const safeDest = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safeDest}'`);
}

/**
 * Create a VACUUM INTO snapshot of the primary SQLite database (tasks.db).
 *
 * Debounced by default (30s). Pass `force: true` to bypass debounce. This
 * function is retained for backward compatibility with existing call sites
 * in `data-safety.ts` / `data-safety-central.ts` that only snapshot tasks.db.
 *
 * Prefer {@link vacuumIntoBackupAll} for new code — it snapshots every
 * registered database (currently tasks.db + brain.db) and shares the same
 * debounce + rotation guarantees.
 *
 * Non-fatal: all errors are swallowed — backup failure must never
 * interrupt normal operation.
 */
export async function vacuumIntoBackup(opts: VacuumOptions = {}): Promise<void> {
  const now = Date.now();
  const prefix = 'tasks';
  const last = _lastBackupEpoch[prefix] ?? 0;
  if (!opts.force && now - last < DEBOUNCE_MS) {
    return; // debounced
  }

  try {
    const cleoDir = getCleoDir(opts.cwd);
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });

    const target = SNAPSHOT_TARGETS.find((t) => t.prefix === prefix);
    if (!target) return;

    snapshotOne(target, backupDir, new Date());
    _lastBackupEpoch[prefix] = Date.now();
  } catch {
    // non-fatal — backup failure must never interrupt normal operation
  }
}

/**
 * Create VACUUM INTO snapshots of all registered CLEO SQLite databases
 * (currently tasks.db + brain.db). Each database is debounced independently.
 *
 * This is the preferred entry point for session-lifecycle hooks and
 * pre-destructive-operation snapshots — it guarantees that BRAIN memory is
 * snapshotted alongside task state.
 *
 * Non-fatal: errors are swallowed per database so a brain.db failure cannot
 * block a tasks.db snapshot (and vice versa).
 */
export async function vacuumIntoBackupAll(opts: VacuumOptions = {}): Promise<void> {
  const nowMs = Date.now();
  const now = new Date();

  let backupDir: string;
  try {
    const cleoDir = getCleoDir(opts.cwd);
    backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
  } catch {
    return; // cannot resolve backup dir — abort silently
  }

  for (const target of SNAPSHOT_TARGETS) {
    const last = _lastBackupEpoch[target.prefix] ?? 0;
    if (!opts.force && nowMs - last < DEBOUNCE_MS) {
      continue; // debounced — skip this target only
    }
    try {
      snapshotOne(target, backupDir, now);
      _lastBackupEpoch[target.prefix] = Date.now();
    } catch {
      // non-fatal — continue with remaining targets
    }
  }
}

/**
 * List existing snapshots for a given prefix (`"tasks"` or `"brain"`),
 * newest first. Returns an empty array if the backup directory does not
 * exist.
 */
function listSqliteBackupsForPrefix(
  prefix: string,
  cwd?: string,
): Array<{ name: string; path: string; mtimeMs: number }> {
  try {
    const cleoDir = getCleoDir(cwd);
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    if (!existsSync(backupDir)) return [];

    const pattern = snapshotPattern(prefix);
    return readdirSync(backupDir)
      .filter((f) => pattern.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  } catch {
    return [];
  }
}

/**
 * List existing tasks.db snapshots (newest first).
 *
 * Retained for backward compatibility. For new code prefer
 * {@link listSqliteBackupsAll}.
 */
export function listSqliteBackups(
  cwd?: string,
): Array<{ name: string; path: string; mtimeMs: number }> {
  return listSqliteBackupsForPrefix('tasks', cwd);
}

/**
 * List existing brain.db snapshots (newest first).
 */
export function listBrainBackups(
  cwd?: string,
): Array<{ name: string; path: string; mtimeMs: number }> {
  return listSqliteBackupsForPrefix('brain', cwd);
}

/**
 * Aggregated listing of all registered SQLite snapshots.
 *
 * Returns an object keyed by snapshot prefix (`tasks`, `brain`) where each
 * value is the per-prefix list sorted newest-first. Missing prefixes are
 * represented as empty arrays.
 */
export function listSqliteBackupsAll(
  cwd?: string,
): Record<string, Array<{ name: string; path: string; mtimeMs: number }>> {
  const out: Record<string, Array<{ name: string; path: string; mtimeMs: number }>> = {};
  for (const target of SNAPSHOT_TARGETS) {
    out[target.prefix] = listSqliteBackupsForPrefix(target.prefix, cwd);
  }
  return out;
}
