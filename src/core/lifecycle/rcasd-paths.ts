/**
 * Canonical RCASD path helpers for provenance file management.
 *
 * All provenance artifacts live under `.cleo/rcasd/{epicId}/` with
 * stage subdirectories created on-demand.
 *
 * @task T5200
 * @epic T4798
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { getCleoDirAbsolute } from '../paths.js';

// Stage subdirectory names (mapped from canonical stage names in stages.ts)
const STAGE_SUBDIRS: Record<string, string> = {
  research: 'research',
  consensus: 'consensus',
  architecture_decision: 'architecture',
  specification: 'specification',
  decomposition: 'decomposition',
  contribution: 'contributions',
};

const LIFECYCLE_DATA_DIRS = ['rcasd', 'rcsd'] as const;
const DEFAULT_DIR = 'rcasd' as const;

// Pattern for epic IDs: T followed by one or more digits
const EPIC_ID_PATTERN = /^(T\d+)/;

/**
 * Strip suffixes from epic directory names.
 * E.g. `T4881_install-channels` -> `T4881`
 *
 * @param dirName - Directory name that may contain a suffix
 * @returns The normalized T#### epic ID
 */
export function normalizeEpicId(dirName: string): string {
  const match = dirName.match(EPIC_ID_PATTERN);
  return match ? match[1] : dirName;
}

/**
 * Get the absolute path to the `.cleo/rcasd/` base directory.
 *
 * @param cwd - Optional working directory override
 * @returns Absolute path to the rcasd base directory
 */
export function getRcasdBaseDir(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DEFAULT_DIR);
}

/**
 * Get the absolute path to `.cleo/rcasd/{epicId}/`.
 * Uses the normalized epic ID (without suffixes).
 *
 * @param epicId - Epic identifier (e.g. `T4881`)
 * @param cwd - Optional working directory override
 * @returns Absolute path to the epic directory
 */
export function getEpicDir(epicId: string, cwd?: string): string {
  const normalized = normalizeEpicId(epicId);
  return join(getCleoDirAbsolute(cwd), DEFAULT_DIR, normalized);
}

/**
 * Search both `rcasd/` and legacy `rcsd/` for an existing epic directory.
 * Also checks suffixed directory names (e.g. `T4881_install-channels`
 * matches `T4881`).
 *
 * @param epicId - Epic identifier to search for
 * @param cwd - Optional working directory override
 * @returns Absolute path to the found directory, or null
 */
export function findEpicDir(epicId: string, cwd?: string): string | null {
  const normalized = normalizeEpicId(epicId);
  const cleoDir = getCleoDirAbsolute(cwd);

  for (const dirName of LIFECYCLE_DATA_DIRS) {
    const baseDir = join(cleoDir, dirName);
    if (!existsSync(baseDir)) continue;

    // Check exact match first
    const exactPath = join(baseDir, normalized);
    if (existsSync(exactPath)) return exactPath;

    // Check suffixed directories
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && normalizeEpicId(entry.name) === normalized) {
          return join(baseDir, entry.name);
        }
      }
    } catch {
      // Directory not readable, skip
    }
  }

  return null;
}

/**
 * Get the stage subdirectory path for an epic.
 * Uses STAGE_SUBDIRS mapping, falling back to the raw stage name.
 *
 * @param epicId - Epic identifier
 * @param stage - Canonical stage name (e.g. `research`, `contribution`)
 * @param cwd - Optional working directory override
 * @returns Absolute path to the stage subdirectory
 */
export function getStagePath(epicId: string, stage: string, cwd?: string): string {
  const subdir = STAGE_SUBDIRS[stage] ?? stage;
  return join(getEpicDir(epicId, cwd), subdir);
}

/**
 * Get the stage subdirectory path, creating it if it does not exist.
 *
 * @param epicId - Epic identifier
 * @param stage - Canonical stage name
 * @param cwd - Optional working directory override
 * @returns Absolute path to the (now existing) stage subdirectory
 */
export function ensureStagePath(epicId: string, stage: string, cwd?: string): string {
  const path = getStagePath(epicId, stage, cwd);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

/**
 * Get the manifest path for an epic under the default rcasd directory.
 *
 * @param epicId - Epic identifier
 * @param cwd - Optional working directory override
 * @returns Absolute path to `.cleo/rcasd/{epicId}/_manifest.json`
 */
export function getManifestPath(epicId: string, cwd?: string): string {
  return join(getEpicDir(epicId, cwd), '_manifest.json');
}

/**
 * Search both `rcasd/` and `rcsd/` for an existing manifest file.
 * Checks suffixed directory names as well.
 *
 * @param epicId - Epic identifier
 * @param cwd - Optional working directory override
 * @returns Absolute path to the found manifest, or null
 */
export function findManifestPath(epicId: string, cwd?: string): string | null {
  const epicDir = findEpicDir(epicId, cwd);
  if (!epicDir) return null;

  const manifestPath = join(epicDir, '_manifest.json');
  return existsSync(manifestPath) ? manifestPath : null;
}

/**
 * Scan the rcasd root directory for loose `T####_*.md` files that are
 * not inside subdirectories.
 *
 * @param cwd - Optional working directory override
 * @returns Array of file info with extracted epic ID
 */
export function getLooseResearchFiles(cwd?: string): Array<{ file: string; epicId: string; fullPath: string }> {
  const baseDir = getRcasdBaseDir(cwd);
  if (!existsSync(baseDir)) return [];

  const results: Array<{ file: string; epicId: string; fullPath: string }> = [];
  const looseFilePattern = /^(T\d+)_.+\.md$/;

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(looseFilePattern);
      if (match) {
        results.push({
          file: entry.name,
          epicId: match[1],
          fullPath: join(baseDir, entry.name),
        });
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}

/**
 * List all epic directories across `rcasd/` and `rcsd/`.
 *
 * @param cwd - Optional working directory override
 * @returns Array of epic info with normalized IDs and original directory names
 */
export function listEpicDirs(cwd?: string): Array<{ epicId: string; dirName: string; fullPath: string }> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const results: Array<{ epicId: string; dirName: string; fullPath: string }> = [];
  const seen = new Set<string>();

  for (const dirName of LIFECYCLE_DATA_DIRS) {
    const baseDir = join(cleoDir, dirName);
    if (!existsSync(baseDir)) continue;

    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const normalized = normalizeEpicId(entry.name);
        // Only include directories that look like epic IDs
        if (!EPIC_ID_PATTERN.test(entry.name)) continue;
        // Deduplicate: prefer the first occurrence (rcasd over rcsd)
        const key = `${normalized}:${entry.name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          epicId: normalized,
          dirName: entry.name,
          fullPath: join(baseDir, entry.name),
        });
      }
    } catch {
      // Directory not readable
    }
  }

  return results;
}
