/**
 * The @cleocode/cleo test process can never reach the host's real registry.
 *
 * The owner's global `nexus_project_registry` accumulated ~1,000 rows from
 * CLI-spawning tests in this package (`cleo-viewer-regression-*`,
 * `cleo-T11381-cli-*`) before the shared vitest setup sandboxed every fork.
 * This pins the invariant from the package's own test run: the fork's
 * `CLEO_HOME` is an ephemeral sandbox, core resolves the registry inside it,
 * and a spawned child inherits it.
 *
 * @task T12324
 */

import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { isEphemeralPath } from '@cleocode/core/nexus/registry-hygiene.js';
import { getCleoHome } from '@cleocode/core/paths.js';
import { describe, expect, it } from 'vitest';

describe('registry sandbox for @cleocode/cleo tests (T12324)', () => {
  it('pins CLEO_HOME to an ephemeral per-fork sandbox', () => {
    const sandbox = process.env['CLEO_TEST_ALLOWED_DB_ROOTS'];
    expect(sandbox).toBeTruthy();
    const home = getCleoHome();
    expect(home === sandbox || home.startsWith(`${sandbox}${sep}`)).toBe(true);
    expect(isEphemeralPath(home)).toBe(true);
    // userInfo() reads the account record, not the fork's overridden HOME.
    expect(home).not.toBe(join(userInfo().homedir, '.local', 'share', 'cleo'));
  });

  it('hands the sandboxed CLEO_HOME to a spawned child process', () => {
    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CLEO_HOME ?? "")'],
      {
        encoding: 'utf-8',
      },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(getCleoHome());
  });
});
