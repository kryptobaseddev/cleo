/**
 * XDG-compliant path resolution for CleoOS.
 *
 * Resolves:
 * - Data: $XDG_DATA_HOME/cleo/ or ~/.local/share/cleo/
 * - Config: $XDG_CONFIG_HOME/cleo/ or ~/.config/cleo/
 * - Agent dir: same as data root (Pi's agentDir equivalent)
 * - Extensions: <data>/extensions/
 * - CANT source: <data>/cant/ (global tier)
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolved CleoOS filesystem paths following XDG Base Directory Specification. */
export interface CleoOsPaths {
  /** XDG data home: ~/.local/share/cleo/ */
  data: string;
  /** XDG config home: ~/.config/cleo/ */
  config: string;
  /** Pi agent directory (= data root) */
  agentDir: string;
  /** Extensions directory: <data>/extensions/ */
  extensions: string;
  /** Global CANT source: <data>/cant/ */
  cant: string;
  /** Auth/keystore directory: <config>/auth/ */
  auth: string;
}

/**
 * Resolve CleoOS filesystem paths using XDG Base Directory Specification.
 *
 * Respects `XDG_DATA_HOME` and `XDG_CONFIG_HOME` environment variables
 * when set, falling back to the XDG defaults (`~/.local/share/` and
 * `~/.config/` respectively).
 *
 * @returns Resolved paths for all CleoOS directories.
 */
export function resolveCleoOsPaths(): CleoOsPaths {
  const home = homedir();
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');

  const data = join(xdgData, 'cleo');
  const config = join(xdgConfig, 'cleo');

  return {
    data,
    config,
    agentDir: data,
    extensions: join(data, 'extensions'),
    cant: join(data, 'cant'),
    auth: join(config, 'auth'),
  };
}
