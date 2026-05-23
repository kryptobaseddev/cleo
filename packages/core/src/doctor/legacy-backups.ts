/**
 * Legacy-backup walker for `cleo doctor legacy-backups`.
 *
 * Enumerates every `*-pre-cleo.db.bak`, `brain.db.PRE-DUP-FIX-*`,
 * `*.pre-untrack-*`, and overflow `.cleo/backups/sqlite/*.db` artefact
 * across:
 *
 *   - `<projectRoot>/.cleo/quarantine/`     (NEVER auto-pruned)
 *   - `<projectRoot>/.cleo/backups/`        (snapshot rotation overflow only)
 *   - `<projectRoot>/.cleo/backups/sqlite/` (per-DB rotation overflow)
 *   - `<projectRoot>/.cleo/backups/safety/` (T5158 pre-untrack siblings)
 *   - `<cleoHome>/`                          (global tier legacy DBs)
 *   - `<cleoHome>/nexus/`                    (nested-nexus legacy DBs)
 *
 * Each match is classified by `LegacyBackupOriginHint` and given a
 * retention recommendation (`keep` / `compress` / `delete`) based on the
 * 30-day soft + 90-day hard retention windows documented in ADR-013 §9.
 *
 * Two modes are exposed:
 *
 *   - {@link scanLegacyBackups}  — read-only walk; populates `entries`.
 *   - {@link pruneLegacyBackups} — same walk + actually deletes
 *     `delete`-recommended files (dry-run by default).
 *
 * Path resolution honours the project root + `@cleocode/paths`
 * `getCleoHome()`. Every disk op is wrapped in a defensive try/catch so
 * a single permission error never breaks the survey.
 *
 * @task T10309
 * @epic T10282
 * @saga T10281
 * @see ADR-013 §9 — Legacy backup retention policy
 */

import { type Dirent, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type {
  LegacyBackupEntry,
  LegacyBackupOriginHint,
  LegacyBackupRecommendation,
  LegacyBackupScanResult,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';

/**
 * Number of `.cleo/backups/sqlite/<prefix>-*.db` rotation snapshots to
 * keep per DB prefix. Mirrors the rotation cap documented in ADR-013 §9
 * (`vacuumIntoBackupAll` keeps 10 snapshots per target). Anything older
 * than the cap is classified as `db-backup-rotation` overflow.
 */
const SQLITE_BACKUP_ROTATION_CAP = 10;

/**
 * Default soft retention window. Files younger than this are
 * unconditionally classified `keep` regardless of any other heuristic.
 */
export const DEFAULT_SOFT_RETENTION_DAYS = 30;

/**
 * Default hard retention window. Files older than this and outside the
 * quarantine tree are classified `delete`.
 */
export const DEFAULT_HARD_RETENTION_DAYS = 90;

/**
 * One millisecond budget per day (used for day-rounded age math).
 *
 * @internal
 */
const MS_PER_DAY = 86_400_000;

/**
 * Configurable retention thresholds + override hook for clock-skew
 * deterministic tests.
 *
 * @task T10309
 */
export interface LegacyBackupScanOptions {
  /** Soft retention window in days (default {@link DEFAULT_SOFT_RETENTION_DAYS}). */
  softRetentionDays?: number;
  /** Hard retention window in days (default {@link DEFAULT_HARD_RETENTION_DAYS}). */
  hardRetentionDays?: number;
  /**
   * Wall-clock reference used by the walker for age computation. Test
   * fixtures pin this so the recommendation is independent of the
   * machine clock. Defaults to `Date.now()` at call time.
   */
  nowMs?: number;
}

/**
 * Prune-mode options. Always implies dry-run unless the caller passes
 * `dryRun: false`.
 *
 * @task T10309
 */
export interface LegacyBackupPruneOptions extends LegacyBackupScanOptions {
  /**
   * When `false`, the walker physically removes every artefact whose
   * recommendation is `delete`. DEFAULTS to `true` (dry-run) so a bare
   * `--prune` invocation can never destroy data.
   */
  dryRun?: boolean;
}

/**
 * Predicate: does this filename match one of the legacy backup
 * patterns the walker is responsible for?
 *
 * @param name - Plain filename (no directory).
 * @returns `true` when the file is a legacy backup candidate.
 */
export function isLegacyBackupFilename(name: string): boolean {
  if (name.endsWith('-pre-cleo.db.bak')) return true;
  if (name.endsWith('.db.bak')) return true;
  if (name.startsWith('brain.db.PRE-DUP-FIX-')) return true;
  if (name.endsWith('.db.malformed')) return true;
  if (name.includes('.pre-untrack-')) return true;
  if (name.includes('.snapshot-')) {
    // `.cleo/backups/snapshot/*.db` and `.cleo/backups/snapshot/*.json`
    // rotation-overflow candidates. The basename here ends with the
    // ISO timestamp rather than a file extension (e.g.
    // `config.json.snapshot-2026-05-12T00-33-56-575Z`), so the
    // `.snapshot-` substring is the canonical marker.
    return true;
  }
  return false;
}

/**
 * Infer the origin hint for a legacy backup file from its absolute path
 * and basename.
 *
 * @param absolutePath - Absolute path to the candidate file.
 * @returns The most specific {@link LegacyBackupOriginHint} we can
 *   confidently assign without opening the file.
 */
export function classifyLegacyBackup(absolutePath: string): LegacyBackupOriginHint {
  const name = basename(absolutePath);

  // Quarantine paths always win — even pre-cleo.bak files inside
  // quarantine are forensic artefacts, NOT auto-prune candidates.
  if (absolutePath.includes(`${join('.cleo', 'quarantine')}${sep}`)) {
    if (absolutePath.includes(`${join('quarantine', 'brain-malformed')}`)) {
      return 'brain-malformed';
    }
    return 'quarantine-snapshot';
  }

  if (name.startsWith('brain.db.PRE-DUP-FIX-')) return 'brain-dup-fix';
  if (name.endsWith('.db.malformed')) return 'brain-malformed';
  if (name.includes('.pre-untrack-')) return 'pre-untrack';
  if (name.endsWith('-pre-cleo.db.bak')) return 'pre-cleo-migration';
  if (name.endsWith('.db.bak')) return 'pre-cleo-migration';

  // Snapshot rotation overflow lives under `.cleo/backups/snapshot/`.
  if (absolutePath.includes(`${join('backups', 'snapshot')}`) && name.includes('.snapshot-')) {
    return 'db-backup-rotation';
  }

  return 'unknown';
}

/**
 * Compute the retention recommendation for a legacy backup.
 *
 * Decision table:
 *
 * | Condition                            | Recommendation |
 * |--------------------------------------|----------------|
 * | `originHint === 'quarantine-*'`      | `keep`         |
 * | `ageDays <= softRetentionDays`       | `keep`         |
 * | `ageDays >= hardRetentionDays`       | `delete`       |
 * | `softRetentionDays < age < hard...`  | `compress`     |
 *
 * Quarantine and brain-malformed origins are ALWAYS kept — operators
 * may need them for forensic incident analysis.
 *
 * @param entry - Partial entry with `ageDays` and `originHint` already
 *   resolved.
 * @param softRetentionDays - Soft retention threshold.
 * @param hardRetentionDays - Hard retention threshold.
 * @returns Tuple of recommendation + human-readable reason.
 */
export function recommendForBackup(
  entry: Pick<LegacyBackupEntry, 'ageDays' | 'originHint'>,
  softRetentionDays: number,
  hardRetentionDays: number,
): { recommendation: LegacyBackupRecommendation; reason: string } {
  if (entry.originHint === 'quarantine-snapshot' || entry.originHint === 'brain-malformed') {
    return {
      recommendation: 'keep',
      reason: `quarantine artefact — never auto-pruned (ADR-013 §9)`,
    };
  }

  if (entry.ageDays <= softRetentionDays) {
    return {
      recommendation: 'keep',
      reason: `younger than soft retention (${entry.ageDays}d <= ${softRetentionDays}d)`,
    };
  }

  if (entry.ageDays >= hardRetentionDays) {
    return {
      recommendation: 'delete',
      reason: `older than hard retention (${entry.ageDays}d >= ${hardRetentionDays}d) — eligible for prune`,
    };
  }

  return {
    recommendation: 'compress',
    reason: `between soft (${softRetentionDays}d) and hard (${hardRetentionDays}d) retention — compression candidate`,
  };
}

/**
 * Read one directory entry's `Dirent` array, swallowing errors.
 *
 * @param dir - Absolute directory path.
 * @returns Array of `Dirent`s, or empty array when the dir is missing
 *   / unreadable.
 * @internal
 */
function safeReaddir(dir: string): Dirent[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Recursive walker that yields every regular file under `dir`. Returns
 * absolute paths only; symlinks are not followed.
 *
 * @param dir - Absolute directory to walk.
 * @returns Generator of absolute file paths.
 * @internal
 */
function* walkFiles(dir: string): Generator<string> {
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Mint a {@link LegacyBackupEntry} for one absolute path, computing
 * age + recommendation from `nowMs` and the retention thresholds.
 *
 * @param absolutePath - Absolute path to the candidate file.
 * @param nowMs - Reference wall-clock time (ms since epoch).
 * @param softRetentionDays - Soft retention threshold.
 * @param hardRetentionDays - Hard retention threshold.
 * @returns The populated entry, or `null` when stat() failed.
 * @internal
 */
function mintEntry(
  absolutePath: string,
  nowMs: number,
  softRetentionDays: number,
  hardRetentionDays: number,
): LegacyBackupEntry | null {
  let sizeBytes = 0;
  let mtimeMs = 0;
  try {
    const stat = statSync(absolutePath);
    sizeBytes = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }
  const ageMs = Math.max(0, nowMs - mtimeMs);
  const ageDays = Math.floor(ageMs / MS_PER_DAY);
  const originHint = classifyLegacyBackup(absolutePath);
  const { recommendation, reason } = recommendForBackup(
    { ageDays, originHint },
    softRetentionDays,
    hardRetentionDays,
  );
  return {
    path: absolutePath,
    sizeBytes,
    mtimeMs,
    ageDays,
    originHint,
    recommendation,
    reason,
  };
}

/**
 * Mark `.cleo/backups/sqlite/<prefix>-YYYYMMDD-HHmmss.db` files that
 * exceed the rotation cap as `db-backup-rotation` overflow.
 *
 * Per-prefix sorting is by mtime (newest first); everything past index
 * {@link SQLITE_BACKUP_ROTATION_CAP} is overflow.
 *
 * @param dir - Absolute path to `.cleo/backups/sqlite/`.
 * @returns Absolute paths of overflow files (already past the rotation
 *   cap).
 * @internal
 */
function collectSqliteRotationOverflow(dir: string): string[] {
  const entries = safeReaddir(dir);
  const groups = new Map<string, Array<{ path: string; mtimeMs: number }>>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.db')) continue;
    // <prefix>-YYYYMMDD-HHmmss.db — anchor the prefix on the first
    // hyphen-digit segment.
    const match = entry.name.match(/^([A-Za-z0-9_]+)-\d{8}-\d{6}\.db$/);
    if (!match) continue;
    const prefix = match[1];
    if (prefix === undefined) continue;
    const full = join(dir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const list = groups.get(prefix) ?? [];
    list.push({ path: full, mtimeMs });
    groups.set(prefix, list);
  }
  const overflow: string[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = SQLITE_BACKUP_ROTATION_CAP; i < list.length; i += 1) {
      const item = list[i];
      if (item) overflow.push(item.path);
    }
  }
  return overflow;
}

/**
 * Source paths the walker visits, in canonical order. Excludes the
 * worktree mirror under `<projectRoot>/.cleo/worktrees.json` (sentinel
 * file, not a directory) and the `.git/` tree.
 *
 * @param projectRoot - Absolute project root.
 * @param cleoHome    - Absolute CLEO home (`getCleoHome()`).
 * @returns Ordered array of directories to walk.
 */
export function legacyBackupSearchRoots(projectRoot: string, cleoHome: string): string[] {
  return [
    join(projectRoot, '.cleo', 'quarantine'),
    join(projectRoot, '.cleo', 'backups', 'safety'),
    join(projectRoot, '.cleo', 'backups', 'snapshot'),
    join(projectRoot, '.cleo', 'backups'),
    cleoHome,
    join(cleoHome, 'nexus'),
  ];
}

/**
 * Read-only legacy-backup walker.
 *
 * Enumerates every artefact under {@link legacyBackupSearchRoots} that
 * matches {@link isLegacyBackupFilename}, classifies each by origin,
 * and assigns a retention recommendation. The result is sorted by path
 * ascending and exposes the configured thresholds back to the caller.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Optional retention thresholds + clock override.
 * @returns A {@link LegacyBackupScanResult} with `prune: false` and
 *   empty `pruned`/`kept` arrays.
 *
 * @task T10309
 */
export function scanLegacyBackups(
  projectRoot: string,
  options: LegacyBackupScanOptions = {},
): LegacyBackupScanResult {
  const softRetentionDays = options.softRetentionDays ?? DEFAULT_SOFT_RETENTION_DAYS;
  const hardRetentionDays = options.hardRetentionDays ?? DEFAULT_HARD_RETENTION_DAYS;
  const nowMs = options.nowMs ?? Date.now();

  const cleoHome = getCleoHome();
  const seen = new Set<string>();
  const entries: LegacyBackupEntry[] = [];

  // Walk every search root and collect filename-pattern matches.
  for (const root of legacyBackupSearchRoots(projectRoot, cleoHome)) {
    for (const filePath of walkFiles(root)) {
      if (seen.has(filePath)) continue;
      if (!isLegacyBackupFilename(basename(filePath))) continue;
      const entry = mintEntry(filePath, nowMs, softRetentionDays, hardRetentionDays);
      if (entry === null) continue;
      seen.add(filePath);
      entries.push(entry);
    }
  }

  // Add db-backup-rotation overflow from .cleo/backups/sqlite/ — these
  // files DON'T match the legacy suffix patterns, they're just past the
  // rotation cap.
  const sqliteDir = join(projectRoot, '.cleo', 'backups', 'sqlite');
  for (const overflowPath of collectSqliteRotationOverflow(sqliteDir)) {
    if (seen.has(overflowPath)) continue;
    const entry = mintEntry(overflowPath, nowMs, softRetentionDays, hardRetentionDays);
    if (entry === null) continue;
    // Force the origin hint — sqlite-rotation overflow doesn't match
    // any of the suffix patterns but it IS a legacy-backup artefact.
    entry.originHint = 'db-backup-rotation';
    const reco = recommendForBackup(
      { ageDays: entry.ageDays, originHint: entry.originHint },
      softRetentionDays,
      hardRetentionDays,
    );
    entry.recommendation = reco.recommendation;
    entry.reason = `rotation overflow — ${reco.reason}`;
    seen.add(overflowPath);
    entries.push(entry);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  return {
    projectRoot,
    cleoHome,
    entries,
    totalBytes,
    softRetentionDays,
    hardRetentionDays,
    prune: false,
    dryRun: false,
    pruned: [],
    kept: [],
    errors: [],
  };
}

/**
 * Prune-mode wrapper around {@link scanLegacyBackups}.
 *
 * Walks the same roots and, when `options.dryRun === false`, removes
 * every artefact whose `recommendation === 'delete'`. Quarantine
 * artefacts are NEVER touched — the `recommendForBackup` decision
 * table already filters them out.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Retention thresholds + dry-run toggle. `dryRun`
 *   defaults to `true` so the verb is safe under all calling
 *   conditions.
 * @returns A {@link LegacyBackupScanResult} with `prune: true` and
 *   `pruned`/`kept`/`errors` populated.
 *
 * @task T10309
 */
export function pruneLegacyBackups(
  projectRoot: string,
  options: LegacyBackupPruneOptions = {},
): LegacyBackupScanResult {
  const dryRun = options.dryRun ?? true;
  const scan = scanLegacyBackups(projectRoot, options);

  const pruned: LegacyBackupEntry[] = [];
  const kept: LegacyBackupEntry[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const entry of scan.entries) {
    if (entry.recommendation !== 'delete') {
      kept.push(entry);
      continue;
    }
    if (dryRun) {
      pruned.push(entry);
      continue;
    }
    try {
      rmSync(entry.path, { force: true });
      pruned.push(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: entry.path, error: message });
    }
  }

  return {
    ...scan,
    prune: true,
    dryRun,
    pruned,
    kept,
    errors,
  };
}
