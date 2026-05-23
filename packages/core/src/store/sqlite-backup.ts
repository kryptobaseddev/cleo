/**
 * SQLite backup via VACUUM INTO with snapshot rotation.
 *
 * Produces self-contained, WAL-free copies of CLEO SQLite databases
 * (tasks.db, brain.db, conduit.db at project tier; nexus.db, signaldock.db at
 * global tier) into `.cleo/backups/sqlite/` (project) or
 * `$XDG_DATA_HOME/cleo/backups/sqlite/` (global) with a configurable rotation
 * limit. Also provides raw-file backup for the global-salt binary (not SQLite).
 * All errors are swallowed — backup failure must never interrupt normal operation.
 *
 * @task T4873
 * @task T5158 — extended to cover brain.db
 * @task T306  — extended to cover global-tier nexus.db (epic T299)
 * @task T369  — extended to cover conduit.db (project), signaldock.db (global),
 *               and global-salt raw-file backup (epic T310)
 * @epic T4867
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCleoDir, getCleoHome, resolveOrCwd } from '../paths.js';
import { ensureConduitDb, getConduitNativeDb } from './conduit-sqlite.js';
import { getGlobalSaltPath } from './global-salt.js';
import { getBrainDb, getBrainNativeDb } from './memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from './nexus-sqlite.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';
import { getDb, getNativeDb } from './sqlite.js';

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
 * Minimal shape of the handle used by the snapshot pipeline — only `exec()`
 * is required to issue `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO`.
 */
type SnapshotDbHandle = { exec: (sql: string) => void };

/**
 * Registered snapshot target — each one maps a logical key (prefix used in
 * snapshot filenames) to a function returning the live {@link DatabaseSync}
 * handle. `null` means the database has not been initialized in the current
 * process; in that case {@link SnapshotTarget.openDb} (T10316) eagerly opens
 * the canonical singleton through the per-DB chokepoint so the snapshot
 * pipeline never silently skips a target.
 *
 * @task T10316 — added `openDb` so `vacuumIntoBackupAll` snapshots EVERY
 *               registered DB even when no caller in this process has
 *               lazily opened it earlier (brain backup gap, Saga T10281 / E3).
 */
interface SnapshotTarget {
  /** Canonical name used in snapshot filenames, e.g. `"tasks"` or `"brain"`. */
  prefix: string;
  /** Resolves the live native handle, or `null` if not yet initialized. */
  getDb: () => SnapshotDbHandle | null;
  /**
   * Eagerly opens the canonical singleton when {@link getDb} returns `null`.
   * MUST flow through the per-DB chokepoint (ADR-068) — these openers all
   * live in `packages/core/src/store/**` (the allowlist root) so this is
   * pragma-consistent and singleton-managed. Returns `null` only when the
   * underlying opener legitimately has nothing to open (e.g. missing
   * project context); callers MUST treat `null` as "skip silently".
   */
  openDb: (cwd?: string) => Promise<SnapshotDbHandle | null>;
}

/**
 * Open the canonical brain.db singleton via {@link getBrainDb} and return its
 * native handle. Used as the eager-open fallback for the `brain` snapshot
 * target when no earlier code in this process lazily opened brain.db
 * (T10316 — fixes the brain backup gap).
 *
 * `getBrainDb` is the canonical chokepoint for brain.db opens
 * (`packages/core/src/store/memory-sqlite.ts`, allowlisted under
 * `packages/core/src/store/**`). We call it directly rather than via
 * `openCleoDb('brain', cwd)` because the latter is currently misrouted to
 * `getTasksDb` — a separate routing bug tracked outside T10316. Calling the
 * canonical opener guarantees brain.db is actually opened.
 */
async function openBrainDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  await getBrainDb(cwd);
  // After getBrainDb resolves, the native singleton MUST be populated.
  return getBrainNativeDb();
}

/**
 * Open the canonical tasks.db singleton via {@link getDb} and return its
 * native handle. Mirrors {@link openBrainDbForSnapshot}; same rationale.
 */
async function openTasksDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  await getDb(cwd);
  return getNativeDb();
}

/**
 * Open the canonical conduit.db singleton via {@link ensureConduitDb}
 * (sync) and return its native handle.
 */
async function openConduitDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  // ensureConduitDb requires an absolute project root.
  ensureConduitDb(resolveOrCwd(cwd));
  return getConduitNativeDb();
}

/**
 * Canonical list of snapshot targets. Ordering is insertion order — tasks.db
 * snapshots first (highest-value operational state), then brain.db, then
 * conduit.db (project messaging state).
 *
 * Every entry MUST provide both `getDb` (fast in-process lookup) and `openDb`
 * (eager open via chokepoint). The latter closes the T10316 gap where a
 * session-end snapshot found a `null` handle and silently skipped the DB.
 *
 * @task T369
 * @task T10316 — added eager-open openers for every project target
 * @epic T310
 */
const SNAPSHOT_TARGETS: SnapshotTarget[] = [
  { prefix: 'tasks', getDb: getNativeDb, openDb: openTasksDbForSnapshot },
  { prefix: 'brain', getDb: getBrainNativeDb, openDb: openBrainDbForSnapshot },
  // Added T369 — project messaging DB. openDb added T10316.
  { prefix: 'conduit', getDb: getConduitNativeDb, openDb: openConduitDbForSnapshot },
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
 * If `target.getDb()` returns `null` (the DB has not been lazily opened
 * earlier in this process), T10316 added an eager-open fallback via
 * `target.openDb(cwd)` — the canonical per-DB chokepoint. Only when BOTH
 * lookups return `null` does the snapshot step skip the target.
 *
 * Non-fatal: all errors are swallowed via the outer try in
 * {@link vacuumIntoBackupAll}; failures here must never block normal
 * operation.
 *
 * @param target — snapshot target descriptor (prefix + native DB getter)
 * @param backupDir — absolute path to `.cleo/backups/sqlite/`
 * @param now — reference timestamp for the filename
 * @param cwd — optional working directory propagated to `target.openDb`
 *
 * @task T10316 — eager-open via openCleoDb chokepoint (Saga T10281 / E3)
 */
async function snapshotOne(
  target: SnapshotTarget,
  backupDir: string,
  now: Date,
  cwd?: string,
): Promise<void> {
  let db = target.getDb();
  if (!db) {
    // T10316: eager-open via the canonical per-DB chokepoint so the
    // session-end backup never silently skips a registered target. This is
    // the brain backup gap captured live in Saga T10281 / E3 — every
    // session-end fired with brain.db handle = null in production despite
    // the mock-based TC-100 unit test passing.
    try {
      db = await target.openDb(cwd);
    } catch {
      // Non-fatal — opener failure (e.g. missing project context) must
      // not block snapshots of other registered targets.
      return;
    }
    if (!db) return;
  }

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

    await snapshotOne(target, backupDir, new Date(), opts.cwd);
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
      await snapshotOne(target, backupDir, now, opts.cwd);
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

// ============================================================================
// Global-tier backup (ADR-036 §Backup Mechanism)
// @task T306
// @epic T299
// ============================================================================

/**
 * Backup scope: project (per-project `.cleo/`) or global (`$XDG_DATA_HOME/cleo/`).
 *
 * @task T306
 * @epic T299
 */
export type BackupScope = 'project' | 'global';

/**
 * Open the canonical nexus.db singleton via {@link getNexusDb} and return
 * its native handle. Symmetric counterpart to {@link openBrainDbForSnapshot}
 * — eager-open via per-DB chokepoint so global-tier snapshots also work
 * when the in-process handle cache is empty.
 *
 * @task T10316
 */
async function openNexusDbForSnapshot(): Promise<SnapshotDbHandle | null> {
  await getNexusDb();
  return getNexusNativeDb();
}

/**
 * Open the canonical global signaldock.db singleton via
 * {@link ensureGlobalSignaldockDb} and return its native handle.
 *
 * @task T10316
 */
async function openSignaldockDbForSnapshot(): Promise<SnapshotDbHandle | null> {
  await ensureGlobalSignaldockDb();
  return getGlobalSignaldockNativeDb();
}

/**
 * Registered global-tier snapshot targets. Both `nexus` and `signaldock` are
 * active as of T369 (epic T310). T10316 added eager-open `openDb` functions
 * to mirror the project-tier behaviour and close the same handle-cache gap.
 *
 * @task T369
 * @task T10316 — eager-open via openCleoDb chokepoint
 * @epic T310
 */
const GLOBAL_SNAPSHOT_TARGETS: SnapshotTarget[] = [
  { prefix: 'nexus', getDb: getNexusNativeDb, openDb: openNexusDbForSnapshot },
  // Activated T369 — global agent registry. openDb added T10316.
  {
    prefix: 'signaldock',
    getDb: getGlobalSignaldockNativeDb,
    openDb: openSignaldockDbForSnapshot,
  },
];

/**
 * Resolve the global-tier backup directory, creating it on first use.
 *
 * Uses `cleoHomeOverride` when provided (test isolation) or falls back to
 * `getCleoHome()` (XDG-compliant; never hardcodes `~/.cleo`).
 */
function resolveGlobalBackupDir(cleoHomeOverride?: string): string {
  const base = cleoHomeOverride ?? getCleoHome();
  return join(base, 'backups', 'sqlite');
}

/**
 * Snapshot a global-tier SQLite database via VACUUM INTO.
 *
 * Writes to `$XDG_DATA_HOME/cleo/backups/sqlite/<dbName>-YYYYMMDD-HHmmss.db`
 * and enforces a per-prefix rotation window (default 10 snapshots).
 *
 * Non-fatal: errors from any individual step are surfaced via the return value
 * but never thrown — a failed snapshot MUST NOT interrupt normal operation.
 *
 * @param dbName         - Which global-tier DB to snapshot (`'nexus'` or `'signaldock'`)
 * @param opts.rotation  - Maximum retained snapshots per prefix (default 10)
 * @param opts.cleoHomeOverride - Override `getCleoHome()` path (use in tests to target a tmp dir)
 * @returns Object containing the new snapshot path and any rotated (deleted) file paths
 *
 * @task T306
 * @task T369 — activated signaldock target (epic T310)
 * @epic T299
 * @why ADR-036 §Backup Mechanism requires VACUUM INTO rotation at the global tier;
 *      nexus.db has zero backup coverage prior to v2026.4.11.
 */
export async function vacuumIntoGlobalBackup(
  dbName: 'nexus' | 'signaldock',
  opts?: { rotation?: number; cleoHomeOverride?: string },
): Promise<{ snapshotPath: string; rotated: string[] }> {
  const maxSnaps = opts?.rotation ?? MAX_SNAPSHOTS;
  const backupDir = resolveGlobalBackupDir(opts?.cleoHomeOverride);

  mkdirSync(backupDir, { recursive: true });

  const target = GLOBAL_SNAPSHOT_TARGETS.find((t) => t.prefix === dbName);
  if (!target) {
    return { snapshotPath: '', rotated: [] };
  }

  // T10316: eager-open via per-DB chokepoint when the in-process singleton
  // is empty. Mirrors the project-tier fix in `snapshotOne` (Saga T10281 /
  // E3 — brain backup gap).
  let db = target.getDb();
  if (!db) {
    try {
      db = await target.openDb();
    } catch {
      return { snapshotPath: '', rotated: [] };
    }
    if (!db) {
      return { snapshotPath: '', rotated: [] };
    }
  }

  const now = new Date();
  const snapshotName = `${dbName}-${formatTimestamp(now)}.db`;
  const snapshotPath = join(backupDir, snapshotName);

  // Collect files that will be rotated out before writing the new one.
  const rotated: string[] = [];
  try {
    const pattern = snapshotPattern(dbName);
    const existing = readdirSync(backupDir)
      .filter((f) => pattern.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    // Remove oldest until we have room for the new snapshot.
    while (existing.length >= maxSnaps) {
      const oldest = existing.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
        rotated.push(oldest.path);
      } catch {
        // non-fatal rotation failure
      }
    }
  } catch {
    // non-fatal — continue even if rotation enumeration fails
  }

  // Checkpoint then VACUUM INTO for a WAL-free, atomic snapshot.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const safeDest = snapshotPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safeDest}'`);

  return { snapshotPath, rotated };
}

/**
 * A single entry returned by {@link listGlobalSqliteBackups}.
 *
 * @task T306
 * @epic T299
 */
export interface GlobalBackupEntry {
  /** Snapshot filename, e.g. `nexus-20260408-143022.db`. */
  name: string;
  /** Absolute path to the snapshot file. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified timestamp. */
  mtime: Date;
}

/**
 * List global-tier SQLite backups from `$XDG_DATA_HOME/cleo/backups/sqlite/`,
 * optionally filtered by prefix (e.g. `'nexus'`). Sorted newest-first by mtime.
 *
 * Returns an empty array when the backup directory does not exist.
 *
 * @param prefix            - Optional prefix filter; when omitted all `.db` snapshot files are listed
 * @param cleoHomeOverride  - Override `getCleoHome()` path (use in tests to target a tmp dir)
 *
 * @task T306
 * @epic T299
 */
export function listGlobalSqliteBackups(
  prefix?: string,
  cleoHomeOverride?: string,
): GlobalBackupEntry[] {
  try {
    const backupDir = resolveGlobalBackupDir(cleoHomeOverride);
    if (!existsSync(backupDir)) return [];

    const pattern = prefix ? snapshotPattern(prefix) : /^[a-zA-Z0-9_-]+-\d{8}-\d{6}\.db$/;

    return readdirSync(backupDir)
      .filter((f) => pattern.test(f))
      .map((f) => {
        const filePath = join(backupDir, f);
        const s = statSync(filePath);
        return { name: f, path: filePath, size: s.size, mtime: new Date(s.mtimeMs) };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // newest first
  } catch {
    return [];
  }
}

// ============================================================================
// Global-salt raw-file backup (ADR-037 §5)
// @task T369
// @epic T310
// ============================================================================

/** Filename prefix for global-salt backup files. */
const GLOBAL_SALT_BACKUP_PREFIX = 'global-salt';

/** Regex matching global-salt backup filenames: `global-salt-YYYYMMDD-HHmmss`. */
const GLOBAL_SALT_BACKUP_PATTERN = /^global-salt-\d{8}-\d{6}$/;

/**
 * Resolve the backup directory for global-salt files: `{cleoHome}/backups/`.
 * Global-salt backups live directly under `backups/` (not `backups/sqlite/`)
 * to make clear they are binary files, not SQLite databases.
 */
function resolveGlobalSaltBackupDir(cleoHomeOverride?: string): string {
  const base = cleoHomeOverride ?? getCleoHome();
  return join(base, 'backups');
}

/**
 * Rotate global-salt backup files: delete the oldest until fewer than
 * {@link MAX_SNAPSHOTS} remain. Returns the paths of deleted files.
 * Non-fatal on any filesystem error.
 */
function rotateGlobalSaltBackups(backupDir: string): string[] {
  const rotated: string[] = [];
  try {
    const files = readdirSync(backupDir)
      .filter((f) => GLOBAL_SALT_BACKUP_PATTERN.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    while (files.length >= MAX_SNAPSHOTS) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
        rotated.push(oldest.path);
      } catch {
        // non-fatal rotation failure
      }
    }
  } catch {
    // non-fatal
  }
  return rotated;
}

/**
 * Creates a raw-file backup of the global-salt binary at
 * `${getCleoHome()}/backups/global-salt-YYYYMMDD-HHmmss` with `0o600`
 * permissions. Rotates to {@link MAX_SNAPSHOTS} (10) copies, deleting the
 * oldest when the limit is reached.
 *
 * Non-fatal: errors are swallowed — salt backup failure must never block cleo.
 * Returns empty strings and no rotated paths on failure.
 *
 * @param opts.cleoHomeOverride - Override `getCleoHome()` path (use in tests to target a tmp dir)
 * @returns Object with the new snapshot path and any rotated (deleted) file paths
 *
 * @task T369
 * @epic T310
 * @why ADR-037 §5 — global-salt is security-critical; losing it invalidates
 *      all API keys. Backup enables recovery from accidental deletion.
 */
export async function backupGlobalSalt(opts?: {
  cleoHomeOverride?: string;
}): Promise<{ snapshotPath: string; rotated: string[] }> {
  try {
    const cleoHome = opts?.cleoHomeOverride ?? getCleoHome();
    const saltSourcePath = opts?.cleoHomeOverride
      ? join(cleoHome, 'global-salt')
      : getGlobalSaltPath();

    if (!existsSync(saltSourcePath)) {
      return { snapshotPath: '', rotated: [] };
    }

    const backupDir = resolveGlobalSaltBackupDir(opts?.cleoHomeOverride);
    mkdirSync(backupDir, { recursive: true });

    const rotated = rotateGlobalSaltBackups(backupDir);

    const snapshotName = `${GLOBAL_SALT_BACKUP_PREFIX}-${formatTimestamp(new Date())}`;
    const snapshotPath = join(backupDir, snapshotName);

    copyFileSync(saltSourcePath, snapshotPath);
    chmodSync(snapshotPath, 0o600);

    return { snapshotPath, rotated };
  } catch {
    // non-fatal — backup failure must never interrupt normal operation
    return { snapshotPath: '', rotated: [] };
  }
}

/**
 * A single entry returned by {@link listGlobalSaltBackups}.
 *
 * @task T369
 * @epic T310
 */
export interface GlobalSaltBackupEntry {
  /** Backup filename, e.g. `global-salt-20260408-143022`. */
  name: string;
  /** Absolute path to the backup file. */
  path: string;
  /** File size in bytes (should be 32 for a valid global-salt). */
  size: number;
  /** Last-modified timestamp. */
  mtime: Date;
}

/**
 * List global-salt backup files from `$XDG_DATA_HOME/cleo/backups/`, sorted
 * newest-first by mtime.
 *
 * Returns an empty array when the backup directory does not exist.
 *
 * @param cleoHomeOverride - Override `getCleoHome()` path (use in tests to target a tmp dir)
 *
 * @task T369
 * @epic T310
 */
export function listGlobalSaltBackups(cleoHomeOverride?: string): GlobalSaltBackupEntry[] {
  try {
    const backupDir = resolveGlobalSaltBackupDir(cleoHomeOverride);
    if (!existsSync(backupDir)) return [];

    return readdirSync(backupDir)
      .filter((f) => GLOBAL_SALT_BACKUP_PATTERN.test(f))
      .map((f) => {
        const filePath = join(backupDir, f);
        const s = statSync(filePath);
        return { name: f, path: filePath, size: s.size, mtime: new Date(s.mtimeMs) };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // newest first
  } catch {
    return [];
  }
}
