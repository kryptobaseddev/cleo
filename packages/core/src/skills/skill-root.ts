/**
 * Canonical SSoT path helpers for the CLEO skill system.
 *
 * @remarks
 * Provides two pure, synchronous helpers that the CAAMP installer, sentient
 * daemon, and `cleo skills` CLI all depend on:
 *
 * 1. {@link resolveSkillsRoot} — resolves the canonical user-machine skills
 *    root, preferring the new `~/.cleo/skills/` SSoT but falling back to
 *    legacy `~/.local/share/agents/skills/` when only the legacy path exists.
 * 2. {@link is_canonical} — write-guard predicate that returns `true` when a
 *    given skill is owned by the CLEO core team (Sphere A) and must be
 *    treated as read-only on user machines.
 *
 * Both helpers are dependency-injected for db / manifest lookups so they can
 * be safely consumed from environments where `skills.db` is not yet
 * initialized (sentient daemon boot, installer pre-flight, etc.).
 *
 * @see {@link docs/architecture/SG-CLEO-SKILLS-architecture-v3.md} §1, §6
 * @task T9650
 * @epic T9571
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';

/**
 * Source-type discriminator stored in `skills.db` rows.
 *
 * @remarks
 * Mirrors the enum on `skills.source_type` (see architecture-v3.md §4).
 * Treated as `canonical` short-circuits the manifest + path checks in
 * {@link is_canonical}.
 *
 * @public
 */
export type SkillSourceType = 'canonical' | 'user' | 'community' | 'agent-created';

/**
 * Options for {@link is_canonical}.
 *
 * @remarks
 * Both fields are optional — `is_canonical` can be called with no options at
 * all, in which case only the legacy-path fallback runs. Callers that have
 * access to `skills.db` or the canonical manifest SHOULD pass the relevant
 * field to get the most accurate result.
 *
 * @public
 */
export interface IsCanonicalOptions {
  /**
   * The `source_type` field from the skill's `skills.db` row.
   *
   * @remarks
   * When equal to `'canonical'` the skill is unconditionally treated as a
   * Sphere A canonical skill and the manifest + path checks are skipped.
   */
  dbSourceType?: SkillSourceType | string;

  /**
   * Names of canonical skills loaded from `packages/skills/skills/manifest.json`.
   *
   * @remarks
   * When provided, `is_canonical` checks whether the basename of the resolved
   * skill path is a member of this list — this is the manifest-membership
   * step in the resolution chain.
   */
  manifestNames?: string[];
}

/**
 * The legacy XDG canonical skills directory.
 *
 * @remarks
 * Old (pre-v3) location for canonical skills on Linux/macOS. Still consulted
 * by both {@link resolveSkillsRoot} (as a last-resort fallback) and
 * {@link is_canonical} (as the path-prefix fallback for canonical detection).
 * Emits a deprecation warning to stderr when used as the resolved root.
 */
const LEGACY_AGENTS_SKILLS_SUBPATH = join('.local', 'share', 'agents', 'skills');

/**
 * Compute the legacy XDG skills path for the current user's home directory.
 *
 * @remarks
 * Resolves `~/.local/share/agents/skills/` against {@link homedir}. Kept as a
 * helper so callers do not duplicate the path-join in hot paths.
 *
 * @returns The absolute legacy skills path (does not check existence).
 */
function legacySkillsPath(): string {
  return join(homedir(), LEGACY_AGENTS_SKILLS_SUBPATH);
}

/**
 * Compute the new SSoT skills path under `~/.cleo/skills/`.
 *
 * @remarks
 * This is the preferred location for both Sphere A (canonical) and Sphere B
 * (user / community / agent-created) skills per architecture-v3.md §1.
 * Resolution uses `~/.cleo` directly (NOT `getCleoHome()`) because the
 * `~/.cleo` symlink is created by `bootstrapGlobalCleo()` and always points
 * to the OS-appropriate canonical data directory, making it stable across
 * `CLEO_HOME` test overrides.
 *
 * @returns The absolute new skills path (does not check existence).
 */
function newSkillsPath(): string {
  return join(homedir(), '.cleo', 'skills');
}

/**
 * Compute the env-paths XDG skills path under `getCleoHome()`.
 *
 * @remarks
 * On Linux this resolves to `~/.local/share/cleo/skills` (the env-paths
 * canonical data directory). When the `~/.cleo` symlink exists and resolves
 * to this same target, both paths are equivalent. Kept as a separate helper
 * because callers may want to bypass the `~/.cleo` symlink in cases where
 * the symlink is missing or stale.
 *
 * @returns The absolute env-paths skills directory (does not check existence).
 */
function envPathsSkillsPath(): string {
  return join(getCleoHome(), 'skills');
}

/**
 * Emit a one-shot deprecation warning to stderr when the legacy path is used.
 *
 * @remarks
 * Uses a module-scoped flag so repeated calls during a single process
 * lifecycle log only once. The warning is non-fatal — callers continue to
 * function on the legacy path until `cleo skills doctor` migrates them.
 */
let legacyWarningEmitted = false;
function warnLegacySkillsRoot(legacyPath: string): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  process.stderr.write(
    `[skill-root] WARNING: resolved skills root from legacy path ${legacyPath}. ` +
      'Run `cleo skills doctor` to migrate to ~/.cleo/skills/.\n',
  );
}

/**
 * Reset the cached deprecation-warning flag.
 *
 * @remarks
 * Used exclusively by tests to verify warning emission across multiple
 * resolver invocations within a single process. Not part of the public
 * runtime contract.
 *
 * @internal
 */
export function _resetLegacyWarningCache(): void {
  legacyWarningEmitted = false;
}

/**
 * Resolve the canonical user-machine skills root directory.
 *
 * @remarks
 * Resolution order (per architecture-v3.md §1):
 *
 * 1. `~/.cleo/skills/` (new SSoT — preferred). Returned if the directory
 *    exists OR if neither of the legacy / env-paths candidates exists
 *    (i.e. on a fresh install we still return the preferred location so
 *    callers can create it).
 * 2. `~/.local/share/cleo/skills/` (XDG canonical via env-paths). Returned
 *    when `~/.cleo/skills/` is absent but this path exists.
 * 3. `~/.local/share/agents/skills/` (LEGACY). Returned only when neither of
 *    the above exists but the legacy path does — emits a one-shot
 *    deprecation warning to stderr.
 *
 * The returned path is always absolute and is NOT guaranteed to exist on
 * disk — callers are responsible for `mkdirSync` if they need to write into
 * it.
 *
 * @returns Absolute path to the resolved skills root.
 *
 * @example
 * ```typescript
 * import { resolveSkillsRoot } from '@cleocode/core';
 *
 * const root = resolveSkillsRoot();
 * // e.g. "/home/user/.cleo/skills" (preferred)
 * //      "/home/user/.local/share/cleo/skills" (env-paths fallback)
 * //      "/home/user/.local/share/agents/skills" (legacy + warning)
 * ```
 *
 * @public
 */
export function resolveSkillsRoot(): string {
  const newPath = newSkillsPath();
  const envPath = envPathsSkillsPath();
  const legacyPath = legacySkillsPath();

  // 1. Preferred new SSoT — return if it exists.
  if (existsSync(newPath)) {
    return newPath;
  }

  // 2. env-paths XDG canonical (equivalent target via ~/.cleo symlink in
  //    most installations, but used as a real fallback when the symlink is
  //    missing).
  if (existsSync(envPath)) {
    return envPath;
  }

  // 3. Legacy — emit deprecation warning when we have to fall back to it.
  if (existsSync(legacyPath)) {
    warnLegacySkillsRoot(legacyPath);
    return legacyPath;
  }

  // Nothing exists yet → return the preferred new path so the caller can
  // create it on first use.
  return newPath;
}

/**
 * Resolve a path through any symlinks, returning the input on failure.
 *
 * @remarks
 * Wraps {@link realpathSync} so {@link is_canonical} can compare against the
 * physical target regardless of how the caller named the path. When the
 * input does not yet exist (e.g. a probe before install) we fall back to the
 * input unchanged — the caller's prefix check below still works against the
 * un-resolved path string.
 *
 * @param input - Absolute or relative path to resolve.
 * @returns The resolved absolute path, or the input verbatim on error.
 */
function safeRealpath(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return input;
  }
}

/**
 * Determine whether a given skill path refers to a canonical (Sphere A) skill.
 *
 * @remarks
 * Canonical skills are owned by the CLEO core team and MUST be treated as
 * read-only on user machines — the local sentient daemon and any other
 * write paths MUST refuse mutations when this returns `true`.
 *
 * Resolution order (per architecture-v3.md §6):
 *
 * 1. **db short-circuit:** if `options.dbSourceType === 'canonical'`, return
 *    `true` immediately.
 * 2. **manifest membership:** if `options.manifestNames` is provided and the
 *    basename of the resolved path matches any entry, return `true`.
 * 3. **legacy path fallback:** if the resolved path starts with
 *    `~/.local/share/agents/skills/`, return `true`.
 * 4. Otherwise return `false`.
 *
 * The path is `realpathSync`-resolved before comparison so symlinks (e.g.
 * `~/.claude/skills/agents-shared/<name>` → `~/.cleo/skills/<name>`) are
 * compared against their physical targets.
 *
 * @param skillPath - Absolute path to the skill directory under inspection.
 * @param options - Optional DI hooks for db row and canonical-name manifest.
 * @returns `true` when the skill is Sphere A canonical, `false` otherwise.
 *
 * @example
 * ```typescript
 * import { is_canonical } from '@cleocode/core';
 *
 * // db short-circuit
 * is_canonical('/home/user/.cleo/skills/ct-orchestrator', {
 *   dbSourceType: 'canonical',
 * }); // → true
 *
 * // manifest hit
 * is_canonical('/home/user/.cleo/skills/ct-lead', {
 *   manifestNames: ['ct-lead', 'ct-orchestrator'],
 * }); // → true
 *
 * // legacy path fallback
 * is_canonical('/home/user/.local/share/agents/skills/ct-foo'); // → true
 *
 * // user skill — not canonical
 * is_canonical('/home/user/.cleo/skills/my-custom-skill', {
 *   dbSourceType: 'user',
 * }); // → false
 * ```
 *
 * @public
 */
export function is_canonical(skillPath: string, options?: IsCanonicalOptions): boolean {
  // 1. db short-circuit — fastest path when caller already has the row.
  if (options?.dbSourceType === 'canonical') {
    return true;
  }

  const resolved = safeRealpath(skillPath);

  // 2. manifest membership.
  if (options?.manifestNames && options.manifestNames.length > 0) {
    const basename = path.basename(resolved);
    if (options.manifestNames.includes(basename)) {
      return true;
    }
  }

  // 3. Legacy path fallback — the historical canonical store.
  const legacyPrefix = legacySkillsPath();
  if (resolved === legacyPrefix || resolved.startsWith(`${legacyPrefix}${path.sep}`)) {
    return true;
  }

  return false;
}
