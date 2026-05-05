/**
 * OS platform-path resolver factory backed by `env-paths`.
 *
 * The factory is parameterised by `appName` + `homeEnvVar` so a single
 * implementation serves every CLEO package that needs XDG-compliant
 * paths — `cleo`, `agents` (CAAMP), or any future tool — without each
 * package re-implementing the same env-paths wrapper, the same tilde
 * expansion, and the same SystemInfo cache.
 *
 * `getPlatformPaths()` reads fresh on every call: env-paths is microsecond-fast
 * and a process-wide cache would mask XDG / APPDATA env-var changes that test
 * code legitimately makes. `getSystemInfo()` IS cached because hostname /
 * platform / arch don't change during a process lifetime.
 *
 * @packageDocumentation
 * @task T1883
 */

import { arch, homedir, hostname, platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import envPaths from 'env-paths';

/**
 * OS-appropriate directory paths for an application.
 *
 * Defaults follow XDG Base Directory on Linux, Apple's File System Programming
 * Guide on macOS, and Microsoft's Known Folders on Windows. The home env-var
 * passed to {@link createPlatformPathsResolver} overrides `data`.
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
 * Snapshot of the current system environment combined with resolved platform paths.
 *
 * Cached for the process lifetime by {@link PlatformPathsResolver.getSystemInfo}.
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
  /** Node.js version string (e.g. `"v24.0.0"`). */
  nodeVersion: string;
  /** Resolved platform directory paths. */
  paths: PlatformPaths;
}

/**
 * A platform-paths resolver bound to one app name + one home env var.
 *
 * Each resolver carries its own `SystemInfo` cache so resolvers for different
 * apps (e.g. `cleo` vs `agents`) stay fully isolated.
 *
 * @public
 */
export interface PlatformPathsResolver {
  /**
   * Get OS-appropriate paths for the resolver's app directories.
   *
   * Reads fresh on every call. The home env var (when set) overrides the
   * `data` field; `~`, `~/...`, absolute, and relative path values are all
   * accepted and resolved against `homedir()`.
   */
  getPlatformPaths(): PlatformPaths;

  /**
   * Get a cached system information snapshot.
   *
   * Captured once per resolver and reused for the process lifetime. Includes
   * platform, architecture, hostname, Node version, and resolved paths.
   */
  getSystemInfo(): SystemInfo;

  /**
   * Invalidate the cached system info snapshot. Use in tests after mutating
   * the home env var.
   *
   * @internal
   */
  resetCache(): void;
}

/**
 * Normalize a home-override env var value to an absolute path.
 *
 * Returns `undefined` for absent / blank values so callers fall back to the
 * env-paths default. Accepts `~`, `~/foo`, absolute paths, and relative paths
 * (which are resolved against `homedir()`).
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
 * Returns a resolver with its own internal `SystemInfo` cache. Path reads are
 * always fresh (env-paths is fast); only system info is cached.
 *
 * @param appName - The application name passed to `env-paths` (e.g. `"cleo"`,
 *   `"agents"`).
 * @param homeEnvVar - The env var name that overrides the data directory
 *   (e.g. `"CLEO_HOME"`, `"AGENTS_HOME"`). Tilde-prefixed and relative
 *   values are resolved against `homedir()`.
 *
 * @example
 * ```typescript
 * const cleo = createPlatformPathsResolver('cleo', 'CLEO_HOME');
 * cleo.getPlatformPaths().data; // → "/home/user/.local/share/cleo"  (Linux, no override)
 * ```
 *
 * @public
 */
export function createPlatformPathsResolver(
  appName: string,
  homeEnvVar: string,
): PlatformPathsResolver {
  let cachedSysInfo: SystemInfo | null = null;

  function readPlatformPaths(): PlatformPaths {
    const ep = envPaths(appName, { suffix: '' });
    const override = resolveHomeOverride(process.env[homeEnvVar]);
    return {
      data: override ?? ep.data,
      config: ep.config,
      cache: ep.cache,
      log: ep.log,
      temp: ep.temp,
    };
  }

  return {
    getPlatformPaths: readPlatformPaths,
    getSystemInfo() {
      if (cachedSysInfo) return cachedSysInfo;
      cachedSysInfo = {
        platform: platform(),
        arch: arch(),
        release: release(),
        hostname: hostname(),
        nodeVersion: process.version,
        paths: readPlatformPaths(),
      };
      return cachedSysInfo;
    },
    resetCache() {
      cachedSysInfo = null;
    },
  };
}
