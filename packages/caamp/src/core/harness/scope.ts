/**
 * Three-tier scope helper for Pi harness operations.
 *
 * @remarks
 * Per ADR-035 §D1, CAAMP wraps Pi's native two-tier extension model
 * (project-local `.pi/extensions/` → global `~/.pi/agent/extensions/`)
 * with a third tier for the CleoOS-managed cross-project hub. The
 * resulting hierarchy, in precedence order on reads:
 *
 * | Tier      | Path                                           | Who owns it              |
 * | --------- | ---------------------------------------------- | ------------------------ |
 * | `project` | `<cwd>/.pi/<asset>/`                           | repository               |
 * | `user`    | `$PI_CODING_AGENT_DIR` or `~/.pi/agent/<asset>`| Pi itself                |
 * | `global`  | `$CLEO_HOME/pi-<asset>/`                       | CleoOS (this wrapper)    |
 *
 * Pi's own discovery loader is NOT modified. The `global` tier is either
 * copied or symlinked into the `user` tier on first use (lazy
 * materialization), so Pi's native two-tier loader picks extensions up
 * from the familiar location without needing a patch.
 *
 * This helper intentionally lives next to {@link ../harness/pi.ts} rather
 * than being exported at a higher level — three-tier scope is a Pi
 * concept today, and other harnesses (if any ever land) will want their
 * own mapping.
 *
 * @see ADR-035 §D1 (Three-tier scope hierarchy with explicit precedence)
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Three-tier scope identifier for Pi harness operations.
 *
 * @remarks
 * Each tier maps to a distinct root directory; see the module overview
 * for the precedence and resolution rules. This is distinct from (and
 * coexists with) the legacy {@link HarnessScope} discriminated union,
 * which only supports two tiers (`global`/`project`) and is preserved
 * for back-compat with existing skill/instruction installers.
 *
 * @public
 */
export type HarnessTier = 'project' | 'user' | 'global';

/**
 * Asset kinds managed by the three-tier scope model.
 *
 * @remarks
 * Each asset kind has its own directory name on disk, so a single tier
 * resolver function can be used for extensions, prompts, themes, and
 * CANT files without repeating path logic across the harness.
 *
 * - `extensions` — Pi extension modules (`.ts` files)
 * - `prompts`    — Prompt templates (directories containing `prompt.md`)
 * - `themes`     — Theme modules (`.ts` or `.json` files)
 * - `sessions`   — Session JSONL files (only the `user` tier is meaningful)
 * - `cant`       — CANT DSL files (`.cant`)
 *
 * @public
 */
export type HarnessAssetKind = 'extensions' | 'prompts' | 'themes' | 'sessions' | 'cant';

/**
 * Precedence-ordered iteration of tiers for read operations.
 *
 * @remarks
 * `list`-style operations iterate this array and merge results with
 * higher-precedence tiers winning on name collisions. Write operations
 * use a single tier selected by the caller.
 *
 * @public
 */
export const TIER_PRECEDENCE: readonly HarnessTier[] = ['project', 'user', 'global'];

/**
 * Resolve the Pi state root for the `user` tier, honouring
 * `$PI_CODING_AGENT_DIR`.
 *
 * @remarks
 * Kept private to this module so that tests can redirect it by setting
 * the env var. Matches the logic in {@link ../pi.ts}'s private
 * `getPiAgentDir` helper, intentionally duplicated here to avoid
 * exposing it as a public export.
 */
function getPiAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  if (env !== undefined && env.length > 0) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  return join(homedir(), '.pi', 'agent');
}

/**
 * Resolve the CleoOS-managed hub root for the `global` tier, honouring
 * `$CLEO_HOME`.
 *
 * @remarks
 * Falls back to `~/.local/share/cleo` on non-Windows platforms (matching
 * XDG conventions) so that the hub is picked up consistently across
 * machines without requiring `$CLEO_HOME` to be set. On Windows falls
 * back to `%LOCALAPPDATA%/cleo/Data` when available, otherwise
 * `~/AppData/Local/cleo/Data`.
 */
function getCleoHomeDir(): string {
  const env = process.env['CLEO_HOME'];
  if (env !== undefined && env.trim().length > 0) {
    return env.trim();
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.length > 0) {
      return join(localAppData, 'cleo', 'Data');
    }
    return join(homedir(), 'AppData', 'Local', 'cleo', 'Data');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'cleo');
  }
  const xdgData = process.env['XDG_DATA_HOME'];
  if (xdgData !== undefined && xdgData.length > 0) {
    return join(xdgData, 'cleo');
  }
  return join(homedir(), '.local', 'share', 'cleo');
}

/**
 * Map an asset kind to the directory name Pi uses natively under its
 * state root, and the name CleoOS uses under its hub.
 *
 * @remarks
 * Extensions live at `<piRoot>/extensions/` natively and at
 * `<cleoHome>/pi-extensions/` in the hub. Prompts and themes follow the
 * same `pi-<kind>` pattern in the hub because `<cleoHome>/extensions/`
 * and `<cleoHome>/themes/` would collide with non-Pi CleoOS assets.
 *
 * For the `sessions` asset kind the `global` tier is meaningless — Pi
 * owns session storage — so calls with `tier='global'` and
 * `kind='sessions'` deliberately return the user-tier path (the only
 * sane fallback) rather than inventing a second session store. Likewise
 * the `project` tier is meaningless for sessions and also folds back to
 * the user tier.
 */
function assetDirName(kind: HarnessAssetKind): {
  native: string;
  hubSuffix: string;
} {
  switch (kind) {
    case 'extensions':
      return { native: 'extensions', hubSuffix: 'pi-extensions' };
    case 'prompts':
      return { native: 'prompts', hubSuffix: 'pi-prompts' };
    case 'themes':
      return { native: 'themes', hubSuffix: 'pi-themes' };
    case 'sessions':
      return { native: 'sessions', hubSuffix: 'pi-sessions' };
    case 'cant':
      return { native: 'cant', hubSuffix: 'pi-cant' };
  }
}

/**
 * Options accepted by {@link resolveTierDir}.
 *
 * @public
 */
export interface ResolveTierDirOptions {
  /** Tier to resolve. */
  tier: HarnessTier;
  /** Asset kind (extensions, prompts, themes, sessions, cant). */
  kind: HarnessAssetKind;
  /**
   * Project directory used when {@link tier} is `project`. Ignored for
   * other tiers. When omitted with `tier='project'` the caller MUST
   * substitute `process.cwd()` before invoking the resolver, so the
   * harness never silently resolves to an unexpected working directory.
   *
   * @defaultValue undefined
   */
  projectDir?: string;
}

/**
 * Resolve the on-disk directory for an asset at a given tier.
 *
 * @remarks
 * This is the single source of truth for three-tier path resolution.
 * Every PiHarness method that accepts a {@link HarnessTier} MUST route
 * through this resolver rather than re-deriving the path, so that
 * changes to the hierarchy (e.g. XDG migration) happen in one place.
 *
 * @param opts - Resolution options (see {@link ResolveTierDirOptions})
 * @returns Absolute directory path for the asset at the requested tier
 * @throws `Error` when `tier='project'` and no `projectDir` is supplied
 *
 * @example
 * ```typescript
 * import { resolveTierDir } from "./scope.js";
 *
 * const projectExt = resolveTierDir({
 *   tier: "project",
 *   kind: "extensions",
 *   projectDir: "/home/alice/repos/cleo",
 * });
 * // → "/home/alice/repos/cleo/.pi/extensions"
 *
 * const userExt = resolveTierDir({ tier: "user", kind: "extensions" });
 * // → "/home/alice/.pi/agent/extensions"
 *
 * const globalExt = resolveTierDir({ tier: "global", kind: "extensions" });
 * // → "/home/alice/.local/share/cleo/pi-extensions"
 * ```
 *
 * @public
 */
export function resolveTierDir(opts: ResolveTierDirOptions): string {
  const { tier, kind } = opts;
  const names = assetDirName(kind);

  if (tier === 'project') {
    if (opts.projectDir === undefined || opts.projectDir.length === 0) {
      throw new Error("resolveTierDir: 'project' tier requires a projectDir argument");
    }
    return join(opts.projectDir, '.pi', names.native);
  }

  if (tier === 'user') {
    return join(getPiAgentDir(), names.native);
  }

  // global
  return join(getCleoHomeDir(), names.hubSuffix);
}

/**
 * Resolve every tier directory for a given asset kind, in precedence
 * order.
 *
 * @remarks
 * Convenience wrapper for `list`-style operations that need to walk all
 * three tiers. Entries are returned in the precedence order declared in
 * {@link TIER_PRECEDENCE}, so a naive de-duplication loop that keeps the
 * first seen name automatically implements the "higher tier wins" rule.
 *
 * @param kind - Asset kind to resolve
 * @param projectDir - Project directory for the `project` tier. When
 *   omitted the `project` tier entry is skipped rather than failing.
 * @returns Array of `{ tier, dir }` pairs in precedence order
 *
 * @example
 * ```typescript
 * const tiers = resolveAllTiers("extensions", "/home/alice/repo");
 * for (const { tier, dir } of tiers) {
 *   for (const entry of await safeReaddir(dir)) {
 *     // higher-precedence tier wins on name collision
 *   }
 * }
 * ```
 *
 * @public
 */
export function resolveAllTiers(
  kind: HarnessAssetKind,
  projectDir?: string,
): Array<{ tier: HarnessTier; dir: string }> {
  const out: Array<{ tier: HarnessTier; dir: string }> = [];
  for (const tier of TIER_PRECEDENCE) {
    if (tier === 'project' && (projectDir === undefined || projectDir.length === 0)) {
      continue;
    }
    out.push({ tier, dir: resolveTierDir({ tier, kind, projectDir }) });
  }
  return out;
}
