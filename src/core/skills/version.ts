/**
 * Skills version tracking.
 *
 * CAAMP's skills-lock is the PRIMARY source of truth for skill versions.
 * CLEO's local installed-skills.json is kept as a synchronous cache
 * and fallback for when CAAMP's async lock file is unavailable.
 *
 * Write operations record to BOTH CAAMP lock and CLEO local tracking.
 * Read operations check CAAMP lock first, CLEO local second.
 *
 * @epic T4454
 * @task T4521
 * @task T4680
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  getTrackedSkills as caampGetTrackedSkills,
  recordSkillInstall as caampRecordSkillInstall,
  checkSkillUpdate as caampCheckSkillUpdate,
} from '@cleocode/caamp';
import { getCleoHome, getProjectRoot } from '../paths.js';
import type { InstalledSkillsFile } from './types.js';

// ============================================================================
// Paths
// ============================================================================

/**
 * Get the installed skills tracking file path (CLEO local cache).
 */
function getInstalledSkillsPath(): string {
  return join(getCleoHome(), 'installed-skills.json');
}

/**
 * Get the source manifest.json path (from the CLEO repo).
 */
function getSourceManifestPath(cwd?: string): string {
  const root = process.env['CLEO_ROOT'] ?? getProjectRoot(cwd);
  return join(root, 'skills', 'manifest.json');
}

// ============================================================================
// CLEO Local Cache Operations
// ============================================================================

/**
 * Read the installed skills file (CLEO local cache).
 * @task T4521
 */
export function readInstalledSkills(): InstalledSkillsFile {
  const path = getInstalledSkillsPath();

  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Corrupt file, return empty
    }
  }

  return {
    _meta: {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
    },
    skills: {},
  };
}

/**
 * Save the installed skills file (CLEO local cache).
 * @task T4521
 */
export function saveInstalledSkills(data: InstalledSkillsFile): void {
  const path = getInstalledSkillsPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  data._meta.lastUpdated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================================
// Version Tracking (CAAMP primary, CLEO local fallback)
// ============================================================================

/**
 * Initialize the installed skills file if it doesn't exist.
 * @task T4521
 */
export function initInstalledSkills(): InstalledSkillsFile {
  const existing = readInstalledSkills();
  if (Object.keys(existing.skills).length === 0) {
    saveInstalledSkills(existing);
  }
  return existing;
}

/**
 * Record a skill version after installation.
 * Writes to BOTH CAAMP lock (primary) and CLEO local cache (fallback).
 *
 * @task T4521
 * @task T4680
 */
export function recordSkillVersion(
  name: string,
  version: string,
  sourcePath: string,
  symlinkPath: string,
): void {
  // Write to CLEO local cache (synchronous, always succeeds)
  const data = readInstalledSkills();
  data.skills[name] = {
    name,
    version,
    installedAt: new Date().toISOString(),
    sourcePath,
    symlinkPath,
  };
  saveInstalledSkills(data);

  // Write to CAAMP lock (async, best-effort)
  // Fire-and-forget: CAAMP lock is the primary source but we don't
  // block synchronous callers. Next async read will pick it up.
  caampRecordSkillInstall(
    name,
    name, // scopedName
    sourcePath, // source
    'local', // sourceType
    [], // agents (populated by CAAMP during actual install)
    symlinkPath, // canonicalPath
    true, // isGlobal
    undefined, // projectDir
    version,
  ).catch(() => {
    // CAAMP lock write failed - CLEO local cache is the fallback
  });
}

/**
 * Get the installed version of a skill from CLEO's local cache.
 * Synchronous fallback - prefer getInstalledVersionAsync() for accurate results.
 * @task T4521
 */
export function getInstalledVersion(name: string): string | null {
  const data = readInstalledSkills();
  return data.skills[name]?.version ?? null;
}

/**
 * Get the installed version of a skill.
 * Checks CAAMP's lock file first (primary), falls back to CLEO local cache.
 *
 * @task T4521
 * @task T4680
 */
export async function getInstalledVersionAsync(name: string): Promise<string | null> {
  // Check CAAMP's lock file first (primary source of truth)
  try {
    const tracked = await caampGetTrackedSkills();
    const entry = tracked[name];
    if (entry?.version) return entry.version;
  } catch {
    // CAAMP lock file not available, fall through to local cache
  }

  // Fallback: check CLEO's local tracking
  const localVersion = getInstalledVersion(name);
  if (localVersion) return localVersion;

  return null;
}

/**
 * Check for skill updates using CAAMP's lock-based update checker.
 * Falls back to manifest comparison if CAAMP check is unavailable.
 *
 * @task T4521
 * @task T4680
 */
export function checkSkillUpdates(cwd?: string): Array<{
  name: string;
  installedVersion: string;
  availableVersion: string;
  needsUpdate: boolean;
}> {
  const manifestPath = getSourceManifestPath(cwd);
  if (!existsSync(manifestPath)) return [];

  let manifest: Array<{ name?: string; dirName?: string; version?: string }>;
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest = data.skills ?? [];
  } catch {
    return [];
  }

  const installed = readInstalledSkills();
  const updates: Array<{
    name: string;
    installedVersion: string;
    availableVersion: string;
    needsUpdate: boolean;
  }> = [];

  for (const skill of manifest) {
    const name = skill.dirName ?? skill.name ?? '';
    if (!name) continue;

    const available = skill.version ?? '0.0.0';
    const current = installed.skills[name]?.version ?? '0.0.0';
    const needsUpdate = compareVersions(available, current) > 0;

    updates.push({
      name,
      installedVersion: current,
      availableVersion: available,
      needsUpdate,
    });
  }

  return updates;
}

/**
 * Check if a single skill needs an update via CAAMP's lock-based checker.
 * Async because it reads the CAAMP lock file.
 *
 * @task T4680
 */
export async function checkSkillUpdateAsync(name: string): Promise<{
  needsUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
}> {
  try {
    const result = await caampCheckSkillUpdate(name);
    return {
      needsUpdate: result.hasUpdate,
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
    };
  } catch {
    // CAAMP check unavailable, fall back to local
    const local = getInstalledVersion(name);
    return { needsUpdate: false, currentVersion: local ?? undefined };
  }
}

/**
 * Apply skill updates (record new versions).
 * @task T4521
 */
export function applySkillUpdates(
  updates: Array<{ name: string; version: string; sourcePath: string; symlinkPath: string }>,
): number {
  let applied = 0;

  for (const update of updates) {
    recordSkillVersion(update.name, update.version, update.sourcePath, update.symlinkPath);
    applied++;
  }

  return applied;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compare two version strings (X.Y.Z format, works for both semver and CalVer).
 * Returns: positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }

  return 0;
}
