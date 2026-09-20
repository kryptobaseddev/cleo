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
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
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
let commandSequence = 0;
let bundleSha256: string;
const retainedFailureSandboxes = new Set<string>();

function cleanupFixture(directory: string): void {
  if (!retainedFailureSandboxes.has(directory)) rmSync(directory, { recursive: true, force: true });
}

beforeAll(() => {
  sandbox = mkdtempSync(resolve(tmpdir(), 'cleo-cli-mutation-isolation-'));
  project = resolve(sandbox, 'project');
  bundleSha256 = HAS_BUNDLE
    ? createHash('sha256').update(readFileSync(CLI_BUNDLE)).digest('hex')
    : 'unavailable';
  mkdirSync(resolve(sandbox, 'diagnostics'), { recursive: true });
  mkdirSync(resolve(project, '.cleo'), { recursive: true });
  guardPath = resolve(sandbox, 'guard.mjs');
  // Guard the child before any CLI import: no host browsers, model requests,
  // subprocess descendants, or bound listeners even if a hook is added later.
  writeFileSync(
    guardPath,
    `
    import childProcess from 'node:child_process';
    import net from 'node:net';
    import { readFileSync, writeFileSync, writeSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { isMainThread } from 'node:worker_threads';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('Isolated CLI test forbids process/network/listener access'); };
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[name] = deny;
    }
    net.Socket.prototype.connect = deny;
    net.Server.prototype.listen = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
    if (isMainThread) {
      let nativeStartIdentity = null;
      try { nativeStartIdentity = readFileSync('/proc/self/stat', 'utf8'); } catch { /* Explicitly unavailable off Linux. */ }
      writeFileSync(join(dirname(process.env.CLEO_ROOT), 'diagnostics', 'start-' + process.pid + '.json'), JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), uptimeSeconds: process.uptime(),
        argv: process.argv, execPath: process.execPath, versions: process.versions,
        nativeStartIdentity, phase: 'guard-before-cli-import'
      }));
      if (process.env.CLEO_FIXTURE_DIAGNOSTIC_SIGNAL === 'SIGTERM') {
        writeSync(1, 'fixture stdout before signal\\n');
        writeSync(2, 'fixture stderr before signal\\n');
        process.kill(process.pid, 'SIGTERM');
      }
    }
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
  if (sandbox) cleanupFixture(sandbox);
});

/**
 * Spawn the CLI in a child Node process and capture stdout + stderr.
 *
 * Uses `--disable-warning=ExperimentalWarning` so the noisy `node:sqlite`
 * banner does not pollute stderr assertions in tests that want to
 * inspect what the CLI itself printed there.
 */
function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = childEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const cwd = env['CLEO_ROOT'] ?? project;
  const fixture = dirname(cwd);
  const argv = [
    '--disable-warning=ExperimentalWarning',
    '--import',
    guardPath,
    CLI_BUNDLE,
    ...args,
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, argv, {
    encoding: 'utf-8',
    cwd,
    env,
    timeout: 30_000,
  });
  const receiptPath = resolve(fixture, 'diagnostics', `command-${++commandSequence}.json`);
  const identityPath = resolve(fixture, 'diagnostics', `start-${result.pid}.json`);
  const receipt = {
    argv: [process.execPath, ...argv],
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    error: result.error ? { name: result.error.name, message: result.error.message } : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    bundleSha256,
    nativeStartIdentityPath: existsSync(identityPath) ? identityPath : null,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  if (result.error || result.signal) {
    retainedFailureSandboxes.add(fixture);
    throw new Error(
      `CLI process failed; fixture retained at ${fixture}; receipt ${receiptPath}: ${JSON.stringify(receipt)}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!HAS_BUNDLE)('CLI signal diagnostic retention', () => {
  it.skipIf(process.platform === 'win32')(
    'retains output, identity and fixture after a controlled child signal',
    () => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'cleo-cli-signal-control-'));
      const fixtureProject = resolve(fixture, 'project');
      mkdirSync(resolve(fixtureProject, '.cleo'), { recursive: true });
      mkdirSync(resolve(fixture, 'diagnostics'));
      writeFileSync(
        resolve(fixtureProject, 'preserved-user-bytes'),
        'retain these exact fixture bytes',
      );
      try {
        expect(() =>
          runCli(['--version'], {
            ...childEnv,
            CLEO_ROOT: fixtureProject,
            CLEO_DIR: resolve(fixtureProject, '.cleo'),
            CLEO_FIXTURE_DIAGNOSTIC_SIGNAL: 'SIGTERM',
          }),
        ).toThrow(/SIGTERM.*fixture stdout before signal.*fixture stderr before signal/s);
        cleanupFixture(fixture);
        expect(readFileSync(resolve(fixtureProject, 'preserved-user-bytes'), 'utf8')).toBe(
          'retain these exact fixture bytes',
        );
        const files = readdirSync(resolve(fixture, 'diagnostics'));
        const receiptName = files.find((file) => file.startsWith('command-'));
        expect(receiptName).toBeDefined();
        const receipt = JSON.parse(
          readFileSync(resolve(fixture, 'diagnostics', receiptName!), 'utf8'),
        );
        expect(receipt).toMatchObject({
          signal: 'SIGTERM',
          status: null,
          cwd: fixtureProject,
          stdout: 'fixture stdout before signal\n',
          stderr: 'fixture stderr before signal\n',
          bundleSha256,
          nativeStartIdentityPath: expect.any(String),
          pid: expect.any(Number),
        });
        expect(receipt.argv.at(-1)).toBe('--version');
        const identity = JSON.parse(readFileSync(receipt.nativeStartIdentityPath, 'utf8'));
        expect(identity).toMatchObject({
          pid: receipt.pid,
          execPath: process.execPath,
          phase: 'guard-before-cli-import',
        });
        if (process.platform === 'linux')
          expect(identity.nativeStartIdentity).toMatch(new RegExp(`^${receipt.pid} `));
      } finally {
        // This deliberately signalled fixture is verified above and belongs only to this control.
        retainedFailureSandboxes.delete(fixture);
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});

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
    for (const mutation of [
      ['--title', 'Rejected mutation'],
      ['--pipeline-stage', 'implementation'],
      ['--priority', 'critical'],
    ]) {
      const result = runCli(['update', 'T999999', ...mutation, ...flags]);
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
    }
  });

  describe('fresh-process persistence', () => {
    beforeAll(() => {
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
    }, 60_000);

    function createFixtureEpic(title: string): string {
      const epic = runCli([
        'add',
        '--type',
        'epic',
        '--parent',
        'T001',
        '--title',
        title,
        '--description',
        'Synthetic fixture for fresh-process persistence verification',
        '--acceptance',
        'a|b|c|d|e',
        '--output',
        'id',
      ]);
      expect(epic.status, epic.stderr || epic.stdout).toBe(0);
      const taskId = epic.stdout.trim();
      expect(taskId).toMatch(/^T\d+$/);
      expect(runCli(['show', taskId, '--field', '/data/task/title']).stdout.trim()).toBe(title);
      return taskId;
    }

    it('returns update and delete IDs with fresh-process postconditions', () => {
      const taskId = createFixtureEpic('Mutation ID receipt epic');
      const title = 'Updated mutation ID receipt epic';
      const updated = runCli(['update', taskId, '--title', title, '--output', 'id']);
      expect(updated.status, updated.stderr || updated.stdout).toBe(0);
      expect(updated.stdout.trim()).toBe(taskId);
      expect(runCli(['show', taskId, '--field', '/data/task/title']).stdout.trim()).toBe(title);
      const deleted = runCli(['delete', taskId, '--output', 'id']);
      expect(deleted.status, deleted.stderr || deleted.stdout).toBe(0);
      expect(deleted.stdout.trim()).toBe(taskId);
      const reread = runCli(['show', taskId, '--field', '/data/task/status']);
      expect(reread.status, reread.stderr || reread.stdout).toBe(0);
      expect(reread.stdout.trim()).toBe('archived');
    }, 60_000);

    it.each([
      'cascade',
      'force',
    ] as const)('enforces guarded %s deletion and retains affected IDs', (control) => {
      const parentId = createFixtureEpic(`${control} deletion policy epic`);
      const created = runCli([
        'add',
        '--type',
        'task',
        '--parent',
        parentId,
        '--title',
        `${control} deletion policy child`,
        '--description',
        'Synthetic descendant for guarded deletion verification',
        '--acceptance',
        'blocked without authorization|correct affected IDs|fresh state',
        '--output',
        'id',
      ]);
      expect(created.status, created.stderr || created.stdout).toBe(0);
      const childId = created.stdout.trim();
      expect(childId).toMatch(/^T\d+$/);
      const rejected = runCli(['delete', parentId, '--output', 'id']);
      expect(rejected.status).not.toBe(0);
      for (const taskId of [parentId, childId]) {
        const unchanged = runCli(['show', taskId, '--field', '/data/task/status']);
        expect(unchanged.status, unchanged.stderr || unchanged.stdout).toBe(0);
        expect(unchanged.stdout.trim()).toBe('pending');
      }
      const deleted = runCli(['delete', parentId, `--${control}`, '--output', 'id']);
      expect(deleted.status, deleted.stderr || deleted.stdout).toBe(0);
      expect(deleted.stdout.trim().split('\n')).toEqual(
        control === 'cascade' ? [parentId, childId] : [parentId],
      );
      expect(runCli(['show', parentId, '--field', '/data/task/status']).stdout.trim()).toBe(
        'archived',
      );
      const child = runCli(['show', childId, '--verbose']);
      expect(child.status, child.stderr || child.stdout).toBe(0);
      const task = JSON.parse(child.stdout).data.task;
      expect(task.status).toBe(control === 'cascade' ? 'archived' : 'pending');
      if (control === 'force') expect(task.parentId ?? null).toBeNull();
    }, 60_000);

    it('persists both auto-complete flag values', () => {
      const taskId = createFixtureEpic('Flag persistence epic');
      for (const [flag, expected] of [
        ['--no-auto-complete', 'true'],
        ['--auto-complete', 'false'],
      ] as const) {
        const updated = runCli(['update', taskId, flag, '--output', 'silent']);
        expect(updated.status, updated.stderr || updated.stdout).toBe(0);
        const reread = runCli(['show', taskId, '--field', '/data/task/noAutoComplete']);
        expect(reread.status, reread.stderr || reread.stdout).toBe(0);
        expect(reread.stdout.trim()).toBe(expected);
      }
    }, 60_000);

    it('persists canonical JSON auto-complete values', () => {
      const taskId = createFixtureEpic('JSON persistence epic');
      for (const noAutoComplete of [true, false]) {
        const updated = runCli([
          'update',
          taskId,
          '--params',
          JSON.stringify({ noAutoComplete }),
          '--output',
          'silent',
        ]);
        expect(updated.status, updated.stderr || updated.stdout).toBe(0);
        const reread = runCli(['show', taskId, '--field', '/data/task/noAutoComplete']);
        expect(reread.status, reread.stderr || reread.stdout).toBe(0);
        expect(reread.stdout.trim()).toBe(String(noAutoComplete));
      }
    }, 60_000);

    it('durably stores a quiet phase update', () => {
      const taskId = createFixtureEpic('Phase persistence epic');
      const phase = runCli(['update', taskId, '--phase', 'verification', '--output', 'silent']);
      expect(phase.status, phase.stderr || phase.stdout).toBe(0);
      expect(runCli(['show', taskId, '--field', '/data/task/phase']).stdout.trim()).toBe(
        'verification',
      );
    }, 60_000);

    it('durably records files and waiver and correction provenance', () => {
      const parentId = createFixtureEpic('Audit provenance epic');
      const creationReason = 'Independent critical incident repair';
      const created = runCli([
        'add',
        '--title',
        'Waiver provenance fixture',
        '--description',
        'Synthetic task with durable critical-priority authorization',
        '--type',
        'task',
        '--parent',
        parentId,
        '--priority',
        'critical',
        '--depends-waiver',
        creationReason,
        '--acceptance',
        'original criterion|verified audit|fresh read',
        '--files',
        'src/repair.ts',
        '--output',
        'id',
      ]);
      expect(created.status, created.stderr || created.stdout).toBe(0);
      const taskId = created.stdout.trim();
      expect(taskId).toMatch(/^T\d+$/);
      expect(JSON.parse(runCli(['show', taskId, '--field', '/data/task/files']).stdout)).toEqual([
        'src/repair.ts',
      ]);
      const creationAudit = runCli(['log', '--task', taskId, '--operation', 'task_created']);
      expect(creationAudit.status, creationAudit.stderr || creationAudit.stdout).toBe(0);
      expect(JSON.parse(creationAudit.stdout).data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId,
            details: expect.objectContaining({ dependsWaiver: creationReason }),
          }),
        ]),
      );
      const updateReason = 'Critical scope independently verified';
      const updated = runCli([
        'update',
        taskId,
        '--priority',
        'critical',
        '--depends-waiver',
        updateReason,
        '--acceptance',
        'approved criterion|verified audit|fresh read',
        '--reason',
        'Owner approved correction',
        '--output',
        'silent',
      ]);
      expect(updated.status, updated.stderr || updated.stdout).toBe(0);
      const updateAudit = runCli(['log', '--task', taskId, '--operation', 'task_updated']);
      expect(updateAudit.status, updateAudit.stderr || updateAudit.stdout).toBe(0);
      expect(JSON.parse(updateAudit.stdout).data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId,
            details: expect.objectContaining({
              dependsWaiver: updateReason,
              reason: 'Owner approved correction',
            }),
          }),
        ]),
      );
    }, 60_000);
  });
});
