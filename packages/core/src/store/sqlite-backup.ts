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
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DbInventoryEntry, DbRole } from '@cleocode/contracts';
import { DB_INVENTORY } from '@cleocode/contracts/db-inventory.js';
import { getCleoDir, getCleoHome, resolveOrCwd } from '../paths.js';
import { getTelemetryDb, getTelemetryNativeDb } from '../telemetry/sqlite.js';
import {
  ensureGlobalAgentRegistryDb,
  getGlobalAgentRegistryNativeDb,
} from './agent-registry-store.js';
import { ensureConduitDb, getConduitNativeDb } from './conduit-sqlite.js';
import { getGlobalSaltPath } from './global-salt.js';
import { getBrainDb, getBrainNativeDb } from './memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from './nexus-sqlite.js';
import { getSkillsNativeDb, openSkillsDb } from './skills-db.js';
import {
  readSnapshotGeneration,
  runGatedSnapshot,
  type SnapshotGateMode,
  type SnapshotGateResult,
  type SnapshotOutcome,
  selectSnapshotsToKeep,
} from './snapshot-gate.js';
import { getDb, getNativeDb } from './sqlite.js';

/**
 * Maximum number of snapshots retained per global-tier database and for the
 * global-salt backups (oldest rotated out). Project-tier snapshots use the
 * time-spread policy in `snapshot-gate.ts` instead (T12508).
 */
const MAX_SNAPSHOTS = 10;

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
 *                                  `getNexusDb`, `ensureGlobalAgentRegistryDb`,
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
  /**
   * Resolves the live native handle for the project at `cwd` (global targets
   * ignore it), or `null` if not yet initialized. The `cwd` MUST be passed:
   * without it a project-tier getter resolves the process's ambient project,
   * and project A's backup would contain project B's database (T12508).
   */
  readonly getDb: (cwd?: string) => SnapshotDbHandle | null;
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
 * `packages/core/src/store/**`). Historically this was called directly
 * because `openCleoDb('brain')` was misrouted to `getTasksDb` (T10397) —
 * that bug is now fixed in `open-cleo-db.ts`, so direct calls here remain
 * valid but redundant; keeping the direct call avoids re-applying pragmas
 * and the project_id consistency gate on the snapshot path.
 */
async function openBrainDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  await getBrainDb(cwd);
  // After getBrainDb resolves, the native singleton MUST be populated.
  return getBrainNativeDb(cwd);
}

/**
 * Open the canonical tasks.db singleton via {@link getDb} and return its
 * native handle. Mirrors {@link openBrainDbForSnapshot}; same rationale.
 */
async function openTasksDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  await getDb(cwd);
  return getNativeDb(cwd);
}

/**
 * Open the canonical conduit.db singleton via {@link ensureConduitDb}
 * (sync) and return its native handle.
 */
async function openConduitDbForSnapshot(cwd?: string): Promise<SnapshotDbHandle | null> {
  // ensureConduitDb requires an absolute project root. E6-L3 (T11523): it is now
  // async (routes through the dual-scope cleo.db chokepoint).
  const projectRoot = resolveOrCwd(cwd);
  await ensureConduitDb(projectRoot);
  return getConduitNativeDb(projectRoot);
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
 * {@link ensureGlobalAgentRegistryDb} and return its native handle.
 *
 * @task T10316
 */
async function openAgentRegistryDbForSnapshot(): Promise<SnapshotDbHandle | null> {
  await ensureGlobalAgentRegistryDb();
  return getGlobalAgentRegistryNativeDb();
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
    // T12508: `existsSync` answers false for EACCES too, which would class an
    // unreadable database as absent. Only ENOENT means absent; any other stat
    // error is a failure and propagates.
    try {
      statSync(path);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
      throw err;
    }
    // Dynamic import preserves the T1331 lazy-init contract: importing
    // sqlite.ts (which statically imports sqlite-backup.ts for
    // `listSqliteBackups`) MUST NOT pull node:sqlite into module-load
    // time. Only the raw-file-vacuum-readonly path needs the
    // constructor, and it is exercised at snapshot-time, not load-time.
    //
    // T12508: an existing file that cannot be opened (locked, corrupt) THROWS
    // here. That is a failure, not an absent database; the gate reports it
    // and every caller stays non-fatal.
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path, { readOnly: true });
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
      readonly getDb: (cwd?: string) => SnapshotDbHandle | null;
      readonly openDb: (cwd?: string) => Promise<SnapshotDbHandle | null>;
    }
  >
> = {
  tasks: { getDb: getNativeDb, openDb: openTasksDbForSnapshot },
  brain: { getDb: getBrainNativeDb, openDb: openBrainDbForSnapshot },
  conduit: { getDb: getConduitNativeDb, openDb: openConduitDbForSnapshot },
  nexus: { getDb: getNexusNativeDb, openDb: openNexusDbForSnapshot },
  'signaldock-global': {
    getDb: getGlobalAgentRegistryNativeDb,
    openDb: openAgentRegistryDbForSnapshot,
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
 * Apply time-spread retention to a single prefix: delete every snapshot not
 * selected by {@link selectSnapshotsToKeep} (latest, quarter-hourly, hourly
 * and daily slots). Runs AFTER the new snapshot is written, so a failed
 * `VACUUM INTO` never costs an existing recovery point, and the file just
 * written is pinned. Non-fatal on any filesystem error.
 *
 * @param backupDir - Snapshot directory.
 * @param prefix - Snapshot prefix to prune.
 * @param justWritten - Basename of the snapshot just written; never deleted.
 * @task T12508 — replaces the newest-10 rotation that a burst could flush
 */
function rotateSnapshots(backupDir: string, prefix: string, justWritten: string): void {
  try {
    const pattern = snapshotPattern(prefix);
    const names = readdirSync(backupDir).filter((f) => pattern.test(f));
    const keep = selectSnapshotsToKeep(names, {
      pinned: justWritten,
      nowStamp: formatTimestamp(new Date()),
    });
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        unlinkSync(join(backupDir, name));
      } catch {
        // non-fatal — try the rest
      }
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
  /**
   * Gate admission mode (see `snapshot-gate.ts`). `routine` (default) is
   * debounced and skips when a snapshot is in flight. `required` — session
   * end and pre-destructive checkpoints — is not debounced, waits for the
   * lock, and is satisfied only by a snapshot that started after the request.
   * Neither mode bypasses the lock.
   */
  mode?: SnapshotGateMode;
  /**
   * `required` mode: the gate generation the caller observed when it made the
   * request (see `readSnapshotGeneration`); only a later snapshot covers it.
   * Defaults to the generation read when this call starts.
   */
  seenGeneration?: number;
  /** `required` mode: never treat a prefix as covered (see `snapshot-gate.ts`). */
  alwaysSnapshot?: boolean;
  /**
   * `required` mode: lock retries before giving up with `lock-timeout`.
   * Defaults to `SNAPSHOT_LOCK_WAIT_RETRIES` (about 90 s).
   */
  lockWaitRetries?: number;
  /** Called under the gate lock before the generation is claimed (see `snapshot-gate.ts`). */
  onLockAcquired?: () => void;
}

/**
 * Resolve the project `cleo.db` handle that stores the snapshot gate state
 * (see `snapshot-gate.ts`). Returns `null` when it cannot be opened, in which
 * case the gate admits no snapshot.
 *
 * @task T12508
 */
async function resolveGateStateDb(cwd?: string): Promise<DatabaseSync | null> {
  try {
    const bound = getNativeDb(cwd);
    if (bound) return bound;
    await getDb(cwd);
    return getNativeDb(cwd);
  } catch {
    return null;
  }
}

/**
 * Read the project's current snapshot generation — what a `required` request
 * should record as `seenGeneration` at the moment it is made (after the
 * caller's last write), when the snapshot itself runs later or elsewhere.
 *
 * @param cwd - Project directory.
 * @returns The generation, or `null` when the gate state cannot be read.
 * @task T12508
 */
export async function readProjectSnapshotGeneration(cwd?: string): Promise<number | null> {
  return readSnapshotGeneration(await resolveGateStateDb(cwd));
}

/**
 * Snapshot the given project-tier targets through the project-wide gate:
 * one snapshot in flight per project across processes, and a per-prefix
 * debounce persisted in `cleo.db`. Non-fatal.
 *
 * @returns The gate outcome, or `null` when the backup directory cannot be
 *          resolved or no target is snapshottable.
 * @task T12508
 */
async function snapshotProjectTargetsGated(
  targets: readonly SnapshotTarget[],
  opts: VacuumOptions,
): Promise<SnapshotGateResult | null> {
  const cwd = opts.cwd;
  let backupDir: string;
  try {
    const cleoDir = getCleoDir(cwd);
    backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
  } catch {
    return null; // cannot resolve backup dir — abort silently
  }

  const byPrefix = new Map(
    targets.filter((t) => t.strategy !== 'skip-derived').map((t) => [t.prefix, t] as const),
  );
  if (byPrefix.size === 0) return null;

  // One VACUUM per physical database file per run (T12508): tasks, brain and
  // conduit share the project cleo.db handle. Maps source realpath → the
  // snapshot file written for it in this run.
  const writtenBySource = new Map<string, string>();
  return runGatedSnapshot(
    {
      backupDir,
      stateDb: await resolveGateStateDb(cwd),
      prefixes: [...byPrefix.keys()],
      mode: opts.mode ?? 'routine',
      ...(opts.seenGeneration !== undefined && { seenGeneration: opts.seenGeneration }),
      ...(opts.alwaysSnapshot !== undefined && { alwaysSnapshot: opts.alwaysSnapshot }),
      ...(opts.lockWaitRetries !== undefined && { lockWaitRetries: opts.lockWaitRetries }),
      ...(opts.onLockAcquired !== undefined && { onLockAcquired: opts.onLockAcquired }),
    },
    async (prefix) => {
      const target = byPrefix.get(prefix);
      return target ? snapshotOne(target, backupDir, writtenBySource, cwd) : 'absent';
    },
  );
}

/**
 * Real path of the database file behind a native handle, or `null` when it is
 * unknown (an in-memory database, or a handle without `location()`).
 *
 * @task T12508
 */
function sourceFileOf(db: SnapshotDbHandle): string | null {
  if (!hasLocation(db)) return null;
  const location = db.location();
  if (!location) return null;
  try {
    return realpathSync(location);
  } catch {
    return location;
  }
}

/** Whether a handle exposes `DatabaseSync.location()` (Node 24+). */
function hasLocation(
  db: SnapshotDbHandle,
): db is SnapshotDbHandle & { location: () => string | null } {
  return 'location' in db && typeof db.location === 'function';
}

/**
 * Refuse to snapshot a project-tier handle whose file lies outside this
 * project's `.cleo/` directory. A handle resolved for the wrong project (the
 * ambient one in a multi-project process) would otherwise put project B's
 * database into project A's backups.
 *
 * @task T12508
 */
function assertOwnedByProject(source: string, prefix: string, cwd?: string): void {
  let cleoDir = getCleoDir(cwd);
  try {
    cleoDir = realpathSync(cleoDir);
  } catch {
    // Compare against the unresolved path.
  }
  if (!source.startsWith(cleoDir + sep)) {
    throw new Error(
      `refusing to snapshot ${prefix}: its database ${source} is not inside ${cleoDir}`,
    );
  }
}

/**
 * `link()` error codes that mean "this filesystem cannot hard-link these
 * files" rather than a real failure: permission-less link (EPERM), no link
 * support (ENOTSUP, e.g. exFAT), different devices (EXDEV), link-count cap
 * (EMLINK). The caller copies instead.
 */
const LINK_FALLBACK_CODES = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK']);

/**
 * Hard-link `existing` to `dest`. Returns `false` when the filesystem cannot
 * hard-link (see {@link LINK_FALLBACK_CODES}); any other error throws.
 *
 * @task T12508
 */
function tryHardLink(existing: string, dest: string): boolean {
  try {
    linkSync(existing, dest);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
      if (LINK_FALLBACK_CODES.has(err.code)) return false;
    }
    throw err;
  }
}

/**
 * An in-progress snapshot file `<name>.tmp-<pid>`, or a SQLite sidecar
 * (`-journal`, `-wal`, `-shm`) that `VACUUM INTO` may leave beside it.
 */
const TEMP_SNAPSHOT_RE = /\.db\.tmp-(\d+)(?:-journal|-wal|-shm)?$/;

/** Age after which any temp snapshot is a leftover, even if its pid was reused. */
const TEMP_SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

/**
 * Temp path a snapshot is written to before it is committed. It does not end
 * in `.db`, so every snapshot reader (listing, retention, restore, doctor)
 * ignores it.
 */
function tempSnapshotPath(dest: string): string {
  return `${dest}.tmp-${process.pid}`;
}

/**
 * Make a finished temp snapshot durable and give it its real name: fsync the
 * file, rename it (atomic within a directory), then fsync the directory
 * (best-effort) so the rename itself survives a crash.
 *
 * @task T12508
 */
function commitSnapshotFile(tmp: string, dest: string): void {
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  try {
    const dirFd = openSync(dirname(dest), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Not every platform can fsync a directory; the rename is still atomic.
  }
}

/** Whether a process with this pid exists (EPERM means it exists but is not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * Remove temp snapshots left by a process killed mid-write: those whose pid
 * is dead, or that are older than {@link TEMP_SNAPSHOT_MAX_AGE_MS}. Never
 * throws.
 *
 * @task T12508
 */
function removeDeadTempSnapshots(backupDir: string): void {
  try {
    for (const name of readdirSync(backupDir)) {
      const m = TEMP_SNAPSHOT_RE.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      const path = join(backupDir, name);
      const stale =
        pid !== process.pid &&
        (!isPidAlive(pid) || Date.now() - statSync(path).mtimeMs > TEMP_SNAPSHOT_MAX_AGE_MS);
      if (stale) rmSync(path, { force: true });
    }
  } catch {
    // Cleanup is best-effort.
  }
}

/** Attempts at finding a free snapshot filename before giving up. */
const SNAPSHOT_NAME_ATTEMPTS = 3;

/**
 * Choose a snapshot filename `<prefix>-YYYYMMDD-HHmmss.db` that does not yet
 * exist. `VACUUM INTO` refuses an existing destination, and two snapshots of
 * one prefix can fall in the same second (a routine checkpoint followed by a
 * pre-destructive one). On a collision this waits for the next second rather
 * than adding a suffix, so every reader of the documented filename format
 * (listing, restore, verify, doctor) keeps working. Called under the gate
 * lock, so no other gated writer can take the name in between.
 *
 * @task T12508
 */
async function freeSnapshotName(backupDir: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < SNAPSHOT_NAME_ATTEMPTS; attempt++) {
    const name = `${prefix}-${formatTimestamp(new Date())}.db`;
    if (!existsSync(join(backupDir, name))) return name;
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
  }
  throw new Error(`no free snapshot filename for ${prefix} in ${backupDir}`);
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
 * The filename is stamped HERE, under the gate lock, not when the request
 * was made — see {@link freeSnapshotName}.
 *
 * @param target — snapshot target descriptor (role + prefix + native DB getter)
 * @param backupDir — absolute path to the snapshot directory
 * @param cwd — optional working directory propagated to `target.openDb`
 * @param writtenBySource — snapshot files already written in this run, keyed
 *        by source realpath; a second target on the same file is hard-linked.
 * @returns `'written'` when a snapshot file was written; `'linked'` when the
 *          same physical database was already snapshotted in this run and the
 *          file was hard-linked under this prefix; `'absent'` when the
 *          database does not exist in this project (or is a derived row).
 *          Opener, ownership and `VACUUM INTO` errors throw.
 *
 * @task T10316 — eager-open via openCleoDb chokepoint (Saga T10281 / E3)
 * @task T10317 — raw-file-vacuum-readonly strategy for opener-less roles
 * @task T12508 — reports whether it wrote, so the gate never records a skip as a snapshot
 */
async function snapshotOne(
  target: SnapshotTarget,
  backupDir: string,
  writtenBySource: Map<string, string>,
  cwd?: string,
): Promise<SnapshotOutcome> {
  if (target.strategy === 'skip-derived') {
    // Derived row — file is rebuildable from the blob CAS. Inventory row
    // documents `backupPath === 'rebuildable-from-blob-store'`. Nothing to do.
    return 'absent';
  }

  let db = target.getDb(cwd);
  let opened: SnapshotDbHandle | null = null;
  if (!db) {
    // T10316 / T10317: eager-open via the canonical per-DB chokepoint (for
    // chokepoint-opener roles) or a one-shot read-only `DatabaseSync` (for
    // raw-file-vacuum-readonly roles). Either way, the snapshot pipeline
    // never silently skips a registered target just because the in-process
    // handle cache is empty.
    // An opener that THROWS (locked file, malformed orphan) propagates: the
    // gate reports it as failed. `null` means there is no such database here.
    db = await target.openDb(cwd);
    if (!db) return 'absent';
    opened = db;
  }

  let destName: string;
  let source: string | null;
  try {
    source = sourceFileOf(db);
    if (source !== null && (target.tier === 'project' || target.tier === 'derived')) {
      assertOwnedByProject(source, target.prefix, cwd);
    }
    destName = await freeSnapshotName(backupDir, target.prefix);
  } catch (err) {
    if (opened && target.closeDb) target.closeDb(opened);
    throw err;
  }
  const dest = join(backupDir, destName);

  // Leftovers of a snapshot killed mid-write (see commitSnapshotFile).
  removeDeadTempSnapshots(backupDir);

  // Already snapshotted this physical file in this run: hard-link the same
  // snapshot under this prefix. One VACUUM, no extra disk, and every reader
  // that looks for `<prefix>-*.db` (restore, recover-brain-db, listing)
  // still finds a file. A filesystem without hard links (exFAT, FAT, some
  // network mounts) gets a copy instead.
  const existing = source !== null ? writtenBySource.get(source) : undefined;
  if (existing !== undefined) {
    try {
      if (tryHardLink(existing, dest)) {
        rotateSnapshots(backupDir, target.prefix, destName);
        return 'linked';
      }
      const tmp = tempSnapshotPath(dest);
      try {
        copyFileSync(existing, tmp);
        commitSnapshotFile(tmp, dest);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      rotateSnapshots(backupDir, target.prefix, destName);
      return 'written';
    } finally {
      if (opened && target.closeDb) target.closeDb(opened);
    }
  }

  try {
    // TRUNCATE checkpoint: flushes all WAL frames to the main DB and truncates
    // the WAL file to zero bytes, ensuring a consistent DB state before the
    // VACUUM INTO snapshot (ADR-013, section 3 point 7). For read-only opens
    // of orphan files there is no WAL to truncate, but the pragma is a no-op
    // in that case so we keep the call uniform.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    // VACUUM INTO a temp name, fsync, then rename: a process killed
    // mid-VACUUM leaves only `<name>.tmp-<pid>`, which no reader lists,
    // never an empty file under a valid snapshot name (T12508).
    const tmp = tempSnapshotPath(dest);
    try {
      // Escape single quotes in path (path is programmatic, but be safe).
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      commitSnapshotFile(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }

    if (source !== null) writtenBySource.set(source, dest);
    rotateSnapshots(backupDir, target.prefix, destName);
    return 'written';
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
 * Retained for backward compatibility with call sites in
 * `data-safety-central.ts` that only snapshot tasks.db. It passes through the
 * same project-wide gate as {@link vacuumIntoBackupAll}: at most one snapshot
 * in flight per project. Per-write checkpoints use the debounced `routine`
 * mode; pre-destructive checkpoints pass `mode: 'required'` and AWAIT the
 * result, so the snapshot is on disk before the destructive step begins.
 *
 * Non-fatal: all errors are swallowed — backup failure must never
 * interrupt normal operation.
 *
 * @returns The gate outcome (which prefixes were snapshotted, or why none
 *          were), or `null` when nothing could be attempted.
 * @task T12508 — gated; the `force` bypass was removed
 */
export async function vacuumIntoBackup(
  opts: VacuumOptions = {},
): Promise<SnapshotGateResult | null> {
  try {
    const target = SNAPSHOT_TARGETS.find((t) => t.prefix === 'tasks');
    if (!target) return null;
    return await snapshotProjectTargetsGated([target], opts);
  } catch {
    // non-fatal — backup failure must never interrupt normal operation
    return null;
  }
}

/**
 * Create VACUUM INTO snapshots of every project-tier (and opt-in `derived`)
 * SQLite database registered in `DB_INVENTORY`, through the project-wide
 * cross-process gate (see `snapshot-gate.ts`). The session-end hook passes
 * `mode: 'required'`: the snapshot is not debounced by earlier per-write
 * checkpoints, so it captures the session's final writes, and requests that
 * queue behind one running snapshot are all covered by the next one — a burst
 * of session ends produces one snapshot.
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
 * @returns The gate outcome (which prefixes were snapshotted, or why none
 *          were), or `null` when nothing could be attempted.
 * @task T12508 — cross-process gate + persisted debounce; `force` removed
 */
export async function vacuumIntoBackupAll(
  opts: VacuumOptions = {},
): Promise<SnapshotGateResult | null> {
  try {
    return await snapshotProjectTargetsGated(SNAPSHOT_TARGETS, opts);
  } catch {
    // non-fatal — backup failure must never interrupt normal operation
    return null;
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

  removeDeadTempSnapshots(backupDir);
  try {
    // Checkpoint then VACUUM INTO a temp name, fsync, rename (T12508): a
    // kill mid-VACUUM never leaves an empty file under a snapshot name.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const tmp = tempSnapshotPath(snapshotPath);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      commitSnapshotFile(tmp, snapshotPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
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
