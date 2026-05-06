/**
 * Filesystem-backed playbook resolver with 3-tier precedence.
 *
 * Lookup order (highest wins):
 *   1. `project`  — `<projectRoot>/.cleo/playbooks/<name>.cantbook`
 *   2. `global`   — `~/.local/share/cleo/playbooks/<name>.cantbook`
 *                   (resolved via `@cleocode/paths` `getCleoHome()`)
 *   3. `packaged` — `@cleocode/playbooks/starter/<name>.cantbook`
 *                   (resolved relative to this file's compiled location)
 *
 * This resolver is symmetric to `resolveAgent()` in `agent-resolver.ts`.
 * It is a pure filesystem resolver — no database involved. Same inputs
 * always produce the same outputs (pure function — no global state).
 *
 * Empty project or global tier directories are silently skipped; the resolver
 * falls through to the next tier. `PlaybookNotFoundError` is thrown only when
 * all three tiers miss, enumerating every tried path for operator clarity.
 *
 * @module playbook-resolver
 * @task T1937
 * @see packages/core/src/store/agent-resolver.ts — symmetric agent resolver
 * @see ADR-068 Decision 4 — symmetric playbook tier resolver
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCleoHome } from '@cleocode/paths';

// ---------------------------------------------------------------------------
// Tier type
// ---------------------------------------------------------------------------

/**
 * The three tiers at which a `.cantbook` playbook may be discovered.
 * Mirrors the language used in `agent-resolver.ts` (AgentTier) for
 * consistent cross-resolver semantics.
 */
export type PlaybookTier = 'project' | 'global' | 'packaged';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Resolved playbook envelope returned by {@link resolvePlaybook} and
 * {@link listPlaybooks}. Carries the tier of origin so callers can surface
 * provenance to the user (`cleo playbook list` table: Name | Tier | Path).
 *
 * @example
 * ```typescript
 * const resolved = resolvePlaybook('rcasd', { projectRoot: '/path/to/proj' });
 * // → { name: 'rcasd', tier: 'packaged', path: '...rcasd.cantbook', source: '...' }
 * ```
 */
export interface ResolvedPlaybook {
  /** Bare playbook name (no extension). */
  name: string;
  /** Tier at which the playbook was found. */
  tier: PlaybookTier;
  /** Absolute path to the `.cantbook` file. */
  path: string;
  /** Raw UTF-8 source content of the `.cantbook` file. */
  source: string;
}

/**
 * Options for {@link resolvePlaybook} and {@link listPlaybooks}.
 *
 * Mirrors the `ResolveAgentOptions` naming convention from `agent-resolver.ts`
 * so future callers can apply consistent patterns across both resolvers.
 */
export interface ResolvePlaybookOptions {
  /**
   * Absolute path to the project root. Required to locate the project-tier
   * playbook directory at `<projectRoot>/.cleo/playbooks/`.
   *
   * When omitted, the project tier is silently skipped (no error).
   */
  projectRoot?: string;
  /**
   * Preferred tier to try first. When supplied, that tier is moved to the
   * head of the lookup order; the remaining tiers follow in the default
   * sequence `project → global → packaged`.
   *
   * This is an extension point — Phase 1 callers do not use it but it
   * mirrors `ResolveAgentOptions.preferTier` for API symmetry.
   */
  preferTier?: PlaybookTier;
  /**
   * Override the packaged-tier starter directory. Defaults to the
   * `@cleocode/playbooks/starter/` directory resolved relative to
   * this file's compiled location. Tests should set this to a fixture
   * directory containing `.cantbook` files to keep coverage hermetic.
   */
  packagedStarterDir?: string;
  /**
   * Override the global-tier playbooks directory. Defaults to
   * `getCleoHome() + '/playbooks'`. Tests set this to a temp directory.
   */
  globalPlaybooksDir?: string;
}

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

/**
 * Thrown when every tier in {@link resolvePlaybook} fails to locate the named
 * playbook. The `triedPaths` array enumerates the full absolute path that was
 * checked at each tier so operators can diagnose the miss without guessing.
 *
 * Mirrors `AgentNotFoundError` from `agent-resolver.ts`:
 *   - Named typed error class with `code` and `exitCode` fields.
 *   - `triedPaths` instead of `triedTiers` because the filesystem check is the
 *     meaningful diagnostic (unlike agent resolution which queries a DB per tier).
 *
 * @task T1937
 */
export class PlaybookNotFoundError extends Error {
  /** Canonical CLEO error code for playbook-resolution misses. */
  readonly code = 'E_PLAYBOOK_NOT_FOUND';
  /** CLI exit code reserved for playbook-resolution misses. */
  readonly exitCode = 66;

  constructor(
    /** Bare playbook name that was searched for. */
    readonly playbookName: string,
    /** Absolute paths tried at each tier, in lookup order. */
    readonly triedPaths: string[],
  ) {
    super(
      `E_PLAYBOOK_NOT_FOUND: playbook '${playbookName}' not found in any tier.\n` +
        `Tried:\n${triedPaths.map((p) => `  - ${p}`).join('\n')}\n` +
        `Create a playbook at one of the paths above, or use a packaged playbook name: rcasd, ivtr, release.`,
    );
    this.name = 'PlaybookNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Tier path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of tiers to try, placing `preferTier` first when
 * supplied. Mirrors `orderTiers()` in `agent-resolver.ts`.
 *
 * @param preferred - Tier to prioritise, or `undefined` for the default order.
 * @returns Lookup sequence.
 * @internal
 */
function orderTiers(preferred: PlaybookTier | undefined): PlaybookTier[] {
  const defaultOrder: PlaybookTier[] = ['project', 'global', 'packaged'];
  if (!preferred) return defaultOrder;
  const remaining = defaultOrder.filter((t) => t !== preferred);
  return [preferred, ...remaining];
}

/**
 * Resolve the path to the project-tier playbooks directory.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to `<projectRoot>/.cleo/playbooks/`.
 * @internal
 */
function projectPlaybooksDir(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'playbooks');
}

/**
 * Resolve the path to the global-tier playbooks directory.
 *
 * Reads `CLEO_HOME` (via `getCleoHome()` from `@cleocode/paths`) and appends
 * `playbooks/`. On Linux this is `~/.local/share/cleo/playbooks/`; on macOS
 * `~/Library/Application Support/cleo/playbooks/`; on Windows
 * `%LOCALAPPDATA%\cleo\Data\playbooks\`.
 *
 * Tests override this via {@link ResolvePlaybookOptions.globalPlaybooksDir}.
 *
 * @param override - Optional absolute path override (tests only).
 * @returns Absolute path to the global playbooks directory.
 * @internal
 */
function resolveGlobalPlaybooksDir(override?: string): string {
  if (override) return override;
  return join(getCleoHome(), 'playbooks');
}

/**
 * Resolve the path to the packaged-tier starter directory.
 *
 * Climbs from the compiled location of this file (`.../core/dist/playbooks/`)
 * up through the workspace to `packages/playbooks/starter/`, then also
 * checks the installed-package layout inside `node_modules`.
 *
 * Tests override this via {@link ResolvePlaybookOptions.packagedStarterDir}.
 *
 * @param override - Optional absolute path override (tests only).
 * @returns Absolute path to the packaged starter directory, or the first
 *          candidate that exists on disk. Falls back to the computed path
 *          even when absent so `PlaybookNotFoundError` can report it.
 * @internal
 */
function resolvePackagedStarterDir(override?: string): string {
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  // Candidate 1: workspace source layout
  //   packages/core/src/playbooks/ → ../../playbooks/starter
  // Candidate 2: workspace compiled layout
  //   packages/core/dist/playbooks/ → ../../playbooks/starter
  // Candidate 3: installed node_modules layout
  //   node_modules/@cleocode/core/dist/playbooks/ → ../../playbooks/starter
  const candidates = [
    resolve(here, '..', '..', '..', 'playbooks', 'starter'),
    resolve(here, '..', '..', '..', '..', 'playbooks', 'starter'),
    resolve(here, '..', '..', '..', '..', '..', 'playbooks', 'starter'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single `.cantbook` playbook by bare name using 3-tier precedence.
 *
 * Tiers walked in order: `project` → `global` → `packaged`. Project tier
 * MUST shadow global; global MUST shadow packaged.
 *
 * Empty higher tiers silently fall through — no error is emitted when the
 * project or global directory is absent or contains no `.cantbook` files.
 *
 * @param name    - Bare playbook name without extension (e.g., `'rcasd'`).
 * @param options - Optional lookup overrides (see {@link ResolvePlaybookOptions}).
 * @returns The highest-precedence {@link ResolvedPlaybook} envelope.
 * @throws {PlaybookNotFoundError} When every tier misses. The error message
 *                                  enumerates all tried absolute paths.
 * @example
 * ```typescript
 * import { resolvePlaybook } from '@cleocode/core';
 *
 * const pb = resolvePlaybook('rcasd', { projectRoot: process.cwd() });
 * console.log(pb.tier);  // 'packaged' (if no project/global override exists)
 * console.log(pb.path);  // '/path/to/.../playbooks/starter/rcasd.cantbook'
 * ```
 * @task T1937
 */
export function resolvePlaybook(
  name: string,
  options: ResolvePlaybookOptions = {},
): ResolvedPlaybook {
  const tiers = orderTiers(options.preferTier);
  const triedPaths: string[] = [];

  for (const tier of tiers) {
    const resolved = tryResolveAtTier(name, tier, options, triedPaths);
    if (resolved !== null) return resolved;
  }

  throw new PlaybookNotFoundError(name, triedPaths);
}

/**
 * List all `.cantbook` playbooks discoverable across all tiers, deduped by
 * name (project tier shadows global; global shadows packaged).
 *
 * Playbooks are returned with their tier provenance so callers can render a
 * `Name | Tier | Path` table for `cleo playbook list --tier all`.
 *
 * When the same name exists in multiple tiers, only the highest-precedence
 * entry is returned (project wins over global, global wins over packaged).
 * The returned order is: project tier entries first, then global, then
 * packaged (with shadowed entries omitted).
 *
 * @param options - Lookup options (see {@link ResolvePlaybookOptions}).
 * @returns Deduplicated list of {@link ResolvedPlaybook} entries, sorted by
 *          tier precedence (project → global → packaged), then by name within
 *          each tier.
 * @task T1937
 */
export function listPlaybooks(options: ResolvePlaybookOptions = {}): ResolvedPlaybook[] {
  const seen = new Set<string>();
  const result: ResolvedPlaybook[] = [];

  const tierOrder: PlaybookTier[] = ['project', 'global', 'packaged'];
  for (const tier of tierOrder) {
    const entries = listAtTier(tier, options);
    for (const entry of entries) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        result.push(entry);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve `name` at a single tier. Records the absolute path
 * tried (for error reporting) even when the file is absent.
 *
 * @param name       - Bare playbook name.
 * @param tier       - Tier to attempt.
 * @param options    - Lookup options with optional overrides.
 * @param triedPaths - Mutable array to record the path tried.
 * @returns Resolved envelope on hit, or `null` on miss.
 * @internal
 */
function tryResolveAtTier(
  name: string,
  tier: PlaybookTier,
  options: ResolvePlaybookOptions,
  triedPaths: string[],
): ResolvedPlaybook | null {
  const dir = tierDir(tier, options);
  if (dir === null) {
    // Project tier without projectRoot — silently skip.
    return null;
  }
  const filePath = join(dir, `${name}.cantbook`);
  triedPaths.push(filePath);
  if (!existsSync(filePath)) return null;
  const source = readFileSync(filePath, 'utf8');
  return { name, tier, path: filePath, source };
}

/**
 * List all `.cantbook` files present at a single tier.
 *
 * Returns an empty array when the directory does not exist, is unreadable,
 * or contains no `.cantbook` files. Never throws.
 *
 * @param tier    - Tier to enumerate.
 * @param options - Lookup options with optional overrides.
 * @returns Resolved entries sorted by name within the tier.
 * @internal
 */
function listAtTier(tier: PlaybookTier, options: ResolvePlaybookOptions): ResolvedPlaybook[] {
  const dir = tierDir(tier, options);
  if (dir === null || !existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const result: ResolvedPlaybook[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.cantbook')) continue;
    const name = entry.slice(0, -'.cantbook'.length);
    const filePath = join(dir, entry);
    try {
      const source = readFileSync(filePath, 'utf8');
      result.push({ name, tier, path: filePath, source });
    } catch {
      // Unreadable file — skip silently (permission error, etc.)
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compute the absolute directory path for the given tier.
 *
 * Returns `null` when the project tier is requested but `projectRoot` is
 * absent — the caller should silently skip rather than fail.
 *
 * @param tier    - Tier to resolve.
 * @param options - Options carrying optional `projectRoot` override.
 * @returns Absolute directory path, or `null` for the no-projectRoot case.
 * @internal
 */
function tierDir(tier: PlaybookTier, options: ResolvePlaybookOptions): string | null {
  switch (tier) {
    case 'project': {
      if (!options.projectRoot) return null;
      return projectPlaybooksDir(options.projectRoot);
    }
    case 'global': {
      return resolveGlobalPlaybooksDir(options.globalPlaybooksDir);
    }
    case 'packaged': {
      return resolvePackagedStarterDir(options.packagedStarterDir);
    }
  }
}
