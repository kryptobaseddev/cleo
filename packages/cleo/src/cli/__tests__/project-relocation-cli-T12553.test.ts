/**
 * `cleo project move` / `cleo project reroot` through the real CLI
 * (T12552 · T12553 · T12558).
 *
 * - T12553: a failure is a `success:false` LAFS envelope and the exit code
 *   follows the error class (before: a SUCCESS section, then exit 1).
 * - T12552: `move --dry-run` leaves the target absent and the source untouched.
 * - T12558: reroot end to end — refused while a session is active, then tasks,
 *   BRAIN memory and sessions are all readable from the new root.
 *
 * Spawns the compiled CLI with an isolated `CLEO_HOME` / `HOME`; skipped on a
 * cold checkout where `dist/` has not been built.
 *
 * @task T12552
 * @task T12553
 * @task T12558
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSoleEnvelope } from './helpers/envelope.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

let sandbox: string;

/** Environment that confines the CLI to the sandbox. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLEO_') || key.startsWith('XDG_')) delete env[key];
  }
  delete env['ANTHROPIC_API_KEY'];
  delete env['OPENAI_API_KEY'];
  delete env['CLAUDE_CODE_SESSION_ID'];
  const home = join(sandbox, 'fakehome');
  return {
    ...env,
    CLEO_HOME: join(sandbox, 'cleo-home'),
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
}

/** Run `cleo <args>` in `cwd`. */
function cleo(cwd: string, ...args: string[]): { stdout: string; status: number | null } {
  const result = spawnSync('node', [CLI_DIST, ...args], {
    cwd,
    env: sandboxEnv(),
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

/** Run `cleo <args> --field <pointer>` and return the scalar. */
function field(cwd: string, pointer: string, ...args: string[]): string {
  return cleo(cwd, ...args, '--field', pointer).stdout.trim();
}

/** A git repository with one commit and an initialised CLEO project. */
function initProject(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'README'), 'x');
  execFileSync('git', ['add', 'README'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: root,
  });
  expect(cleo(root, 'init').status).toBe(0);
}

beforeAll(async () => {
  sandbox = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-relocate-cli-T12553-')));
  mkdirSync(join(sandbox, 'cleo-home'), { recursive: true });
  mkdirSync(join(sandbox, 'fakehome'), { recursive: true });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo project move — envelopes and dry run', () => {
  let root: string;

  beforeAll(() => {
    root = join(sandbox, 'mover');
    initProject(root);
  }, 180_000);

  it('E_MOVE_FAILED: --field /success is false and the exit code is FILE_ERROR (3)', () => {
    writeFileSync(join(sandbox, 'afile'), 'not a directory');
    const run = cleo(root, 'project', 'move', join(sandbox, 'afile', 'sub'), '--field', '/success');
    const envelope = parseSoleEnvelope(run.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.codeName).toBe('E_MOVE_FAILED');
    expect(run.status).toBe(3);
  });

  it('E_INVALID_TARGET for a child target: success:false, exit 2, fix names reroot, nothing created', () => {
    const run = cleo(root, 'project', 'move', join(root, 'app'));
    const envelope = parseSoleEnvelope(run.stdout) as {
      success: boolean;
      error?: { fix?: string; codeName?: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error?.codeName).toBe('E_INVALID_TARGET');
    expect(envelope.error?.fix).toContain('cleo project reroot app');
    expect(run.status).toBe(2);
    expect(existsSync(join(root, 'app'))).toBe(false);
  });

  it('--dry-run leaves the target absent and project-info.json byte-identical', () => {
    const target = join(sandbox, 'dry-target');
    const infoBefore = readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8');
    const run = cleo(root, 'project', 'move', target, '--dry-run');
    expect(run.status).toBe(0);
    expect(parseSoleEnvelope(run.stdout).success).toBe(true);
    expect(run.stdout).toContain('Dry Run: project move');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')).toBe(infoBefore);
  });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo project reroot — end to end', () => {
  it('keeps tasks, BRAIN memory and sessions, and leaves no .cleo/ behind', () => {
    const root = join(sandbox, 'mono');
    initProject(root);
    const child = join(root, 'app');
    mkdirSync(child);

    const sessionId = field(
      root,
      '/data/session/id',
      'session',
      'start',
      '--scope',
      'global',
      '--name',
      'fixture',
    );
    const saga = field(
      root,
      '/data/created/0',
      'saga',
      'create',
      '--title',
      'fixture saga',
      '--description',
      'd',
      '--acceptance',
      'a1|a2|a3|a4|a5',
    );
    const epic = field(
      root,
      '/data/created/0',
      'add',
      '--type',
      'epic',
      '--parent',
      saga,
      '--title',
      'fixture epic',
      '--acceptance',
      'e1|e2|e3|e4|e5',
    );
    const task = field(
      root,
      '/data/created/0',
      'add',
      '--type',
      'task',
      '--parent',
      epic,
      '--title',
      'reroot fixture task',
      '--acceptance',
      'survives',
    );
    expect(task).toMatch(/^T\d+$/);
    expect(
      field(
        root,
        '/data/id',
        'memory',
        'observe',
        'reroot fixture zebra marker',
        '--title',
        'reroot-marker',
      ),
    ).not.toBe('');

    // Refused while the session is active; nothing moves.
    const blocked = cleo(root, 'project', 'reroot', 'app');
    expect(parseSoleEnvelope(blocked.stdout).error?.codeName).toBe('E_REROOT_BLOCKED');
    expect(blocked.status).toBe(2);
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(true);
    expect(existsSync(join(child, '.cleo'))).toBe(false);

    expect(field(root, '/success', 'session', 'end', '--note', 'done')).toBe('true');
    const done = cleo(root, 'project', 'reroot', 'app');
    expect(done.status).toBe(0);
    expect(parseSoleEnvelope(done.stdout).success).toBe(true);

    expect(existsSync(join(root, '.cleo'))).toBe(false);
    expect(existsSync(join(child, '.cleo', 'cleo.db'))).toBe(true);
    expect(field(child, '/data/task/title', 'show', task)).toBe('reroot fixture task');
    expect(field(child, '/data/results/0/title', 'memory', 'find', 'zebra')).toBe('reroot-marker');
    expect(cleo(child, 'session', 'list', '--output', 'id').stdout).toContain(sessionId);
    // Reads from the new root did not recreate a store at the old one.
    expect(existsSync(join(root, '.cleo'))).toBe(false);
  }, 300_000);
});
