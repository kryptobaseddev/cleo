/**
 * Vitest global setup file.
 *
 * Sweeps stale `cleo-injection-chain-*` directories from os.tmpdir() before
 * and after the full suite. Catches orphans left by crashed or aborted runs
 * that bypassed per-test afterEach cleanup.
 *
 * @task T1914
 */

import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INJECTION_CHAIN_PREFIX = 'cleo-injection-chain-';

function sweepOrphanedInjectionChainDirs(): number {
  let swept = 0;
  try {
    const entries = readdirSync(tmpdir(), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(INJECTION_CHAIN_PREFIX)) {
        try {
          rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
          swept++;
        } catch {
          // Best-effort — ignore errors on individual dirs.
        }
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
  sweepOrphanedInjectionChainDirs();
}

/**
 * Run after the full test suite.
 */
export function teardown(): void {
  sweepOrphanedInjectionChainDirs();
}
