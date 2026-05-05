/**
 * Core platform-path façade — delegates to the `@cleocode/paths` SSoT.
 *
 * Historically core hand-rolled an `env-paths` wrapper here. That logic now
 * lives in `@cleocode/paths` and is shared with `@cleocode/worktree`,
 * `@cleocode/brain`, `@cleocode/adapters`, and `@cleocode/caamp`. This module
 * re-exposes the cleo-bound surface so existing core consumers
 * (`getPlatformPaths`, `getSystemInfo`, `getSystemPaths`, etc.) keep working
 * without code changes.
 *
 * Platform path defaults (no `CLEO_HOME` set):
 *   data:   ~/.local/share/cleo  | ~/Library/Application Support/cleo | %LOCALAPPDATA%\cleo\Data
 *   config: ~/.config/cleo       | ~/Library/Preferences/cleo          | %APPDATA%\cleo\Config
 *   cache:  ~/.cache/cleo        | ~/Library/Caches/cleo               | %LOCALAPPDATA%\cleo\Cache
 *   log:    ~/.local/state/cleo  | ~/Library/Logs/cleo                 | %LOCALAPPDATA%\cleo\Log
 *   temp:   /tmp/<user>/cleo     | /var/folders/.../cleo               | %TEMP%\cleo
 *
 * `CLEO_HOME` env var overrides the data path (with tilde expansion).
 *
 * @task T1884
 */

import { existsSync } from 'node:fs';
import {
  _resetCleoPlatformPathsCache,
  getCleoPlatformPaths,
  getCleoSystemInfo,
  type PlatformPaths,
  type SystemInfo,
} from '@cleocode/paths';
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

export type { PlatformPaths, SystemInfo };

/**
 * Get OS-appropriate paths for CLEO's global directories.
 *
 * Delegates to {@link getCleoPlatformPaths} from `@cleocode/paths`.
 * Reads fresh on every call — env-paths is microsecond-fast.
 */
export function getPlatformPaths(): PlatformPaths {
  return getCleoPlatformPaths();
}

/**
 * Get a cached system information snapshot.
 * Captured once and reused for the process lifetime.
 */
export function getSystemInfo(): SystemInfo {
  return getCleoSystemInfo();
}

/**
 * Invalidate the cached system info snapshot.
 * Use in tests that need a fresh platform snapshot.
 * @internal
 */
export function _resetPlatformPathsCache(): void {
  _resetCleoPlatformPathsCache();
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
