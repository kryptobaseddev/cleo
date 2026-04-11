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

/**
 * Verify runtime dependencies after bootstrap and print a structured report.
 *
 * Imports checkAllDependencies from @cleocode/core using the same two-path
 * strategy (internal subpath first, public barrel as fallback) used by
 * bootstrapGlobalCleo above.
 *
 * This function is intentionally non-throwing — all errors are caught and
 * logged. It will never cause npm install to exit with a non-zero code.
 */
async function verifyDependencies() {
  console.log('CLEO: Verifying dependencies...');

  try {
    let checkAllDependencies;
    try {
      ({ checkAllDependencies } = await import('@cleocode/core/internal'));
    } catch {
      ({ checkAllDependencies } = await import('@cleocode/core'));
    }

    const report = await checkAllDependencies();

    // Report required dependencies — always shown
    for (const result of report.results) {
      if (result.category === 'required') {
        if (result.healthy) {
          const ver = result.version ? ` ${result.version}` : '';
          console.log(`CLEO: \u2713 ${result.name}${ver}`);
        } else {
          const reason = result.installed ? 'unhealthy' : 'not found';
          console.log(`CLEO: \u2717 ${result.name} — REQUIRED but ${reason}`);
          if (result.suggestedFix) {
            console.log(`CLEO:   Fix: ${result.suggestedFix}`);
          }
        }
      }
    }

    // Report missing optional/feature dependencies as a summary
    const optionalMissing = report.results.filter(
      (r) => r.category !== 'required' && !r.installed,
    );
    if (optionalMissing.length > 0) {
      console.log(
        `CLEO: ${optionalMissing.length} optional ${optionalMissing.length === 1 ? 'dependency' : 'dependencies'} not installed (install for full functionality)`,
      );
      for (const r of optionalMissing) {
        const hint = r.suggestedFix ?? 'optional';
        console.log(`CLEO:   - ${r.name}: ${hint}`);
      }
    }

    if (!report.allRequiredMet) {
      console.log(
        'CLEO: Warning: Some required dependencies are missing. CLEO will work but some features may fail.',
      );
      console.log('CLEO: Run "cleo doctor" for full diagnostics.');
    }
  } catch (err) {
    console.log('CLEO: Dependency check deferred (will complete on first "cleo doctor")');
    if (process.env.CLEO_DEBUG) {
      console.error('CLEO: Dependency check detail:', err);
    }
  }
}

async function runPostinstall() {
  if (!isGlobalInstall()) {
    console.log('CLEO: Skipping global bootstrap (not global install)');
    return;
  }

  console.log('CLEO: Bootstrapping global system...');

  try {
    // Import bootstrap from @cleocode/core.
    // Try the internal subpath first (multi-file tsc build), fall back to main
    // barrel (esbuild single-file bundle where internal.js doesn't exist).
    let bootstrapGlobalCleo;
    try {
      ({ bootstrapGlobalCleo } = await import('@cleocode/core/internal'));
    } catch {
      ({ bootstrapGlobalCleo } = await import('@cleocode/core'));
    }

    // No packageRoot override — let bootstrap resolve templates from
    // @cleocode/core's getPackageRoot() (templates live in core, not cleo)
    const result = await bootstrapGlobalCleo({});

    for (const item of result.created) {
      console.log(`CLEO: ${item}`);
    }
    for (const warning of result.warnings) {
      console.log(`CLEO: Warning: ${warning}`);
    }

    console.log('CLEO: Global bootstrap complete!');
    console.log('CLEO: Run "cleo init" in any project to set up local CLEO.');

    // Dependency verification — non-blocking, never fails the install
    await verifyDependencies();
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
