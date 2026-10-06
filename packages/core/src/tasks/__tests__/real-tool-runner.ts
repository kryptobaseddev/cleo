/**
 * Opt a test file in to the REAL evidence tool runner (T13203).
 *
 * Inside vitest, `runToolCached` refuses to spawn a tool unless a runner was
 * injected, because a test reaching the real runner is usually a mock that
 * stopped intercepting (and `pnpm run test` from a test worker multiplies
 * whole-suite runs). The tool-cache suites spawn tiny `node -e` commands on
 * purpose; calling this at the top of such a file injects the real runner for
 * the file's duration and restores the guard afterwards.
 *
 * @task T13203
 */

import { afterAll, beforeAll } from 'vitest';
import { spawnToolProcess } from '../tool-cache.js';
import { injectToolProcessRunner } from '../tool-runner-guard.js';

/** Inject the real tool process runner for every test in the calling file. */
export function useRealToolRunner(): void {
  beforeAll(() => {
    injectToolProcessRunner(spawnToolProcess);
  });
  afterAll(() => {
    injectToolProcessRunner(null);
  });
}
