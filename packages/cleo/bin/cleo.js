#!/usr/bin/env node
/**
 * T1138: Wrapper script for the CLEO CLI.
 *
 * This wrapper invokes the actual CLI bundle with Node.js flags to suppress
 * the ExperimentalWarning for node:sqlite. The warning fires during ESM module
 * resolution (before any JS code executes), so it must be suppressed at the
 * Node runtime level, not in application code.
 *
 * See: https://github.com/kryptobaseddev/cleo/issues/XXX (T1138)
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../dist/cli/index.js');
const args = process.argv.slice(2);

try {
  execFileSync('node', ['--disable-warning=ExperimentalWarning', cliPath, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(error.status || 1);
}
