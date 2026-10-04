/**
 * The built CLI's update notice goes to stderr and never changes the stdout LAFS
 * envelope (T13137).
 *
 * Runs `dist/cli/index.js version` in a throwaway HOME / CLEO_HOME / project,
 * with a fresh cache that flags a hotfix, once with the notice and once with
 * `CLEO_NO_UPDATE_NOTICE=1`. The cache is fresh, so no registry check starts
 * (no lock file appears) and the test makes no network request.
 *
 * @task T13137
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCleoStateDir } from '@cleocode/paths';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UPDATE_CACHE_FILE, UPDATE_LOCK_FILE } from '../lib/update-notice.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** The test needs the compiled CLI (CI builds before testing). */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

/** Envelope fields that differ between any two runs (each run is its own process). */
const VOLATILE_META = new Set([
  'timestamp',
  'requestId',
  'duration_ms',
  'originSessionId',
  'executionSessionId',
]);

/** The envelope with run-specific `meta` values removed (their keys are kept). */
function stable(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as Record<string, unknown>;
  const meta = envelope['meta'];
  if (typeof meta === 'object' && meta !== null) {
    envelope['meta'] = Object.fromEntries(
      Object.entries(meta).map(([k, v]) => [k, VOLATILE_META.has(k) ? '<volatile>' : v]),
    );
  }
  return envelope;
}

describe('update notice in the built CLI (T13137)', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let stateDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-update-notice-cli-'));
    for (const d of ['home', 'cleo', 'state', 'project']) mkdirSync(join(root, d));
    // Built from scratch: no CI variable reaches the child, whatever runs this test.
    env = {
      PATH: process.env['PATH'],
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      CLEO_HOME: join(root, 'cleo'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
      XDG_CONFIG_HOME: join(root, 'home', '.config'),
      TMPDIR: tmpdir(),
      NO_COLOR: '1',
      CLEO_DISABLE_LOCAL_INFERENCE: '1',
      // dist/ is not an installed package; this opts the build into the notice.
      CLEO_UPDATE_NOTICE_FROM_SOURCE: '1',
    };
    // Resolve the state dir exactly as the child will, from the same variables.
    for (const k of ['HOME', 'CLEO_HOME', 'XDG_STATE_HOME'] as const) vi.stubEnv(k, env[k] ?? '');
    stateDir = getCleoStateDir();
    vi.unstubAllEnvs();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, UPDATE_CACHE_FILE),
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        ok: true,
        distTags: { latest: '9999.1.0', hotfix: '9999.1.0' },
      }),
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function runVersion(extra: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI_DIST, 'version'], {
      cwd: join(root, 'project'),
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return { stdout: result.stdout, stderr: result.stderr };
  }

  it.skipIf(!CLI_DIST_AVAILABLE)(
    'prints the hotfix notice on stderr and leaves the stdout envelope unchanged',
    () => {
      const noticed = runVersion({});
      const silenced = runVersion({ CLEO_NO_UPDATE_NOTICE: '1' });

      expect(noticed.stderr).toContain('[cleo] HOTFIX available: 9999.1.0 is a hotfix release');
      expect(noticed.stderr).toContain('`cleo self-update`');
      expect(silenced.stderr).not.toContain('[cleo] HOTFIX');

      // stdout is exactly one envelope line, identical with and without the notice.
      expect(noticed.stdout.trimEnd().split('\n')).toHaveLength(1);
      expect(noticed.stdout).not.toContain('HOTFIX');
      expect(noticed.stdout).not.toContain('self-update');
      expect(stable(noticed.stdout)).toEqual(stable(silenced.stdout));

      // The cache was fresh: no background check was claimed.
      expect(existsSync(join(stateDir, UPDATE_LOCK_FILE))).toBe(false);
    },
  );

  it.skipIf(!CLI_DIST_AVAILABLE)('is silent in CI', () => {
    expect(runVersion({ CI: 'true' }).stderr).not.toContain('[cleo] HOTFIX');
  });
});
