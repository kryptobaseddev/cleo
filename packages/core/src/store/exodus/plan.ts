/**
 * Exodus pre-flight plan builder.
 *
 * `buildExodusPlan()` computes the full migration plan — source DB paths,
 * combined size, free-disk availability, staging directory — BEFORE any
 * writes occur. A `--dry-run` caller can print the plan and exit early.
 *
 * ## Disk pre-flight (AC8 · right-sized T11838)
 *
 * The original gate required `availableBytes >= 3 * totalSourceBytes` — an
 * over-estimate that blocked large-fleet migrations even with ample headroom:
 * exodus never holds 3× the SUM of every source on disk at once. It copies one
 * source into staging at a time (lock released before the next) and writes a
 * single consolidated cleo.db whose size approximates the sum of source ROW data.
 *
 * The right-sized requirement is therefore
 * `STAGING_HEADROOM_FACTOR * largestSourceBytes + consolidatedEstimate`, where
 * `consolidatedEstimate ≈ totalSourceBytes` ({@link computeRequiredBytes}). The
 * check uses `statvfs` via `node:fs.statfsSync()` (Node 18+).
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @task T11838 (right-sized preflight + optional staging copy for large sources)
 * @saga T11242
 */

import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome, resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import type { ExodusPlan, LegacyDbDescriptor } from './types.js';

// ---------------------------------------------------------------------------
// Disk pre-flight sizing constants (right-sized — T11838)
// ---------------------------------------------------------------------------

/**
 * Headroom multiplier applied to the LARGEST single source when sizing the
 * staging-copy footprint. The staging dir only ever holds ONE source backup at a
 * time (its advisory lock is released before the next source is touched), so the
 * peak staging footprint is the largest source plus a small slack for the
 * write-then-rename journal + SQLite sidecars — hence `1.2×`, not `3×` of the SUM.
 *
 * @task T11838
 */
export const STAGING_HEADROOM_FACTOR = 1.2 as const;

/**
 * Per-source byte threshold above which the full staging `copyFileSync` backup
 * is skipped (the source is archived, not deleted, on success). Sized at 256 MiB
 * — comfortably above the small project DBs (tasks/conduit/skills/signaldock are
 * sub-MB to low-MB) but below the large global stores (a multi-GB `brain.db` or
 * `nexus.db`) whose redundant full-file copy is the costly case T11838 removes.
 *
 * @task T11838
 */
export const STAGING_COPY_SKIP_THRESHOLD_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Compute the right-sized free-disk requirement for an exodus run (T11838).
 *
 * `STAGING_HEADROOM_FACTOR * largestSourceBytes` covers the peak staging-copy
 * footprint (one source at a time, plus slack), and `totalSourceBytes` is the
 * consolidated-cleo.db estimate (every source's row data lands there). The two
 * are additive because staging and the consolidated DB coexist on disk until the
 * sources are archived.
 *
 * @param totalSourceBytes   - Combined size of all source DB files in bytes.
 * @param largestSourceBytes - Size of the single largest source DB in bytes.
 * @returns The minimum free bytes the target filesystem must have.
 */
export function computeRequiredBytes(totalSourceBytes: number, largestSourceBytes: number): number {
  return Math.ceil(STAGING_HEADROOM_FACTOR * largestSourceBytes) + totalSourceBytes;
}

// ---------------------------------------------------------------------------
// Legacy DB descriptors (AC2 — 6 per-machine source DBs mapped to 2 targets)
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of legacy source DB descriptors for a given project.
 *
 * Project-scoped sources live under `<project>/.cleo/`.
 * Global-scoped sources live under `getCleoHome()`.
 */
function buildSourceDescriptors(cwd?: string): LegacyDbDescriptor[] {
  const cleoDir = resolveCleoDir(cwd);
  const cleoHome = getCleoHome();

  return [
    // Project-tier — go into consolidated project-scope cleo.db
    {
      name: 'tasks',
      path: join(cleoDir, 'tasks.db'),
      targetScope: 'project',
    },
    {
      name: 'brain (project)',
      path: join(cleoDir, 'brain.db'),
      targetScope: 'project',
    },
    {
      name: 'conduit',
      path: join(cleoDir, 'conduit.db'),
      targetScope: 'project',
    },
    // Global-tier — go into consolidated global-scope cleo.db
    {
      name: 'nexus',
      path: join(cleoHome, 'nexus.db'),
      targetScope: 'global',
    },
    {
      name: 'signaldock',
      path: join(cleoHome, 'signaldock.db'),
      targetScope: 'global',
    },
    {
      name: 'skills',
      path: join(cleoHome, 'skills.db'),
      targetScope: 'global',
    },
  ] as const;
}

/**
 * Safely stat a file and return its size in bytes, or 0 if it does not exist.
 */
function safeFileBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Return available bytes on the filesystem that contains `dir`.
 *
 * Uses `statfsSync` (Node 18+). Falls back to 0 if unavailable.
 */
function getAvailableBytes(dir: string): number {
  try {
    const result = statfsSync(dir);
    // `bfree` = blocks free for privileged processes; `bavail` = unprivileged.
    return (result.bavail ?? result.bfree ?? 0) * (result.bsize ?? 4096);
  } catch {
    return 0;
  }
}

/**
 * Derive the staging directory name from the current ISO-8601 timestamp.
 *
 * Pattern: `.cleo/exodus-staging-<YYYYMMDDTHHMMSSZ>`.
 * Colons are replaced with empty string (NTFS + shell-safe).
 */
export function deriveStagingDirName(): string {
  const iso = new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\..+Z$/, 'Z');
  return `exodus-staging-${iso}`;
}

/**
 * Scan for an existing staging directory from a previous (possibly crashed)
 * run inside the given `.cleo/` directory.
 *
 * Returns the absolute path to the most-recent staging dir, or `null` if none
 * exists.
 */
function findExistingStaging(cleoDir: string): string | null {
  try {
    const entries = readdirSync(cleoDir, { withFileTypes: true });
    const stagingDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('exodus-staging-'))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first
    if (stagingDirs.length > 0) {
      return join(cleoDir, stagingDirs[0]);
    }
  } catch {
    // .cleo/ may not exist yet
  }
  return null;
}

/**
 * Build the complete exodus plan.
 *
 * This is a pure read operation — no files are created or modified.
 * Pass the result to `runExodusMigrate()` to execute the migration.
 *
 * @param cwd - Working directory used to resolve the project root. Defaults to
 *   `process.cwd()`.
 * @returns {@link ExodusPlan} describing sources, disk availability, and paths.
 *
 * @task T11248 (AC8 — disk pre-flight)
 * @task T11838 (right-sized: largest-source factor + consolidated estimate)
 */
export function buildExodusPlan(cwd?: string): ExodusPlan {
  const cleoDir = resolveCleoDir(cwd);
  const sources = buildSourceDescriptors(cwd);

  // Per-source sizes (only existing files contribute) — drive both the total
  // and the largest-single-source factor of the right-sized preflight (T11838).
  const sourceBytes = sources.map((s) => safeFileBytes(s.path));
  const totalSourceBytes = sourceBytes.reduce((sum, b) => sum + b, 0);
  const largestSourceBytes = sourceBytes.reduce((max, b) => Math.max(max, b), 0);

  // Right-sized disk pre-flight (T11838): exodus never holds 3× the SUM of all
  // sources at once — it stages ONE source at a time and writes one consolidated
  // cleo.db (≈ totalSourceBytes). Check against the directory that will hold the
  // staging data (the .cleo/ dir, where both backup + staging live).
  const requiredBytes = computeRequiredBytes(totalSourceBytes, largestSourceBytes);
  const availableBytes = getAvailableBytes(cleoDir);
  const diskPreflight = totalSourceBytes === 0 || availableBytes >= requiredBytes;

  // Staging directory — resume if a previous one exists
  const existingStaging = findExistingStaging(cleoDir);
  const stagingDir = existingStaging ?? join(cleoDir, deriveStagingDirName());
  const resumeFromStaging = existingStaging !== null;

  // Target paths (consolidated cleo.db)
  const projectDbPath = resolveDualScopeDbPath('project', cwd);
  const globalDbPath = resolveDualScopeDbPath('global');

  return {
    sources,
    totalSourceBytes,
    largestSourceBytes,
    requiredBytes,
    availableBytes,
    diskPreflight,
    stagingCopyThresholdBytes: STAGING_COPY_SKIP_THRESHOLD_BYTES,
    stagingDir,
    resumeFromStaging,
    projectDbPath,
    globalDbPath,
  };
}

/**
 * Check whether all required source DBs exist.
 *
 * Returns `true` if at least one source file is present (partial sets are
 * acceptable — empty tables simply copy zero rows).
 */
export function sourcesPresent(sources: LegacyDbDescriptor[]): boolean {
  return sources.some((s) => existsSync(s.path));
}
