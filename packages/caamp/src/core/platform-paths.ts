/**
 * Central OS platform path resolution using env-paths.
 *
 * Provides OS-appropriate paths for CAAMP's global directories using
 * XDG conventions on Linux, standard conventions on macOS/Windows.
 * Results are cached for the process lifetime. Env vars take precedence.
 *
 * Platform path defaults:
 *   data:   ~/.local/share/agents  | ~/Library/Application Support/agents | %LOCALAPPDATA%\agents\Data
 *   config: ~/.config/agents       | ~/Library/Preferences/agents          | %APPDATA%\agents\Config
 *   cache:  ~/.cache/agents        | ~/Library/Caches/agents               | %LOCALAPPDATA%\agents\Cache
 *   log:    ~/.local/state/agents  | ~/Library/Logs/agents                 | %LOCALAPPDATA%\agents\Log
 *   temp:   /tmp/<user>/agents     | /var/folders/.../agents               | %TEMP%\agents
 *
 * AGENTS_HOME env var overrides the data path for backward compatibility
 * with existing ~/.agents installations.
 */

import { arch, homedir, hostname, platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import envPaths from 'env-paths';

const APP_NAME = 'agents';

/**
 * Normalize an AGENTS_HOME env var value to an absolute path.
 * Returns undefined when the value is absent, empty, or whitespace-only
 * (callers should fall back to the OS default in that case).
 */
function resolveAgentsHomeOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(homedir(), trimmed);
}

/**
 * OS-appropriate directory paths for CAAMP's global storage.
 *
 * @public
 */
export interface PlatformPaths {
  /** User data dir. Override with AGENTS_HOME env var. */
  data: string;
  /** OS config dir (XDG_CONFIG_HOME / Library/Preferences / %APPDATA%). */
  config: string;
  /** OS cache dir. */
  cache: string;
  /** OS log dir. */
  log: string;
  /** OS temp dir. */
  temp: string;
}

/**
 * Snapshot of the current system environment and resolved platform paths.
 *
 * @public
 */
export interface SystemInfo {
  /** Operating system platform identifier. */
  platform: NodeJS.Platform;
  /** CPU architecture (e.g. `"x64"`, `"arm64"`). */
  arch: string;
  /** OS kernel release version string. */
  release: string;
  /** Machine hostname. */
  hostname: string;
  /** Node.js version string (e.g. `"v20.11.0"`). */
  nodeVersion: string;
  /** Resolved platform directory paths. */
  paths: PlatformPaths;
}

let _paths: PlatformPaths | null = null;
let _sysInfo: SystemInfo | null = null;
let _lastAgentsHome: string | undefined;

/**
 * Get OS-appropriate paths for CAAMP's global directories.
 *
 * @remarks
 * Cached after first call. The `AGENTS_HOME` env var overrides the data path
 * for backward compatibility with existing `~/.agents` installations. The
 * cache auto-invalidates when `AGENTS_HOME` changes (supports test isolation).
 *
 * @returns Resolved platform paths
 *
 * @example
 * ```typescript
 * const paths = getPlatformPaths();
 * console.log(paths.data); // e.g. "/home/user/.local/share/agents"
 * ```
 *
 * @public
 */
export function getPlatformPaths(): PlatformPaths {
  const currentAgentsHome = process.env['AGENTS_HOME'];

  // Invalidate if AGENTS_HOME changed since last cache build
  if (_paths && currentAgentsHome !== _lastAgentsHome) {
    _paths = null;
    _sysInfo = null;
  }

  if (_paths) return _paths;

  const ep = envPaths(APP_NAME, { suffix: '' });
  _lastAgentsHome = currentAgentsHome;

  _paths = {
    data: resolveAgentsHomeOverride(currentAgentsHome) ?? ep.data,
    config: ep.config,
    cache: ep.cache,
    log: ep.log,
    temp: ep.temp,
  };

  return _paths;
}

/**
 * Get a cached system information snapshot.
 *
 * @remarks
 * Captured once and reused for the process lifetime. Includes platform,
 * architecture, hostname, Node version, and resolved paths.
 *
 * @returns Cached system info object
 *
 * @example
 * ```typescript
 * const info = getSystemInfo();
 * console.log(`Running on ${info.platform}/${info.arch}`);
 * ```
 *
 * @public
 */
export function getSystemInfo(): SystemInfo {
  if (_sysInfo) return _sysInfo;

  const paths = getPlatformPaths();

  _sysInfo = {
    platform: platform(),
    arch: arch(),
    release: release(),
    hostname: hostname(),
    nodeVersion: process.version,
    paths,
  };

  return _sysInfo;
}

/**
 * Invalidate the path and system info caches.
 * Use in tests after mutating AGENTS_HOME env var.
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  _paths = null;
  _sysInfo = null;
  _lastAgentsHome = undefined;
}
