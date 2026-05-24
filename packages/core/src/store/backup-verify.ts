/**
 * `cleo backup verify` core SDK — per-DB freshness + integrity walker.
 *
 * Walks every entry in `DB_INVENTORY` (`@cleocode/contracts`) and reports
 * the freshest snapshot in BOTH the canonical backup directory
 * (`.cleo/backups/sqlite/` per T10315 / ADR-013 §10) and the legacy backup
 * directory (`.cleo/backups/snapshot/`, retained read-only for one
 * deprecation window). Each freshest snapshot is opened via
 * {@link openCleoDbSnapshot} (the canonical chokepoint, allowlisted under
 * `packages/core/src/store/**`) and verified with `PRAGMA integrity_check`.
 *
 * Verdict semantics live in {@link BackupVerifyVerdict}; the CLI verb's exit
 * code is driven directly by the `summary` returned here.
 *
 * @task T10319
 * @epic T10284
 * @saga T10281
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BackupVerifyDbReport,
  type BackupVerifyResult,
  type BackupVerifySnapshot,
  type BackupVerifySummary,
  type BackupVerifyVerdict,
  DB_INVENTORY,
  type DbInventoryEntry,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { openCleoDbSnapshot } from './open-cleo-db.js';

/**
 * Threshold above which a snapshot is considered `stale` even if its
 * integrity check passes. Matches the AC4 contract: exit non-zero when any
 * DB is more than 24h since its last snapshot.
 */
const STALE_THRESHOLD_HOURS = 24;

/** Milliseconds in one hour — used for the stale comparison + reporting. */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Options accepted by {@link runBackupVerify}.
 *
 * @public
 */
export interface BackupVerifyOptions {
  /**
   * Absolute path to the project root. Used to resolve `<projectRoot>` in
   * `DB_INVENTORY` path templates and the canonical / legacy backup
   * directories under it.
   */
  projectRoot: string;
  /**
   * Override for the global CLEO home (`$XDG_DATA_HOME/cleo/`). Defaults to
   * `getCleoHome()` from `@cleocode/paths`. Tests inject a tmp dir here.
   */
  cleoHomeOverride?: string;
  /**
   * Reference timestamp (epoch ms) used to compute `dataLossEstimateHours`.
   * Defaults to `Date.now()`. Tests pin this for deterministic envelopes.
   */
  nowMs?: number;
  /**
   * Per-DB integrity-check timeout in milliseconds. Default 30 000ms per the
   * T10319 acceptance criteria. When the check exceeds this budget the
   * snapshot is reported as `integrityOK: false` with an `error` of
   * `'integrity-check timed out'`.
   */
  perDbTimeoutMs?: number;
}

/**
 * Internal snapshot candidate — used while scanning a directory before the
 * freshest one is selected and opened.
 */
interface SnapshotCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * Compute the canonical backup directory for a given inventory entry.
 *
 * Project-tier and derived-tier entries snapshot under
 * `<projectRoot>/.cleo/backups/sqlite/`. Global-tier entries snapshot under
 * `<cleoHome>/backups/sqlite/`.
 *
 * @internal
 */
function resolveCanonicalBackupDir(
  entry: DbInventoryEntry,
  projectRoot: string,
  cleoHome: string,
): string {
  if (entry.tier === 'global') {
    return join(cleoHome, 'backups', 'sqlite');
  }
  return join(projectRoot, '.cleo', 'backups', 'sqlite');
}

/**
 * Compute the legacy backup directory for a given inventory entry.
 *
 * @internal
 */
function resolveLegacyBackupDir(
  entry: DbInventoryEntry,
  projectRoot: string,
  cleoHome: string,
): string {
  if (entry.tier === 'global') {
    return join(cleoHome, 'backups', 'snapshot');
  }
  return join(projectRoot, '.cleo', 'backups', 'snapshot');
}

/**
 * Build the set of filename patterns that match a snapshot for the given
 * role. We accept multiple shapes to remain forward-compatible with the
 * three producers that write into these directories:
 *
 *  - `vacuumIntoBackupAll` / `vacuumIntoGlobalBackup` — `<role>-YYYYMMDD-HHmmss.db`
 *  - `createBackup` per-file sidecar pattern — `<role>.db.<backupId>` where
 *    `backupId = <type>-YYYYMMDD-HHmmss`
 *  - Legacy `cleo backup add` snapshot pattern — `<role>.db.snapshot-<iso>`
 *
 * Each shape uses a dedicated regex; we test them in order and accept the
 * first hit. The `<role>` token is escaped because a future role could
 * technically contain a regex metacharacter (today none do, but the
 * inventory is operator-extensible).
 *
 * @internal
 */
function buildSnapshotPatterns(role: string): readonly RegExp[] {
  const safe = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`^${safe}-\\d{8}-\\d{6}\\.db$`),
    new RegExp(`^${safe}\\.db\\.[A-Za-z0-9_-]+-\\d{8}-\\d{6}$`),
    new RegExp(`^${safe}\\.db\\.snapshot-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`),
  ];
}

/**
 * Test whether a filename is a snapshot for the given role, using
 * {@link buildSnapshotPatterns}.
 *
 * @internal
 */
function isSnapshotFor(role: string, filename: string): boolean {
  const patterns = buildSnapshotPatterns(role);
  for (const re of patterns) {
    if (re.test(filename)) return true;
  }
  return false;
}

/**
 * Find the freshest snapshot in `dir` whose filename matches a known
 * snapshot pattern for `role`. Returns `null` when no snapshot is present
 * or the directory does not exist.
 *
 * @internal
 */
function findFreshestSnapshot(dir: string, role: string): SnapshotCandidate | null {
  if (!existsSync(dir)) return null;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let freshest: SnapshotCandidate | null = null;
  for (const filename of entries) {
    if (!isSnapshotFor(role, filename)) continue;
    const candidatePath = join(dir, filename);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(candidatePath).mtimeMs;
    } catch {
      continue;
    }
    if (freshest === null || mtimeMs > freshest.mtimeMs) {
      freshest = { path: candidatePath, mtimeMs };
    }
  }
  return freshest;
}

/**
 * Run `PRAGMA integrity_check` against the snapshot at `path` and return
 * the structured per-snapshot record. Bounded by `perDbTimeoutMs` — when
 * the check exceeds the budget, the snapshot is reported as
 * `integrityOK: false` with `error: 'integrity-check timed out'`. The
 * snapshot handle is ALWAYS closed before returning.
 *
 * @internal
 */
function verifySnapshot(
  candidate: SnapshotCandidate,
  perDbTimeoutMs: number,
): BackupVerifySnapshot {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(candidate.path).size;
  } catch {
    // stat failed — file may have vanished between discovery and verify.
    sizeBytes = null;
  }

  // Note: node:sqlite is a CJS-only built-in opened via createRequire inside
  // openCleoDbSnapshot. The integrity_check call is synchronous; we measure
  // the elapsed wall-clock time and treat anything exceeding the budget as
  // a soft timeout (the call already completed, so there is nothing to
  // abort — but surfacing the budget breach is still useful diagnostic
  // signal).
  const startMs = Date.now();
  let snap: ReturnType<typeof openCleoDbSnapshot> | null = null;
  try {
    snap = openCleoDbSnapshot(candidate.path, { readOnly: true, applyPragmas: false });
    type IntegrityRow = { integrity_check: string };
    const rows = snap.db.prepare('PRAGMA integrity_check').all() as IntegrityRow[];
    const elapsedMs = Date.now() - startMs;
    const passedCheck = rows.length === 1 && rows[0]?.integrity_check === 'ok';
    if (elapsedMs > perDbTimeoutMs) {
      return {
        path: candidate.path,
        mtime: candidate.mtimeMs,
        integrityOK: false,
        sizeBytes,
        error: `integrity-check exceeded ${perDbTimeoutMs}ms budget (took ${elapsedMs}ms)`,
      };
    }
    return {
      path: candidate.path,
      mtime: candidate.mtimeMs,
      integrityOK: passedCheck,
      sizeBytes,
      error: passedCheck ? null : 'integrity_check returned non-ok rows',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      path: candidate.path,
      mtime: candidate.mtimeMs,
      integrityOK: false,
      sizeBytes,
      error: message,
    };
  } finally {
    snap?.close();
  }
}

/**
 * Decide the per-DB verdict from the freshest available snapshot.
 *
 * @internal
 */
function computeVerdict(
  freshSnapshot: BackupVerifySnapshot | null,
  legacySnapshot: BackupVerifySnapshot | null,
  nowMs: number,
): { verdict: BackupVerifyVerdict; dataLossEstimateHours: number | null } {
  // Pick the newer of the two by mtime — operators care about the freshest
  // snapshot available, regardless of which directory holds it.
  let best: BackupVerifySnapshot | null = null;
  if (freshSnapshot && legacySnapshot) {
    best = freshSnapshot.mtime >= legacySnapshot.mtime ? freshSnapshot : legacySnapshot;
  } else {
    best = freshSnapshot ?? legacySnapshot;
  }

  if (best === null) {
    return { verdict: 'missing', dataLossEstimateHours: null };
  }

  const dataLossEstimateHours = Math.max(0, (nowMs - best.mtime) / MS_PER_HOUR);

  if (!best.integrityOK) {
    return { verdict: 'corrupt', dataLossEstimateHours };
  }
  if (dataLossEstimateHours > STALE_THRESHOLD_HOURS) {
    return { verdict: 'stale', dataLossEstimateHours };
  }
  return { verdict: 'healthy', dataLossEstimateHours };
}

/**
 * Verify backups for a single inventory entry. Walks both the canonical
 * and legacy snapshot directories, opens each freshest snapshot via
 * {@link openCleoDbSnapshot}, runs `PRAGMA integrity_check`, and rolls the
 * results up into a {@link BackupVerifyDbReport}.
 *
 * @internal
 */
function verifyOne(
  entry: DbInventoryEntry,
  projectRoot: string,
  cleoHome: string,
  nowMs: number,
  perDbTimeoutMs: number,
): BackupVerifyDbReport {
  const canonicalDir = resolveCanonicalBackupDir(entry, projectRoot, cleoHome);
  const legacyDir = resolveLegacyBackupDir(entry, projectRoot, cleoHome);

  const canonicalCandidate = findFreshestSnapshot(canonicalDir, entry.role);
  const legacyCandidate = findFreshestSnapshot(legacyDir, entry.role);

  const freshSnapshot = canonicalCandidate
    ? verifySnapshot(canonicalCandidate, perDbTimeoutMs)
    : null;
  const legacySnapshot = legacyCandidate ? verifySnapshot(legacyCandidate, perDbTimeoutMs) : null;

  const { verdict, dataLossEstimateHours } = computeVerdict(freshSnapshot, legacySnapshot, nowMs);

  return {
    role: entry.role,
    tier: entry.tier,
    freshSnapshot,
    legacySnapshot,
    dataLossEstimateHours,
    verdict,
  };
}

/**
 * Roll per-DB reports up into the aggregate counters surfaced as
 * `BackupVerifyResult.summary`.
 *
 * @internal
 */
function summarize(reports: readonly BackupVerifyDbReport[]): BackupVerifySummary {
  let healthy = 0;
  let stale = 0;
  let corrupt = 0;
  let missing = 0;
  for (const report of reports) {
    switch (report.verdict) {
      case 'healthy':
        healthy += 1;
        break;
      case 'stale':
        stale += 1;
        break;
      case 'corrupt':
        corrupt += 1;
        break;
      case 'missing':
        missing += 1;
        break;
    }
  }
  return { healthy, stale, corrupt, missing };
}

/**
 * Walk every entry in `DB_INVENTORY`, find each role's freshest snapshot in
 * the canonical and legacy backup directories, verify integrity, and
 * return a structured {@link BackupVerifyResult}.
 *
 * @remarks
 * Read-only — performs zero writes. The result's `summary` is the source
 * of truth for the CLI verb's exit code (`stale > 0 || corrupt > 0` → 1).
 *
 * @example Verify backups for the current project
 * ```typescript
 * import { runBackupVerify } from '@cleocode/core/store/backup-verify.js';
 *
 * const result = runBackupVerify({ projectRoot: process.cwd() });
 * for (const [role, report] of Object.entries(result.dbs)) {
 *   console.log(role, report.verdict, report.dataLossEstimateHours);
 * }
 * ```
 *
 * @public
 */
export function runBackupVerify(options: BackupVerifyOptions): BackupVerifyResult {
  const cleoHome = options.cleoHomeOverride ?? getCleoHome();
  const nowMs = options.nowMs ?? Date.now();
  const perDbTimeoutMs = options.perDbTimeoutMs ?? 30_000;

  const dbs: Record<string, BackupVerifyDbReport> = {};
  const reports: BackupVerifyDbReport[] = [];
  for (const entry of DB_INVENTORY) {
    const report = verifyOne(entry, options.projectRoot, cleoHome, nowMs, perDbTimeoutMs);
    dbs[entry.role] = report;
    reports.push(report);
  }

  return {
    dbs,
    summary: summarize(reports),
  };
}
