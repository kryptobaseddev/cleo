/**
 * Generic CLEO database auto-recovery pipeline — generalised from the
 * brain-only T10303 helper (`recoverMalformedBrainDb`) so the same flow
 * works for every DB declared in {@link DB_INVENTORY}.
 *
 * Mirrors the EXACT semantics of {@link recoverMalformedBrainDb}:
 *
 * 1. Move the corrupt DB (plus `-wal` / `-shm` sidecars) to
 *    `<cleoDir>/quarantine/<role>-malformed-<iso>/`.
 * 2. Enumerate snapshot candidates from three sources:
 *    - `<cleoDir>/backups/snapshot/<role>.db.snapshot-*` (system-backup format)
 *    - `<cleoDir>/backups/sqlite/<role>-YYYYMMDD-HHmmss.db` (VACUUM INTO format)
 *    - `<cleoDir>/<role>.db.PRE-DUP-FIX-*` (legacy artifact fallback)
 *    Sort newest-first.
 * 3. Validate each candidate via `PRAGMA quick_check` (best-effort, with
 *    sqlite-internal busy timeout). Pick the freshest one that returns `ok`.
 * 4. `copyFileSync` the chosen source to the canonical DB path and run one
 *    final `quick_check` to confirm the restored file opens cleanly.
 *
 * The role is sourced from {@link DB_INVENTORY} via {@link getRoleConfig} —
 * the inventory is the SSoT for which DBs exist and where they live.
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 * @adr ADR-068
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DbInventoryEntry,
  DbRecoveredRowCounts,
  DbRecoveryResult,
  DbRole,
} from '@cleocode/contracts';
import { DB_INVENTORY } from '@cleocode/contracts/db-inventory.js';
import type {
  StoreDeletionEvidence,
  StoreFreshnessFinding,
  StoreSnapshotIdentity,
  StoreTableHighWater,
} from '@cleocode/contracts/db-recovery.js';
import { getCleoHome } from '@cleocode/paths';
import { inspectStoreRestoreIntent, repairFileHash } from './restore-marker.js';
import { loadSqliteVecExtension, openNativeDatabase } from './sqlite-native.js';

/**
 * Minimal logger shape used by {@link recoverMalformedDb}.
 *
 * Matches the subset of `pino.Logger` invoked from this module. Declared
 * locally so the recovery pipeline does not pull `pino` into modules that
 * use it strictly as a value type.
 *
 * @task T10318
 * @public
 */
export interface RecoveryLogger {
  /** Structured warning — used for the single auto-recovery announcement. */
  warn(obj: Record<string, unknown>, msg: string): void;
  /** Structured error — used for non-fatal probe failures. */
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Options accepted by {@link recoverMalformedDb}.
 *
 * @task T10318
 * @public
 */
export interface RecoverMalformedDbOptions {
  /** Canonical role of the database to recover. Must exist in {@link DB_INVENTORY}. */
  role: DbRole;
  /**
   * Absolute path to the corrupt DB file. When omitted, derived from the
   * inventory entry's `filePathTemplate` with {@link projectRoot} substitution.
   */
  corruptPath?: string;
  /**
   * Absolute path to the snapshot directory (`.cleo/backups/snapshot/`).
   * When omitted, derived from the inventory tier + {@link projectRoot}.
   */
  snapshotDir?: string;
  /**
   * Absolute path to the VACUUM-INTO snapshot directory
   * (`.cleo/backups/sqlite/`). When omitted, derived from inventory tier +
   * {@link projectRoot}.
   */
  vacuumSnapshotDir?: string;
  /**
   * Absolute path to the legacy artifact directory (`.cleo/` itself) used
   * for `<role>.db.PRE-DUP-FIX-*` fallback enumeration. When omitted,
   * derived from inventory tier + {@link projectRoot}. Pass an empty
   * string to disable legacy fallback entirely.
   */
  legacyArtifactDir?: string;
  /**
   * Absolute path to the quarantine root. Defaults to
   * `<dirname(corruptPath)>/quarantine`.
   */
  quarantineRoot?: string;
  /**
   * Absolute path to the project root used when resolving inventory paths.
   * Required when {@link corruptPath} is not supplied for a `project`-tier
   * role; ignored for `global`-tier roles whose paths resolve via
   * `getCleoHome()`.
   */
  projectRoot?: string;
  /** Pino-shaped logger for the single recovery announcement. */
  logger: RecoveryLogger;
}

/** Source taxonomy for a snapshot candidate — diagnostic only. */
type SnapshotSource = 'system-snapshot' | 'vacuum-snapshot' | 'pre-dup-fix';

/** Internal candidate record used during snapshot ranking. */
interface SnapshotCandidate {
  /** Absolute path to the snapshot file. */
  path: string;
  /** Best-available timestamp for ordering (epoch ms). */
  timestampMs: number;
  /** Source taxonomy — for diagnostic logging only. */
  source: SnapshotSource;
}

/** Result of a single snapshot probe via `PRAGMA quick_check`. */
interface ProbeResult {
  /** `true` when the file opens cleanly and `quick_check` returns `ok`. */
  ok: boolean;
  /** Best-effort per-table row counts in the probed DB. */
  rowCounts: DbRecoveredRowCounts;
}

// ---------------------------------------------------------------------------
// Inventory + path resolution
// ---------------------------------------------------------------------------

/**
 * Look up an inventory entry by role.
 *
 * @internal
 */
function getRoleConfig(role: DbRole): DbInventoryEntry {
  const entry = DB_INVENTORY.find((e) => e.role === role);
  if (!entry) {
    // @sync-invariant none:input-shape the database role must exist in the inventory
    throw new Error(`Unknown DB role "${role}" — not present in DB_INVENTORY`);
  }
  return entry;
}

/**
 * Substitute path tokens in an inventory `filePathTemplate`.
 *
 * @remarks
 * Recognised tokens today:
 * - `<projectRoot>` — substituted from {@link projectRoot}.
 * - `$XDG_DATA_HOME/cleo` — substituted from {@link getCleoHome}().
 *
 * @internal
 */
function substitutePathTokens(template: string, projectRoot: string | undefined): string {
  let out = template;
  if (out.includes('<projectRoot>')) {
    if (!projectRoot) {
      // @sync-invariant none:input-shape a project inventory template requires a project root
      throw new Error(
        `Inventory template "${template}" requires <projectRoot> but none was supplied`,
      );
    }
    out = out.replace(/<projectRoot>/g, projectRoot);
  }
  if (out.includes('$XDG_DATA_HOME/cleo')) {
    out = out.replace(/\$XDG_DATA_HOME\/cleo/g, getCleoHome());
  }
  return out;
}

/**
 * Resolve the canonical filesystem path for a role's DB file.
 *
 * @remarks
 * Substitutes the inventory's `filePathTemplate` tokens. The two tokens
 * recognised today are `<projectRoot>` and `$XDG_DATA_HOME/cleo` (the latter
 * resolves via env-paths through `getCleoHome()`). For project-tier roles,
 * pass {@link projectRoot}. For global-tier roles, the resolver uses
 * `getCleoHome()` directly.
 *
 * Lives in this module rather than `@cleocode/paths` because resolution is
 * SSoT-aware (driven by {@link DB_INVENTORY}) and recovery is the only
 * consumer today. Promote upward when a second consumer appears.
 *
 * @task T10318
 * @public
 */
export function resolveRoleDbPath(role: DbRole, ctx: { projectRoot?: string }): string {
  const entry = getRoleConfig(role);
  return substitutePathTokens(entry.filePathTemplate, ctx.projectRoot);
}

/**
 * Resolve the canonical `.cleo/backups/snapshot/` and `.cleo/backups/sqlite/`
 * dirs for a role's filesystem layout.
 *
 * @remarks
 * For `project`-tier roles these resolve to
 * `<projectRoot>/.cleo/backups/{snapshot,sqlite}`. For `global`-tier roles
 * they resolve to `$XDG_DATA_HOME/cleo/backups/{snapshot,sqlite}`. The
 * legacy artifact directory mirrors the parent `.cleo/` (project) or
 * `cleo/` (global) home for `<role>.db.PRE-DUP-FIX-*` enumeration.
 *
 * @task T10318
 * @public
 */
export function resolveRoleBackupDirs(
  role: DbRole,
  ctx: { projectRoot?: string },
): {
  /** Absolute path to the canonical DB home (parent directory of the DB file). */
  cleoDir: string;
  /** Absolute path to `<cleoDir>/backups/snapshot/`. */
  snapshotDir: string;
  /** Absolute path to `<cleoDir>/backups/sqlite/`. */
  vacuumSnapshotDir: string;
  /** Absolute path to `<cleoDir>` itself — for legacy PRE-DUP-FIX enumeration. */
  legacyArtifactDir: string;
  /** Absolute path to `<cleoDir>/quarantine/` — the quarantine root. */
  quarantineRoot: string;
} {
  const dbPath = resolveRoleDbPath(role, ctx);
  const cleoDir = dirname(dbPath);
  return {
    cleoDir,
    snapshotDir: join(cleoDir, 'backups', 'snapshot'),
    vacuumSnapshotDir: join(cleoDir, 'backups', 'sqlite'),
    legacyArtifactDir: cleoDir,
    quarantineRoot: join(cleoDir, 'quarantine'),
  };
}

// ---------------------------------------------------------------------------
// Snapshot filename patterns — parameterised by role
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use inside a `RegExp` literal segment.
 *
 * @internal
 */
function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the per-role snapshot filename regex (matches
 * `<role>.db.snapshot-2026-05-23T08-00-55-563Z`).
 *
 * @internal
 */
function buildSystemSnapshotRegex(role: DbRole): RegExp {
  return new RegExp(
    `^${escapeRegExpLiteral(role)}\\.db\\.snapshot-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)$`,
  );
}

/**
 * VACUUM INTO filename prefixes that hold a role's data. Brain and conduit
 * live in the unified project `cleo.db`, whose one snapshot per run is
 * `tasks-*.db` (T13891); older runs also wrote `brain-*` / `conduit-*`.
 *
 * @param role - Inventory role.
 * @returns The prefixes whose `<prefix>-YYYYMMDD-HHmmss.db` files hold it.
 * @task T13897
 */
export function vacuumSnapshotPrefixes(role: DbRole): readonly string[] {
  return role === 'brain' || role === 'conduit' ? [role, 'tasks'] : [role];
}

/**
 * Build the per-role VACUUM-INTO snapshot filename regex (matches
 * `<prefix>-20260523-130026.db` for every {@link vacuumSnapshotPrefixes}
 * prefix, so the freshest is picked across them).
 *
 * @internal
 */
function buildVacuumSnapshotRegex(role: DbRole): RegExp {
  const prefixes = vacuumSnapshotPrefixes(role).map(escapeRegExpLiteral).join('|');
  return new RegExp(`^(?:${prefixes})-(\\d{8})-(\\d{6})\\.db$`);
}

/**
 * Build the per-role legacy PRE-DUP-FIX regex (matches
 * `<role>.db.PRE-DUP-FIX-*`).
 *
 * @internal
 */
function buildPreDupFixRegex(role: DbRole): RegExp {
  return new RegExp(`^${escapeRegExpLiteral(role)}\\.db\\.PRE-DUP-FIX-`);
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

/**
 * Parse a snapshot ISO-with-dashes timestamp into epoch ms.
 *
 * @internal
 */
function parseSystemSnapshotTimestamp(stamp: string): number {
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Parse a VACUUM INTO snapshot timestamp (`20260523-130026`) into epoch ms.
 *
 * @internal
 */
function parseVacuumSnapshotTimestamp(datePart: string, timePart: string): number {
  const yyyy = Number.parseInt(datePart.slice(0, 4), 10);
  const mm = Number.parseInt(datePart.slice(4, 6), 10);
  const dd = Number.parseInt(datePart.slice(6, 8), 10);
  const hh = Number.parseInt(timePart.slice(0, 2), 10);
  const mi = Number.parseInt(timePart.slice(2, 4), 10);
  const ss = Number.parseInt(timePart.slice(4, 6), 10);
  if ([yyyy, mm, dd, hh, mi, ss].some((n) => Number.isNaN(n))) return 0;
  return new Date(yyyy, mm - 1, dd, hh, mi, ss).getTime();
}

// ---------------------------------------------------------------------------
// Snapshot enumeration + probing
// ---------------------------------------------------------------------------

/**
 * Enumerate all snapshot candidates for a role from system-snapshot,
 * vacuum-snapshot, and PRE-DUP-FIX legacy sources. Returns newest-first.
 *
 * @internal
 */
export function collectSnapshotCandidatesForRole(opts: {
  role: DbRole;
  snapshotDir?: string;
  vacuumSnapshotDir?: string;
  legacyArtifactDir?: string;
}): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [];
  const systemRe = buildSystemSnapshotRegex(opts.role);
  const vacuumRe = buildVacuumSnapshotRegex(opts.role);
  const preDupFixRe = buildPreDupFixRegex(opts.role);

  // 1. System-backup snapshots.
  if (opts.snapshotDir) {
    try {
      if (existsSync(opts.snapshotDir)) {
        for (const name of readdirSync(opts.snapshotDir)) {
          const m = systemRe.exec(name);
          const stamp = m?.[1];
          if (!stamp) continue;
          out.push({
            path: join(opts.snapshotDir, name),
            timestampMs: parseSystemSnapshotTimestamp(stamp),
            source: 'system-snapshot',
          });
        }
      }
    } catch {
      // non-fatal — directory unreadable, continue to other sources
    }
  }

  // 2. VACUUM INTO debounced snapshots.
  if (opts.vacuumSnapshotDir) {
    try {
      if (existsSync(opts.vacuumSnapshotDir)) {
        for (const name of readdirSync(opts.vacuumSnapshotDir)) {
          const m = vacuumRe.exec(name);
          const datePart = m?.[1];
          const timePart = m?.[2];
          if (!datePart || !timePart) continue;
          out.push({
            path: join(opts.vacuumSnapshotDir, name),
            timestampMs: parseVacuumSnapshotTimestamp(datePart, timePart),
            source: 'vacuum-snapshot',
          });
        }
      }
    } catch {
      // non-fatal
    }
  }

  // 3. Legacy PRE-DUP-FIX artifacts.
  if (opts.legacyArtifactDir) {
    try {
      if (existsSync(opts.legacyArtifactDir)) {
        for (const name of readdirSync(opts.legacyArtifactDir)) {
          if (!preDupFixRe.test(name)) continue;
          const fullPath = join(opts.legacyArtifactDir, name);
          let ts = 0;
          try {
            ts = statSync(fullPath).mtimeMs;
          } catch {
            continue;
          }
          out.push({ path: fullPath, timestampMs: ts, source: 'pre-dup-fix' });
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Newest first. Stable secondary sort by source ranking when timestamps tie
  // (system > vacuum > pre-dup-fix) so the freshest *promoted* artifact wins.
  const rank: Record<SnapshotSource, number> = {
    'system-snapshot': 0,
    'vacuum-snapshot': 1,
    'pre-dup-fix': 2,
  };
  out.sort((a, b) => {
    if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs;
    return rank[a.source] - rank[b.source];
  });
  return out;
}

/**
 * Enumerate user-table names in a DB via `sqlite_master`, excluding internal
 * `sqlite_*` tables and Drizzle journal tables.
 *
 * @internal
 */
function enumerateUserTables(handle: DatabaseSync): string[] {
  try {
    const rows = handle
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name`,
      )
      .all() as Array<{ name?: unknown }>;
    const out: string[] = [];
    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.length > 0) {
        out.push(row.name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Probe a candidate snapshot file by opening it read-only and running
 * `PRAGMA quick_check`. Returns `{ ok: true, rowCounts }` only when the
 * database opens cleanly and `quick_check` returns `ok`.
 *
 * The handle is always closed before this function returns.
 *
 * @internal
 */
export function probeSnapshot(path: string): ProbeResult {
  let handle: DatabaseSync | null = null;
  try {
    handle = openNativeDatabase(path, { readonly: true, enableWal: false });

    const quick = handle.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    const result = quick?.quick_check ?? '';
    if (result !== 'ok') {
      return { ok: false, rowCounts: {} };
    }

    // Best-effort per-table row counts. We enumerate user tables via
    // sqlite_master and count each — any failure surfaces as null in the
    // record. The empty record `{}` is reserved for cases where the DB has
    // no user tables (or sqlite_master itself fails).
    const tables = enumerateUserTables(handle);
    const rowCounts: Record<string, number | null> = {};
    for (const table of tables) {
      try {
        // Identifier validated against sqlite_master enumeration; safe to embed.
        const row = handle.prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`).get() as
          | { cnt?: number }
          | undefined;
        rowCounts[table] = typeof row?.cnt === 'number' ? row.cnt : null;
      } catch {
        rowCounts[table] = null;
      }
    }

    return { ok: true, rowCounts };
  } catch {
    return { ok: false, rowCounts: {} };
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch {
        // close errors are non-fatal; handle is terminal anyway
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

/**
 * Format an epoch-ms timestamp into the canonical quarantine directory
 * name suffix — ISO-8601 with filesystem-safe `-` separators.
 *
 * @internal
 */
function formatQuarantineSuffix(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-');
}

/**
 * Move the corrupt DB and its `-wal`/`-shm` sidecars into a quarantine
 * directory. Returns the absolute path to the quarantine directory.
 *
 * Uses `renameSync` (atomic on same-filesystem) — falls back to
 * `copyFileSync` + unlink when rename crosses filesystems. We don't bother
 * detecting cross-fs explicitly; `renameSync` returns EXDEV in that case
 * which we catch as a recovery failure and the caller surfaces it.
 *
 * @internal
 */
export function quarantineCorruptDb(
  role: DbRole,
  corruptPath: string,
  quarantineRoot: string,
): string {
  const quarantineDir = join(
    quarantineRoot,
    `${role}-malformed-${formatQuarantineSuffix(Date.now())}`,
  );
  mkdirSync(quarantineDir, { recursive: true });

  const dest = join(quarantineDir, `${basename(corruptPath)}.malformed`);
  renameSync(corruptPath, dest);

  // Move sidecars too — their state matters for any forensic post-mortem.
  for (const suffix of ['-wal', '-shm']) {
    const sidecarSrc = corruptPath + suffix;
    if (existsSync(sidecarSrc)) {
      const sidecarDest = join(quarantineDir, basename(corruptPath) + '.malformed' + suffix);
      try {
        renameSync(sidecarSrc, sidecarDest);
      } catch {
        // Sidecar move failure is non-fatal — the main file is already gone.
      }
    }
  }

  return quarantineDir;
}

/**
 * Try each candidate snapshot in newest-first order and return the first
 * one that probes clean.
 *
 * @internal
 */
function pickFreshestValidSnapshot(
  candidates: SnapshotCandidate[],
  logger: RecoveryLogger,
): { candidate: SnapshotCandidate; probe: ProbeResult } | null {
  for (const candidate of candidates) {
    const probe = probeSnapshot(candidate.path);
    if (probe.ok) {
      return { candidate, probe };
    }
    logger.error(
      { snapshotPath: candidate.path, source: candidate.source },
      'CLEO DB snapshot failed PRAGMA quick_check; trying next-freshest',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Recover a malformed CLEO database by quarantining the corrupt file and
 * restoring the freshest validated snapshot.
 *
 * @remarks
 * Synchronous by design — recovery may run on the open-blocking critical
 * path (e.g. brain.db auto-recovery in {@link memory-sqlite.ts}). Restoration
 * is short (a few seconds) and the alternative is broken behavior.
 *
 * NEVER throws on a recoverable path; instead returns a structured
 * {@link DbRecoveryResult} where `restoredFrom === null` and
 * `integrityOK === false` indicate complete failure. The caller surfaces
 * that case to the operator. Throws only on programmer-error inputs (e.g.
 * unknown role, missing `projectRoot` for a project-tier role with no
 * explicit `corruptPath`).
 *
 * @param opts - Recovery inputs.
 * @returns The {@link DbRecoveryResult} envelope.
 *
 * @example
 * ```typescript
 * import { recoverMalformedDb } from '@cleocode/core/store/recover-malformed-db';
 * import { getLogger } from '@cleocode/core/logger';
 *
 * const result = recoverMalformedDb({
 *   role: 'brain',
 *   projectRoot: '/repo',
 *   logger: getLogger('brain-recover'),
 * });
 * if (result.integrityOK) {
 *   // Retry the open.
 * }
 * ```
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 * @public
 */
export function recoverMalformedDb(opts: RecoverMalformedDbOptions): DbRecoveryResult {
  // Validate role + resolve canonical paths via the inventory SSoT.
  const inventoryDirs = resolveRoleBackupDirs(opts.role, { projectRoot: opts.projectRoot });
  const corruptPath =
    opts.corruptPath ?? resolveRoleDbPath(opts.role, { projectRoot: opts.projectRoot });
  const snapshotDir = opts.snapshotDir ?? inventoryDirs.snapshotDir;
  const vacuumSnapshotDir = opts.vacuumSnapshotDir ?? inventoryDirs.vacuumSnapshotDir;
  const legacyArtifactDir =
    opts.legacyArtifactDir !== undefined ? opts.legacyArtifactDir : inventoryDirs.legacyArtifactDir;
  const quarantineRoot = opts.quarantineRoot ?? join(dirname(corruptPath), 'quarantine');

  const result: DbRecoveryResult = {
    role: opts.role,
    restoredFrom: null,
    dataLossWindowHours: null,
    rowCounts: {},
    integrityOK: false,
    quarantineDir: null,
  };

  // 1. Move the corrupt DB into quarantine. Errors here are fatal to the
  //    recovery path because we cannot safely write a restored file on top
  //    of a corrupt one that might still hold file descriptors.
  try {
    if (existsSync(corruptPath)) {
      result.quarantineDir = quarantineCorruptDb(opts.role, corruptPath, quarantineRoot);
    }
  } catch (err) {
    opts.logger.error(
      { err, role: opts.role, corruptPath, quarantineRoot },
      'CLEO DB auto-recovery aborted: could not quarantine corrupt DB',
    );
    return result;
  }

  // 2. Enumerate candidates and pick the freshest validated one.
  const candidates = collectSnapshotCandidatesForRole({
    role: opts.role,
    snapshotDir,
    vacuumSnapshotDir,
    legacyArtifactDir: legacyArtifactDir.length > 0 ? legacyArtifactDir : undefined,
  });
  const chosen = pickFreshestValidSnapshot(candidates, opts.logger);
  if (!chosen) {
    opts.logger.error(
      { role: opts.role, corruptPath, candidates: candidates.length },
      'CLEO DB auto-recovery failed: no validated snapshot found across system/vacuum/legacy sources',
    );
    return result;
  }

  // 3. Restore via copyFileSync. The destination is the original DB path.
  //    node:sqlite has not opened the file yet (we quarantined it), so a
  //    raw copy is safe — no WAL/SHM exists at this point.
  try {
    copyFileSync(chosen.candidate.path, corruptPath);
  } catch (err) {
    opts.logger.error(
      { err, role: opts.role, snapshotPath: chosen.candidate.path, dest: corruptPath },
      'CLEO DB auto-recovery failed: copy from snapshot to live path threw',
    );
    return result;
  }

  // 4. Final verification — open the restored file readonly and quick_check it.
  const finalProbe = probeSnapshot(corruptPath);
  if (!finalProbe.ok) {
    opts.logger.error(
      { role: opts.role, restoredFrom: chosen.candidate.path, dest: corruptPath },
      'CLEO DB auto-recovery failed: restored DB still fails PRAGMA quick_check',
    );
    return result;
  }

  // 5. Compose the result envelope.
  result.restoredFrom = chosen.candidate.path;
  result.integrityOK = true;
  result.rowCounts = finalProbe.rowCounts;

  if (chosen.candidate.timestampMs > 0) {
    const deltaMs = Date.now() - chosen.candidate.timestampMs;
    result.dataLossWindowHours = Math.max(0, Math.round((deltaMs / 3_600_000) * 10) / 10);
  }

  const isoStamp =
    chosen.candidate.timestampMs > 0
      ? new Date(chosen.candidate.timestampMs).toISOString()
      : 'unknown';
  const windowLabel =
    result.dataLossWindowHours !== null ? `~${result.dataLossWindowHours}h` : 'unknown';

  opts.logger.warn(
    {
      event: 'cleo-db.auto-recovery',
      role: opts.role,
      restoredFrom: chosen.candidate.path,
      source: chosen.candidate.source,
      dataLossWindowHours: result.dataLossWindowHours,
      rowCounts: result.rowCounts,
      quarantineDir: result.quarantineDir,
    },
    `CLEO DB "${opts.role}" auto-recovered from snapshot ${isoStamp}; ${windowLabel} of data may be lost (T10318)`,
  );

  return result;
}

/** Enumerate historical consolidated-store snapshots, newest first; callers validate contents. */
export function collectStoreSnapshotCandidates(target: string): SnapshotCandidate[] {
  const home = dirname(target);
  const snapshotDir = join(home, 'backups', 'snapshot');
  const vacuumSnapshotDir = join(home, 'backups', 'sqlite');
  const out = collectSnapshotCandidatesForRole({
    role: 'tasks',
    snapshotDir,
    vacuumSnapshotDir,
    legacyArtifactDir: home,
  });
  const known = new Set(out.map((s) => s.path));
  for (const directory of [snapshotDir, vacuumSnapshotDir, home]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (
        !/^(?:cleo|tasks|brain|conduit|nexus|global)(?:\.db[.-]|-.*\.db$)/.test(name) ||
        /pre-restore|\.restoring(?:\.|$)|(?:-wal|-shm|-journal|\.json)$/.test(name)
      )
        continue;
      const path = join(directory, name);
      if (known.has(path) || !statSync(path).isFile()) continue;
      out.push({ path, timestampMs: statSync(path).mtimeMs, source: 'system-snapshot' });
      known.add(path);
    }
  }
  return out.sort((a, b) => b.timestampMs - a.timestampMs);
}

/** Shared row-version fields used by freshness diagnosis and lossless merge. */
export const STORE_ROW_VERSION_COLUMNS = [
  'updated_at',
  'updatedAt',
  'modified_at',
  'modifiedAt',
  'created_at',
  'timestamp',
  'started_at',
  'ended_at',
  'last_activity',
  'task_started_at',
  'accepted_at',
  'valid_at',
] as const;

/** Each key's own timestamp is compared; unrelated writes cannot hide a missing row. */
function storeRowTimestamp(columns: readonly string[]): string {
  const stamps = STORE_ROW_VERSION_COLUMNS.filter((c) => columns.includes(c)).map(
    (c) => `coalesce(unixepoch("${c}", 'subsec'), 0)`,
  );
  return stamps.length > 1 ? `max(${stamps.join(',')})` : (stamps[0] ?? '0');
}

/** Key tables whose absent versions participate in recovery assessment. */
export const STORE_FRESHNESS_TABLES = [
  'tasks_tasks',
  'tasks_sessions',
  'tasks_audit_log',
  'tasks_architecture_decisions',
  'brain_decisions',
  'brain_observations',
  'nexus_audit_log',
] as const;

/** Store-local evidence of committed logical deletes; it is never inferred from age. */
export const STORE_DELETION_TABLE = '_store_deleted_keys';

/** Read durable delete receipts, optionally accumulating validated snapshot history. */
export function readStoreDeletedKeys(
  db: DatabaseSync,
  into: Map<string, Map<string, StoreDeletionEvidence>> = new Map(),
): Map<string, Map<string, StoreDeletionEvidence>> {
  if (
    !db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?")
      .get(STORE_DELETION_TABLE)
  )
    return into;
  const known = new Set<string>(STORE_FRESHNESS_TABLES);
  for (const row of db
    .prepare(
      `SELECT table_name, record_key, deleted_at, deletion_count FROM main.${STORE_DELETION_TABLE}`,
    )
    .iterate()) {
    if (
      typeof row.table_name !== 'string' ||
      typeof row.record_key !== 'string' ||
      typeof row.deleted_at !== 'string' ||
      typeof row.deletion_count !== 'number' ||
      row.deletion_count < 1 ||
      !known.has(row.table_name)
    ) {
      // @sync-invariant none:local-only malformed local deletion evidence cannot authorize dropping recovery rows
      throw new Error('Malformed store deletion receipt');
    }
    const table = row.table_name;
    const keys = into.get(table) ?? new Map<string, StoreDeletionEvidence>();
    const old = keys.get(row.record_key);
    if (!old || row.deleted_at > old.deletedAt || row.deletion_count > old.deletionCount)
      keys.set(row.record_key, {
        deletedAt: row.deleted_at,
        deletionCount: row.deletion_count,
      });
    into.set(table, keys);
  }
  return into;
}

/** Key tables cover task, session, decision, audit and memory history in both scopes. */
function storeHighWater(db: DatabaseSync): StoreTableHighWater[] {
  const out: StoreTableHighWater[] = [];
  for (const table of STORE_FRESHNESS_TABLES) {
    const columns = db
      .prepare(`PRAGMA main.table_info("${table}")`)
      .all()
      .map((c) => String(c.name));
    if (!columns.includes('id')) continue;
    const row = db
      .prepare(`SELECT count(*) AS n, CAST(max(_rowid_) AS TEXT) AS rowid,
      max(${storeRowTimestamp(columns)}) AS latest FROM main."${table}"`)
      .get();
    out.push({
      table,
      rows: Number(row?.n ?? 0),
      maxRowid: typeof row?.rowid === 'string' ? row.rowid : null,
      latestAt: typeof row?.latest === 'number' && row.latest > 0 ? row.latest : null,
    });
  }
  return out;
}

/** Missing keys and older versions are evidence even after a newer live session or audit write. */
export function compareStoreFreshness(
  live: DatabaseSync,
  source: DatabaseSync,
  path: string,
  kind: StoreFreshnessFinding['kind'],
  deleted: ReadonlyMap<string, ReadonlyMap<string, StoreDeletionEvidence>> = readStoreDeletedKeys(
    live,
  ),
  allowPartialStore = false,
): StoreFreshnessFinding | undefined {
  const before = storeHighWater(live);
  const after = storeHighWater(source);
  if (
    !allowPartialStore &&
    before.some((t) => t.table === 'tasks_tasks') !== after.some((t) => t.table === 'tasks_tasks')
  )
    return;
  const evidence: string[] = [];
  const liveDeletes = readStoreDeletedKeys(live);
  for (const [table, keys] of readStoreDeletedKeys(source)) {
    let missing = 0;
    const sample: string[] = [];
    for (const [key, receipt] of keys) {
      if ((liveDeletes.get(table)?.get(key)?.deletionCount ?? 0) >= receipt.deletionCount) continue;
      missing++;
      if (sample.length < 3) sample.push(key);
    }
    if (missing)
      evidence.push(
        `${table}: ${missing} committed deletion receipts absent or older in live (${sample.join('; ')})`,
      );
  }
  for (const next of after) {
    const old = before.find((t) => t.table === next.table);
    const stamp = (db: DatabaseSync): string =>
      storeRowTimestamp(
        db
          .prepare(`PRAGMA main.table_info("${next.table}")`)
          .all()
          .map((c) => String(c.name)),
      );
    const find = old
      ? live.prepare(`SELECT ${stamp(live)} AS stamp FROM main."${next.table}" WHERE id IS ?`)
      : undefined;
    find?.setReadBigInts(true);
    const rows = source.prepare(`SELECT id, ${stamp(source)} AS stamp FROM main."${next.table}"`);
    rows.setReadBigInts(true);
    let missing = 0,
      older = 0;
    const sample: string[] = [];
    for (const row of rows.iterate()) {
      if (deleted.get(next.table)?.has(String(row.id))) continue;
      const current = find?.get(row.id ?? null);
      if (!current) missing++;
      else if (Number(row.stamp) > Number(current.stamp)) older++;
      else continue;
      if (sample.length < 3)
        sample.push(
          `${String(row.id)}: ${current ? `live timestamp ${String(current.stamp)}, source ${String(row.stamp)}` : 'missing live key'}`,
        );
    }
    if (missing || older)
      evidence.push(
        `${next.table}: ${missing} missing keys, ${older} older versions (${sample.join('; ')}); live ${JSON.stringify(old ?? { rows: 0 })}; source ${JSON.stringify(next)}`,
      );
  }
  if (!evidence.length) return;
  let divergent = false;
  for (const table of before) {
    if (!after.some((t) => t.table === table.table)) {
      divergent ||= table.rows > 0;
      continue;
    }
    const lookup = source.prepare(`SELECT 1 FROM main."${table.table}" WHERE id IS ?`);
    lookup.setReadBigInts(true);
    const keys = live.prepare(`SELECT id FROM main."${table.table}"`);
    keys.setReadBigInts(true);
    for (const row of keys.iterate()) {
      if (deleted.get(table.table)?.has(String(row.id))) continue;
      if (!lookup.get(row.id ?? null)) {
        divergent = true;
        break;
      }
    }
    if (divergent) break;
  }
  return { source: path, kind, evidence, divergent };
}

/** Keep validation work bounded across the count, time-spread and byte-cap passes of one process. */
const snapshotChecks = new Map<string, boolean>();
const snapshotHashes = new Map<string, string>();

/** Read only SQLite headers and stat metadata, including a committed WAL when present. */
export function storeSnapshotIdentity(file: string): StoreSnapshotIdentity {
  const cache: string[] = [];
  const duplicate: string[] = [];
  for (const path of [file, `${file}-wal`]) {
    if (path !== file && (!existsSync(path) || statSync(path).size <= 32)) continue;
    const stat = statSync(path, { bigint: true });
    const fd = openSync(path, 'r');
    const header = Buffer.alloc(100);
    let length: number;
    try {
      length = readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    const image = `${stat.size}:${stat.mtimeNs}:${header.subarray(0, length).toString('hex')}`;
    duplicate.push(image);
    cache.push(`${path}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${image}`);
  }
  return { cacheKey: cache.join('|'), duplicateKey: duplicate.join('|') };
}

/** Open a recovery source without writing its schema or copying its contents. */
export function openStoreRecoverySnapshot(file: string): DatabaseSync {
  const db = openNativeDatabase(file, {
    readonly: true,
    enableWal: false,
    allowExtension: true,
    timeout: 1000,
  });
  try {
    if (
      db
        .prepare(
          "SELECT 1 FROM main.sqlite_schema WHERE type='table' AND sql LIKE '%vec0%' LIMIT 1",
        )
        .get()
    )
      loadSqliteVecExtension(db);
    db.enableLoadExtension(false);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Validate the entire source before its rows or delete receipts may establish recovery authority. */
export function validStoreRecoverySnapshot(db: DatabaseSync, file: string): boolean {
  const key = storeSnapshotIdentity(file).cacheKey;
  const cached = snapshotChecks.get(key);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    const checks = db.prepare('PRAGMA integrity_check').all();
    valid = statSync(file).size > 0 && checks.length === 1 && checks[0]?.integrity_check === 'ok';
  } catch {
    /* An unreadable snapshot is ineligible, including for retention pinning. */
  }
  if (snapshotChecks.size >= 64) {
    const first = snapshotChecks.keys().next().value;
    if (first !== undefined) snapshotChecks.delete(first);
  }
  snapshotChecks.set(key, valid);
  return valid;
}

/** Hash only a possible duplicate or a snapshot that might be excluded by explicit restore intent. */
export function storeSnapshotHash(file: string, withWal = true): string {
  const key = `${withWal ? 'view' : 'main'}:${storeSnapshotIdentity(file).cacheKey}`;
  const old = snapshotHashes.get(key);
  if (old !== undefined) return old;
  const wal = `${file}-wal`;
  const hash =
    repairFileHash(file) +
    (withWal && existsSync(wal) && statSync(wal).size > 32 ? `:${repairFileHash(wal)}` : '');
  if (snapshotHashes.size >= 64) {
    const first = snapshotHashes.keys().next().value;
    if (first !== undefined) snapshotHashes.delete(first);
  }
  snapshotHashes.set(key, hash);
  return hash;
}

/** Explicit rollback intent excludes only the exact retained bytes it names. */
export function storeSnapshotIgnored(target: string, snapshot: string): boolean {
  const intent = inspectStoreRestoreIntent(target);
  if (!intent?.ignoredSnapshots.some((f) => f.bytes === statSync(snapshot).size)) return false;
  const hash = storeSnapshotHash(snapshot, false);
  return intent.ignoredSnapshots.some((f) => f.sha256 === hash);
}

/** Read deletion evidence from every valid, non-rolled-back retained history. */
export function retainedStoreDeletedKeys(
  target: string,
  into: Map<string, Map<string, StoreDeletionEvidence>>,
  project: boolean,
): Map<string, Map<string, StoreDeletionEvidence>> {
  const hasTasks = (db: DatabaseSync): boolean =>
    db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='tasks_tasks'")
      .get() !== undefined;
  for (const candidate of collectStoreSnapshotCandidates(target)) {
    let db: DatabaseSync | undefined;
    try {
      if (storeSnapshotIgnored(target, candidate.path)) continue;
      db = openStoreRecoverySnapshot(candidate.path);
      if (
        hasTasks(db) !== project &&
        !(project && /^(brain|conduit)-/.test(basename(candidate.path)))
      )
        continue;
      if (validStoreRecoverySnapshot(db, candidate.path)) readStoreDeletedKeys(db, into);
    } catch {
      /* Unreadable backup bytes cannot prove a deliberate deletion. */
    } finally {
      db?.close();
    }
  }
  return into;
}

/** Protect only validated recovery rows, honoring durable deletes and explicit rollback intent. */
export function snapshotRecoveryReason(target: string, snapshot: string): string | undefined {
  let live: DatabaseSync | undefined;
  let source: DatabaseSync | undefined;
  try {
    try {
      source = openStoreRecoverySnapshot(snapshot);
      if (!validStoreRecoverySnapshot(source, snapshot)) return;
    } catch {
      return;
    }
    if (storeSnapshotIgnored(target, snapshot)) return;
    live = openStoreRecoverySnapshot(target);
    const deleted = retainedStoreDeletedKeys(
      target,
      readStoreDeletedKeys(live),
      live
        .prepare("SELECT 1 FROM main.sqlite_schema WHERE name='tasks_tasks' AND type='table'")
        .get() !== undefined,
    );
    const finding = compareStoreFreshness(
      live,
      source,
      snapshot,
      'snapshot',
      deleted,
      /^(brain|conduit)-/.test(basename(snapshot)),
    );
    return finding
      ? `Recovery rows absent or older in live store: ${finding.evidence.join('; ')}`
      : undefined;
  } catch (error) {
    return `Live recovery coverage unavailable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    source?.close();
    live?.close();
  }
}
