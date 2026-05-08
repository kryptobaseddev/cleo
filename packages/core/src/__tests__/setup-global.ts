/**
 * Vitest global setup file.
 *
 * Sweeps stale CLEO-generated temp directories from os.tmpdir() before
 * and after the full suite. Catches orphans left by crashed or aborted runs
 * that bypassed per-test afterEach cleanup.
 *
 * Uses the canonical `CLEO_TEMP_PREFIXES` registry from `gc/cleanup.ts` so
 * that the sweeper automatically covers every prefix as new ones are added.
 *
 * @task T1914
 * @task T9043
 */

import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEO_TEMP_PREFIXES } from '../gc/cleanup.js';

/**
 * Remove all CLEO-generated temp directories from os.tmpdir().
 *
 * Called both in `setup` (pre-suite) and `teardown` (post-suite) to ensure
 * a clean state before and after the full test run.
 *
 * @returns Number of directories swept.
 */
function sweepOrphanedCleoTempDirs(): number {
  let swept = 0;
  try {
    const entries = readdirSync(tmpdir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const matchesPrefix = CLEO_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
      if (!matchesPrefix) continue;
      try {
        rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
        swept++;
      } catch {
        // Best-effort — ignore errors on individual dirs.
      }
    }
  } catch {
    // If tmpdir scan fails, proceed silently.
  }
  return swept;
}

/**
 * Run before the full test suite.
 */
export function setup(): void {
  sweepOrphanedCleoTempDirs();
}

/**
 * Run after the full test suite.
 */
export function teardown(): void {
  sweepOrphanedCleoTempDirs();
}
