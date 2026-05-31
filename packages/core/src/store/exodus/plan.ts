/**
 * Exodus pre-flight plan builder.
 *
 * `buildExodusPlan()` computes the full migration plan — source DB paths,
 * combined size, free-disk availability, staging directory — BEFORE any
 * writes occur. A `--dry-run` caller can print the plan and exit early.
 *
 * ## Disk pre-flight (AC8)
 *
 * `availableBytes >= 3 * totalSourceBytes` must hold before migration begins.
 * The check uses `statvfs` via `node:fs.statfsSync()` (Node 18+).
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome, resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import type { ExodusPlan, LegacyDbDescriptor } from './types.js';

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
 * @task T11248 (AC8 — 3× disk pre-flight)
 */
export function buildExodusPlan(cwd?: string): ExodusPlan {
  const cleoDir = resolveCleoDir(cwd);
  const sources = buildSourceDescriptors(cwd);

  // Compute total source size (only existing files count toward the check)
  const totalSourceBytes = sources.reduce((sum, s) => sum + safeFileBytes(s.path), 0);

  // Disk pre-flight: check against the directory that will hold the staging data
  // (the .cleo/ dir, which is where both the backup and staging live).
  const availableBytes = getAvailableBytes(cleoDir);
  const diskPreflight = totalSourceBytes === 0 || availableBytes >= 3 * totalSourceBytes;

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
    availableBytes,
    diskPreflight,
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
