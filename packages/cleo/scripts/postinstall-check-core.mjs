#!/usr/bin/env node
/**
 * Postinstall check: verify @cleocode/core is resolvable.
 *
 * Runs after npm/pnpm/yarn install. If core is missing, prints a
 * helpful error but does NOT fail the install (exit 0 always).
 *
 * Skipped when running inside the cleocode monorepo (pnpm workspace)
 * since the workspace resolver handles it automatically.
 *
 * @task T1179
 * @see ADR-054
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running inside a pnpm workspace by walking up
 * from the current script location looking for pnpm-workspace.yaml.
 */
function isInsideMonorepo() {
  let current = __dirname;
  const root = '/';

  while (current !== root) {
    const marker = join(current, 'pnpm-workspace.yaml');
    if (existsSync(marker)) {
      return true;
    }
    current = dirname(current);
  }

  return false;
}

/**
 * Attempt to resolve @cleocode/core package.json using require.resolve.
 * Returns true if core is installed and resolvable, false otherwise.
 */
function isCoreInstalled() {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('@cleocode/core/package.json');
    return true;
  } catch (err) {
    // ENOTFOUND, MODULE_NOT_FOUND, etc. — core is not installed
    return false;
  }
}

/**
 * Print a boxed helpful error message with remediation steps.
 */
function printMissingCoreMessage() {
  const width = 68;
  const topBorder = '╭' + '─'.repeat(width) + '╮';
  const bottomBorder = '╰' + '─'.repeat(width) + '╯';
  const pad = (text) => {
    const remaining = width - text.length;
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return '│ ' + ' '.repeat(left) + text + ' '.repeat(right) + ' │';
  };

  console.error('');
  console.error(topBorder);
  console.error(pad('⚠️  Missing Dependency'));
  console.error(pad(''));
  console.error(pad('@cleocode/cleo requires @cleocode/core to be'));
  console.error(pad('installed alongside it.'));
  console.error(pad(''));
  console.error(pad('To fix, install both packages:'));
  console.error(pad(''));
  console.error(pad('  npm i -g @cleocode/cleo @cleocode/core'));
  console.error(pad(''));
  console.error(pad('Or with pnpm:'));
  console.error(pad(''));
  console.error(pad('  pnpm add -g @cleocode/cleo @cleocode/core'));
  console.error(pad(''));
  console.error(bottomBorder);
  console.error('');
}

/**
 * Main check routine.
 */
function main() {
  // If we're in a monorepo, skip the check entirely.
  // The workspace resolver will handle core resolution automatically.
  if (isInsideMonorepo()) {
    return;
  }

  // Check if @cleocode/core is installed.
  if (!isCoreInstalled()) {
    printMissingCoreMessage();
  }
}

main();

// Always exit 0 (non-fatal) — postinstall failures should not block npm install
process.exit(0);
