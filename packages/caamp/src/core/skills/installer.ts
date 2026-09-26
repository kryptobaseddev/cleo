/**
 * Skill installer - canonical + symlink model
 *
 * Skills are stored once in a canonical location (`~/.cleo/skills/<name>/`
 * per architecture-v3 §1, with legacy `~/.local/share/agents/skills/` as a
 * read-only fallback for one release cycle) and symlinked to each target
 * agent's skills directory.
 *
 * @task T9659
 * @epic T9571
 * @saga T9560
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { cp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveSkillsRoot } from '@cleocode/core/skills/skill-root.js';
import type { Provider } from '../../types.js';
import { resolveProviderSkillsDirs } from '../paths/standard.js';

/**
 * Source-type discriminator emitted with {@link SkillRowData}.
 *
 * @remarks
 * Mirrors the `source_type` column on the `skills` table defined in
 * architecture-v3 §4. Kept as a local string-literal union (NOT a
 * `@cleocode/core` import) so caamp stays free of a circular dep on core —
 * the dispatch layer in `packages/cleo/` is responsible for plugging the
 * `upsertSkillRow` callback that consumes this shape.
 *
 * @public
 */
export type SkillRowSourceType = 'canonical' | 'user' | 'community' | 'agent-created';

/**
 * Provenance payload emitted by {@link installSkill} after a successful copy.
 *
 * @remarks
 * The CAAMP installer ONLY emits this shape — it never writes to
 * `skills.db` directly. The dispatch layer in `packages/cleo/` (where it's
 * legal to import from `@cleocode/core`) plugs an `upsertSkillRow` callback
 * via {@link InstallSkillOptions.recordRow}. This keeps caamp free of a
 * `@cleocode/core` dependency (mirrors the migration callback pattern
 * established by T9653 — see `migration.ts`).
 *
 * @public
 */
export interface SkillRowData {
  /** Skill folder basename (matches `skills.name` column). */
  name: string;
  /** Resolved canonical install path under `~/.cleo/skills/<name>/`. */
  installPath: string;
  /** Source URL or identifier (matches `skills.source_url`). */
  sourceUrl: string | null;
  /**
   * Source provenance discriminator (matches `skills.source_type`).
   *
   * @remarks
   * Set to `'canonical'` for skills whose name appears in the bundled
   * Sphere A manifest; `'community'` for marketplace / GitHub-clone installs;
   * `'user'` for everything else (local-path installs, library installs).
   * Architecture-v3 §4 enumerates the full set.
   */
  sourceType: SkillRowSourceType;
}

/**
 * Optional knobs accepted by {@link installSkill}.
 *
 * @remarks
 * Encoded as an interface so future T-STORE follow-ups (e.g. `pinned`,
 * `version`) can be added without churning the call sites.
 *
 * @public
 */
export interface InstallSkillOptions {
  /**
   * Per-install sink invoked after a successful canonical copy.
   *
   * @remarks
   * Caamp NEVER imports `@cleocode/core` directly — the dispatch layer in
   * `packages/cleo/` plugs `upsertSkillRow` here so installs are recorded
   * to `~/.cleo/skills.db`. Defaults to a no-op when omitted. May be sync
   * or async; thrown errors propagate to the caller.
   */
  recordRow?: (row: SkillRowData) => Promise<void> | void;

  /**
   * Explicit `sourceUrl` to record on the row.
   *
   * @remarks
   * When omitted, falls back to the `sourcePath` argument. Callers that
   * resolve a library or marketplace identifier (e.g. `library:ct-foo` or
   * `https://github.com/owner/repo`) BEFORE copying to a tmpdir should set
   * this so the row preserves the original provenance string instead of
   * the disposable filesystem path.
   */
  sourceUrl?: string | null;

  /**
   * Explicit `sourceType` to record on the row.
   *
   * @remarks
   * When omitted, the type is heuristically inferred from
   * {@link InstallSkillOptions.sourceUrl} (or `sourcePath` as a fallback)
   * via {@link inferSkillSourceType}. Dispatch-layer callers that know the
   * authoritative provenance (e.g. catalog → `'canonical'`, GitHub URL →
   * `'community'`) SHOULD set this explicitly to bypass the heuristic.
   */
  sourceType?: SkillRowSourceType;
}

/**
 * Result of installing a skill to the canonical location and linking to agents.
 *
 * @example
 * ```typescript
 * const result = await installSkill(sourcePath, "my-skill", providers, true);
 * if (result.success) {
 *   console.log(`Installed to ${result.canonicalPath}`);
 *   console.log(`Linked to: ${result.linkedAgents.join(", ")}`);
 * }
 * ```
 *
 * @public
 */
export interface SkillInstallResult {
  /** Skill name. */
  name: string;
  /** Absolute path to the canonical installation directory. */
  canonicalPath: string;
  /** Provider IDs that were successfully linked. */
  linkedAgents: string[];
  /** Error messages from failed link operations. */
  errors: string[];
  /** Whether at least one agent was successfully linked. */
  success: boolean;
}

/** Ensure canonical skills directory exists */
async function ensureCanonicalDir(): Promise<void> {
  await mkdir(resolveSkillsRoot(), { recursive: true });
}

/**
 * Whether anything — file, directory, or symlink (including a dangling one) —
 * occupies `path`.
 *
 * @remarks
 * `existsSync` follows symlinks, so a dangling link reports `false` even though
 * a rename onto that path would still collide with it. `lstat` does not follow.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a hidden sibling path for a staging or set-aside entry.
 *
 * @remarks
 * Siblings share the target's filesystem, which is what makes the final
 * `rename(2)` atomic. The leading dot keeps them out of listings, and the
 * random suffix keeps concurrent installs of the same skill apart.
 */
function siblingPath(targetPath: string, role: 'staging' | 'previous'): string {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return join(dirname(targetPath), `.${basename(targetPath)}.caamp-${role}-${suffix}`);
}

/** Rename error codes that mean another writer occupied the target first. */
const TARGET_OCCUPIED_CODES: ReadonlySet<string> = new Set(['EEXIST', 'ENOTEMPTY', 'EISDIR']);

/** Extract a Node errno code from a thrown value, or `''`. */
function errnoCode(err: Error | string | object | null | undefined): string {
  return err instanceof Error && 'code' in err ? String(err.code) : '';
}

/**
 * Move a fully staged entry onto `targetPath` without ever deleting the entry
 * it replaces before the replacement is in place.
 *
 * @remarks
 * T12383. The previous installer ran `rm -rf <target>` and only then copied
 * the new source; when the copy failed (for instance because the "source" was
 * the unresolved string `library:<name>`) the installed skill was gone.
 *
 * The swap moves the current entry aside to a hidden sibling, renames the
 * staged entry into place, then deletes the set-aside copy. If the second
 * rename fails, the set-aside copy is renamed back, so a failure at any step
 * leaves the original entry where it was. POSIX offers no portable atomic
 * exchange of two directories, so the path is absent for the span of one
 * `rename(2)` — but no step discards data that has not already been superseded
 * on disk.
 *
 * When a concurrent installer occupies the path between the two renames, the
 * swap retries a bounded number of times; the last writer wins, as before.
 *
 * @param stagedPath - A complete replacement, on the same filesystem as `targetPath`
 * @param targetPath - The path to replace (need not exist)
 * @throws The underlying filesystem error when the swap cannot complete; the
 *   original entry is restored before the error propagates
 *
 * @example
 * ```typescript
 * const staged = await stageSkillCopy("/tmp/my-skill", target);
 * await swapIntoPlace(staged, target);
 * ```
 *
 * @public
 */
export async function swapIntoPlace(stagedPath: string, targetPath: string): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    let previousPath: string | null = null;
    if (entryExists(targetPath)) {
      previousPath = siblingPath(targetPath, 'previous');
      await rename(targetPath, previousPath);
    }
    try {
      await rename(stagedPath, targetPath);
    } catch (err) {
      if (previousPath !== null) {
        if (entryExists(targetPath)) {
          // Another writer landed a complete entry after ours was set aside;
          // theirs supersedes the copy we moved away.
          await rm(previousPath, { recursive: true, force: true });
        } else {
          await rename(previousPath, targetPath);
        }
      }
      const code = errnoCode(err instanceof Error ? err : null);
      if (TARGET_OCCUPIED_CODES.has(code) && attempt < maxAttempts) continue;
      throw err;
    }
    if (previousPath !== null) {
      await rm(previousPath, { recursive: true, force: true });
    }
    return;
  }
}

/**
 * Copy `sourcePath` into a hidden staging sibling of `targetPath`.
 *
 * @remarks
 * Nothing at `targetPath` is touched. If the copy fails the partial staging
 * directory is removed and the error propagates.
 *
 * @param sourcePath - Directory to copy
 * @param targetPath - Path the staged copy will later replace
 * @returns Absolute path of the complete staged copy
 * @throws The copy error (e.g. `ENOENT` when `sourcePath` does not exist)
 *
 * @example
 * ```typescript
 * const staged = await stageSkillCopy("/tmp/my-skill", "/home/u/.cleo/skills/my-skill");
 * ```
 *
 * @public
 */
export async function stageSkillCopy(sourcePath: string, targetPath: string): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true });
  const stagedPath = siblingPath(targetPath, 'staging');
  try {
    await cp(sourcePath, stagedPath, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    await rm(stagedPath, { recursive: true, force: true });
    throw err;
  }
  return stagedPath;
}

/**
 * Replace the directory at `targetPath` with a copy of `sourcePath`, staging
 * the copy completely before anything existing is moved.
 *
 * @param sourcePath - Directory to copy
 * @param targetPath - Directory to replace (need not exist)
 * @throws When the copy or the swap fails; the existing directory is kept
 *
 * @example
 * ```typescript
 * await replaceDirectoryFromSource("/tmp/my-skill", "/home/u/.pi/agent/skills/my-skill");
 * ```
 *
 * @public
 */
export async function replaceDirectoryFromSource(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const stagedPath = await stageSkillCopy(sourcePath, targetPath);
  try {
    await swapIntoPlace(stagedPath, targetPath);
  } catch (err) {
    await rm(stagedPath, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Copy skill files to the canonical location.
 *
 * @remarks
 * T12383: the new copy is staged in full beside the target and then swapped
 * in (see {@link swapIntoPlace}). The existing installation is never removed
 * before its replacement exists, so a failing source — a missing path, an
 * unresolved `library:<name>` id, a copy error part-way through — leaves the
 * installed skill exactly as it was.
 *
 * @param sourcePath - Absolute path to the source skill directory to copy
 * @param skillName - Name for the skill (used as the subdirectory name)
 * @returns Absolute path to the canonical installation directory
 * @throws When the source cannot be copied; the existing copy is preserved
 *
 * @example
 * ```typescript
 * const canonicalPath = await installToCanonical("/tmp/my-skill", "my-skill");
 * console.log(`Installed to: ${canonicalPath}`);
 * ```
 *
 * @public
 */
export async function installToCanonical(sourcePath: string, skillName: string): Promise<string> {
  await ensureCanonicalDir();

  const targetDir = join(resolveSkillsRoot(), skillName);
  await replaceDirectoryFromSource(sourcePath, targetDir);
  return targetDir;
}

/** Whether `linkPath` is already a symlink pointing at `canonicalPath`. */
function isLinkTo(linkPath: string, canonicalPath: string): boolean {
  try {
    return lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === canonicalPath;
  } catch {
    return false;
  }
}

/** Create symlinks from an agent's skills directories to the canonical location */
async function linkToAgent(
  canonicalPath: string,
  provider: Provider,
  skillName: string,
  isGlobal: boolean,
  projectDir?: string,
): Promise<{ success: boolean; error?: string }> {
  const scope = isGlobal ? 'global' : 'project';
  const targetDirs = resolveProviderSkillsDirs(provider, scope, projectDir);

  if (targetDirs.length === 0) {
    return { success: false, error: `Provider ${provider.id} has no skills directory` };
  }

  const errors: string[] = [];
  let anySuccess = false;

  for (const targetSkillsDir of targetDirs) {
    if (!targetSkillsDir) continue;

    try {
      await mkdir(targetSkillsDir, { recursive: true });

      const linkPath = join(targetSkillsDir, skillName);
      if (isLinkTo(linkPath, canonicalPath)) {
        anySuccess = true;
        continue;
      }

      // T12383: stage the new link (or copy) beside the existing entry, then
      // swap it in. The existing link or directory is discarded only once its
      // replacement is in place. Junction on Windows for compat.
      const stagedPath = siblingPath(linkPath, 'staging');
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        await symlink(canonicalPath, stagedPath, symlinkType);
      } catch {
        // Fallback to copy if symlinks not supported
        await rm(stagedPath, { recursive: true, force: true });
        await cp(canonicalPath, stagedPath, { recursive: true });
      }
      try {
        await swapIntoPlace(stagedPath, linkPath);
      } catch (err) {
        await rm(stagedPath, { recursive: true, force: true });
        throw err;
      }

      anySuccess = true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (anySuccess) {
    return { success: true };
  }
  return {
    success: false,
    error: errors.join('; ') || `Provider ${provider.id} has no skills directory`,
  };
}

/**
 * Heuristic source-type classifier for installs that don't carry an explicit
 * `source_type`.
 *
 * @remarks
 * Pure string inspection — keeps the installer free of network calls and
 * filesystem reads. The dispatch layer can ALWAYS override the result by
 * passing an explicit row through {@link InstallSkillOptions.recordRow}.
 *
 * Classification rules:
 *
 * 1. `library:<name>` → `'canonical'` (installed from the bundled Sphere A
 *    skill library — `packages/skills/skills/`).
 * 2. `github.com` / `gitlab.com` / scoped `@author/name` → `'community'`.
 * 3. Anything else (local paths, opaque values) → `'user'`.
 *
 * @param sourceUrl - The source identifier passed to {@link installSkill}.
 *   `null` is treated as `'user'`.
 * @returns The inferred source-type discriminator.
 *
 * @public
 */
export function inferSkillSourceType(sourceUrl: string | null | undefined): SkillRowSourceType {
  if (!sourceUrl) return 'user';
  if (sourceUrl.startsWith('library:')) return 'canonical';
  if (
    sourceUrl.startsWith('@') ||
    sourceUrl.includes('github.com') ||
    sourceUrl.includes('gitlab.com') ||
    sourceUrl.includes('://')
  ) {
    return 'community';
  }
  return 'user';
}

/**
 * Install a skill from a local path to the canonical location and link to agents.
 *
 * @remarks
 * Copies the skill directory to the canonical skills directory and creates symlinks
 * (or copies on Windows) from each provider's skills directory to the canonical path.
 *
 * **T9659** — when `options.recordRow` is supplied, the callback is invoked
 * with a {@link SkillRowData} payload after the canonical copy lands and
 * BEFORE provider linking. This is the integration seam that the cleo
 * dispatch layer uses to plug `upsertSkillRow` from
 * `@cleocode/core/store/skills-db` into `~/.cleo/skills.db`. The row is
 * recorded regardless of whether subsequent provider linking succeeds — the
 * canonical install is itself the durable artefact.
 *
 * @param sourcePath - Local path to the skill directory to install
 * @param skillName - Name for the installed skill
 * @param providers - Target providers to link the skill to
 * @param isGlobal - Whether to link to global or project skill directories
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @param options - Optional callbacks (incl. `recordRow` for `skills.db`)
 * @returns Install result with linked agents and any errors
 *
 * @example
 * ```typescript
 * const result = await installSkill(
 *   "/tmp/my-skill",
 *   "my-skill",
 *   providers,
 *   true,
 *   "/my/project",
 *   {
 *     recordRow: async (row) => upsertSkillRow({
 *       name: row.name,
 *       installPath: row.installPath,
 *       sourceType: row.sourceType,
 *       sourceUrl: row.sourceUrl,
 *       installedAt: new Date().toISOString(),
 *     }),
 *   },
 * );
 * ```
 *
 * @public
 */
export async function installSkill(
  sourcePath: string,
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string,
  options?: InstallSkillOptions,
): Promise<SkillInstallResult> {
  const errors: string[] = [];
  const linkedAgents: string[] = [];

  // Step 1: Install to canonical location
  const canonicalPath = await installToCanonical(sourcePath, skillName);

  // Step 2: Emit provenance row (T9659) BEFORE provider linking so the DB
  // reflects the canonical artefact even when downstream linking fails.
  if (options?.recordRow) {
    const resolvedSourceUrl = options.sourceUrl ?? sourcePath;
    const resolvedSourceType = options.sourceType ?? inferSkillSourceType(resolvedSourceUrl);
    await options.recordRow({
      name: skillName,
      installPath: canonicalPath,
      sourceUrl: resolvedSourceUrl,
      sourceType: resolvedSourceType,
    });
  }

  // Step 3: Link to each agent
  for (const provider of providers) {
    const result = await linkToAgent(canonicalPath, provider, skillName, isGlobal, projectDir);
    if (result.success) {
      linkedAgents.push(provider.id);
    } else if (result.error) {
      errors.push(`${provider.id}: ${result.error}`);
    }
  }

  return {
    name: skillName,
    canonicalPath,
    linkedAgents,
    errors,
    success: linkedAgents.length > 0,
  };
}

/**
 * Remove a skill from the canonical location and all agent symlinks.
 *
 * @remarks
 * Removes symlinks from each provider's skills directory and then removes the
 * canonical copy from the centralized canonical skills directory.
 *
 * @param skillName - Name of the skill to remove
 * @param providers - Providers to unlink the skill from
 * @param isGlobal - Whether to target global or project skill directories
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns Object with arrays of successfully removed provider IDs and error messages
 *
 * @example
 * ```typescript
 * const { removed, errors } = await removeSkill("my-skill", providers, true, "/my/project");
 * console.log(`Removed from: ${removed.join(", ")}`);
 * ```
 *
 * @public
 */
export async function removeSkill(
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string,
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  // Remove symlinks from each agent (all precedence-aware paths)
  for (const provider of providers) {
    const scope = isGlobal ? 'global' : 'project';
    const targetDirs = resolveProviderSkillsDirs(provider, scope, projectDir);
    let providerRemoved = false;

    for (const skillsDir of targetDirs) {
      if (!skillsDir) continue;

      const linkPath = join(skillsDir, skillName);
      if (existsSync(linkPath)) {
        try {
          await rm(linkPath, { recursive: true });
          providerRemoved = true;
        } catch (err) {
          errors.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (providerRemoved) {
      removed.push(provider.id);
    }
  }

  // Remove canonical copy
  const canonicalPath = join(resolveSkillsRoot(), skillName);
  if (existsSync(canonicalPath)) {
    try {
      await rm(canonicalPath, { recursive: true });
    } catch (err) {
      errors.push(`canonical: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed, errors };
}

/**
 * List all skills installed in the canonical skills directory.
 *
 * @remarks
 * Returns the directory names of all skills, which correspond to skill names.
 * Includes both regular directories and symlinks in the canonical location.
 *
 * @returns Array of skill names
 *
 * @example
 * ```typescript
 * const skills = await listCanonicalSkills();
 * // ["my-skill", "another-skill"]
 * ```
 *
 * @public
 */
export async function listCanonicalSkills(): Promise<string[]> {
  if (!existsSync(resolveSkillsRoot())) return [];

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(resolveSkillsRoot(), { withFileTypes: true });
  // Hidden entries are in-flight staging/set-aside copies (T12383), not skills.
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => e.name);
}
