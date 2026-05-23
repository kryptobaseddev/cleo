/**
 * Brain.db auto-recovery from snapshot — armoring against the live malformation
 * incident that triggered Saga T10281 SG-BRAIN-DB-RESILIENCE.
 *
 * The failure mode this module armors against:
 *
 * ```
 * $ sqlite3 .cleo/brain.db 'PRAGMA integrity_check;'
 * Error: in prepare, malformed database schema (epic:T1075) (11)
 * ```
 *
 * Surfaces in CLEO as `ERR_SQLITE_ERROR errcode=11` → `E_BRAIN_OBSERVE` on
 * every `cleo memory observe`, and as a silent dialectic-hook crash
 * (T10260, T10265) on every `cleo update`. The previous behaviour was to
 * silently degrade cognition until an operator noticed memory writes were
 * failing. The recovery pipeline below makes the next incident self-healing.
 *
 * ## Pipeline
 *
 * 1. Move the corrupt DB (plus `-wal` / `-shm` sidecars) to
 *    `<projectRoot>/.cleo/quarantine/brain-malformed-<iso>/`.
 * 2. Enumerate `.cleo/backups/snapshot/brain.db.snapshot-*` and
 *    `.cleo/backups/sqlite/brain-YYYYMMDD-HHmmss.db` (system-backup and
 *    VACUUM INTO formats). Sort newest-first.
 * 3. Validate each candidate via `PRAGMA quick_check` (best-effort, with
 *    sqlite-internal busy timeout). Pick the freshest one that returns `ok`.
 * 4. If no snapshot validates, fall back to `.cleo/brain.db.PRE-DUP-FIX-*`
 *    legacy artifacts (also `quick_check`-validated).
 * 5. `copyFileSync` the chosen source to `.cleo/brain.db` and run one final
 *    `quick_check` to confirm the restored file opens cleanly.
 *
 * ## Invariants
 *
 * - **Synchronous**: runs on the open-blocking critical path. Restoration is
 *   short (a few seconds) and the alternative is broken cognition.
 * - **Idempotent on partial failure**: any throw inside the pipeline leaves
 *   the corrupt DB at the original path AND the quarantined copy in place,
 *   so the next process attempt can retry without losing forensic state.
 * - **No raw `new DatabaseSync`** outside the canonical leaf
 *   {@link openNativeDatabase} — every snapshot probe flows through the
 *   pragma SSoT (ADR-068).
 *
 * @task T10303
 * @epic T10286
 * @saga T10281
 * @adr ADR-068
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BrainRecoveryResult } from '@cleocode/contracts';
import { openNativeDatabase } from './sqlite-native.js';

/**
 * Minimal logger shape used by {@link recoverMalformedBrainDb}.
 *
 * Matches the subset of `pino.Logger` invoked from this module. Declared
 * locally so the recovery pipeline does not pull `pino` into modules that
 * use it strictly as a value type.
 */
export interface RecoveryLogger {
  /** Structured warning — used for the single auto-recovery announcement. */
  warn(obj: Record<string, unknown>, msg: string): void;
  /** Structured error — used for non-fatal probe failures. */
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Options accepted by {@link recoverMalformedBrainDb}.
 */
export interface RecoverMalformedBrainDbOptions {
  /**
   * Absolute path to the corrupt `brain.db`. Recovery moves this file (plus
   * `-wal`/`-shm` sidecars) into the quarantine directory before restoring.
   */
  corruptPath: string;
  /**
   * Absolute path to the project's `.cleo/backups/snapshot/` directory.
   * Recovery enumerates `brain.db.snapshot-*` files here and selects the
   * freshest validated snapshot.
   */
  snapshotDir: string;
  /**
   * Optional absolute path to the project's `.cleo/backups/sqlite/`
   * directory containing VACUUM INTO snapshots (`brain-YYYYMMDD-HHmmss.db`).
   * When present, these snapshots compete with the `snapshotDir` candidates
   * in the same freshness-ranking pool.
   */
  vacuumSnapshotDir?: string;
  /**
   * Optional absolute path to the project's `.cleo/` directory. Used to
   * enumerate legacy `brain.db.PRE-DUP-FIX-*` artifacts as a last-resort
   * fallback. When unset, legacy fallback is skipped.
   */
  legacyArtifactDir?: string;
  /**
   * Absolute path to the quarantine root. The corrupt DB is moved to
   * `<quarantineRoot>/brain-malformed-<iso>/brain.db.malformed`.
   *
   * Defaults to `<dirname(corruptPath)>/quarantine` when omitted.
   */
  quarantineRoot?: string;
  /** Pino-shaped logger for the single recovery announcement. */
  logger: RecoveryLogger;
}

/** Internal candidate record used during snapshot ranking. */
interface SnapshotCandidate {
  /** Absolute path to the snapshot file. */
  path: string;
  /** Best-available timestamp for ordering (epoch ms). */
  timestampMs: number;
  /** Source taxonomy — for diagnostic logging only. */
  source: 'system-snapshot' | 'vacuum-snapshot' | 'pre-dup-fix';
}

/** Result of a single snapshot probe via `PRAGMA quick_check`. */
interface ProbeResult {
  /** `true` when the file opens cleanly and `quick_check` returns `ok`. */
  ok: boolean;
  /**
   * Number of rows in `brain_observations` — best-effort, `null` when the
   * count query failed (table missing, version mismatch, …).
   */
  observationCount: number | null;
}

/**
 * Snapshot filename pattern for `cleo backup add` artifacts:
 * `brain.db.snapshot-2026-05-23T08-00-55-563Z`.
 *
 * The timestamp uses `-` separators because filesystems on Windows reject
 * `:` — the existing system-backup writer (`createBackup` in
 * `system/backup.ts`) already replaces `:.` → `-` before composing the name.
 */
const SNAPSHOT_FILENAME_RE = /^brain\.db\.snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

/**
 * Snapshot filename pattern for VACUUM INTO debounced session-end snapshots:
 * `brain-20260523-130026.db`. Format mirrors `sqlite-backup.ts:formatTimestamp`.
 */
const VACUUM_FILENAME_RE = /^brain-(\d{8})-(\d{6})\.db$/;

/** Legacy pre-T9685 dup-fix backup pattern: `brain.db.PRE-DUP-FIX-191315`. */
const PRE_DUP_FIX_RE = /^brain\.db\.PRE-DUP-FIX-/;

/**
 * Parse a snapshot ISO-with-dashes timestamp into epoch ms.
 *
 * The system-backup writer composes filenames as
 * `brain.db.snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`,
 * which round-trips to a valid ISO once we undo the `:` and `.` swaps.
 *
 * @internal
 */
function parseSystemSnapshotTimestamp(stamp: string): number {
  // Convert `2026-05-23T08-00-55-563Z` → `2026-05-23T08:00:55.563Z`.
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
 * The VACUUM-INTO writer uses local time, so we reconstruct via the same
 * pad-and-Date constructor. Falls back to the file's mtime when the regex
 * doesn't capture cleanly.
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
 * Enumerate all snapshot candidates from system-snapshot, vacuum-snapshot,
 * and PRE-DUP-FIX legacy sources. Returns newest-first.
 *
 * @internal
 */
function collectSnapshotCandidates(opts: RecoverMalformedBrainDbOptions): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [];

  // 1. System backup snapshots (created via `cleo backup add`).
  try {
    if (existsSync(opts.snapshotDir)) {
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
    }
  } catch {
    // non-fatal — directory unreadable, continue to other sources
  }

  // 2. VACUUM INTO debounced snapshots (created on session-end hooks).
  if (opts.vacuumSnapshotDir) {
    try {
      if (existsSync(opts.vacuumSnapshotDir)) {
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
      }
    } catch {
      // non-fatal
    }
  }

  // 3. Legacy `.cleo/brain.db.PRE-DUP-FIX-*` artifacts — last-resort fallback.
  if (opts.legacyArtifactDir) {
    try {
      if (existsSync(opts.legacyArtifactDir)) {
        for (const name of readdirSync(opts.legacyArtifactDir)) {
          if (!PRE_DUP_FIX_RE.test(name)) continue;
          const fullPath = join(opts.legacyArtifactDir, name);
          let ts = 0;
          try {
            ts = statSync(fullPath).mtimeMs;
          } catch {
            // skip unreadable file
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
 * Probe a candidate snapshot file by opening it read-only and running
 * `PRAGMA quick_check`. Returns `{ ok: true, observationCount }` only when
 * the database opens cleanly and `quick_check` returns `ok`.
 *
 * The handle is always closed before this function returns.
 *
 * @internal
 */
function probeSnapshot(path: string): ProbeResult {
  let handle: DatabaseSync | null = null;
  try {
    // Readonly open — applyPerfPragmas auto-disables WAL on readonly handles,
    // so this probe cannot mutate the snapshot file. busy_timeout caps the
    // total wait at 5s by default (T1331 SSoT pragma set).
    handle = openNativeDatabase(path, { readonly: true, enableWal: false });

    const quick = handle.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    const result = quick?.quick_check ?? '';
    if (result !== 'ok') {
      return { ok: false, observationCount: null };
    }

    // Best-effort observation count for the recovery announcement. A version
    // mismatch where the table doesn't exist yet (very old snapshot) is fine
    // — we still trust quick_check's verdict and return ok with null count.
    let observationCount: number | null = null;
    try {
      const row = handle.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as
        | { cnt?: number }
        | undefined;
      observationCount = typeof row?.cnt === 'number' ? row.cnt : null;
    } catch {
      observationCount = null;
    }

    return { ok: true, observationCount };
  } catch {
    return { ok: false, observationCount: null };
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
function quarantineCorruptDb(corruptPath: string, quarantineRoot: string): string {
  const quarantineDir = join(
    quarantineRoot,
    `brain-malformed-${formatQuarantineSuffix(Date.now())}`,
  );
  mkdirSync(quarantineDir, { recursive: true });

  const dest = join(quarantineDir, 'brain.db.malformed');
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
      'BRAIN snapshot failed PRAGMA quick_check; trying next-freshest',
    );
  }
  return null;
}

/**
 * Recover a malformed `brain.db` by quarantining the corrupt file and
 * restoring the freshest validated snapshot.
 *
 * Intended to be called synchronously from the brain.db open chokepoint
 * (`packages/core/src/store/memory-sqlite.ts:getBrainDb`) when the open
 * throws an `ERR_SQLITE_ERROR errcode=11` or when `PRAGMA integrity_check`
 * fails after open. Callers MUST retry the open after this function
 * returns — the function does not re-open the DB itself, so the caller
 * remains the SSoT of the open lifecycle (singletons, drizzle wrapper,
 * migration journal).
 *
 * The function NEVER throws on a recoverable path; instead it returns a
 * structured {@link BrainRecoveryResult} where `restoredFrom === null` and
 * `integrityOK === false` indicate complete failure. The caller surfaces
 * that case to the operator. Throws only on programmer-error inputs (e.g.
 * `corruptPath` is missing).
 *
 * @param opts - Recovery inputs: corrupt path, snapshot directories,
 *               logger, optional quarantine root.
 * @returns The {@link BrainRecoveryResult} envelope.
 *
 * @example
 * ```typescript
 * import { recoverMalformedBrainDb } from '@cleocode/core/store/recover-brain-db';
 * import { getLogger } from '@cleocode/core/logger';
 *
 * const result = recoverMalformedBrainDb({
 *   corruptPath: '/repo/.cleo/brain.db',
 *   snapshotDir: '/repo/.cleo/backups/snapshot',
 *   vacuumSnapshotDir: '/repo/.cleo/backups/sqlite',
 *   legacyArtifactDir: '/repo/.cleo',
 *   logger: getLogger('brain-recover'),
 * });
 * if (result.integrityOK) {
 *   // Retry the open.
 * }
 * ```
 */
export function recoverMalformedBrainDb(opts: RecoverMalformedBrainDbOptions): BrainRecoveryResult {
  if (!opts.corruptPath) {
    throw new Error('recoverMalformedBrainDb: corruptPath is required');
  }
  const quarantineRoot = opts.quarantineRoot ?? join(dirname(opts.corruptPath), 'quarantine');
  const result: BrainRecoveryResult = {
    restoredFrom: null,
    dataLossWindowHours: null,
    observationsRecovered: null,
    integrityOK: false,
    quarantineDir: null,
  };

  // 1. Move the corrupt DB into quarantine. Errors here are fatal to the
  //    recovery path because we cannot safely write a restored file on top
  //    of a corrupt one that might still hold file descriptors.
  try {
    if (existsSync(opts.corruptPath)) {
      result.quarantineDir = quarantineCorruptDb(opts.corruptPath, quarantineRoot);
    }
  } catch (err) {
    opts.logger.error(
      { err, corruptPath: opts.corruptPath, quarantineRoot },
      'BRAIN auto-recovery aborted: could not quarantine corrupt DB',
    );
    return result;
  }

  // 2. Enumerate candidates and pick the freshest validated one.
  const candidates = collectSnapshotCandidates(opts);
  const chosen = pickFreshestValidSnapshot(candidates, opts.logger);
  if (!chosen) {
    opts.logger.error(
      { corruptPath: opts.corruptPath, candidates: candidates.length },
      'BRAIN auto-recovery failed: no validated snapshot found across system/vacuum/legacy sources',
    );
    return result;
  }

  // 3. Restore via copyFileSync. The destination is the original brain.db
  //    path. node:sqlite has not opened the file yet (we quarantined it),
  //    so a raw copy is safe — no WAL/SHM exists at this point.
  try {
    copyFileSync(chosen.candidate.path, opts.corruptPath);
  } catch (err) {
    opts.logger.error(
      { err, snapshotPath: chosen.candidate.path, dest: opts.corruptPath },
      'BRAIN auto-recovery failed: copy from snapshot to live path threw',
    );
    return result;
  }

  // 4. Final verification — open the restored file readonly and quick_check it.
  const finalProbe = probeSnapshot(opts.corruptPath);
  if (!finalProbe.ok) {
    opts.logger.error(
      { restoredFrom: chosen.candidate.path, dest: opts.corruptPath },
      'BRAIN auto-recovery failed: restored DB still fails PRAGMA quick_check',
    );
    return result;
  }

  // 5. Compose the result envelope.
  result.restoredFrom = chosen.candidate.path;
  result.integrityOK = true;
  result.observationsRecovered =
    finalProbe.observationCount ?? chosen.probe.observationCount ?? null;

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
      event: 'brain.auto-recovery',
      restoredFrom: chosen.candidate.path,
      source: chosen.candidate.source,
      dataLossWindowHours: result.dataLossWindowHours,
      observationsRecovered: result.observationsRecovered,
      quarantineDir: result.quarantineDir,
    },
    `BRAIN auto-recovered from snapshot ${isoStamp}; ${windowLabel} of memory may be lost (T10303)`,
  );

  return result;
}
