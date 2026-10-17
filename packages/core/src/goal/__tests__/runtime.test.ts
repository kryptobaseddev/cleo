/**
 * CLEO Goal runtime (T13819, T13820): `cleo doctor` reports the bin, its
 * version and npm's latest (an unpublished package is informational), and
 * `cleo goal install` drives a fake `cleo-goal` bin per harness.
 *
 * @task T13819
 * @task T13820
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGoalRuntime } from '../../system/health.js';
import { inspectGoalRuntime, installGoalForHarness } from '../runtime.js';

vi.mock('../../resources/heavy-command-hook-delivery.js', () => ({
  deliverHeavyCommandHooks: vi.fn(async () => ({ mode: 'enforce', outcomes: [] })),
}));

let dir: string;

/** Write an executable `/bin/sh` script named `name` into the fake PATH dir. */
function bin(name: string, body: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-goal-bin-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('cleo doctor goal_runtime check', () => {
  it('reports the installed version and a newer npm release', () => {
    bin('ocg', 'echo "cleo-goal 0.5.0"');
    bin('npm', 'echo 0.6.0');
    expect(inspectGoalRuntime({ PATH: dir })).toEqual({
      bin: join(dir, 'ocg'),
      version: '0.5.0',
      latest: '0.6.0',
      updateAvailable: true,
    });
  });

  it('treats a missing bin and an unpublished package as info, not a failure', async () => {
    bin('npm', 'echo "npm error 404 Not Found" >&2; exit 1');
    vi.stubEnv('PATH', dir);
    const check = await checkGoalRuntime();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not installed (not found on npm)');
    expect(check.fix).toBeUndefined();
  });
});

describe('cleo goal install --harness', () => {
  it('opencode: runs cleo-goal install --project in the project and passes its JSON through', async () => {
    bin(
      'cleo-goal',
      'echo "$@" > "$PWD/args"; echo \'{"schemaVersion":1,"wrote":".opencode/opencode.json"}\'',
    );
    const result = await installGoalForHarness(dir, 'opencode', { PATH: dir });
    expect(result).toEqual({
      success: true,
      data: {
        harness: 'opencode',
        bin: join(dir, 'cleo-goal'),
        goal: { schemaVersion: 1, wrote: '.opencode/opencode.json' },
      },
    });
    expect(readFileSync(join(dir, 'args'), 'utf-8').trim()).toBe('install --project');
  });

  it('claude: installs the project Stop dispatcher through hook delivery', async () => {
    bin('cleo-goal', 'exit 0');
    const result = await installGoalForHarness(dir, 'claude', { PATH: dir });
    expect(result.success && result.data.delivery).toEqual({ mode: 'enforce', outcomes: [] });
  });

  it('fails with the install command when the bin is missing', async () => {
    const result = await installGoalForHarness(dir, 'opencode', { PATH: dir });
    expect(result.success ? null : result.error.code).toBe('E_GOAL_RUNTIME_MISSING');
    expect(result.success ? null : result.error.fix).toBe('npm i -g @cleocode/goal@latest');
  });

  it('hermes and kimi name the pilot task', async () => {
    const result = await installGoalForHarness(dir, 'kimi', { PATH: dir });
    expect(result.success ? null : result.error.code).toBe('E_NOT_IMPLEMENTED');
    expect(result.success ? null : result.error.message).toContain('T13822');
  });
});
