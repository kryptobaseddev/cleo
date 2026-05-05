/**
 * CLEO-bound platform path helpers.
 *
 * Pre-binds {@link createPlatformPathsResolver} to `(appName='cleo', homeEnvVar='CLEO_HOME')`
 * and exposes the cleo-specific helpers every other CLEO package needs:
 * `getCleoHome`, `getCleoPlatformPaths`, `getCleoSystemInfo`, and
 * `getCleoTemplatesTildePath`.
 *
 * @task T1883
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformPathsResolver,
  type PlatformPaths,
  type SystemInfo,
} from './platform-paths.js';

const TEMPLATES_SUBDIR = 'templates';

const cleoResolver = createPlatformPathsResolver('cleo', 'CLEO_HOME');

/**
 * Get OS-appropriate paths for CLEO's global directories.
 *
 * Linux:   `~/.local/share/cleo` | macOS: `~/Library/Application Support/cleo`
 * Windows: `%LOCALAPPDATA%\cleo\Data`
 *
 * The `CLEO_HOME` env var overrides the `data` field. Read fresh on every call.
 *
 * @public
 */
export function getCleoPlatformPaths(): PlatformPaths {
  return cleoResolver.getPlatformPaths();
}

/**
 * Get the absolute path to CLEO's global data directory.
 *
 * Equivalent to `getCleoPlatformPaths().data` — exposed as a stable named
 * helper because `getCleoHome()` is the most common consumer call.
 *
 * @public
 */
export function getCleoHome(): string {
  return cleoResolver.getPlatformPaths().data;
}

/**
 * Get a cached system information snapshot scoped to CLEO.
 *
 * Includes platform, architecture, hostname, Node version, and resolved
 * CLEO paths. Captured once per process and reused — invalidate via
 * {@link _resetCleoPlatformPathsCache} in tests if needed.
 *
 * @public
 */
export function getCleoSystemInfo(): SystemInfo {
  return cleoResolver.getSystemInfo();
}

/**
 * Get the CLEO templates directory as a tilde-prefixed path for use in
 * `@`-references (AGENTS.md, CLAUDE.md, etc.). Cross-platform: replaces
 * the user's home directory with `~` so the reference resolves consistently
 * when an LLM provider expands `~` at runtime.
 *
 * @returns Tilde-prefixed path like `"~/.local/share/cleo/templates"` on Linux
 *
 * @example
 * ```typescript
 * const ref = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
 * // "@~/.local/share/cleo/templates/CLEO-INJECTION.md"  (Linux)
 * ```
 *
 * @public
 */
export function getCleoTemplatesTildePath(): string {
  const absPath = join(getCleoHome(), TEMPLATES_SUBDIR);
  const home = homedir();
  if (absPath.startsWith(home)) {
    const relative = absPath.slice(home.length).replace(/\\/g, '/');
    return `~${relative}`;
  }
  return absPath;
}

/**
 * Invalidate the cached CLEO system info snapshot. Use in tests after
 * mutating `CLEO_HOME` or related env vars.
 *
 * @internal
 */
export function _resetCleoPlatformPathsCache(): void {
  cleoResolver.resetCache();
}
