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

import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provider } from '../../types.js';
import { getCanonicalSkillsDir, resolveProviderSkillsDirs } from '../paths/standard.js';

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
  await mkdir(getCanonicalSkillsDir(), { recursive: true });
}

/**
 * Copy skill files to the canonical location.
 *
 * @remarks
 * Removes any existing installation at the target directory before copying.
 * Handles race conditions where another concurrent install may create the
 * directory between removal and copy by retrying the operation.
 *
 * @param sourcePath - Absolute path to the source skill directory to copy
 * @param skillName - Name for the skill (used as the subdirectory name)
 * @returns Absolute path to the canonical installation directory
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

  const targetDir = join(getCanonicalSkillsDir(), skillName);

  // Remove existing (force: true ignores ENOENT if it doesn't exist)
  await rm(targetDir, { recursive: true, force: true });

  try {
    await cp(sourcePath, targetDir, { recursive: true });
  } catch (err: unknown) {
    // Handle race condition: another concurrent install may have created the dir
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourcePath, targetDir, { recursive: true });
    } else {
      throw err;
    }
  }

  return targetDir;
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

      // Remove existing link/directory
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          await rm(linkPath);
        } else {
          await rm(linkPath, { recursive: true });
        }
      }

      // Create symlink (junction on Windows for compat)
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        await symlink(canonicalPath, linkPath, symlinkType);
      } catch {
        // Fallback to copy if symlinks not supported
        await cp(canonicalPath, linkPath, { recursive: true });
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
  const canonicalPath = join(getCanonicalSkillsDir(), skillName);
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
  if (!existsSync(getCanonicalSkillsDir())) return [];

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(getCanonicalSkillsDir(), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
}
