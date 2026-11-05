/**
 * The test harness's sandbox marker, shared by every guard that treats a path
 * below it as a test fixture (T12687, T14282).
 *
 * @task T12687
 * @task T14282
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * File the test harness (`vitest.setup.ts`) writes at the root of each fork's
 * sandbox. A path below it is a fixture — including one a CLI child process
 * the test spawned uses: such a child carries `VITEST` only when the test
 * passes its own environment through, and many build an explicit `env`.
 * A marker inside a git checkout is ignored: the sandbox is never in one, so a
 * marker there was committed or planted in a real project.
 */
export const TEST_SANDBOX_MARKER = '.cleo-test-sandbox';

/** Whether `dir` or an ancestor is a git checkout (has `.git`). */
function insideGitCheckout(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether a {@link TEST_SANDBOX_MARKER} sits beside `path` or in an ancestor
 * directory, outside any git checkout (a marker inside a checkout is refused).
 *
 * @param path - Any path; its directory and the ancestors are searched.
 * @returns `true` when `path` is a test fixture.
 */
export function insideTestSandbox(path: string): boolean {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(join(dir, TEST_SANDBOX_MARKER))) return !insideGitCheckout(dir);
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
