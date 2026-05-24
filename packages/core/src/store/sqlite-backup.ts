/**
 * SQLite backup via VACUUM INTO with snapshot rotation.
 *
 * Produces self-contained, WAL-free copies of every CLEO SQLite database
 * (`DB_INVENTORY` from `@cleocode/contracts`) into:
 *
 *   - `.cleo/backups/sqlite/`                  — project-tier (and `derived` rows
 *                                                that opt into snapshotting)
 *   - `$XDG_DATA_HOME/cleo/backups/sqlite/`    — global-tier
 *
 * with a configurable rotation limit. Also provides raw-file backup for the
 * global-salt binary (not SQLite). All errors are swallowed — backup failure
 * must never interrupt normal operation.
 *
 * Snapshot targets are derived from the canonical inventory in
 * `db-inventory.json` so the snapshot pipeline cannot drift from the charter
 * (Saga T10281 / Epic T10284 / E3-BACKUP-RECOVERY). Every inventory entry is
 * classified into one of two strategies:
 *
 *   - **chokepoint-opener**     — role has a registered canonical opener
 *                                 (tasks, brain, conduit, nexus,
 *                                 signaldock-global, telemetry, skills).
 *                                 Snapshot via the opener's native handle.
 *   - **raw-file-vacuum-readonly** — role has NO live opener (llmtxt reserved,
 *                                 signaldock-project historical, global-brain
 *                                 / global-tasks orphans, manifest derived
 *                                 when opted in). Snapshot by opening the
 *                                 file read-only and issuing `VACUUM INTO`.
 *
 * Both strategies live under `packages/core/src/store/**` — the canonical
 * allowlist root for direct `DatabaseSync` construction (ADR-068).
 *
 * @task T4873
 * @task T5158 — extended to cover brain.db
 * @task T306  — extended to cover global-tier nexus.db (epic T299)
 * @task T369  — extended to cover conduit.db (project), signaldock.db (global),
 *               and global-salt raw-file backup (epic T310)
 * @task T10316 — eager-open via per-DB chokepoint (brain backup gap)
 * @task T10317 — every `DB_INVENTORY` row now produces a snapshot
 *                (Saga T10281 / Epic T10284 / E3)
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
import type { DatabaseSync } from 'node:sqlite';
import { DB_INVENTORY, type DbInventoryEntry, type DbRole } from '@cleocode/contracts';
import { getCleoDir, getCleoHome, resolveOrCwd } from '../paths.js';
import { getTelemetryDb, getTelemetryNativeDb } from '../telemetry/sqlite.js';
import { ensureConduitDb, getConduitNativeDb } from './conduit-sqlite.js';
import { getGlobalSaltPath } from './global-salt.js';
import { getBrainDb, getBrainNativeDb } from './memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from './nexus-sqlite.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';
import { getSkillsNativeDb, openSkillsDb } from './skills-db.js';
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
 * Snapshot strategy classification.
 *
 *   - `chokepoint-opener`        — role has a canonical opener (`getDb`,
 *                                  `getBrainDb`, `ensureConduitDb`,
 *                                  `getNexusDb`, `ensureGlobalSignaldockDb`,
 *                                  `getTelemetryDb`, `openSkillsDb`).
 *   - `raw-file-vacuum-readonly` — role has NO live opener; the file is
 *                                  opened read-only via a one-shot
 *                                  `DatabaseSync` (allowlisted under
 *                                  `packages/core/src/store/**`) just to
 *                                  emit `VACUUM INTO`, then closed.
 *   - `skip-derived`             — `tier === 'derived'`; the canonical
 *                                  charter row marks the file as rebuildable
 *                                  (`backupPath === 'rebuildable-from-blob-store'`).
 *                                  Excluded from the snapshot pipeline. The
 *                                  row IS surfaced in `listSqliteBackupsAll`
 *                                  for completeness but its bucket stays empty.
 *
 * @task T10317
 */
type SnapshotStrategy = 'chokepoint-opener' | 'raw-file-vacuum-readonly' | 'skip-derived';

/**
 * Resolve the path on disk for a given `DB_INVENTORY` row.
 *
 * Substitutes the documented path tokens:
 *
 *   - `<projectRoot>`  → resolved via {@link resolveOrCwd}
 *   - `$XDG_DATA_HOME` → resolved via {@link getCleoHome} (env-paths SSoT)
 *
 * Returns `null` when the project tier is requested without a resolvable
 * project root (e.g. `getCleoDir()` throws because no project context).
 *
 * @task T10317
 */
function resolveInventoryPath(entry: DbInventoryEntry, cwd?: string): string | null {
  try {
    if (entry.tier === 'global') {
      // Replace the leading `$XDG_DATA_HOME/cleo/` token with `getCleoHome()`.
      const cleoHome = getCleoHome();
      return entry.filePathTemplate.replace(/^\$XDG_DATA_HOME\/cleo/, cleoHome);
    }
    // Project + derived (derived is project-rooted in the inventory).
    const projectRoot = resolveOrCwd(cwd);
    return entry.filePathTemplate.replace(/^<projectRoot>/, projectRoot);
  } catch {
    return null;
  }
}

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
 * @task T10317 — added `role`, `tier`, `strategy`, and `resolveFile` to
 *               cover every `DB_INVENTORY` entry uniformly.
 */
interface SnapshotTarget {
  /** Canonical role from `DB_INVENTORY`. */
  readonly role: DbRole;
  /** Canonical name used in snapshot filenames, e.g. `"tasks"` or `"global-brain"`. */
  readonly prefix: string;
  /** Inventory tier — determines which backup directory the snapshot lands in. */
  readonly tier: DbInventoryEntry['tier'];
  /** How this target obtains a live handle. See {@link SnapshotStrategy}. */
  readonly strategy: SnapshotStrategy;
  /** Resolves the live native handle, or `null` if not yet initialized. */
  readonly getDb: () => SnapshotDbHandle | null;
  /**
   * Eagerly opens the canonical singleton when {@link getDb} returns `null`.
   * MUST flow through the per-DB chokepoint (ADR-068) — these openers all
   * live in `packages/core/src/store/**` (the allowlist root) so this is
   * pragma-consistent and singleton-managed. Returns `null` only when the
   * underlying opener legitimately has nothing to open (e.g. missing
   * project context); callers MUST treat `null` as "skip silently".
   *
   * For `raw-file-vacuum-readonly` targets, this resolves the on-disk path
   * and opens a one-shot read-only `DatabaseSync`. The returned handle is
   * ephemeral — `snapshotOne` closes it after `VACUUM INTO`.
   */
  readonly openDb: (cwd?: string) => Promise<SnapshotDbHandle | null>;
  /**
   * When non-null, `snapshotOne` calls this AFTER `VACUUM INTO` to release
   * the ephemeral handle opened by {@link openDb}. Used by
   * `raw-file-vacuum-readonly` targets (which open a one-shot
   * `DatabaseSync`). Chokepoint-opener targets manage their own singletons
   * and MUST NOT close them — leave this `null`.
   */
  readonly closeDb: ((db: SnapshotDbHandle) => void) | null;
}

// ---------------------------------------------------------------------------
// Project-tier openers (chokepoint-opener strategy)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Global-tier openers (chokepoint-opener strategy)
// ---------------------------------------------------------------------------

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
 * Open the canonical telemetry.db singleton via {@link getTelemetryDb} and
 * return its native handle. Telemetry is opt-in but the singleton is
 * resolved lazily on first event — when no event has fired, the on-disk
 * file simply doesn't exist and {@link snapshotOne} skips after a clean
 * `null` from {@link openDb}.
 *
 * @task T10317 — fleet snapshot coverage for `telemetry` role
 *                (Saga T10281 / E3)
 */
async function openTelemetryDbForSnapshot(): Promise<SnapshotDbHandle | null> {
  // If the underlying file does not exist, skip without provoking creation
  // — telemetry is opt-in; we MUST NOT materialise a fresh DB on the disk
  // just to snapshot an empty one.
  // The path resolver uses `getCleoHome()` from the same module, so the
  // SSoT path remains consistent with the live opener.
  try {
    // Lazily resolve the live path; mirrors `getTelemetryDbPath()` without
    // pulling in the dedicated import (one less stub for test mocks).
    const path = join(getCleoHome(), 'telemetry.db');
    if (!existsSync(path)) return null;
  } catch {
    return null;
  }
  await getTelemetryDb();
  return getTelemetryNativeDb();
}

/**
 * Open the canonical skills.db singleton via {@link openSkillsDb} and
 * return its native handle.
 *
 * @task T10317
 */
async function openSkillsDbForSnapshot(): Promise<SnapshotDbHandle | null> {
  await openSkillsDb();
  return getSkillsNativeDb();
}

// ---------------------------------------------------------------------------
// Raw-file-VACUUM strategy (no canonical opener)
// ---------------------------------------------------------------------------

/**
 * Build a `raw-file-vacuum-readonly` opener for an inventory row whose role
 * has NO live chokepoint opener (llmtxt RESERVED, signaldock-project
 * HISTORICAL, global-brain / global-tasks UNREGISTERED ORPHANS).
 *
 * The returned function:
 *
 *   1. Resolves the inventory file path with {@link resolveInventoryPath}.
 *   2. Returns `null` immediately if the file does not exist (clean skip —
 *      not every project / global home has every orphan).
 *   3. Otherwise opens a one-shot `DatabaseSync` in **read-only** mode and
 *      returns the handle. The caller (`snapshotOne`) issues `VACUUM INTO`
 *      then calls {@link SnapshotTarget.closeDb} to release the handle.
 *
 * Read-only is the right mode because (a) the file may belong to a different
 * process with an open writer (rare for these orphans, but possible), and
 * (b) VACUUM INTO is an explicit out-of-place operation that does not write
 * to the source DB.
 *
 * The `new DatabaseSync(...)` call is allowed here because this file is
 * under the canonical chokepoint allowlist `packages/core/src/store/**`
 * — the db-open-guard lint baseline already covers it. No per-line
 * `db-open-allowed` annotation is needed.
 *
 * @task T10317
 */
function buildRawFileVacuumOpener(
  entry: DbInventoryEntry,
): (cwd?: string) => Promise<SnapshotDbHandle | null> {
  return async (cwd?: string): Promise<SnapshotDbHandle | null> => {
    const path = resolveInventoryPath(entry, cwd);
    if (!path) return null;
    if (!existsSync(path)) return null;
    try {
      // Dynamic import preserves the T1331 lazy-init contract: importing
      // sqlite.ts (which statically imports sqlite-backup.ts for
      // `listSqliteBackups`) MUST NOT pull node:sqlite into module-load
      // time. Only the raw-file-vacuum-readonly path needs the
      // constructor, and it is exercised at snapshot-time, not load-time.
      const { DatabaseSync } = await import('node:sqlite');
      return new DatabaseSync(path, { readOnly: true });
    } catch {
      // The file might be locked by another writer, corrupt, or otherwise
      // unopenable. Skip silently — snapshot failure must never block
      // normal operation (and the malformed-DB case is exactly why the
      // saga exists).
      return null;
    }
  };
}

/**
 * Close an ephemeral `DatabaseSync` handle opened by a
 * `raw-file-vacuum-readonly` strategy. Idempotent and silent on error —
 * the backup pipeline MUST NOT propagate close failures.
 *
 * @task T10317
 */
function closeEphemeralHandle(db: SnapshotDbHandle): void {
  try {
    const handle = db as DatabaseSync;
    if (typeof handle.close === 'function' && handle.isOpen) {
      handle.close();
    }
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Inventory-driven snapshot target registry
// ---------------------------------------------------------------------------

/**
 * Maps `DB_INVENTORY` rows that use the chokepoint-opener strategy to their
 * concrete openers. Roles absent from this map fall back to either:
 *
 *   - `raw-file-vacuum-readonly` (when the on-disk file exists), or
 *   - `skip-derived` (when `tier === 'derived'` AND `backupPath` is the
 *     `rebuildable-from-blob-store` sentinel).
 *
 * @task T10317
 */
const CHOKEPOINT_OPENERS: Partial<
  Record<
    DbRole,
    {
      readonly getDb: () => SnapshotDbHandle | null;
      readonly openDb: (cwd?: string) => Promise<SnapshotDbHandle | null>;
    }
  >
> = {
  tasks: { getDb: getNativeDb, openDb: openTasksDbForSnapshot },
  brain: { getDb: getBrainNativeDb, openDb: openBrainDbForSnapshot },
  conduit: { getDb: getConduitNativeDb, openDb: openConduitDbForSnapshot },
  nexus: { getDb: getNexusNativeDb, openDb: openNexusDbForSnapshot },
  'signaldock-global': {
    getDb: getGlobalSignaldockNativeDb,
    openDb: openSignaldockDbForSnapshot,
  },
  telemetry: { getDb: getTelemetryNativeDb, openDb: openTelemetryDbForSnapshot },
  skills: { getDb: getSkillsNativeDb, openDb: openSkillsDbForSnapshot },
};

/**
 * Snapshot filename prefix for each role.
 *
 * For most roles the prefix is the role itself. The two project/global
 * variants that share a base name disambiguate via the role string itself
 * (`signaldock-project` ≠ `signaldock-global`; `global-brain` ≠ `brain`).
 *
 * `'signaldock-global'` is the SOLE exception: it keeps the historical
 * `signaldock` prefix so existing `.cleo/backups/sqlite/signaldock-*.db`
 * filenames continue to match `listGlobalSqliteBackups('signaldock', ...)`.
 *
 * @task T10317
 */
function prefixForRole(role: DbRole): string {
  if (role === 'signaldock-global') return 'signaldock';
  return role;
}

/**
 * Whether an inventory row should be SKIPPED from the snapshot pipeline
 * entirely. Today this is just `manifest` — the canonical charter row
 * marks it as rebuildable from the blob store (`backupPath ===
 * 'rebuildable-from-blob-store'`), so re-snapshotting would duplicate the
 * exact same content that the blob CAS already stores.
 *
 * Future opt-in (`cleo backup add --include-derived`) is tracked under
 * Saga T10281 / E3 follow-ups — when implemented, the flag would flip
 * derived rows from `skip-derived` to `raw-file-vacuum-readonly`.
 *
 * @task T10317
 */
function isSkipDerived(entry: DbInventoryEntry): boolean {
  return entry.tier === 'derived' && entry.backupPath === 'rebuildable-from-blob-store';
}

/**
 * Classify an inventory row into a snapshot strategy.
 *
 * @task T10317
 */
function strategyFor(entry: DbInventoryEntry): SnapshotStrategy {
  if (isSkipDerived(entry)) return 'skip-derived';
  if (CHOKEPOINT_OPENERS[entry.role]) return 'chokepoint-opener';
  return 'raw-file-vacuum-readonly';
}

/**
 * Build a {@link SnapshotTarget} for the given inventory row.
 *
 * @task T10317
 */
function buildTarget(entry: DbInventoryEntry): SnapshotTarget {
  const strategy = strategyFor(entry);
  const prefix = prefixForRole(entry.role);

  if (strategy === 'skip-derived') {
    // Build a no-op target so `listSqliteBackupsAll` still surfaces the
    // row's bucket (always empty). Snapshot iteration skips it.
    return {
      role: entry.role,
      prefix,
      tier: entry.tier,
      strategy,
      getDb: () => null,
      openDb: async () => null,
      closeDb: null,
    };
  }

  if (strategy === 'chokepoint-opener') {
    const opener = CHOKEPOINT_OPENERS[entry.role];
    if (!opener) {
      // Defensive — strategyFor() guarantees this branch unreachable. Fall
      // through to the raw-file strategy so we never crash the snapshot
      // pipeline.
      return {
        role: entry.role,
        prefix,
        tier: entry.tier,
        strategy: 'raw-file-vacuum-readonly',
        getDb: () => null,
        openDb: buildRawFileVacuumOpener(entry),
        closeDb: closeEphemeralHandle,
      };
    }
    return {
      role: entry.role,
      prefix,
      tier: entry.tier,
      strategy,
      getDb: opener.getDb,
      openDb: opener.openDb,
      closeDb: null,
    };
  }

  // raw-file-vacuum-readonly
  return {
    role: entry.role,
    prefix,
    tier: entry.tier,
    strategy,
    getDb: () => null,
    openDb: buildRawFileVacuumOpener(entry),
    closeDb: closeEphemeralHandle,
  };
}

/**
 * Snapshot targets for every project + derived inventory row. Derived rows
 * with `skip-derived` strategy retain a present-but-empty bucket in
 * `listSqliteBackupsAll`.
 *
 * @task T10317
 */
const SNAPSHOT_TARGETS: readonly SnapshotTarget[] = DB_INVENTORY.filter(
  (entry) => entry.tier === 'project' || entry.tier === 'derived',
).map(buildTarget);

/**
 * Snapshot targets for every global-tier inventory row.
 *
 * @task T10317
 */
const GLOBAL_SNAPSHOT_TARGETS: readonly SnapshotTarget[] = DB_INVENTORY.filter(
  (entry) => entry.tier === 'global',
).map(buildTarget);

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
 * Targets with `strategy === 'skip-derived'` are bypassed entirely — their
 * inventory row documents `backupPath === 'rebuildable-from-blob-store'`.
 *
 * For `raw-file-vacuum-readonly` targets, the eager-open returns a one-shot
 * `DatabaseSync` that this function closes via {@link SnapshotTarget.closeDb}
 * after `VACUUM INTO` completes.
 *
 * Non-fatal: all errors are swallowed via the outer try in
 * {@link vacuumIntoBackupAll}; failures here must never block normal
 * operation.
 *
 * @param target — snapshot target descriptor (role + prefix + native DB getter)
 * @param backupDir — absolute path to the snapshot directory
 * @param now — reference timestamp for the filename
 * @param cwd — optional working directory propagated to `target.openDb`
 *
 * @task T10316 — eager-open via openCleoDb chokepoint (Saga T10281 / E3)
 * @task T10317 — raw-file-vacuum-readonly strategy for opener-less roles
 */
async function snapshotOne(
  target: SnapshotTarget,
  backupDir: string,
  now: Date,
  cwd?: string,
): Promise<void> {
  if (target.strategy === 'skip-derived') {
    // Derived row — file is rebuildable from the blob CAS. Inventory row
    // documents `backupPath === 'rebuildable-from-blob-store'`. Nothing to do.
    return;
  }

  let db = target.getDb();
  let opened: SnapshotDbHandle | null = null;
  if (!db) {
    // T10316 / T10317: eager-open via the canonical per-DB chokepoint (for
    // chokepoint-opener roles) or a one-shot read-only `DatabaseSync` (for
    // raw-file-vacuum-readonly roles). Either way, the snapshot pipeline
    // never silently skips a registered target just because the in-process
    // handle cache is empty.
    try {
      db = await target.openDb(cwd);
    } catch {
      // Non-fatal — opener failure (e.g. missing project context, locked
      // file, malformed orphan) must not block snapshots of other targets.
      return;
    }
    if (!db) return;
    opened = db;
  }

  const dest = join(backupDir, `${target.prefix}-${formatTimestamp(now)}.db`);

  try {
    // TRUNCATE checkpoint: flushes all WAL frames to the main DB and truncates
    // the WAL file to zero bytes, ensuring a consistent DB state before the
    // VACUUM INTO snapshot (ADR-013, section 3 point 7). For read-only opens
    // of orphan files there is no WAL to truncate, but the pragma is a no-op
    // in that case so we keep the call uniform.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    rotateSnapshots(backupDir, target.prefix);

    // Escape single quotes in path (path is programmatic, but be safe).
    const safeDest = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safeDest}'`);
  } finally {
    // Release the ephemeral handle for raw-file-vacuum-readonly targets.
    // Chokepoint-opener handles (`closeDb === null`) remain owned by their
    // module singleton and MUST NOT be closed here.
    if (opened && target.closeDb) {
      target.closeDb(opened);
    }
  }
}

/**
 * Create a VACUUM INTO snapshot of the primary SQLite database (tasks.db).
 *
 * Debounced by default (30s). Pass `force: true` to bypass debounce. This
 * function is retained for backward compatibility with existing call sites
 * in `data-safety.ts` / `data-safety-central.ts` that only snapshot tasks.db.
 *
 * Prefer {@link vacuumIntoBackupAll} for new code — it snapshots every
 * inventory-registered database and shares the same debounce + rotation
 * guarantees.
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
 * Create VACUUM INTO snapshots of every project-tier (and opt-in `derived`)
 * SQLite database registered in `DB_INVENTORY`. Each database is debounced
 * independently.
 *
 * This is the preferred entry point for session-lifecycle hooks and
 * pre-destructive-operation snapshots — it guarantees that BRAIN memory is
 * snapshotted alongside task state, plus every other inventory-registered
 * project-tier DB.
 *
 * Non-fatal: errors are swallowed per database so any single failure cannot
 * block snapshots of the rest.
 *
 * Global-tier rotation is the responsibility of
 * {@link vacuumIntoGlobalBackupAll}.
 *
 * @task T5158
 * @task T10317 — extended to every `DB_INVENTORY` project + derived row
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
    if (target.strategy === 'skip-derived') continue;
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
 * Returns an object keyed by snapshot prefix (`tasks`, `brain`, `conduit`,
 * `llmtxt`, `signaldock-project`, `manifest`) where each value is the
 * per-prefix list sorted newest-first. Missing prefixes are represented as
 * empty arrays. Derived rows (`manifest`) keep an always-empty bucket so
 * downstream code can detect "covered by inventory, not snapshotted by
 * design" vs "unknown prefix".
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
 * Names accepted by {@link vacuumIntoGlobalBackup}. Mirrors
 * {@link DbRole} for the global-tier subset PLUS the historical
 * `'signaldock'` alias kept for backward compatibility with callers that
 * pre-date the inventory split.
 *
 * @task T10317 — extended to cover every global-tier inventory entry
 */
export type GlobalBackupName =
  | 'nexus'
  | 'signaldock'
  | 'signaldock-global'
  | 'telemetry'
  | 'skills'
  | 'global-brain'
  | 'global-tasks';

/**
 * Resolve a {@link GlobalBackupName} to the matching global snapshot
 * target. Accepts the historical `'signaldock'` alias as a synonym for
 * `'signaldock-global'`.
 */
function findGlobalTarget(name: GlobalBackupName): SnapshotTarget | undefined {
  if (name === 'signaldock') {
    return GLOBAL_SNAPSHOT_TARGETS.find((t) => t.role === 'signaldock-global');
  }
  return GLOBAL_SNAPSHOT_TARGETS.find((t) => t.role === name);
}

/**
 * Snapshot a global-tier SQLite database via VACUUM INTO.
 *
 * Writes to `$XDG_DATA_HOME/cleo/backups/sqlite/<prefix>-YYYYMMDD-HHmmss.db`
 * and enforces a per-prefix rotation window (default 10 snapshots).
 *
 * Non-fatal: errors from any individual step are surfaced via the return value
 * but never thrown — a failed snapshot MUST NOT interrupt normal operation.
 *
 * @param dbName         - Which global-tier DB to snapshot
 *                         (see {@link GlobalBackupName})
 * @param opts.rotation  - Maximum retained snapshots per prefix (default 10)
 * @param opts.cleoHomeOverride - Override `getCleoHome()` path (use in tests to target a tmp dir)
 * @returns Object containing the new snapshot path and any rotated (deleted) file paths
 *
 * @task T306
 * @task T369 — activated signaldock target (epic T310)
 * @task T10317 — every `DB_INVENTORY` global-tier row covered
 * @epic T299
 * @why ADR-036 §Backup Mechanism requires VACUUM INTO rotation at the global tier;
 *      nexus.db has zero backup coverage prior to v2026.4.11.
 */
export async function vacuumIntoGlobalBackup(
  dbName: GlobalBackupName,
  opts?: { rotation?: number; cleoHomeOverride?: string },
): Promise<{ snapshotPath: string; rotated: string[] }> {
  const maxSnaps = opts?.rotation ?? MAX_SNAPSHOTS;
  const backupDir = resolveGlobalBackupDir(opts?.cleoHomeOverride);

  mkdirSync(backupDir, { recursive: true });

  const target = findGlobalTarget(dbName);
  if (!target || target.strategy === 'skip-derived') {
    return { snapshotPath: '', rotated: [] };
  }

  // T10316: eager-open via per-DB chokepoint when the in-process singleton
  // is empty. T10317: also covers raw-file-vacuum-readonly targets (orphan
  // global-brain / global-tasks). Mirrors the project-tier fix in
  // `snapshotOne` (Saga T10281 / E3).
  let db = target.getDb();
  let opened: SnapshotDbHandle | null = null;
  if (!db) {
    try {
      db = await target.openDb();
    } catch {
      return { snapshotPath: '', rotated: [] };
    }
    if (!db) {
      return { snapshotPath: '', rotated: [] };
    }
    opened = db;
  }

  const now = new Date();
  const snapshotName = `${target.prefix}-${formatTimestamp(now)}.db`;
  const snapshotPath = join(backupDir, snapshotName);

  // Collect files that will be rotated out before writing the new one.
  const rotated: string[] = [];
  try {
    const pattern = snapshotPattern(target.prefix);
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

  try {
    // Checkpoint then VACUUM INTO for a WAL-free, atomic snapshot.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const safeDest = snapshotPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safeDest}'`);
  } finally {
    // Release ephemeral handle for raw-file-vacuum-readonly targets.
    if (opened && target.closeDb) {
      target.closeDb(opened);
    }
  }

  return { snapshotPath, rotated };
}

/**
 * Snapshot every global-tier database registered in `DB_INVENTORY`.
 *
 * Iterates {@link GLOBAL_SNAPSHOT_TARGETS} and invokes
 * {@link vacuumIntoGlobalBackup} for each entry that resolves to a present
 * on-disk file. Non-fatal per target — one failure does not block the rest.
 *
 * Useful for session-end + `cleo backup add` flows so the global tier
 * (nexus, signaldock, telemetry, skills, plus any orphan files) gets the
 * same per-session rotation treatment as the project tier.
 *
 * @param opts.cleoHomeOverride - Override `getCleoHome()` path (test isolation)
 * @param opts.rotation         - Maximum retained snapshots per prefix (default 10)
 * @returns Array of per-target results (matches insertion order of inventory).
 *          Skipped or failed targets surface as `{ snapshotPath: '', rotated: [] }`
 *          so callers can audit coverage without consulting the inventory.
 *
 * @task T10317 — fleet snapshot at session-end (Saga T10281 / E3)
 */
export async function vacuumIntoGlobalBackupAll(opts?: {
  cleoHomeOverride?: string;
  rotation?: number;
}): Promise<Array<{ role: DbRole; snapshotPath: string; rotated: string[] }>> {
  const out: Array<{ role: DbRole; snapshotPath: string; rotated: string[] }> = [];
  for (const target of GLOBAL_SNAPSHOT_TARGETS) {
    if (target.strategy === 'skip-derived') {
      out.push({ role: target.role, snapshotPath: '', rotated: [] });
      continue;
    }
    try {
      // Map role → the global-backup name; `signaldock-global` keeps its
      // canonical role here (the historical alias is only honoured at the
      // public API boundary in `vacuumIntoGlobalBackup`).
      const name: GlobalBackupName = target.role as GlobalBackupName;
      const r = await vacuumIntoGlobalBackup(name, opts);
      out.push({ role: target.role, ...r });
    } catch {
      out.push({ role: target.role, snapshotPath: '', rotated: [] });
    }
  }
  return out;
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

/**
 * Aggregated listing of every global-tier snapshot bucket. Returns a map
 * keyed by canonical snapshot prefix (`nexus`, `signaldock`, `telemetry`,
 * `skills`, `global-brain`, `global-tasks`) with each value sorted
 * newest-first by mtime. Empty arrays surface for buckets with no snapshots
 * yet — callers can distinguish "covered by inventory, nothing on disk" vs
 * "unknown prefix".
 *
 * @task T10317
 */
export function listGlobalSqliteBackupsAll(
  cleoHomeOverride?: string,
): Record<string, GlobalBackupEntry[]> {
  const out: Record<string, GlobalBackupEntry[]> = {};
  for (const target of GLOBAL_SNAPSHOT_TARGETS) {
    out[target.prefix] = listGlobalSqliteBackups(target.prefix, cleoHomeOverride);
  }
  return out;
}

// ============================================================================
// Inventory coverage introspection
// ============================================================================

/**
 * Inventory coverage report. Lists every {@link DbRole} and the snapshot
 * strategy that covers it. Used by test suites and `cleo doctor` follow-ups
 * to assert no inventory entry is silently uncovered.
 *
 * @task T10317
 */
export interface InventoryCoverageRow {
  readonly role: DbRole;
  readonly tier: DbInventoryEntry['tier'];
  readonly prefix: string;
  readonly strategy: SnapshotStrategy;
}

/**
 * Return the strategy + filename prefix that the snapshot pipeline applies
 * to each `DB_INVENTORY` row.
 *
 * @task T10317
 */
export function describeSnapshotCoverage(): readonly InventoryCoverageRow[] {
  return [...SNAPSHOT_TARGETS, ...GLOBAL_SNAPSHOT_TARGETS].map((t) => ({
    role: t.role,
    tier: t.tier,
    prefix: t.prefix,
    strategy: t.strategy,
  }));
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
