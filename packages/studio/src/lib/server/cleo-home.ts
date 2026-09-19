/**
 * Resolves CLEO home and project data paths for the studio server.
 *
 * Resolution order:
 *   1. CLEO_HOME env var — explicit override
 *   2. OS-appropriate data path via `@cleocode/core` → `env-paths`
 *      (XDG on Linux, `~/Library/Application Support/cleo` on macOS,
 *      `%LOCALAPPDATA%\cleo\Data` on Windows)
 *
 * Project domains share the canonical project `.cleo/cleo.db`; cross-project
 * registry domains share the global `cleo.db`. Explicit selections retain their
 * root even when ambient process variables point to another project.
 *
 * Previously this module hand-rolled platform detection which caused a
 * Windows path mismatch (see brain/src/cleo-home.ts for details).
 * Fixed in T1874 (Closes #102, supersedes #103) by delegating to
 * `@cleocode/core`'s canonical `getCleoHome` which uses env-paths.
 *
 * @task T1874
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateProjectHash } from '@cleocode/core/nexus/hash';
import {
  getCleoHome as getCleoHomeFromCore,
  getProjectRoot,
  worktreeScope,
} from '@cleocode/core/paths.js';
import { resolveDualScopeDbPath } from '@cleocode/core/store/dual-scope-db';

/**
 * Returns the CLEO home directory (where global DBs live).
 *
 * Delegates to `@cleocode/core`'s `getCleoHome` which uses `env-paths`
 * for OS-appropriate, XDG-compliant path resolution.
 *
 * @returns Absolute path to the global CLEO data directory
 *
 * @example
 * ```typescript
 * const home = getCleoHome(); // e.g. "/home/user/.local/share/cleo"
 * ```
 */
export function getCleoHome(): string {
  return getCleoHomeFromCore();
}

/**
 * Return the canonical project data directory for the current request scope.
 * @returns Absolute project data directory selected by the core path policy.
 * @remarks Explicit project selection is handled by the domain path helpers below.
 * @example
 * ```ts
 * const directory = getCleoProjectDir();
 * ```
 */
export function getCleoProjectDir(): string {
  return dirname(getTasksDbPath());
}

/**
 * Run a synchronous Studio context read under the selected project scope.
 * @param projectRoot - Explicit selected root.
 * @param read - Synchronous path or metadata read using canonical core services.
 * @returns The read result without changing process-wide environment.
 * @throws When an active execution belongs to a different project or has expired.
 * @remarks Reuses core AsyncLocalStorage and retains captured execution authority.
 * Scoped metadata reads do not enter the legacy encounter-registration path.
 * @example
 * ```ts
 * const path = withStudioProjectScope(root, () => getTasksDbPath());
 * ```
 */
export function withStudioProjectScope<T>(projectRoot: string, read: () => T): T {
  const root = resolve(projectRoot);
  const inherited = worktreeScope.getStore();
  inherited?.execution?.assertActive();
  if (inherited?.execution && resolve(inherited.execution.identity.projectRoot) !== root) {
    throw new Error('Studio project selection differs from captured execution ownership.');
  }
  return worktreeScope.run(
    { ...inherited, worktreeRoot: root, projectHash: generateProjectHash(root) },
    read,
  );
}

/** Resolve an explicit selection without changing process-wide environment. */
function projectStorePath(projectRoot?: string): string {
  if (projectRoot === undefined) return resolveDualScopeDbPath('project', getProjectRoot());
  return withStudioProjectScope(projectRoot, () => resolveDualScopeDbPath('project', projectRoot));
}

/**
 * Return the global registry store path, not the project analysis graph path.
 * @returns Absolute global consolidated store path.
 * @example
 * ```ts
 * const registryPath = getNexusDbPath();
 * ```
 */
export function getNexusDbPath(): string {
  return resolveDualScopeDbPath('global');
}

/**
 * Return the project store containing brain tables.
 * @param projectRoot - Explicit selected root, or the current request scope.
 * @returns Absolute consolidated project store path.
 * @example
 * ```ts
 * const brainPath = getBrainDbPath('/projects/example');
 * ```
 */
export function getBrainDbPath(projectRoot?: string): string {
  return projectStorePath(projectRoot);
}

/**
 * Return the project store containing task tables.
 * @param projectRoot - Explicit selected root, or the current request scope.
 * @returns Absolute consolidated project store path.
 * @example
 * ```ts
 * const taskPath = getTasksDbPath('/projects/example');
 * ```
 */
export function getTasksDbPath(projectRoot?: string): string {
  return projectStorePath(projectRoot);
}

/**
 * Return the project store containing conduit tables.
 * @param projectRoot - Explicit selected root, or the current request scope.
 * @returns Absolute consolidated project store path.
 * @example
 * ```ts
 * const conduitPath = getConduitDbPath('/projects/example');
 * ```
 */
export function getConduitDbPath(projectRoot?: string): string {
  return projectStorePath(projectRoot);
}

/**
 * Return the global store containing the agent registry.
 * @returns Absolute global consolidated store path.
 * @example
 * ```ts
 * const agentRegistryPath = getAgentRegistryDbPath();
 * ```
 */
export function getAgentRegistryDbPath(): string {
  return resolveDualScopeDbPath('global');
}

/** Returns true when the given DB file exists on disk. */
export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
