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
 *
 * @remarks
 * Dependency note: `@cleocode/core` depends on `@cleocode/caamp`, so this
 * module intentionally does NOT import from `@cleocode/core` to avoid a
 * circular dependency. The shared env-paths wrapper pattern is factored into
 * {@link createPlatformPathsResolver} below, which can be reused by callers
 * that need a different app name / home env-var without duplicating logic.
 */

import { arch, homedir, hostname, platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import envPaths from 'env-paths';

/**
 * OS-appropriate directory paths for a global agent tool.
 *
 * @public
 */
export interface PlatformPaths {
  /** User data dir. Override with the configured home env var. */
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

/**
 * A bound platform-paths resolver for one app name + home env var.
 *
 * @remarks
 * Created by {@link createPlatformPathsResolver}. Holds its own cache state
 * so different resolvers (e.g. `agents` and `cleo`) are fully isolated.
 *
 * @public
 */
export interface PlatformPathsResolver {
  /**
   * Get OS-appropriate paths for the resolver's app directories.
   *
   * @remarks
   * Cached after first call. The home env var overrides the data path for
   * backward compatibility. The cache auto-invalidates when the env var
   * changes (supports test isolation).
   *
   * @returns Resolved platform paths
   *
   * @example
   * ```typescript
   * const resolver = createPlatformPathsResolver('agents', 'AGENTS_HOME');
   * const paths = resolver.getPlatformPaths();
   * console.log(paths.data); // e.g. "/home/user/.local/share/agents"
   * ```
   */
  getPlatformPaths(): PlatformPaths;

  /**
   * Get a cached system information snapshot.
   *
   * @remarks
   * Captured once and reused for the process lifetime. Includes platform,
   * architecture, hostname, Node version, and resolved paths.
   *
   * @returns Cached system info object
   */
  getSystemInfo(): SystemInfo;

  /**
   * Invalidate the path and system info caches.
   * Use in tests after mutating the home env var.
   * @internal
   */
  resetCache(): void;
}

/**
 * Normalize a home override env var value to an absolute path.
 *
 * @remarks
 * Returns `undefined` when the value is absent, empty, or whitespace-only
 * (callers should fall back to the OS default in that case).
 *
 * @param value - The raw env var value to normalize
 * @returns An absolute path string, or `undefined` if the value is blank
 *
 * @internal
 */
function resolveHomeOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(homedir(), trimmed);
}

/**
 * Create a platform-paths resolver bound to a specific app name and home env var.
 *
 * @remarks
 * Encapsulates the `env-paths` wrapper pattern so callers can declare their
 * own app-specific resolver without duplicating the caching and tilde-expansion
 * logic. Each call to `createPlatformPathsResolver` returns an independent
 * resolver with its own internal cache — different apps (e.g. `agents` vs
 * `cleo`) remain fully isolated.
 *
 * Dependency constraint: `@cleocode/core` depends on `@cleocode/caamp`, so
 * this factory lives here rather than in core. Packages that cannot import
 * from core (e.g. install-time scripts) should use this factory directly with
 * `env-paths` as a peer dependency.
 *
 * @param appName - The application name passed to `env-paths` (e.g. `"agents"`)
 * @param homeEnvVar - The env var name that overrides the data directory
 *   (e.g. `"AGENTS_HOME"`). The override supports `~`, `~/…`, absolute, and
 *   relative paths.
 * @returns A {@link PlatformPathsResolver} with `getPlatformPaths`,
 *   `getSystemInfo`, and `resetCache` methods
 *
 * @example
 * ```typescript
 * const resolver = createPlatformPathsResolver('agents', 'AGENTS_HOME');
 * const paths = resolver.getPlatformPaths();
 * console.log(paths.data); // e.g. "/home/user/.local/share/agents"
 * ```
 *
 * @public
 */
export function createPlatformPathsResolver(
  appName: string,
  homeEnvVar: string,
): PlatformPathsResolver {
  let _paths: PlatformPaths | null = null;
  let _sysInfo: SystemInfo | null = null;
  let _lastHomeValue: string | undefined;

  function getPlatformPaths(): PlatformPaths {
    const currentHome = process.env[homeEnvVar];

    // Invalidate if the home env var changed since last cache build
    if (_paths && currentHome !== _lastHomeValue) {
      _paths = null;
      _sysInfo = null;
    }

    if (_paths) return _paths;

    const ep = envPaths(appName, { suffix: '' });
    _lastHomeValue = currentHome;

    _paths = {
      data: resolveHomeOverride(currentHome) ?? ep.data,
      config: ep.config,
      cache: ep.cache,
      log: ep.log,
      temp: ep.temp,
    };

    return _paths;
  }

  function getSystemInfo(): SystemInfo {
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

  function resetCache(): void {
    _paths = null;
    _sysInfo = null;
    _lastHomeValue = undefined;
  }

  return { getPlatformPaths, getSystemInfo, resetCache };
}

// ---------------------------------------------------------------------------
// CAAMP's bound resolver — app name "agents", home override "AGENTS_HOME"
// ---------------------------------------------------------------------------

const _agentsResolver = createPlatformPathsResolver('agents', 'AGENTS_HOME');

/**
 * Get OS-appropriate paths for CAAMP's global directories.
 *
 * @remarks
 * Cached after first call. The `AGENTS_HOME` env var overrides the data path
 * for backward compatibility with existing `~/.agents` installations. The
 * cache auto-invalidates when `AGENTS_HOME` changes (supports test isolation).
 *
 * Delegates to an internal {@link PlatformPathsResolver} created by
 * {@link createPlatformPathsResolver}. To resolve paths for a different app
 * use that factory directly.
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
  return _agentsResolver.getPlatformPaths();
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
  return _agentsResolver.getSystemInfo();
}

/**
 * Invalidate the path and system info caches.
 * Use in tests after mutating AGENTS_HOME env var.
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  _agentsResolver.resetCache();
}
