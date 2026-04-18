/**
 * CleoOS filesystem path resolution.
 *
 * Thin adapter over `@cleocode/core`'s canonical `getPlatformPaths()`
 * (which uses env-paths internally). Adds CleoOS-specific sub-paths
 * on top of the OS-appropriate data/config roots.
 *
 * Canonical OS layout (from env-paths via core/platform-paths):
 *   Linux:   data=~/.local/share/cleo         config=~/.config/cleo
 *   macOS:   data=~/Library/Application Support/cleo  config=~/Library/Preferences/cleo
 *   Windows: data=%LOCALAPPDATA%\cleo\Data    config=%APPDATA%\cleo\Config
 *
 * CleoOS sub-paths:
 *   - `agentDir` = data root (Pi's agentDir convention)
 *   - `extensions` = `<data>/extensions/`
 *   - `cant` = `<data>/cant/` (global tier)
 *   - `cantUser` = `<config>/cant/` (user tier)
 *   - `auth` = `<config>/auth/` (credential storage)
 *
 * @packageDocumentation
 */

import { join } from 'node:path';
import { getPlatformPaths } from '@cleocode/core/system/platform-paths.js';

/** Resolved CleoOS filesystem paths. */
export interface CleoOsPaths {
  /** User data root (OS-appropriate, respects CLEO_HOME override). */
  data: string;
  /** User config root (OS-appropriate). */
  config: string;
  /** Pi agent directory (= data root). */
  agentDir: string;
  /** Extensions directory: `<data>/extensions/`. */
  extensions: string;
  /** Global CANT source: `<data>/cant/`. */
  cant: string;
  /** User-tier CANT source: `<config>/cant/`. */
  cantUser: string;
  /** Auth/keystore directory: `<config>/auth/`. */
  auth: string;
}

/**
 * Resolve CleoOS filesystem paths.
 *
 * Delegates to `@cleocode/core`'s `getPlatformPaths()` for the cross-OS
 * data and config roots, then layers CleoOS-specific subdirectories on top.
 *
 * @returns Resolved paths for all CleoOS directories.
 */
export function resolveCleoOsPaths(): CleoOsPaths {
  const { data, config } = getPlatformPaths();

  return {
    data,
    config,
    agentDir: data,
    extensions: join(data, 'extensions'),
    cant: join(data, 'cant'),
    cantUser: join(config, 'cant'),
    auth: join(config, 'auth'),
  };
}
