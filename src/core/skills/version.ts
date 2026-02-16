/**
 * Skills version tracking.
 * Delegates lock file tracking to @cleocode/caamp for canonical skill versions.
 * Keeps CLEO's local installed-skills.json for project-specific tracking.
 *
 * @epic T4454
 * @task T4521
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
} from '@cleocode/caamp';
import { getCleoHome, getProjectRoot } from '../paths.js';
import type { InstalledSkillsFile } from './types.js';

// ============================================================================
// Paths
// ============================================================================

/**
 * Get the installed skills tracking file path.
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
// File Operations
// ============================================================================

/**
 * Read the installed skills file.
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
 * Save the installed skills file.
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
// Version Tracking
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
 * @task T4521
 */
export function recordSkillVersion(
  name: string,
  version: string,
  sourcePath: string,
  symlinkPath: string,
): void {
  const data = readInstalledSkills();

  data.skills[name] = {
    name,
    version,
    installedAt: new Date().toISOString(),
    sourcePath,
    symlinkPath,
  };

  saveInstalledSkills(data);
}

/**
 * Get the installed version of a skill from CLEO's local tracking.
 * @task T4521
 */
export function getInstalledVersion(name: string): string | null {
  const data = readInstalledSkills();
  return data.skills[name]?.version ?? null;
}

/**
 * Get the installed version of a skill, checking CAAMP's lock file as fallback.
 * Async because CAAMP's getTrackedSkills reads the lock file asynchronously.
 * @task T4521
 */
export async function getInstalledVersionAsync(name: string): Promise<string | null> {
  // Check CLEO's local tracking first
  const localVersion = getInstalledVersion(name);
  if (localVersion) return localVersion;

  // Fallback: check CAAMP's tracked skills
  try {
    const tracked = await caampGetTrackedSkills();
    const entry = tracked[name];
    if (entry?.version) return entry.version;
  } catch {
    // CAAMP lock file not available
  }

  return null;
}

/**
 * Check for skill updates by comparing installed versions against manifest.
 * @task T4521
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
