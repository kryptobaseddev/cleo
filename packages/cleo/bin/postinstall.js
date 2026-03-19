#!/usr/bin/env node
/**
 * NPM Postinstall Hook - Bootstrap Global CLEO System
 *
 * This script runs automatically after `npm install -g @cleocode/cleo`.
 * It delegates to the shared bootstrap module in @cleocode/core so that
 * both postinstall and `cleo install-global` use the same logic.
 *
 * Bootstraps:
 *   - ~/.cleo/ directory structure
 *   - Global templates (CLEO-INJECTION.md)
 *   - CAAMP provider configs
 *   - MCP server to detected providers
 *   - Core skills globally
 *   - Provider adapters
 *
 * @task T5267
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine if we're running from npm global install
function isNpmGlobalInstall() {
  const execPath = process.argv[1] || '';
  // Check if running from node_modules/@cleocode/cleo/
  return (
    execPath.includes('node_modules/@cleocode/cleo/') ||
    execPath.includes('node_modules\\@cleocode\\cleo\\')
  );
}

// Get package root (bin/ is one level below package root)
function getPackageRoot() {
  return resolve(__dirname, '..');
}

async function runPostinstall() {
  // Only run for npm global installs, not local dev or other contexts
  if (!isNpmGlobalInstall()) {
    console.log('CLEO: Skipping global bootstrap (not npm global install)');
    return;
  }

  console.log('CLEO: Bootstrapping global system...');

  try {
    // Import the shared bootstrap from the built core dist.
    // At postinstall time, dist/ should already be present in the published package.
    const { bootstrapGlobalCleo } = await import(
      '../dist/core/bootstrap.js'
    );

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
    // Bootstrap is best-effort — CAAMP/MCP may not be configured yet
    console.log('CLEO: CAAMP/MCP setup deferred (will complete on first use)');
    if (process.env.CLEO_DEBUG) {
      console.error('CLEO: Bootstrap detail:', err);
    }
  }
}

// Run bootstrap — never fail npm install
runPostinstall().catch((err) => {
  console.error('CLEO: Bootstrap error (non-fatal):', err.message);
  process.exit(0); // Never fail npm install
});
