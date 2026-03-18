/**
 * Central OS platform path resolution using env-paths.
 *
 * Provides OS-appropriate paths for CLEO's global directories using
 * XDG conventions on Linux, standard conventions on macOS/Windows.
 * Results are cached for the process lifetime. Env vars take precedence.
 *
 * Platform path defaults (no env vars set):
 *   data:   ~/.local/share/cleo  | ~/Library/Application Support/cleo | %LOCALAPPDATA%\cleo\Data
 *   config: ~/.config/cleo       | ~/Library/Preferences/cleo          | %APPDATA%\cleo\Config
 *   cache:  ~/.cache/cleo        | ~/Library/Caches/cleo               | %LOCALAPPDATA%\cleo\Cache
 *   log:    ~/.local/state/cleo  | ~/Library/Logs/cleo                 | %LOCALAPPDATA%\cleo\Log
 *   temp:   /tmp/<user>/cleo     | /var/folders/.../cleo               | %TEMP%\cleo
 *
 * CLEO_HOME env var overrides the data path for backward compatibility
 * with existing ~/.cleo installations.
 */

import { arch, hostname, platform, release } from 'node:os';
import envPaths from 'env-paths';

const APP_NAME = 'cleo';

/** OS-appropriate paths for CLEO's global directories. */
export interface PlatformPaths {
  /** User data dir. Override with CLEO_HOME env var. */
  data: string;
  /** User config dir (XDG_CONFIG_HOME / Library/Preferences / %APPDATA%). */
  config: string;
  /** User cache dir (XDG_CACHE_HOME / Library/Caches / %LOCALAPPDATA%). */
  cache: string;
  /** User log dir (XDG_STATE_HOME / Library/Logs / %LOCALAPPDATA%). */
  log: string;
  /** Temp dir for ephemeral files. */
  temp: string;
}

/** Immutable system information snapshot, captured once per process. */
export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  hostname: string;
  nodeVersion: string;
  paths: PlatformPaths;
}

let _paths: PlatformPaths | null = null;
let _sysInfo: SystemInfo | null = null;
let _lastCleoHome: string | undefined;

/**
 * Get OS-appropriate paths for CLEO's global directories.
 * Cached after first call. CLEO_HOME env var overrides the data path.
 *
 * The cache is automatically invalidated when CLEO_HOME changes,
 * so test code can set process.env['CLEO_HOME'] without calling
 * _resetPlatformPathsCache() manually.
 */
export function getPlatformPaths(): PlatformPaths {
  const currentCleoHome = process.env['CLEO_HOME'];

  // Invalidate if CLEO_HOME changed since last cache build
  if (_paths && currentCleoHome !== _lastCleoHome) {
    _paths = null;
    _sysInfo = null;
  }

  if (_paths) return _paths;

  const ep = envPaths(APP_NAME, { suffix: '' });
  _lastCleoHome = currentCleoHome;

  _paths = {
    data: currentCleoHome ?? ep.data,
    config: ep.config,
    cache: ep.cache,
    log: ep.log,
    temp: ep.temp,
  };

  return _paths;
}

/**
 * Get a cached system information snapshot.
 * Captured once and reused for the process lifetime.
 * Useful for diagnostics, issue reports, and log enrichment.
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
 * Use in tests after mutating CLEO_HOME env var.
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  _paths = null;
  _sysInfo = null;
}
