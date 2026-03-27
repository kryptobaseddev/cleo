/**
 * Skill integrity checking
 *
 * Validates that installed skills have intact symlinks, correct canonical paths,
 * and enforces ct-* prefix priority for CAAMP-shipped skills.
 */

import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LockEntry, Provider } from '../../types.js';
import { readLockFile } from '../lock-utils.js';
import { getCanonicalSkillsDir, resolveProviderSkillsDirs } from '../paths/standard.js';

/** CAAMP-reserved skill prefix. Skills with this prefix are owned by CAAMP. */
const CAAMP_SKILL_PREFIX = 'ct-';

/**
 * Status of a single skill's integrity check.
 *
 * @public
 */
export type SkillIntegrityStatus =
  | 'intact'
  | 'broken-symlink'
  | 'missing-canonical'
  | 'missing-link'
  | 'not-tracked'
  | 'tampered';

/**
 * Result of checking a single skill's integrity.
 *
 * @public
 */
export interface SkillIntegrityResult {
  /** Skill name. */
  name: string;
  /** Overall integrity status. */
  status: SkillIntegrityStatus;
  /** Whether the canonical directory exists. */
  canonicalExists: boolean;
  /** Expected canonical path from lock file. */
  canonicalPath: string | null;
  /** Provider link statuses — which agents have valid symlinks. */
  linkStatuses: Array<{
    providerId: string;
    linkPath: string;
    exists: boolean;
    isSymlink: boolean;
    pointsToCanonical: boolean;
  }>;
  /** Whether this is a CAAMP-reserved (ct-*) skill. */
  isCaampOwned: boolean;
  /** Human-readable issue description, if any. */
  issue?: string;
}

/**
 * Check whether a skill name is reserved by CAAMP (ct-* prefix).
 *
 * @remarks
 * Skills with the `ct-` prefix are considered CAAMP-owned and receive
 * special treatment during installation conflict resolution.
 *
 * @param skillName - Skill name to check
 * @returns `true` if the skill name starts with `ct-`
 *
 * @example
 * ```typescript
 * isCaampOwnedSkill("ct-research-agent"); // true
 * isCaampOwnedSkill("my-custom-skill");   // false
 * ```
 *
 * @public
 */
export function isCaampOwnedSkill(skillName: string): boolean {
  return skillName.startsWith(CAAMP_SKILL_PREFIX);
}

/**
 * Check the integrity of a single installed skill.
 *
 * @remarks
 * Validates that the canonical directory exists on disk, the lock file entry
 * matches the actual state, and symlinks from provider skill directories
 * point to the canonical path.
 *
 * @param skillName - Name of the skill to check
 * @param providers - Providers to check symlinks for
 * @param scope - Whether to check global or project links
 * @param projectDir - Project directory (for project scope)
 * @returns Integrity check result
 *
 * @example
 * ```typescript
 * const result = await checkSkillIntegrity("ct-research-agent", providers, "global");
 * if (result.status !== "intact") {
 *   console.log(`Issue: ${result.issue}`);
 * }
 * ```
 *
 * @public
 */
export async function checkSkillIntegrity(
  skillName: string,
  providers: Provider[],
  scope: 'global' | 'project' = 'global',
  projectDir?: string,
): Promise<SkillIntegrityResult> {
  const lock = await readLockFile();
  const entry = lock.skills[skillName];
  const isCaampOwned = isCaampOwnedSkill(skillName);

  // Not tracked in lock file
  if (!entry) {
    const canonicalPath = join(getCanonicalSkillsDir(), skillName);
    return {
      name: skillName,
      status: 'not-tracked',
      canonicalExists: existsSync(canonicalPath),
      canonicalPath: null,
      linkStatuses: [],
      isCaampOwned,
      issue: 'Skill is not tracked in the CAAMP lock file',
    };
  }

  const canonicalPath = entry.canonicalPath;
  const canonicalExists = existsSync(canonicalPath);

  // Check symlinks for each provider
  const linkStatuses: SkillIntegrityResult['linkStatuses'] = [];

  for (const provider of providers) {
    const targetDirs = resolveProviderSkillsDirs(provider, scope, projectDir);
    for (const skillsDir of targetDirs) {
      if (!skillsDir) continue;

      const linkPath = join(skillsDir, skillName);
      const exists = existsSync(linkPath);
      let isSymlink = false;
      let pointsToCanonical = false;

      if (exists) {
        try {
          const stat = lstatSync(linkPath);
          isSymlink = stat.isSymbolicLink();
          if (isSymlink) {
            const target = resolve(readlinkSync(linkPath));
            pointsToCanonical = target === resolve(canonicalPath);
          }
        } catch {
          // Can't stat — treat as broken
        }
      }

      linkStatuses.push({
        providerId: provider.id,
        linkPath,
        exists,
        isSymlink,
        pointsToCanonical,
      });
    }
  }

  // Determine overall status
  if (!canonicalExists) {
    return {
      name: skillName,
      status: 'missing-canonical',
      canonicalExists,
      canonicalPath,
      linkStatuses,
      isCaampOwned,
      issue: `Canonical directory missing: ${canonicalPath}`,
    };
  }

  const brokenLinks = linkStatuses.filter((l) => !l.exists);
  const tamperedLinks = linkStatuses.filter((l) => l.exists && !l.pointsToCanonical);

  if (tamperedLinks.length > 0) {
    return {
      name: skillName,
      status: 'tampered',
      canonicalExists,
      canonicalPath,
      linkStatuses,
      isCaampOwned,
      issue: `${tamperedLinks.length} link(s) do not point to canonical path`,
    };
  }

  if (brokenLinks.length > 0) {
    return {
      name: skillName,
      status: 'broken-symlink',
      canonicalExists,
      canonicalPath,
      linkStatuses,
      isCaampOwned,
      issue: `${brokenLinks.length} symlink(s) missing`,
    };
  }

  return {
    name: skillName,
    status: 'intact',
    canonicalExists,
    canonicalPath,
    linkStatuses,
    isCaampOwned,
  };
}

/**
 * Check integrity of all tracked skills.
 *
 * @remarks
 * Iterates over every skill in the lock file and runs
 * {@link checkSkillIntegrity} on each.
 *
 * @param providers - Providers to check symlinks for
 * @param scope - Whether to check global or project links
 * @param projectDir - Project directory (for project scope)
 * @returns Map of skill name to integrity result
 *
 * @example
 * ```typescript
 * const results = await checkAllSkillIntegrity(providers);
 * for (const [name, result] of results) {
 *   console.log(`${name}: ${result.status}`);
 * }
 * ```
 *
 * @public
 */
export async function checkAllSkillIntegrity(
  providers: Provider[],
  scope: 'global' | 'project' = 'global',
  projectDir?: string,
): Promise<Map<string, SkillIntegrityResult>> {
  const lock = await readLockFile();
  const results = new Map<string, SkillIntegrityResult>();

  for (const skillName of Object.keys(lock.skills)) {
    const result = await checkSkillIntegrity(skillName, providers, scope, projectDir);
    results.set(skillName, result);
  }

  return results;
}

/**
 * Resolve a skill name conflict where a user-installed skill collides
 * with a CAAMP-owned (ct-*) skill.
 *
 * @remarks
 * CAAMP-owned skills always win. Returns `true` if the incoming skill
 * should take precedence over the existing installation.
 *
 * @param skillName - Skill name to check
 * @param incomingSource - Source of the incoming skill installation
 * @param existingEntry - Existing lock entry, if any
 * @returns `true` if the incoming installation should proceed
 *
 * @example
 * ```typescript
 * const proceed = shouldOverrideSkill("ct-research-agent", "library", existingEntry);
 * if (proceed) {
 *   // Safe to install/override
 * }
 * ```
 *
 * @public
 */
export function shouldOverrideSkill(
  skillName: string,
  incomingSource: string,
  existingEntry: LockEntry | undefined,
): boolean {
  // No existing entry — always allow
  if (!existingEntry) return true;

  // For ct-* skills, CAAMP package source always wins
  if (isCaampOwnedSkill(skillName)) {
    // If incoming is from CAAMP package (library source), it always wins
    if (existingEntry.sourceType === 'library') return true;
    // If existing is from CAAMP but incoming is user, CAAMP wins (block user)
    return true;
  }

  // Non-ct-* skills: user always wins
  return true;
}

/**
 * Validate instruction file injection status across all providers.
 *
 * @remarks
 * Checks that CAAMP blocks exist and are current in all relevant
 * instruction files (CLAUDE.md, AGENTS.md, GEMINI.md).
 *
 * @param providers - Providers to check
 * @param projectDir - Project directory
 * @param scope - Whether to check global or project files
 * @param expectedContent - Expected CAAMP block content
 * @returns Array of file paths with issues
 *
 * @example
 * ```typescript
 * const issues = await validateInstructionIntegrity(providers, process.cwd(), "project");
 * for (const issue of issues) {
 *   console.log(`${issue.providerId}: ${issue.issue} (${issue.file})`);
 * }
 * ```
 *
 * @public
 */
export async function validateInstructionIntegrity(
  providers: Provider[],
  projectDir: string,
  scope: 'project' | 'global',
  expectedContent?: string,
): Promise<Array<{ file: string; providerId: string; issue: string }>> {
  const { checkAllInjections } = await import('../instructions/injector.js');
  const results = await checkAllInjections(providers, projectDir, scope, expectedContent);
  const issues: Array<{ file: string; providerId: string; issue: string }> = [];

  for (const result of results) {
    if (result.status === 'missing') {
      issues.push({
        file: result.file,
        providerId: result.provider,
        issue: 'Instruction file does not exist',
      });
    } else if (result.status === 'none') {
      issues.push({
        file: result.file,
        providerId: result.provider,
        issue: 'No CAAMP injection block found',
      });
    } else if (result.status === 'outdated') {
      issues.push({
        file: result.file,
        providerId: result.provider,
        issue: 'CAAMP injection block is outdated',
      });
    }
  }

  return issues;
}
