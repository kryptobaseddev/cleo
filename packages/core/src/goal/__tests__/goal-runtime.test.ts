/**
 * CLEO Goal runtime (T13819, T13820): `cleo doctor` reports the bin, its
 * version and status schema without touching the network (npm only on
 * opt-in), an `ocg` that is not CLEO Goal is never run, and `cleo goal
 * install` drives a fake `cleo-goal` bin per harness, writing project config
 * only.
 *
 * @task T13819
 * @task T13820
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGoalRuntime } from '../../system/health.js';
import {
  goalTickCommand,
  inspectGoalRuntime,
  installGoalForHarness,
  readGoalStatus,
} from '../runtime.js';

let dir: string;

/** Write an executable `/bin/sh` script named `name` into `into` (default the fake PATH dir). */
function bin(name: string, body: string, into: string = dir): string {
  const file = join(into, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** An `ocg` installed by the `@cleocode/goal` package; returns its bin dir. */
function packagedOcg(body: string): string {
  const pkg = join(dir, 'node_modules', '@cleocode', 'goal');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@cleocode/goal' }));
  bin('ocg', body, join(pkg, 'bin'));
  return join(pkg, 'bin');
}

const INSTALL_V1 =
  '{"schemaVersion":1,"action":"installed","file":".opencode/opencode.json","spec":"github:kryptobaseddev/opencode-goal#v0.8.0","plugins":["github:kryptobaseddev/opencode-goal#v0.8.0"]}';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-goal-bin-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('cleo doctor goal_runtime check', () => {
  it('bare doctor never spawns npm; --check-updates does', async () => {
    bin('npm', `: > "${dir}/npm-ran"; echo 0.6.0`);
    bin(
      'cleo-goal',
      'case "$1" in --version) echo "cleo-goal 0.5.0";; *) echo \'{"schemaVersion":1,"goal":null,"status":"none"}\';; esac',
    );
    vi.stubEnv('PATH', dir);
    const bare = await checkGoalRuntime(dir);
    expect(bare).toMatchObject({ status: 'ok', details: { version: '0.5.0', latest: null } });
    expect(existsSync(join(dir, 'npm-ran'))).toBe(false);
    const opted = await checkGoalRuntime(dir, { checkUpdates: true });
    expect(opted).toMatchObject({ status: 'warning', details: { latest: '0.6.0' } });
    expect(existsSync(join(dir, 'npm-ran'))).toBe(true);
  });

  it('accepts an ocg from the @cleocode/goal package and reports a newer npm release', () => {
    const binDir = packagedOcg('echo "cleo-goal 0.5.0"');
    bin('npm', 'echo 0.6.0');
    expect(inspectGoalRuntime({ PATH: `${binDir}:${dir}` }, { checkUpdates: true })).toEqual({
      bin: join(binDir, 'ocg'),
      foreign: null,
      version: '0.5.0',
      latest: '0.6.0',
      updateAvailable: true,
    });
    expect(goalTickCommand({ PATH: binDir })).toBe(`${join(binDir, 'ocg')} tick`);
  });

  it('never runs an ocg that is not CLEO Goal, and says so', async () => {
    const foreign = bin('ocg', `: > "${dir}/ocg-ran"`);
    vi.stubEnv('PATH', dir);
    const check = await checkGoalRuntime(dir);
    expect(check.status).toBe('warning');
    expect(check.message).toContain(`found ${foreign}, which is not CLEO Goal`);
    expect(existsSync(join(dir, 'ocg-ran'))).toBe(false);
    const install = await installGoalForHarness(dir, 'opencode', { PATH: dir });
    expect(install.success ? null : install.error.code).toBe('E_GOAL_RUNTIME_MISSING');
    expect(existsSync(join(dir, 'ocg-ran'))).toBe(false);
  });

  it('treats a missing bin and an unpublished package as info, not a failure', async () => {
    bin('npm', 'echo "npm error 404 Not Found" >&2; exit 1');
    vi.stubEnv('PATH', dir);
    const check = await checkGoalRuntime(dir, { checkUpdates: true });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not installed (not found on npm)');
    expect(check.fix).toBeUndefined();
  });
});

describe('cleo-goal status --json', () => {
  it('reads a no-goal status and refuses an unknown schemaVersion', () => {
    bin('cleo-goal', 'echo \'{"schemaVersion":1,"goal":null,"runId":null,"status":"none"}\'');
    expect(readGoalStatus(dir, { PATH: dir })).toMatchObject({
      success: true,
      data: { status: 'none' },
    });
    bin('cleo-goal', 'echo \'{"schemaVersion":2,"goal":null}\'');
    const refused = readGoalStatus(dir, { PATH: dir });
    expect(refused.success ? null : refused.error.code).toBe('E_GOAL_RUNTIME_SCHEMA');
  });

  it('doctor reports the goal as unknown when status --json is slow', async () => {
    bin(
      'cleo-goal',
      'case "$1" in --version) echo "cleo-goal 0.8.0";; *) exec /bin/sleep 5;; esac',
    );
    vi.stubEnv('PATH', dir);
    const check = await checkGoalRuntime(dir);
    expect(check).toMatchObject({ status: 'ok', details: { version: '0.8.0', goalStatus: null } });
    expect(check.message).toContain('goal unknown');
  });
});

describe('cleo goal install --harness', () => {
  it('opencode: runs install --project --json in the project and accepts schemaVersion 1', async () => {
    bin('cleo-goal', `echo "$@" > "$PWD/args"; echo '${INSTALL_V1}'`);
    const result = await installGoalForHarness(dir, 'opencode', { PATH: dir });
    expect(result).toEqual({
      success: true,
      data: { harness: 'opencode', bin: join(dir, 'cleo-goal'), goal: JSON.parse(INSTALL_V1) },
    });
    expect(readFileSync(join(dir, 'args'), 'utf-8').trim()).toBe('install --project --json');
  });

  it.each([
    ['schemaVersion 2', `echo '{"schemaVersion":2,"action":"installed"}'`, 'schemaVersion 2'],
    ['plain text', 'echo "plugin added"', 'non-JSON output: plugin added'],
    [
      'an exit-1 error',
      `echo '{"schemaVersion":1,"error":"opencode.json is not valid JSON"}'; exit 1`,
      'opencode.json is not valid JSON',
    ],
  ])('opencode: refuses %s with E_GOAL_INSTALL_FAILED', async (_name, body, cause) => {
    bin('cleo-goal', body);
    const result = await installGoalForHarness(dir, 'opencode', { PATH: dir });
    expect(result.success ? null : result.error.code).toBe('E_GOAL_INSTALL_FAILED');
    expect(result.success ? null : result.error.message).toContain(cause);
  });

  it.each([
    ['claude', '.claude/settings.local.json'],
    ['codex', '.codex/hooks.json'],
  ])('%s: installs only the project Stop dispatcher, nothing user-global', async (harness, file) => {
    const home = join(dir, 'home');
    const project = join(dir, 'project');
    mkdirSync(home);
    mkdirSync(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_HOME', undefined);
    vi.stubEnv('CODEX_HOME', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    bin('cleo-goal', 'exit 0');
    const result = await installGoalForHarness(project, harness, { PATH: dir });
    expect(result.success && result.data.delivery?.status).toBe('installed');
    const config = readFileSync(join(project, file), 'utf-8');
    expect(config).toContain('cleo hook stop');
    expect(config).not.toContain('PreToolUse');
    for (const global of ['.claude', '.codex', '.config']) {
      expect(existsSync(join(home, global))).toBe(false);
    }
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
