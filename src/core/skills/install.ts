/**
 * Skills installation functions.
 * Delegates CAAMP-managed skill installation to @cleocode/caamp.
 * Keeps local symlink installation for project-embedded skills.
 *
 * @epic T4454
 * @task T4521
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getCanonicalSkillsDir,
} from '@cleocode/caamp';
import { getProjectRoot } from '../paths.js';

// ============================================================================
// Configuration
// ============================================================================

/** Default target directory for installed skills (delegates to CAAMP). */
function getSkillsTargetDir(): string {
  return process.env['SKILLS_TARGET_DIR'] ?? getCanonicalSkillsDir();
}

/** Get the repo root (for skill source paths). */
function getRepoRoot(cwd?: string): string {
  return process.env['CLEO_REPO_ROOT'] ?? getProjectRoot(cwd);
}

// ============================================================================
// Manifest Reading
// ============================================================================

/**
 * Get skill names from the skills/manifest.json file.
 * @task T4521
 */
export function getSkillsFromManifest(cwd?: string): string[] {
  const repoRoot = getRepoRoot(cwd);
  const manifestPath = join(repoRoot, 'skills', 'manifest.json');

  if (!existsSync(manifestPath)) {
    return [];
  }

  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const skills = data.skills ?? [];
    return skills.map((s: { name?: string; dirName?: string }) => s.dirName ?? s.name ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Local Installation (symlink-based, for project-embedded skills)
// ============================================================================

/**
 * Install a single skill via symlink (local project skills).
 * @task T4521
 */
export function installSkill(
  skillName: string,
  cwd?: string,
): { installed: boolean; path: string; error?: string } {
  const targetDir = getSkillsTargetDir();
  const repoRoot = getRepoRoot(cwd);
  const sourcePath = join(repoRoot, 'skills', skillName);
  const targetPath = join(targetDir, skillName);

  // Ensure target directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Check source exists
  if (!existsSync(sourcePath)) {
    return { installed: false, path: targetPath, error: `Source not found: ${sourcePath}` };
  }

  // Handle existing entry
  if (existsSync(targetPath)) {
    try {
      const existing = readlinkSync(targetPath);
      if (existing === sourcePath) {
        return { installed: true, path: targetPath }; // Already correct
      }
      unlinkSync(targetPath);
    } catch {
      return { installed: false, path: targetPath, error: `Target exists and is not a symlink: ${targetPath}` };
    }
  }

  try {
    symlinkSync(sourcePath, targetPath, 'dir');
    return { installed: true, path: targetPath };
  } catch (err) {
    return { installed: false, path: targetPath, error: `Symlink failed: ${err}` };
  }
}

/**
 * Install all skills from manifest.
 * @task T4521
 */
export function installAllSkills(cwd?: string): Array<{
  name: string;
  installed: boolean;
  error?: string;
}> {
  const skillNames = getSkillsFromManifest(cwd);
  return skillNames.map(name => {
    const result = installSkill(name, cwd);
    return { name, installed: result.installed, error: result.error };
  });
}

/**
 * Uninstall a single skill by removing its symlink.
 * @task T4521
 */
export function uninstallSkill(skillName: string): boolean {
  const targetDir = getSkillsTargetDir();
  const targetPath = join(targetDir, skillName);

  if (!existsSync(targetPath)) return false;

  try {
    unlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Uninstall all installed skills.
 * @task T4521
 */
export function uninstallAllSkills(cwd?: string): string[] {
  const skillNames = getSkillsFromManifest(cwd);
  const removed: string[] = [];

  for (const name of skillNames) {
    if (uninstallSkill(name)) {
      removed.push(name);
    }
  }

  return removed;
}
