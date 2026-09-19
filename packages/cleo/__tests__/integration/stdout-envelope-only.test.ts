/**
 * Integration test: stdout = LAFS envelope only.
 *
 * Saga T9855 / E9.1 / T9928 — agents and shell pipelines downstream of
 * `cleo` MUST be able to `JSON.parse(stdout)` without log-line
 * contamination. This test spawns the built CLI as a real subprocess and
 * asserts that:
 *
 *   1. STDOUT parses cleanly as a single JSON object (the LAFS envelope).
 *   2. The parsed envelope has the canonical `success` + `meta.operation`
 *      shape declared by ADR-039.
 *   3. STDERR is unconstrained — Pino warnings, the `node:sqlite`
 *      ExperimentalWarning, daemon ticks, and other operational logging
 *      may appear there freely.
 *
 * The test deliberately spawns commands that do NOT require a populated
 * `.cleo/tasks.db` (`--version`, and `show <nonexistent-id>` which
 * returns an error envelope) so it remains hermetic and stable across
 * CI environments.
 *
 * @task T9928
 * @epic T9927
 * @saga T9855
 * @adr ADR-039
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);

/**
 * Absolute path to the built CLI bundle. Resolved from the test file so
 * the test works regardless of the cwd vitest is invoked under.
 *
 * `packages/cleo/__tests__/integration/stdout-envelope-only.test.ts`
 * → `packages/cleo/dist/cli/index.js`
 */
const CLI_BUNDLE = resolve(__filename, '..', '..', '..', 'dist', 'cli', 'index.js');

/**
 * Skip the suite when the bundle is not present (e.g. a fresh worktree
 * before `pnpm run build`). The suite is opt-in: CI always builds first,
 * so it always runs there.
 */
const HAS_BUNDLE = existsSync(CLI_BUNDLE);
let sandbox: string;
let project: string;
let guardPath: string;
let childEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  sandbox = mkdtempSync(resolve(tmpdir(), 'cleo-cli-mutation-isolation-'));
  project = resolve(sandbox, 'project');
  mkdirSync(resolve(project, '.cleo'), { recursive: true });
  guardPath = resolve(sandbox, 'guard.mjs');
  // Guard the child before any CLI import: no host browsers, model requests,
  // subprocess descendants, or bound listeners even if a hook is added later.
  writeFileSync(
    guardPath,
    `
    import childProcess from 'node:child_process';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('Isolated CLI test forbids process/network/listener access'); };
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[name] = deny;
    }
    net.Socket.prototype.connect = deny;
    net.Server.prototype.listen = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
  `,
  );
  childEnv = {
    PATH: process.env['PATH'],
    HOME: resolve(sandbox, 'home'),
    USERPROFILE: resolve(sandbox, 'home'),
    XDG_DATA_HOME: resolve(sandbox, 'data'),
    XDG_CONFIG_HOME: resolve(sandbox, 'config'),
    XDG_CACHE_HOME: resolve(sandbox, 'cache'),
    XDG_RUNTIME_DIR: resolve(sandbox, 'runtime'),
    CLEO_HOME: resolve(sandbox, 'cleo'),
    CLEO_CONFIG_HOME: resolve(sandbox, 'cleo-config'),
    CLEO_ROOT: project,
    CLEO_DIR: resolve(project, '.cleo'),
    CLEO_HEADLESS: '1',
    NO_COLOR: '1',
    CI: '1',
  };
  for (const directory of ['home', 'data', 'config', 'cache', 'runtime', 'cleo', 'cleo-config']) {
    mkdirSync(resolve(sandbox, directory), { recursive: true });
  }
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Spawn the CLI in a child Node process and capture stdout + stderr.
 *
 * Uses `--disable-warning=ExperimentalWarning` so the noisy `node:sqlite`
 * banner does not pollute stderr assertions in tests that want to
 * inspect what the CLI itself printed there.
 */
function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', guardPath, CLI_BUNDLE, ...args],
    {
      encoding: 'utf-8',
      cwd: project,
      env: childEnv,
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`CLI terminated by ${result.signal}`);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!HAS_BUNDLE)(
  'stdout discipline — single LAFS envelope, no log-line contamination',
  () => {
    it('cleo --version: stdout is exactly one JSON envelope', () => {
      const { status, stdout } = runCli(['--version']);

      expect(status).toBe(0);

      const parsed = JSON.parse(stdout) as { success: boolean; meta?: { operation?: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.meta?.operation).toBe('cli.output');
    });

    it('cleo show <invalid-id>: stdout is exactly one JSON envelope (error envelope)', () => {
      const { stdout, status } = runCli(['show', 'T_NONEXISTENT_ID_T9928_TEST']);

      expect(status).not.toBe(0);

      const parsed = JSON.parse(stdout) as {
        success: boolean;
        error?: { codeName?: string };
        meta?: { operation?: string };
      };
      expect(parsed.success).toBe(false);
      expect(parsed.meta?.operation).toBe('tasks.show');
      expect(typeof parsed.error?.codeName).toBe('string');
    });

    it('stdout contains no [CLEO ...] log-prefix lines from daemon/logger sources', () => {
      const { stdout } = runCli(['--version']);

      const forbiddenPrefixes = [
        '[CLEO STUDIO]',
        '[CLEO DAEMON]',
        '[CLEO SENTIENT]',
        '[CLEO SENTIENT T2]',
        '[CLEO SENTIENT CURATOR]',
        '[CLEO SENTIENT HYGIENE]',
        '[LocalBackend]',
      ];
      for (const prefix of forbiddenPrefixes) {
        expect(stdout).not.toContain(prefix);
      }
    });

    it('stdout is a single line (one trailing newline, no interleaving)', () => {
      const { stdout } = runCli(['--version']);

      const trimmed = stdout.replace(/\n+$/, '');
      expect(trimmed.includes('\n')).toBe(false);
    });
  },
);

describe.skipIf(!HAS_BUNDLE)('mutation exit and persistence contract (T12258)', () => {
  it.each([
    ['envelope', ['--output', 'envelope']],
    ['id', ['--output', 'id']],
    ['table', ['--output', 'table']],
    ['count', ['--output', 'count']],
    ['silent', ['--output', 'silent']],
    ['human', ['--human']],
    ['json', ['--json']],
  ] as const)('rejected mutations exit unsuccessfully in %s mode', (mode, flags) => {
    const result = runCli(['update', 'T999999', '--title', 'Rejected mutation', ...flags]);
    expect(result.status).toBe(4);
    if (mode === 'silent' || mode === 'human') {
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Task not found');
    } else {
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        error: { code: 4 },
      });
    }
  });

  it('persists both auto-complete flag values across fresh CLI processes', () => {
    const started = runCli([
      'session',
      'start',
      '--scope',
      'global',
      '--name',
      'Isolated CLI test',
    ]);
    expect(started.status, started.stderr || started.stdout).toBe(0);
    const saga = runCli([
      'saga',
      'create',
      '--title',
      'Isolated mutation program',
      '--description',
      'Synthetic fixture for fresh-process persistence verification',
      '--acceptance',
      'a|b|c|d|e',
    ]);
    expect(saga.status, saga.stderr || saga.stdout).toBe(0);
    const epic = runCli([
      'add',
      '--type',
      'epic',
      '--parent',
      'T001',
      '--title',
      'Isolated mutation epic',
      '--description',
      'Synthetic fixture for fresh-process persistence verification',
      '--acceptance',
      'a|b|c|d|e',
    ]);
    expect(epic.status, epic.stderr || epic.stdout).toBe(0);
    expect(runCli(['show', 'T002', '--field', '/data/task/title']).stdout.trim()).toBe(
      'Isolated mutation epic',
    );

    for (const [flag, expected] of [
      ['--no-auto-complete', 'true'],
      ['--auto-complete', 'false'],
    ] as const) {
      const updated = runCli(['update', 'T002', flag, '--output', 'silent']);
      expect(updated.status, updated.stderr || updated.stdout).toBe(0);
      const reread = runCli(['show', 'T002', '--field', '/data/task/noAutoComplete']);
      expect(reread.status, reread.stderr || reread.stdout).toBe(0);
      expect(reread.stdout.trim()).toBe(expected);
    }
    for (const noAutoComplete of [true, false]) {
      const updated = runCli([
        'update',
        'T002',
        '--params',
        JSON.stringify({ noAutoComplete }),
        '--output',
        'silent',
      ]);
      expect(updated.status, updated.stderr || updated.stdout).toBe(0);
      const reread = runCli(['show', 'T002', '--field', '/data/task/noAutoComplete']);
      expect(reread.status, reread.stderr || reread.stdout).toBe(0);
      expect(reread.stdout.trim()).toBe(String(noAutoComplete));
    }
  }, 60_000);
});
