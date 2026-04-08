#!/usr/bin/env node
/**
 * CleoOS postinstall — scaffolds global XDG hub and deploys extensions.
 *
 * Runs automatically after `npm install -g @cleocode/cleo-os`.
 * Creates XDG-compliant directory structure and copies the CANT bridge
 * extension template into the extensions directory.
 *
 * Skips during workspace/dev installs (non-global).
 *
 * This file is plain JS (not compiled from src/) so it can run before
 * the package is built, matching the @cleocode/cleo postinstall pattern.
 */

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if this is a global npm install (not a workspace/dev install).
 */
function isGlobalInstall() {
  const pkgRoot = resolve(__dirname, '..');

  // Signal 1: npm_config_global env var (set by npm during global installs)
  if (process.env.npm_config_global === 'true') return true;

  // Signal 2: path contains a global node_modules (npm, pnpm, yarn)
  if (/[/\\]lib[/\\]node_modules[/\\]/.test(pkgRoot)) return true;

  // Signal 3: npm_config_prefix matches the package path
  const prefix = process.env.npm_config_prefix;
  if (prefix && pkgRoot.startsWith(prefix)) return true;

  // Signal 4: inside a pnpm workspace — definitely not global
  const workspaceMarker = join(pkgRoot, '..', '..', 'pnpm-workspace.yaml');
  if (existsSync(workspaceMarker)) return false;

  return false;
}

/**
 * Inline XDG path resolution (avoids importing from dist/ which may not exist).
 */
function resolveCleoOsPaths() {
  const home = homedir();
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');

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

function main() {
  if (!isGlobalInstall()) {
    console.log('CleoOS: skipping postinstall (not global install)');
    return;
  }

  const paths = resolveCleoOsPaths();

  // Scaffold directories
  for (const dir of [paths.data, paths.config, paths.extensions, paths.cant, paths.auth]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`CleoOS: created ${dir}`);
    }
  }

  // Deploy bridge extension from package template
  const bridgeTemplate = join(__dirname, '..', 'extensions', 'cleo-cant-bridge.js');
  const bridgeTarget = join(paths.extensions, 'cleo-cant-bridge.js');
  if (existsSync(bridgeTemplate)) {
    cpSync(bridgeTemplate, bridgeTarget, { force: true });
    console.log(`CleoOS: deployed bridge extension to ${bridgeTarget}`);
  }

  console.log('CleoOS: postinstall complete');
}

main();
