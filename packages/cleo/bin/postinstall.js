#!/usr/bin/env node
/**
 * NPM Postinstall Hook - Bootstrap Global CLEO System
 *
 * Runs automatically after `npm install -g @cleocode/cleo`.
 * Delegates to @cleocode/core's bootstrapGlobalCleo().
 *
 * Detection: runs bootstrap when installed in a global node_modules path.
 * Skips for workspace/dev installs (no global prefix in path).
 *
 * @task T5267
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if this is a global npm install (not a workspace/dev install).
 * Checks multiple signals since npm staging paths vary by version.
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

  // Signal 4: not inside a pnpm workspace (no workspace root marker)
  const workspaceMarker = join(pkgRoot, '..', '..', 'pnpm-workspace.yaml');
  if (existsSync(workspaceMarker)) return false;

  return false;
}

function getPackageRoot() {
  return resolve(__dirname, '..');
}

async function runPostinstall() {
  if (!isGlobalInstall()) {
    console.log('CLEO: Skipping global bootstrap (not global install)');
    return;
  }

  console.log('CLEO: Bootstrapping global system...');

  try {
    // Import bootstrap from @cleocode/core (installed as dependency)
    const { bootstrapGlobalCleo } = await import('@cleocode/core/internal');

    const result = await bootstrapGlobalCleo({
      packageRoot: getPackageRoot(),
    });

    for (const item of result.created) {
      console.log(`CLEO: ${item}`);
    }
    for (const warning of result.warnings) {
      console.log(`CLEO: Warning: ${warning}`);
    }

    console.log('CLEO: Global bootstrap complete!');
    console.log('CLEO: Run "cleo init" in any project to set up local CLEO.');
  } catch (err) {
    console.log('CLEO: Bootstrap deferred (will complete on first "cleo install-global")');
    if (process.env.CLEO_DEBUG) {
      console.error('CLEO: Bootstrap detail:', err);
    }
  }
}

runPostinstall().catch((err) => {
  console.error('CLEO: Bootstrap error (non-fatal):', err.message);
  process.exit(0);
});
