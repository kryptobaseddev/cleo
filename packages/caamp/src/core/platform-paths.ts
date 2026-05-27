/**
 * CAAMP platform-path façade — bound to `(appName='agents', envVar='AGENTS_HOME')`.
 *
 * The shared platform-paths factory now lives in `@cleocode/paths` (the
 * XDG / env-paths SSoT for the CLEO ecosystem). This module re-exposes the
 * factory + types and pre-binds an `agents`-scoped resolver so existing CAAMP
 * consumers keep working unchanged.
 *
 * Platform path defaults (no `AGENTS_HOME` set):
 *   data:   ~/.local/share/agents  | ~/Library/Application Support/agents | %LOCALAPPDATA%\agents\Data
 *   config: ~/.config/agents       | ~/Library/Preferences/agents          | %APPDATA%\agents\Config
 *   cache:  ~/.cache/agents        | ~/Library/Caches/agents               | %LOCALAPPDATA%\agents\Cache
 *   log:    ~/.local/state/agents  | ~/Library/Logs/agents                 | %LOCALAPPDATA%\agents\Log
 *   temp:   /tmp/<user>/agents     | /var/folders/.../agents               | %TEMP%\agents
 *
 * `AGENTS_HOME` env var overrides the data path (with tilde expansion).
 *
 * @task T1887
 */

import {
  createPlatformPathsResolver,
  type PlatformPaths,
  type PlatformPathsResolver,
  type SystemInfo,
} from '@cleocode/paths';

export type { PlatformPaths, PlatformPathsResolver, SystemInfo };
export { createPlatformPathsResolver };

const agentsResolver = createPlatformPathsResolver('agents', 'AGENTS_HOME');

/**
 * Get OS-appropriate paths for CAAMP's global directories.
 *
 * Reads fresh on every call (env-paths is microsecond-fast). The
 * `AGENTS_HOME` env var overrides the data path with tilde expansion.
 *
 * @public
 */
export function getPlatformPaths(): PlatformPaths {
  return agentsResolver.getPlatformPaths();
}

/**
 * Get a cached system information snapshot.
 *
 * Captured once and reused for the process lifetime. Includes platform,
 * architecture, hostname, Node version, and resolved paths.
 *
 * @public
 */
export function getSystemInfo(): SystemInfo {
  return agentsResolver.getSystemInfo();
}

/**
 * Invalidate the cached system info snapshot. Use in tests after
 * mutating `AGENTS_HOME`.
 *
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  agentsResolver.resetCache();
}
