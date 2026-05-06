/**
 * Vitest globalSetup / teardown — stale cleo-injection-chain-* sweep.
 *
 * Scans `os.tmpdir()` for orphaned `cleo-injection-chain-*` directories left
 * behind by crashed or aborted test runs that bypassed the per-test `afterEach`
 * cleanup. Runs once before the suite starts (setup) and once after the suite
 * finishes (teardown).
 *
 * Both passes are intentionally independent of individual test lifecycle so that
 * orphans from prior sessions are removed before the first test, and any
 * new orphans produced during the current session are removed after the last.
 *
 * @task T1914
 * @epic T1910
 */

import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Pattern that matches dirs created by injection-chain.test.ts via `mkdtemp`. */
const INJECTION_CHAIN_PREFIX = 'cleo-injection-chain-';

/**
 * Scans `os.tmpdir()` and removes any directory whose name starts with
 * `cleo-injection-chain-`. Returns the number of directories removed.
 */
async function sweepInjectionChainDirs(): Promise<number> {
  const tmp = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(tmp);
  } catch {
    // If tmpdir is unreadable (shouldn't happen) just skip.
    return 0;
  }

  const stale = entries.filter((name) => name.startsWith(INJECTION_CHAIN_PREFIX));

  await Promise.all(stale.map((name) => rm(join(tmp, name), { recursive: true, force: true })));

  return stale.length;
}

export async function setup(): Promise<void> {
  const removed = await sweepInjectionChainDirs();
  if (removed > 0) {
    console.warn(
      `[T1914 globalSetup] Removed ${removed} stale cleo-injection-chain-* dir(s) from ${tmpdir()}`,
    );
  }
}

export async function teardown(): Promise<void> {
  const removed = await sweepInjectionChainDirs();
  if (removed > 0) {
    console.warn(
      `[T1914 globalTeardown] Removed ${removed} escaped cleo-injection-chain-* dir(s) from ${tmpdir()}`,
    );
  }
}
