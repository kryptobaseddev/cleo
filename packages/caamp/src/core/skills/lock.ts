/**
 * Skills lock file management
 *
 * Shares the same canonical lock file as MCP.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit } from 'simple-git';
import type { LockEntry, SourceType } from '../../types.js';
import { readLockFile, updateLockFile } from '../lock-utils.js';
import { parseSource } from '../sources/parser.js';

const execFileAsync = promisify(execFile);

/**
 * Record a skill installation in the lock file.
 *
 * @remarks
 * Creates or updates an entry in `lock.skills`. If the skill already exists,
 * the agent list is merged and `updatedAt` is refreshed while `installedAt` is preserved.
 *
 * @param skillName - Skill name
 * @param scopedName - Scoped name (may include marketplace scope)
 * @param source - Original source string
 * @param sourceType - Classified source type
 * @param agents - Provider IDs the skill was linked to
 * @param canonicalPath - Absolute path to the canonical installation
 * @param isGlobal - Whether this is a global installation
 * @param projectDir - Project directory (for project-scoped installs)
 * @param version - Version string or commit SHA
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "../paths/standard.js";
 * import { join } from "node:path";
 *
 * await recordSkillInstall(
 *   "my-skill", "my-skill", "owner/repo", "github",
 *   ["claude-code"], join(getCanonicalSkillsDir(), "my-skill"), true,
 * );
 * ```
 *
 * @public
 */
export async function recordSkillInstall(
  skillName: string,
  scopedName: string,
  source: string,
  sourceType: SourceType,
  agents: string[],
  canonicalPath: string,
  isGlobal: boolean,
  projectDir?: string,
  version?: string,
): Promise<void> {
  await updateLockFile((lock) => {
    const now = new Date().toISOString();
    const existing = lock.skills[skillName];

    lock.skills[skillName] = {
      name: skillName,
      scopedName: existing?.scopedName ?? scopedName,
      source: existing?.source ?? source,
      sourceType: existing?.sourceType ?? sourceType,
      version: version ?? existing?.version,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      agents: [...new Set([...(existing?.agents ?? []), ...agents])],
      canonicalPath,
      isGlobal: existing?.isGlobal ?? isGlobal,
      projectDir: existing?.projectDir ?? projectDir,
    };
  });
}

/**
 * Remove a skill entry from the lock file.
 *
 * @remarks
 * Deletes the skill's entry from `lock.skills` if it exists. Does not remove
 * any files from disk.
 *
 * @param skillName - Name of the skill to remove
 * @returns `true` if the entry was found and removed, `false` if not found
 *
 * @example
 * ```typescript
 * const removed = await removeSkillFromLock("my-skill");
 * console.log(removed ? "Removed" : "Not found");
 * ```
 *
 * @public
 */
export async function removeSkillFromLock(skillName: string): Promise<boolean> {
  let removed = false;
  await updateLockFile((lock) => {
    if (!(skillName in lock.skills)) return;
    delete lock.skills[skillName];
    removed = true;
  });
  return removed;
}

/**
 * Get all skills tracked in the lock file.
 *
 * @remarks
 * Reads the lock file and returns the skills section as a record.
 *
 * @returns Record of skill name to lock entry
 *
 * @example
 * ```typescript
 * const skills = await getTrackedSkills();
 * for (const [name, entry] of Object.entries(skills)) {
 *   console.log(`${name}: ${entry.source}`);
 * }
 * ```
 *
 * @public
 */
export async function getTrackedSkills(): Promise<Record<string, LockEntry>> {
  const lock = await readLockFile();
  return lock.skills;
}

/** Fetch the latest commit SHA for a GitHub/GitLab repo via ls-remote */
async function fetchLatestSha(repoUrl: string, ref?: string): Promise<string | null> {
  try {
    const git = simpleGit();
    const target = ref ?? 'HEAD';
    // Use --refs only for named refs (branches/tags), not for HEAD
    const args = target === 'HEAD' ? [repoUrl, 'HEAD'] : ['--refs', repoUrl, target];
    const result = await git.listRemote(args);
    const firstLine = result.trim().split('\n')[0];
    if (!firstLine) return null;
    const sha = firstLine.split('\t')[0];
    return sha ?? null;
  } catch {
    return null;
  }
}

/** Fetch the latest version for an npm package via npm view */
async function fetchLatestPackageVersion(packageName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', packageName, 'version']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a skill has updates available by comparing the installed version
 * against the latest remote commit SHA.
 *
 * @remarks
 * Only supports GitHub, GitLab, and library (package-based) sources. Returns `"unknown"` for local,
 * package, or other source types.
 *
 * @param skillName - Name of the installed skill to check
 * @returns Object with update status, current version, and latest version
 *
 * @example
 * ```typescript
 * const update = await checkSkillUpdate("my-skill");
 * if (update.hasUpdate) {
 *   console.log(`Update available: ${update.currentVersion} -> ${update.latestVersion}`);
 * }
 * ```
 *
 * @public
 */
export async function checkSkillUpdate(skillName: string): Promise<{
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  status: 'up-to-date' | 'update-available' | 'unknown';
}> {
  const lock = await readLockFile();
  const entry = lock.skills[skillName];
  if (!entry) {
    return { hasUpdate: false, status: 'unknown' };
  }

  // Only GitHub, GitLab, and library sources support remote checking
  if (
    entry.sourceType !== 'github' &&
    entry.sourceType !== 'gitlab' &&
    entry.sourceType !== 'library'
  ) {
    return {
      hasUpdate: false,
      currentVersion: entry.version,
      status: 'unknown',
    };
  }

  const parsed = parseSource(entry.source);
  if (!parsed.owner) {
    return {
      hasUpdate: false,
      currentVersion: entry.version,
      status: 'unknown',
    };
  }

  if (entry.sourceType === 'library') {
    const packageName = parsed.owner; // owner holds the package name for library type
    const latestVersion = await fetchLatestPackageVersion(packageName);
    if (!latestVersion) {
      return {
        hasUpdate: false,
        currentVersion: entry.version,
        status: 'unknown',
      };
    }
    const currentVersion = entry.version;
    const hasUpdate = !currentVersion || currentVersion !== latestVersion;
    return {
      hasUpdate,
      currentVersion: currentVersion ?? 'unknown',
      latestVersion,
      status: hasUpdate ? 'update-available' : 'up-to-date',
    };
  }

  if (!parsed.repo) {
    return {
      hasUpdate: false,
      currentVersion: entry.version,
      status: 'unknown',
    };
  }

  const host = parsed.type === 'gitlab' ? 'gitlab.com' : 'github.com';
  const repoUrl = `https://${host}/${parsed.owner}/${parsed.repo}.git`;
  const latestSha = await fetchLatestSha(repoUrl, parsed.ref);

  if (!latestSha) {
    return {
      hasUpdate: false,
      currentVersion: entry.version,
      status: 'unknown',
    };
  }

  const currentVersion = entry.version;
  const hasUpdate = !currentVersion || !latestSha.startsWith(currentVersion.slice(0, 7));

  return {
    hasUpdate,
    currentVersion: currentVersion ?? 'unknown',
    latestVersion: latestSha.slice(0, 12),
    status: hasUpdate ? 'update-available' : 'up-to-date',
  };
}

/**
 * Check for updates across all tracked skills.
 *
 * @remarks
 * Iterates over all skills in the lock file and checks each one concurrently
 * via {@link checkSkillUpdate}.
 *
 * @returns Object mapping skill names to their update status
 *
 * @example
 * ```typescript
 * const updates = await checkAllSkillUpdates();
 * for (const [name, status] of Object.entries(updates)) {
 *   if (status.hasUpdate) {
 *     console.log(`${name}: ${status.currentVersion} -> ${status.latestVersion}`);
 *   }
 * }
 * ```
 *
 * @public
 */
export async function checkAllSkillUpdates(): Promise<
  Record<
    string,
    {
      hasUpdate: boolean;
      currentVersion?: string;
      latestVersion?: string;
      status: 'up-to-date' | 'update-available' | 'unknown';
    }
  >
> {
  const lock = await readLockFile();
  const skillNames = Object.keys(lock.skills);

  const results: Record<
    string,
    {
      hasUpdate: boolean;
      currentVersion?: string;
      latestVersion?: string;
      status: 'up-to-date' | 'update-available' | 'unknown';
    }
  > = {};
  await Promise.all(
    skillNames.map(async (name) => {
      results[name] = await checkSkillUpdate(name);
    }),
  );

  return results;
}
