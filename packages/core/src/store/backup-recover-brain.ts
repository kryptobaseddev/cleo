/**
 * CLI-facing wrapper around {@link recoverMalformedBrainDb} (T10303).
 *
 * Exposes the recovery pipeline to the `cleo backup recover brain` verb
 * (T10304) with three additions that don't belong in the chokepoint module:
 *
 *  1. **Dry-run planning** — enumerates snapshot candidates, validates the
 *     freshest one via `PRAGMA quick_check`, and returns the envelope WITHOUT
 *     quarantining or copying anything. Operators use this to preview the
 *     freshness window before pulling the trigger.
 *  2. **Per-table row counts** — probes `brain_observations`, `brain_decisions`,
 *     `brain_learnings` post-restore so the runbook surfaces the recovered
 *     scope (NOT just observation count as the chokepoint helper does).
 *  3. **Snapshot pinning** — accepts `fromSnapshot` (absolute path or ISO
 *     prefix) so operators can roll back to a specific snapshot when the
 *     freshest is also poisoned.
 *
 * The pipeline itself is NEVER re-implemented here — every code path either
 * delegates to {@link recoverMalformedBrainDb} or to private helpers that
 * mirror its candidate-enumeration logic for the dry-run preview.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupRecoverBrainResult, BrainRecoveredRowCounts } from '@cleocode/contracts';
import { type RecoveryLogger, recoverMalformedBrainDb } from './recover-brain-db.js';
import { openNativeDatabase } from './sqlite-native.js';

// ---------------------------------------------------------------------------
// Canonical snapshot filename patterns — kept in sync with recover-brain-db.ts
// ---------------------------------------------------------------------------

/** System-backup snapshot filename (created via `cleo backup add`). */
const SNAPSHOT_FILENAME_RE = /^brain\.db\.snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

/** VACUUM INTO snapshot filename (created on session-end hooks). */
const VACUUM_FILENAME_RE = /^brain-(\d{8})-(\d{6})\.db$/;

/** Legacy pre-T9685 dup-fix backup pattern. */
const PRE_DUP_FIX_RE = /^brain\.db\.PRE-DUP-FIX-/;

/** Internal candidate record used for planning + pinning. */
interface SnapshotCandidate {
  /** Absolute path to the snapshot file. */
  path: string;
  /** Best-available timestamp for ordering (epoch ms). */
  timestampMs: number;
  /** Source taxonomy — for diagnostic logging only. */
  source: 'system-snapshot' | 'vacuum-snapshot' | 'pre-dup-fix';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link runBackupRecoverBrain}.
 */
export interface BackupRecoverBrainOptions {
  /**
   * Absolute path to the corrupt `brain.db`. Required even in `dryRun`
   * mode so the planner can compute the canonical quarantine target.
   */
  corruptPath: string;
  /** Absolute path to `.cleo/backups/snapshot/`. */
  snapshotDir: string;
  /** Absolute path to `.cleo/backups/sqlite/` (VACUUM INTO snapshots). */
  vacuumSnapshotDir?: string;
  /** Absolute path to `.cleo/` for legacy `brain.db.PRE-DUP-FIX-*` fallback. */
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
   * perform delta-merge because T10300 found schema-page corruption
   * makes it unreliable. The flag is plumbed end-to-end so the CLI surface
   * stays stable when delta-merge becomes opt-in.
   */
  noDelta?: boolean;
}

/**
 * Error thrown when the recovery pre-conditions cannot be satisfied.
 *
 * Distinct from runtime recovery failures (which are reported via the
 * envelope's `integrityOK: false` field) — these errors signal that the
 * CLI cannot even attempt recovery (no snapshots present at all,
 * `fromSnapshot` does not resolve, etc.).
 */
export class BackupRecoverBrainError extends Error {
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
    this.name = 'BackupRecoverBrainError';
    this.code = code;
    this.codeName = codeName;
    this.fix = fix;
  }
}

/**
 * Run the brain.db recovery pipeline as an operator-facing one-shot.
 *
 * In `dryRun` mode this returns the plan envelope (which snapshot would be
 * picked, where the corrupt DB would be quarantined) without mutating any
 * files on disk.
 *
 * In execute mode this delegates to {@link recoverMalformedBrainDb} for the
 * actual quarantine + copy + integrity-check pipeline, then probes the
 * restored DB for per-table row counts to enrich the envelope.
 *
 * @param opts - Recovery inputs (corrupt path, snapshot dirs, mode flags).
 * @returns The recovery envelope (plan or post-mutation).
 * @throws {BackupRecoverBrainError} When pre-conditions fail (no snapshots
 *         at all, `fromSnapshot` cannot be resolved, etc.).
 *
 * @example
 * ```typescript
 * import { runBackupRecoverBrain } from '@cleocode/core/store/backup-recover-brain';
 * import { getLogger } from '@cleocode/core/logger';
 *
 * const result = runBackupRecoverBrain({
 *   corruptPath: '/repo/.cleo/brain.db',
 *   snapshotDir: '/repo/.cleo/backups/snapshot',
 *   vacuumSnapshotDir: '/repo/.cleo/backups/sqlite',
 *   legacyArtifactDir: '/repo/.cleo',
 *   logger: getLogger('backup-recover-brain'),
 *   dryRun: true,
 * });
 * if (!result.integrityOK) {
 *   process.exitCode = 1;
 * }
 * ```
 */
export function runBackupRecoverBrain(opts: BackupRecoverBrainOptions): BackupRecoverBrainResult {
  if (!opts.corruptPath) {
    throw new BackupRecoverBrainError('corruptPath is required', 6, 'E_VALIDATION');
  }

  const candidates = collectSnapshotCandidates(opts);
  if (candidates.length === 0) {
    throw new BackupRecoverBrainError(
      `No snapshots found under ${opts.snapshotDir}` +
        (opts.vacuumSnapshotDir ? ` or ${opts.vacuumSnapshotDir}` : '') +
        (opts.legacyArtifactDir ? ` or ${opts.legacyArtifactDir}/brain.db.PRE-DUP-FIX-*` : ''),
      4,
      'E_NO_SNAPSHOT',
      'Run `cleo backup add` to create a snapshot before attempting recovery.',
    );
  }

  // Apply `--from-snapshot` filter when provided. The argument is either
  // an exact absolute path OR an ISO prefix matching the snapshot stamp.
  const filtered = opts.fromSnapshot
    ? candidates.filter((c) => snapshotMatchesPin(c, opts.fromSnapshot ?? ''))
    : candidates;

  if (opts.fromSnapshot && filtered.length === 0) {
    throw new BackupRecoverBrainError(
      `Snapshot pin "${opts.fromSnapshot}" matched zero candidates`,
      4,
      'E_NO_SNAPSHOT_MATCH',
      'List available snapshots with `ls .cleo/backups/snapshot/` (or `.cleo/backups/sqlite/`) and supply an exact path or ISO prefix.',
    );
  }

  // Probe candidates in freshness order to find the first that quick_checks.
  const chosen = pickFreshestValidSnapshot(filtered);
  if (!chosen) {
    throw new BackupRecoverBrainError(
      'No candidate snapshot passed PRAGMA quick_check',
      78,
      'E_NO_VALID_SNAPSHOT',
      'Every available snapshot is itself corrupt. Restore from an external backup or use `cleo backup import`.',
    );
  }

  const quarantineRoot = opts.quarantineRoot ?? join(dirname(opts.corruptPath), 'quarantine');

  if (opts.dryRun === true) {
    // Plan envelope — count rows in the chosen snapshot WITHOUT touching disk.
    const rowsRecovered = probeRowCounts(chosen.path);
    return {
      restoredFrom: chosen.path,
      rowsRecovered,
      dataLossWindowHours: computeDataLossWindowHours(chosen.timestampMs),
      integrityOK: true,
      quarantinedTo: '',
      dryRun: true,
    };
  }

  // Execute mode — delegate to the canonical pipeline. The chokepoint
  // helper enumerates candidates internally, so we let it pick the same
  // snapshot it would pick at open time (the candidate ranking is
  // deterministic). When the operator pinned a snapshot via `fromSnapshot`,
  // we pre-pre-copy the pinned snapshot path to the canonical home so the
  // chokepoint's freshness-first selection still wins.
  if (opts.fromSnapshot) {
    // Pinning path — quarantine the corrupt DB ourselves, then copy the
    // pinned snapshot in place. We deliberately avoid re-implementing
    // recoverMalformedBrainDb's logic by keeping the operations symmetric:
    // quarantine → copy → verify (same three steps the chokepoint runs).
    return runPinnedRestore({
      corruptPath: opts.corruptPath,
      quarantineRoot,
      chosen,
      logger: opts.logger,
    });
  }

  // Unpinned path — delegate to the chokepoint helper directly.
  const result = recoverMalformedBrainDb({
    corruptPath: opts.corruptPath,
    snapshotDir: opts.snapshotDir,
    vacuumSnapshotDir: opts.vacuumSnapshotDir,
    legacyArtifactDir: opts.legacyArtifactDir,
    quarantineRoot,
    logger: opts.logger,
  });

  if (!result.integrityOK || !result.restoredFrom) {
    throw new BackupRecoverBrainError(
      'Recovery pipeline completed but restored DB failed integrity check',
      78,
      'E_RECOVERY_FAILED',
      'Inspect the quarantine directory and try `--from-snapshot <iso>` with an older snapshot.',
    );
  }

  const rowsRecovered = probeRowCounts(opts.corruptPath);
  return {
    restoredFrom: result.restoredFrom,
    rowsRecovered,
    dataLossWindowHours: result.dataLossWindowHours,
    integrityOK: result.integrityOK,
    quarantinedTo: result.quarantineDir ?? '',
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Pinned-restore implementation — mirrors recoverMalformedBrainDb's I/O steps
// ---------------------------------------------------------------------------

/**
 * Execute a pinned restore: quarantine the corrupt DB, copy the pinned
 * snapshot, verify integrity.
 *
 * Kept symmetric with {@link recoverMalformedBrainDb}'s pipeline so the two
 * paths produce indistinguishable on-disk results.
 *
 * @internal
 */
function runPinnedRestore(args: {
  corruptPath: string;
  quarantineRoot: string;
  chosen: SnapshotCandidate;
  logger: RecoveryLogger;
}): BackupRecoverBrainResult {
  let quarantineDir = '';
  try {
    if (existsSync(args.corruptPath)) {
      quarantineDir = quarantineCorruptDb(args.corruptPath, args.quarantineRoot);
    }
  } catch (err) {
    args.logger.error(
      { err, corruptPath: args.corruptPath, quarantineRoot: args.quarantineRoot },
      'BRAIN pinned recovery aborted: could not quarantine corrupt DB',
    );
    throw new BackupRecoverBrainError(
      `Could not quarantine corrupt DB: ${err instanceof Error ? err.message : String(err)}`,
      1,
      'E_QUARANTINE_FAILED',
    );
  }

  try {
    copyFileSync(args.chosen.path, args.corruptPath);
  } catch (err) {
    args.logger.error(
      { err, snapshotPath: args.chosen.path, dest: args.corruptPath },
      'BRAIN pinned recovery failed: copy from snapshot to live path threw',
    );
    throw new BackupRecoverBrainError(
      `Could not copy snapshot to live path: ${err instanceof Error ? err.message : String(err)}`,
      1,
      'E_COPY_FAILED',
    );
  }

  // Final verification — probe via the same quick_check helper.
  if (!probeQuickCheck(args.corruptPath)) {
    throw new BackupRecoverBrainError(
      'Pinned snapshot restored but final quick_check failed',
      78,
      'E_RECOVERY_FAILED',
    );
  }

  const rowsRecovered = probeRowCounts(args.corruptPath);
  const dataLossWindowHours = computeDataLossWindowHours(args.chosen.timestampMs);

  args.logger.warn(
    {
      event: 'brain.pinned-recovery',
      restoredFrom: args.chosen.path,
      source: args.chosen.source,
      dataLossWindowHours,
      quarantineDir,
    },
    `BRAIN pinned recovery completed from ${args.chosen.path} (T10304)`,
  );

  return {
    restoredFrom: args.chosen.path,
    rowsRecovered,
    dataLossWindowHours,
    integrityOK: true,
    quarantinedTo: quarantineDir,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Snapshot candidate enumeration — kept in sync with recover-brain-db.ts
// ---------------------------------------------------------------------------

/**
 * Enumerate snapshot candidates and return them newest-first.
 *
 * Mirrors {@link recoverMalformedBrainDb}'s candidate-collection logic but
 * lives separately so dry-run planning does not need to invoke the full
 * pipeline. Any changes to the freshness-ranking algorithm MUST be applied
 * to both files in the same PR.
 *
 * @internal
 */
function collectSnapshotCandidates(opts: BackupRecoverBrainOptions): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [];

  if (existsSync(opts.snapshotDir)) {
    try {
      for (const name of readdirSync(opts.snapshotDir)) {
        const m = SNAPSHOT_FILENAME_RE.exec(name);
        const stamp = m?.[1];
        if (!stamp) continue;
        out.push({
          path: join(opts.snapshotDir, name),
          timestampMs: parseSystemSnapshotTimestamp(stamp),
          source: 'system-snapshot',
        });
      }
    } catch {
      // unreadable directory — fall through to other sources
    }
  }

  if (opts.vacuumSnapshotDir && existsSync(opts.vacuumSnapshotDir)) {
    try {
      for (const name of readdirSync(opts.vacuumSnapshotDir)) {
        const m = VACUUM_FILENAME_RE.exec(name);
        const datePart = m?.[1];
        const timePart = m?.[2];
        if (!datePart || !timePart) continue;
        out.push({
          path: join(opts.vacuumSnapshotDir, name),
          timestampMs: parseVacuumSnapshotTimestamp(datePart, timePart),
          source: 'vacuum-snapshot',
        });
      }
    } catch {
      // non-fatal
    }
  }

  if (opts.legacyArtifactDir && existsSync(opts.legacyArtifactDir)) {
    try {
      for (const name of readdirSync(opts.legacyArtifactDir)) {
        if (!PRE_DUP_FIX_RE.test(name)) continue;
        const fullPath = join(opts.legacyArtifactDir, name);
        let ts = 0;
        try {
          ts = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        out.push({ path: fullPath, timestampMs: ts, source: 'pre-dup-fix' });
      }
    } catch {
      // non-fatal
    }
  }

  const rank: Record<SnapshotCandidate['source'], number> = {
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
 * Pick the first candidate (newest-first) whose `PRAGMA quick_check` returns
 * `ok`. Returns `null` when no candidate passes.
 *
 * @internal
 */
function pickFreshestValidSnapshot(candidates: SnapshotCandidate[]): SnapshotCandidate | null {
  for (const candidate of candidates) {
    if (probeQuickCheck(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Determine whether a candidate matches the operator's `--from-snapshot`
 * pin. Accepts both an exact absolute path and an ISO timestamp prefix.
 *
 * @internal
 */
function snapshotMatchesPin(candidate: SnapshotCandidate, pin: string): boolean {
  if (!pin) return false;
  if (candidate.path === pin) return true;
  // ISO prefix match against the basename's timestamp portion.
  const name = basename(candidate.path);
  const systemMatch = SNAPSHOT_FILENAME_RE.exec(name);
  if (systemMatch?.[1]) {
    // Convert dashed ISO back to canonical form for prefix matching:
    // `2026-05-23T08-00-55-563Z` → `2026-05-23T08:00:55.563Z`.
    const iso = systemMatch[1].replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
    if (iso.startsWith(pin)) return true;
    if (systemMatch[1].startsWith(pin)) return true;
  }
  const vacuumMatch = VACUUM_FILENAME_RE.exec(name);
  if (vacuumMatch?.[1]?.startsWith(pin)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// I/O helpers — kept symmetric with recover-brain-db.ts
// ---------------------------------------------------------------------------

/**
 * Parse a system-snapshot ISO-with-dashes timestamp into epoch ms.
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

/**
 * Probe a candidate file with `PRAGMA quick_check`.
 *
 * @internal
 */
function probeQuickCheck(path: string): boolean {
  let handle: DatabaseSync | null = null;
  try {
    handle = openNativeDatabase(path, { readonly: true, enableWal: false });
    const quick = handle.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    return (quick?.quick_check ?? '') === 'ok';
  } catch {
    return false;
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch {
        // non-fatal
      }
    }
  }
}

/**
 * Probe a DB for per-table row counts. Each count is best-effort — a missing
 * table or count failure surfaces as `null` instead of throwing so the
 * envelope always serializes cleanly.
 *
 * @internal
 */
function probeRowCounts(path: string): BrainRecoveredRowCounts {
  const result: BrainRecoveredRowCounts = {
    observations: null,
    decisions: null,
    learnings: null,
  };

  let handle: DatabaseSync | null = null;
  try {
    handle = openNativeDatabase(path, { readonly: true, enableWal: false });
    for (const [table, key] of [
      ['brain_observations', 'observations'],
      ['brain_decisions', 'decisions'],
      ['brain_learnings', 'learnings'],
    ] as const) {
      try {
        const row = handle.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as
          | { cnt?: number }
          | undefined;
        if (typeof row?.cnt === 'number') {
          result[key] = row.cnt;
        }
      } catch {
        // table missing in this snapshot rev — leave the value null
      }
    }
  } catch {
    // unopenable — leave all counts null
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch {
        // non-fatal
      }
    }
  }

  return result;
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
 * Format an epoch-ms timestamp into the canonical quarantine directory
 * name suffix — ISO-8601 with filesystem-safe `-` separators.
 *
 * @internal
 */
function formatQuarantineSuffix(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-');
}

/**
 * Move the corrupt DB plus `-wal`/`-shm` sidecars into a quarantine directory.
 *
 * Mirrors {@link recoverMalformedBrainDb}'s internal helper of the same name
 * so the pinned-restore path produces identical on-disk results.
 *
 * @internal
 */
function quarantineCorruptDb(corruptPath: string, quarantineRoot: string): string {
  const quarantineDir = join(
    quarantineRoot,
    `brain-malformed-${formatQuarantineSuffix(Date.now())}`,
  );
  mkdirSync(quarantineDir, { recursive: true });

  const dest = join(quarantineDir, 'brain.db.malformed');
  renameSync(corruptPath, dest);

  for (const suffix of ['-wal', '-shm']) {
    const sidecarSrc = corruptPath + suffix;
    if (existsSync(sidecarSrc)) {
      const sidecarDest = join(quarantineDir, basename(corruptPath) + '.malformed' + suffix);
      try {
        renameSync(sidecarSrc, sidecarDest);
      } catch {
        // Sidecar move failure is non-fatal
      }
    }
  }

  return quarantineDir;
}
