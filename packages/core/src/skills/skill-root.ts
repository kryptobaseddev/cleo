/**
 * Canonical SSoT path helpers for the CLEO skill system.
 *
 * @remarks
 * Provides two pure, synchronous helpers that the CAAMP installer, sentient
 * daemon, and `cleo skills` CLI all depend on:
 *
 * 1. {@link resolveSkillsRoot} — resolves the canonical user-machine skills
 *    root. Always returns `~/.cleo/skills/` (post-T9746). Operators with a
 *    pre-v3 install at `~/.local/share/agents/skills/` MUST run
 *    `cleo skills migrate` (see `migration.ts`) to relocate before further
 *    skill operations succeed.
 * 2. {@link is_canonical} — write-guard predicate that returns `true` when a
 *    given skill is owned by the CLEO core team (Sphere A) and must be
 *    treated as read-only on user machines.
 *
 * Both helpers are dependency-injected for db / manifest lookups so they can
 * be safely consumed from environments where `skills.db` is not yet
 * initialized (sentient daemon boot, installer pre-flight, etc.).
 *
 * @see {@link docs/architecture/SG-CLEO-SKILLS-architecture-v3.md} §1, §6
 * @task T9746
 * @epic T9740
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';

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
 * all, in which case the predicate falls through to `false`. Callers that
 * have access to `skills.db` or the canonical manifest SHOULD pass the
 * relevant field to get an accurate result.
 *
 * @public
 */
export interface IsCanonicalOptions {
  /**
   * The `source_type` field from the skill's `skills.db` row.
   *
   * @remarks
   * When equal to `'canonical'` the skill is unconditionally treated as a
   * Sphere A canonical skill and the manifest check is skipped.
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
 * Absolute path of the SINGLE bridge symlink at `~/.agents/skills/`.
 *
 * @remarks
 * Per architecture-v3 §1, every non-Claude harness (Cursor, Aider, Codeium,
 * etc.) discovers skills through this one symlink, which points at
 * `~/.claude/skills/agents-shared/` (which in turn fans out into
 * `~/.cleo/skills/`). Centralised here as the SSoT so doctor helpers,
 * adopt-orphans, and any future bridge consumer all agree on the same
 * literal — eliminates the four-site duplication noted in
 * SKILLS-CLEANUP-AUDIT.md Part D.
 *
 * @public
 */
export const AGENTS_SKILLS_BRIDGE_PATH: string = join(homedir(), '.agents', 'skills');

/**
 * Absolute path of Claude Code's hardcoded shared-skills mount at
 * `~/.claude/skills/agents-shared/`.
 *
 * @remarks
 * Per architecture-v3 §1, Claude Code reads skills from this directory
 * verbatim (it is the hardcoded discovery mount). Every other harness
 * traverses {@link AGENTS_SKILLS_BRIDGE_PATH} which is a symlink to this
 * directory. Centralised so doctor helpers do not recompute the literal.
 *
 * @public
 */
export const CLAUDE_SKILLS_AGENTS_SHARED_PATH: string = join(
  homedir(),
  '.claude',
  'skills',
  'agents-shared',
);

/**
 * Resolve the canonical user-machine skills root directory.
 *
 * @remarks
 * Always returns `~/.cleo/skills/` (post-T9746). The legacy fallback to
 * `~/.local/share/agents/skills/` and the env-paths XDG fallback to
 * `~/.local/share/cleo/skills/` have been removed — operators on those
 * paths must run `cleo skills migrate` (see `migration.ts`) before further
 * skill operations resolve correctly.
 *
 * The returned path is always absolute and is NOT guaranteed to exist on
 * disk — callers are responsible for `mkdirSync` if they need to write into
 * it.
 *
 * @returns Absolute path to `~/.cleo/skills/`.
 *
 * @example
 * ```typescript
 * import { resolveSkillsRoot } from '@cleocode/core';
 *
 * const root = resolveSkillsRoot();
 * // "/home/user/.cleo/skills"
 * ```
 *
 * @public
 */
export function resolveSkillsRoot(): string {
  return join(homedir(), '.cleo', 'skills'); // path-drift-allowed: ~/.cleo symlink is the canonical bootstrap target — see bootstrapGlobalCleo()
}

/**
 * Resolve a path through any symlinks, returning the input on failure.
 *
 * @remarks
 * Wraps {@link realpathSync} so {@link is_canonical} can compare against the
 * physical target regardless of how the caller named the path. When the
 * input does not yet exist (e.g. a probe before install) we fall back to the
 * input unchanged — the caller's basename check below still works against
 * the un-resolved path string.
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
 * Resolution order (post-T9746, per architecture-v3.md §6):
 *
 * 1. **db short-circuit:** if `options.dbSourceType === 'canonical'`, return
 *    `true` immediately.
 * 2. **manifest membership:** if `options.manifestNames` is provided and the
 *    basename of the resolved path matches any entry, return `true`.
 * 3. Otherwise return `false`. The legacy path-prefix fallback was removed in
 *    T9746 — db row + manifest are now the only signals.
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

  // 2. manifest membership.
  if (options?.manifestNames && options.manifestNames.length > 0) {
    const resolved = safeRealpath(skillPath);
    const basename = path.basename(resolved);
    if (options.manifestNames.includes(basename)) {
      return true;
    }
  }

  return false;
}
