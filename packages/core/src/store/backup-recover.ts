/**
 * CLI-facing wrapper around the generic {@link recoverMalformedDb} pipeline
 * (T10318 SG-BRAIN-DB-RESILIENCE E3-BACKUP-RECOVERY).
 *
 * Exposes the recovery pipeline to the `cleo backup recover <role>` verb
 * with three additions that don't belong in the chokepoint module:
 *
 *  1. **Dry-run planning** — enumerates snapshot candidates, validates the
 *     freshest one via `PRAGMA quick_check`, and returns the envelope WITHOUT
 *     quarantining or copying anything. Operators use this to preview the
 *     freshness window before pulling the trigger.
 *  2. **Per-table row counts** — probes user tables post-restore via
 *     `sqlite_master` enumeration so the runbook surfaces the recovered
 *     scope for any role (not just brain's three tables).
 *  3. **Snapshot pinning** — accepts `fromSnapshot` (absolute path or ISO
 *     prefix) so operators can roll back to a specific snapshot when the
 *     freshest is also poisoned.
 *
 * The pipeline itself is NEVER re-implemented here — every code path
 * delegates to {@link recoverMalformedDb} or to the shared candidate-
 * enumeration / probe helpers re-exported from
 * {@link ./recover-malformed-db.js}.
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 */

import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackupRecoverResult, DbRole } from '@cleocode/contracts';
import {
  collectSnapshotCandidatesForRole,
  probeSnapshot,
  quarantineCorruptDb,
  type RecoveryLogger,
  recoverMalformedDb,
  resolveRoleBackupDirs,
  resolveRoleDbPath,
} from './recover-malformed-db.js';

// ---------------------------------------------------------------------------
// Internal snapshot candidate shape (mirrors recover-malformed-db.ts)
// ---------------------------------------------------------------------------

/**
 * Snapshot candidate emitted by {@link collectSnapshotCandidatesForRole}.
 *
 * @internal
 */
interface SnapshotCandidate {
  path: string;
  timestampMs: number;
  source: 'system-snapshot' | 'vacuum-snapshot' | 'pre-dup-fix';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link runBackupRecover}.
 *
 * @task T10318
 * @public
 */
export interface BackupRecoverOptions {
  /** Canonical role to recover. Must exist in `DB_INVENTORY`. */
  role: DbRole;
  /**
   * Absolute path to the corrupt DB file. When omitted, derived from the
   * inventory entry with `<projectRoot>` substitution.
   */
  corruptPath?: string;
  /**
   * Absolute path to the project root. Used to resolve inventory templates
   * for `project`-tier roles. Required when `corruptPath` is not supplied
   * for a project-tier role.
   */
  projectRoot?: string;
  /** Absolute path to `.cleo/backups/snapshot/` — overrides inventory-derived default. */
  snapshotDir?: string;
  /** Absolute path to `.cleo/backups/sqlite/` (VACUUM INTO snapshots) — overrides default. */
  vacuumSnapshotDir?: string;
  /** Absolute path to `.cleo/` for legacy `<role>.db.PRE-DUP-FIX-*` fallback — overrides default. */
  legacyArtifactDir?: string;
  /**
   * Absolute path to the quarantine root. Defaults to
   * `<dirname(corruptPath)>/quarantine` to match the chokepoint helper.
   */
  quarantineRoot?: string;
  /** Pino-shaped logger for the recovery announcement. */
  logger: RecoveryLogger;
  /**
   * When `true`, enumerate candidates + validate the freshest one and
   * return the planned envelope WITHOUT quarantining or copying.
   */
  dryRun?: boolean;
  /**
   * Optional snapshot pin — either an absolute path to a specific
   * snapshot file OR an ISO timestamp prefix (e.g. `2026-05-23`) that
   * resolves to the freshest validated snapshot whose timestamp begins
   * with that prefix. When unset, the freshest validated candidate wins.
   */
  fromSnapshot?: string;
  /**
   * When `true`, skip the future `sqlite3 .recover` delta-merge step.
   * Reserved for future extension — the current pipeline does not
   * perform delta-merge.
   */
  noDelta?: boolean;
}

/**
 * Error thrown when the recovery pre-conditions cannot be satisfied.
 *
 * @remarks
 * Distinct from runtime recovery failures (which are reported via the
 * envelope's `integrityOK: false` field) — these errors signal that the
 * CLI cannot even attempt recovery (no snapshots present at all,
 * `fromSnapshot` does not resolve, etc.).
 *
 * @task T10318
 * @public
 */
export class BackupRecoverError extends Error {
  /** Stable numeric exit code. */
  readonly code: number;
  /** Stable string error code for envelope `codeName`. */
  readonly codeName: string;
  /** Optional remediation hint surfaced to the operator. */
  readonly fix?: string;

  /**
   * @param message  - Human-readable error message.
   * @param code     - Numeric exit code for the CLI surface.
   * @param codeName - Stable error code (e.g. `'E_NO_SNAPSHOT'`).
   * @param fix      - Optional remediation hint.
   */
  constructor(message: string, code: number, codeName: string, fix?: string) {
    super(message);
    this.name = 'BackupRecoverError';
    this.code = code;
    this.codeName = codeName;
    this.fix = fix;
  }
}

/**
 * Resolve the per-role filesystem layout, merging CLI overrides with
 * inventory-derived defaults.
 *
 * @internal
 */
function resolveLayout(opts: BackupRecoverOptions): {
  corruptPath: string;
  snapshotDir: string;
  vacuumSnapshotDir: string;
  legacyArtifactDir: string;
  quarantineRoot: string;
} {
  const inventoryDirs = resolveRoleBackupDirs(opts.role, { projectRoot: opts.projectRoot });
  const corruptPath =
    opts.corruptPath ?? resolveRoleDbPath(opts.role, { projectRoot: opts.projectRoot });
  return {
    corruptPath,
    snapshotDir: opts.snapshotDir ?? inventoryDirs.snapshotDir,
    vacuumSnapshotDir: opts.vacuumSnapshotDir ?? inventoryDirs.vacuumSnapshotDir,
    legacyArtifactDir:
      opts.legacyArtifactDir !== undefined
        ? opts.legacyArtifactDir
        : inventoryDirs.legacyArtifactDir,
    quarantineRoot: opts.quarantineRoot ?? join(dirname(corruptPath), 'quarantine'),
  };
}

/**
 * Determine whether a candidate matches the operator's `--from-snapshot` pin.
 *
 * Accepts both an exact absolute path and an ISO timestamp prefix. The ISO
 * prefix is matched against the canonical (colon/dot) form so operators can
 * paste timestamps from logs without having to re-encode the filename's
 * dash-separated form.
 *
 * @internal
 */
function snapshotMatchesPin(role: DbRole, candidate: SnapshotCandidate, pin: string): boolean {
  if (!pin) return false;
  if (candidate.path === pin) return true;
  const name = basename(candidate.path);
  // System snapshot: `<role>.db.snapshot-2026-05-23T08-00-55-563Z`.
  const systemPrefix = `${role}.db.snapshot-`;
  if (name.startsWith(systemPrefix)) {
    const stamp = name.slice(systemPrefix.length);
    if (stamp.startsWith(pin)) return true;
    const iso = stamp.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
    if (iso.startsWith(pin)) return true;
  }
  // Vacuum snapshot: `<role>-20260523-130026.db`.
  const vacuumPrefix = `${role}-`;
  if (name.startsWith(vacuumPrefix) && name.endsWith('.db')) {
    const tail = name.slice(vacuumPrefix.length, -3); // strip ".db"
    if (tail.startsWith(pin)) return true;
  }
  return false;
}

/**
 * Pick the first candidate (newest-first) whose `PRAGMA quick_check` returns
 * `ok`. Returns `null` when no candidate passes.
 *
 * @internal
 */
function pickFreshestValidSnapshot(candidates: SnapshotCandidate[]): SnapshotCandidate | null {
  for (const candidate of candidates) {
    if (probeSnapshot(candidate.path).ok) {
      return candidate;
    }
  }
  return null;
}

/**
 * Compute the data-loss window in hours from a snapshot's epoch-ms
 * timestamp. Returns `null` when the timestamp could not be parsed.
 *
 * @internal
 */
function computeDataLossWindowHours(timestampMs: number): number | null {
  if (!timestampMs || timestampMs <= 0) return null;
  const deltaMs = Date.now() - timestampMs;
  return Math.max(0, Math.round((deltaMs / 3_600_000) * 10) / 10);
}

/**
 * Run the database recovery pipeline as an operator-facing one-shot.
 *
 * @remarks
 * In `dryRun` mode this returns the plan envelope (which snapshot would be
 * picked, where the corrupt DB would be quarantined) without mutating any
 * files on disk.
 *
 * In execute mode this delegates to {@link recoverMalformedDb} for the
 * actual quarantine + copy + integrity-check pipeline, then probes the
 * restored DB for per-table row counts to enrich the envelope.
 *
 * @param opts - Recovery inputs (role, corrupt path, snapshot dirs, mode flags).
 * @returns The recovery envelope (plan or post-mutation).
 * @throws {BackupRecoverError} When pre-conditions fail (no snapshots
 *         at all, `fromSnapshot` cannot be resolved, etc.).
 *
 * @example
 * ```typescript
 * import { runBackupRecover } from '@cleocode/core/store/backup-recover';
 * import { getLogger } from '@cleocode/core/logger';
 *
 * const result = runBackupRecover({
 *   role: 'brain',
 *   projectRoot: '/repo',
 *   logger: getLogger('backup-recover'),
 *   dryRun: true,
 * });
 * if (!result.integrityOK) {
 *   process.exitCode = 1;
 * }
 * ```
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 * @public
 */
export function runBackupRecover(opts: BackupRecoverOptions): BackupRecoverResult {
  const layout = resolveLayout(opts);

  const candidates = collectSnapshotCandidatesForRole({
    role: opts.role,
    snapshotDir: layout.snapshotDir,
    vacuumSnapshotDir: layout.vacuumSnapshotDir,
    legacyArtifactDir: layout.legacyArtifactDir.length > 0 ? layout.legacyArtifactDir : undefined,
  });
  if (candidates.length === 0) {
    throw new BackupRecoverError(
      `No snapshots found for role "${opts.role}" under ${layout.snapshotDir}` +
        ` or ${layout.vacuumSnapshotDir}` +
        (layout.legacyArtifactDir.length > 0
          ? ` or ${layout.legacyArtifactDir}/${opts.role}.db.PRE-DUP-FIX-*`
          : ''),
      4,
      'E_NO_SNAPSHOT',
      `Run \`cleo backup add\` to create a snapshot for role "${opts.role}" before attempting recovery.`,
    );
  }

  // Apply `--from-snapshot` filter when provided.
  const filtered = opts.fromSnapshot
    ? candidates.filter((c) => snapshotMatchesPin(opts.role, c, opts.fromSnapshot ?? ''))
    : candidates;

  if (opts.fromSnapshot && filtered.length === 0) {
    throw new BackupRecoverError(
      `Snapshot pin "${opts.fromSnapshot}" matched zero candidates for role "${opts.role}"`,
      4,
      'E_NO_SNAPSHOT_MATCH',
      'List available snapshots with `ls .cleo/backups/snapshot/` (or `.cleo/backups/sqlite/`) and supply an exact path or ISO prefix.',
    );
  }

  const chosen = pickFreshestValidSnapshot(filtered);
  if (!chosen) {
    throw new BackupRecoverError(
      `No candidate snapshot for role "${opts.role}" passed PRAGMA quick_check`,
      78,
      'E_NO_VALID_SNAPSHOT',
      'Every available snapshot is itself corrupt. Restore from an external backup or use `cleo backup import`.',
    );
  }

  if (opts.dryRun === true) {
    // Plan envelope — count rows in the chosen snapshot WITHOUT touching disk.
    const probe = probeSnapshot(chosen.path);
    return {
      role: opts.role,
      restoredFrom: chosen.path,
      rowsRecovered: probe.rowCounts,
      dataLossWindowHours: computeDataLossWindowHours(chosen.timestampMs),
      integrityOK: probe.ok,
      quarantinedTo: '',
      dryRun: true,
    };
  }

  // Execute mode.
  if (opts.fromSnapshot) {
    // Pinning path — quarantine the corrupt DB ourselves, then copy the
    // pinned snapshot in place. We deliberately avoid re-implementing
    // recoverMalformedDb's logic by keeping the operations symmetric:
    // quarantine → copy → verify (same three steps the chokepoint runs).
    return runPinnedRestore({
      role: opts.role,
      corruptPath: layout.corruptPath,
      quarantineRoot: layout.quarantineRoot,
      chosen,
      logger: opts.logger,
    });
  }

  // Unpinned path — delegate to the chokepoint helper directly.
  const result = recoverMalformedDb({
    role: opts.role,
    corruptPath: layout.corruptPath,
    snapshotDir: layout.snapshotDir,
    vacuumSnapshotDir: layout.vacuumSnapshotDir,
    legacyArtifactDir: layout.legacyArtifactDir,
    quarantineRoot: layout.quarantineRoot,
    projectRoot: opts.projectRoot,
    logger: opts.logger,
  });

  if (!result.integrityOK || !result.restoredFrom) {
    throw new BackupRecoverError(
      `Recovery pipeline completed but restored "${opts.role}" DB failed integrity check`,
      78,
      'E_RECOVERY_FAILED',
      'Inspect the quarantine directory and try `--from-snapshot <iso>` with an older snapshot.',
    );
  }

  return {
    role: opts.role,
    restoredFrom: result.restoredFrom,
    rowsRecovered: result.rowCounts,
    dataLossWindowHours: result.dataLossWindowHours,
    integrityOK: result.integrityOK,
    quarantinedTo: result.quarantineDir ?? '',
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Pinned-restore implementation — mirrors recoverMalformedDb's I/O steps
// ---------------------------------------------------------------------------

/**
 * Execute a pinned restore: quarantine the corrupt DB, copy the pinned
 * snapshot, verify integrity.
 *
 * Kept symmetric with {@link recoverMalformedDb}'s pipeline so the two
 * paths produce indistinguishable on-disk results.
 *
 * @internal
 */
function runPinnedRestore(args: {
  role: DbRole;
  corruptPath: string;
  quarantineRoot: string;
  chosen: SnapshotCandidate;
  logger: RecoveryLogger;
}): BackupRecoverResult {
  let quarantineDir = '';
  try {
    if (existsSync(args.corruptPath)) {
      quarantineDir = quarantineCorruptDb(args.role, args.corruptPath, args.quarantineRoot);
    }
  } catch (err) {
    args.logger.error(
      {
        err,
        role: args.role,
        corruptPath: args.corruptPath,
        quarantineRoot: args.quarantineRoot,
      },
      'CLEO DB pinned recovery aborted: could not quarantine corrupt DB',
    );
    throw new BackupRecoverError(
      `Could not quarantine corrupt DB for role "${args.role}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      1,
      'E_QUARANTINE_FAILED',
    );
  }

  try {
    copyFileSync(args.chosen.path, args.corruptPath);
  } catch (err) {
    args.logger.error(
      {
        err,
        role: args.role,
        snapshotPath: args.chosen.path,
        dest: args.corruptPath,
      },
      'CLEO DB pinned recovery failed: copy from snapshot to live path threw',
    );
    throw new BackupRecoverError(
      `Could not copy snapshot to live path for role "${args.role}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      1,
      'E_COPY_FAILED',
    );
  }

  // Final verification — probe via the shared helper.
  const finalProbe = probeSnapshot(args.corruptPath);
  if (!finalProbe.ok) {
    throw new BackupRecoverError(
      `Pinned snapshot restored but final quick_check failed for role "${args.role}"`,
      78,
      'E_RECOVERY_FAILED',
    );
  }

  const dataLossWindowHours = computeDataLossWindowHours(args.chosen.timestampMs);

  args.logger.warn(
    {
      event: 'cleo-db.pinned-recovery',
      role: args.role,
      restoredFrom: args.chosen.path,
      source: args.chosen.source,
      dataLossWindowHours,
      quarantineDir,
    },
    `CLEO DB "${args.role}" pinned recovery completed from ${args.chosen.path} (T10318)`,
  );

  return {
    role: args.role,
    restoredFrom: args.chosen.path,
    rowsRecovered: finalProbe.rowCounts,
    dataLossWindowHours,
    integrityOK: true,
    quarantinedTo: quarantineDir,
    dryRun: false,
  };
}
