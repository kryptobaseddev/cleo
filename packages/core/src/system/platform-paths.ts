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

import { existsSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import envPaths from 'env-paths';
import {
  getCleoCantWorkflowsDir,
  getCleoConfigDir,
  getCleoDirAbsolute,
  getCleoGlobalAgentsDir,
  getCleoGlobalJustfilePath,
  getCleoGlobalRecipesDir,
  getCleoHome,
  getCleoPiExtensionsDir,
} from '../paths.js';

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

let _sysInfo: SystemInfo | null = null;

/**
 * Get OS-appropriate paths for CLEO's global directories.
 *
 * Reads fresh on every call — env-paths is fast (microseconds) and a
 * process-wide cache would skip XDG / APPDATA env-var changes that test
 * code and long-running CLI sessions legitimately make. CLEO_HOME env
 * var overrides the data path for backward compatibility.
 */
export function getPlatformPaths(): PlatformPaths {
  const ep = envPaths(APP_NAME, { suffix: '' });
  return {
    data: process.env['CLEO_HOME'] ?? ep.data,
    config: ep.config,
    cache: ep.cache,
    log: ep.log,
    temp: ep.temp,
  };
}

/**
 * Get a cached system information snapshot.
 * Captured once and reused for the process lifetime.
 * Useful for diagnostics, issue reports, and log enrichment.
 */
export function getSystemInfo(): SystemInfo {
  if (_sysInfo) return _sysInfo;

  _sysInfo = {
    platform: platform(),
    arch: arch(),
    release: release(),
    hostname: hostname(),
    nodeVersion: process.version,
    paths: getPlatformPaths(),
  };

  return _sysInfo;
}

/**
 * Invalidate the system info cache.
 * Use in tests that need a fresh platform snapshot.
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  _sysInfo = null;
}

/** Summary of all resolved CleoOS paths (project + global hub). */
export interface PathsData {
  /** Project-local .cleo directory (absolute). */
  projectCleoDir: string;
  /** XDG-compliant global data root (Linux: ~/.local/share/cleo). */
  cleoHome: string;
  /** XDG config dir (Linux: ~/.config/cleo). */
  configDir: string;
  /** CleoOS Hub subdirectories under cleoHome. */
  hub: {
    globalRecipes: string;
    globalJustfile: string;
    piExtensions: string;
    cantWorkflows: string;
    globalAgents: string;
  };
  /** Scaffolding status — true if hub directories + seed files exist. */
  scaffolded: {
    globalRecipes: boolean;
    globalJustfile: boolean;
    piExtensions: boolean;
    cantWorkflows: boolean;
    globalAgents: boolean;
  };
}

/**
 * Report all resolved CleoOS paths (project + global hub).
 *
 * Read-only: reports current state without mutating the filesystem.
 * Backs the `cleo admin paths` CLI command.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Aggregated path data for all CLEO directories
 *
 * @task T1571
 */
export function getSystemPaths(projectRoot: string): PathsData {
  const cleoHome = getCleoHome();
  const configDir = getCleoConfigDir();
  const globalRecipes = getCleoGlobalRecipesDir();
  const globalJustfile = getCleoGlobalJustfilePath();
  const piExtensions = getCleoPiExtensionsDir();
  const cantWorkflows = getCleoCantWorkflowsDir();
  const globalAgents = getCleoGlobalAgentsDir();

  return {
    projectCleoDir: getCleoDirAbsolute(projectRoot),
    cleoHome,
    configDir,
    hub: {
      globalRecipes,
      globalJustfile,
      piExtensions,
      cantWorkflows,
      globalAgents,
    },
    scaffolded: {
      globalRecipes: existsSync(globalRecipes),
      globalJustfile: existsSync(globalJustfile),
      piExtensions: existsSync(piExtensions),
      cantWorkflows: existsSync(cantWorkflows),
      globalAgents: existsSync(globalAgents),
    },
  };
}
