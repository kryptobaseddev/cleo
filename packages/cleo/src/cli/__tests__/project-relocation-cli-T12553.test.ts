/**
 * `cleo project move` / `cleo project reroot` through the real CLI
 * (T12552 · T12553 · T12556 · T12558).
 *
 * - T12553: a failure is a `success:false` LAFS envelope and the exit code
 *   follows the error class (before: a SUCCESS section, then exit 1).
 * - T12552: `move --dry-run` is structured data under `/data`, and changes
 *   nothing.
 * - T12556: move RENAMES — run from a subdirectory, the project arrives whole
 *   and nothing (no `.cleo/`) is left at the old path.
 * - T12558: reroot end to end — refused while a session is active (conflict
 *   exit class, exact per-session fix), then tasks, BRAIN memory and sessions
 *   are readable from the new root, and the old root refuses with
 *   E_PROJECT_MOVED — also after `git checkout -- .` — without growing a store.
 *
 * Spawns the compiled CLI with an isolated `CLEO_HOME` / `HOME`; skipped on a
 * cold checkout where `dist/` has not been built.
 *
 * @task T12552
 * @task T12553
 * @task T12556
 * @task T12558
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
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

/** Run `cleo <args>` in `cwd`, with optional extra environment. */
function cleo(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { stdout: string; status: number | null } {
  const result = spawnSync('node', [CLI_DIST, ...args], {
    cwd,
    env: { ...sandboxEnv(), ...extraEnv },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

/** Run `cleo <args> --field <pointer>` and return the scalar. */
function field(cwd: string, pointer: string, ...args: string[]): string {
  return cleo(cwd, [...args, '--field', pointer]).stdout.trim();
}

/** Run git in `cwd`. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** A git repository with an initialised CLEO project whose project-id is committed. */
function initProject(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README'), 'x');
  git(root, 'add', 'README');
  git(root, 'commit', '-qm', 'init');
  expect(cleo(root, ['init']).status).toBe(0);
  git(root, 'add', '.cleo/project-id');
  git(root, 'commit', '--no-verify', '-qm', 'project id');
}

/** saga → epic → task, returning the task id. */
function seedTask(root: string, title: string): string {
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
  return field(
    root,
    '/data/created/0',
    'add',
    '--type',
    'task',
    '--parent',
    epic,
    '--title',
    title,
    '--acceptance',
    'survives',
  );
}

beforeAll(async () => {
  sandbox = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-relocate-cli-T12553-')));
  mkdirSync(join(sandbox, 'cleo-home'), { recursive: true });
  mkdirSync(join(sandbox, 'fakehome'), { recursive: true });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo project move', () => {
  let root: string;

  beforeAll(() => {
    root = join(sandbox, 'mover');
    initProject(root);
  }, 180_000);

  it('E_MOVE_FAILED: --field /success is false and the exit code is FILE_ERROR (3)', () => {
    writeFileSync(join(sandbox, 'afile'), 'not a directory');
    const run = cleo(root, [
      'project',
      'move',
      join(sandbox, 'afile', 'sub'),
      '--field',
      '/success',
    ]);
    const envelope = parseSoleEnvelope(run.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.codeName).toBe('E_MOVE_FAILED');
    expect(run.status).toBe(ExitCode.FILE_ERROR);
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(true);
  });

  it('E_INVALID_TARGET for a child target: success:false, exit 2, fix names reroot, nothing created', () => {
    const run = cleo(root, ['project', 'move', join(root, 'app')]);
    const envelope = parseSoleEnvelope(run.stdout) as {
      success: boolean;
      error?: { fix?: string; codeName?: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error?.codeName).toBe('E_INVALID_TARGET');
    expect(envelope.error?.fix).toContain('cleo project reroot app');
    expect(run.status).toBe(ExitCode.INVALID_INPUT);
    expect(existsSync(join(root, 'app'))).toBe(false);
  });

  it('--dry-run is structured data under /data and changes nothing', () => {
    const target = join(sandbox, 'dry-target');
    const infoBefore = readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8');
    const run = cleo(root, ['project', 'move', target, '--dry-run']);
    expect(run.status).toBe(0);
    const envelope = parseSoleEnvelope(run.stdout) as {
      success: boolean;
      data: { dryRun: boolean; target: string; blockers: string[]; registry: { action: string } };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data).toMatchObject({ dryRun: true, target, blockers: [] });
    expect(envelope.data.registry.action).toBe('rebind');
    expect(field(root, '/data/transfer', 'project', 'move', target, '--dry-run')).toBe('rename');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')).toBe(infoBefore);
  });

  it('run from a subdirectory, renames the whole project and leaves nothing at the old path', () => {
    const task = seedTask(root, 'move fixture task');
    field(root, '/success', 'session', 'end', '--note', 'done');
    mkdirSync(join(root, 'sub'));
    const target = join(sandbox, 'moved', 'mover');

    const run = cleo(join(root, 'sub'), ['project', 'move', target]);

    expect(run.status).toBe(0);
    expect(parseSoleEnvelope(run.stdout).success).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(field(target, '/data/task/title', 'show', task)).toBe('move fixture task');
    expect(existsSync(root)).toBe(false);
  });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo project reroot — end to end', () => {
  it('keeps tasks, BRAIN memory and sessions; the old root refuses with E_PROJECT_MOVED', () => {
    const root = join(sandbox, 'mono');
    initProject(root);
    const child = join(root, 'app');
    mkdirSync(child);

    const sessionId = field(
      root,
      '/data/id',
      'session',
      'start',
      '--scope',
      'global',
      '--name',
      'fixture',
    );
    const task = seedTask(root, 'reroot fixture task');
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

    // Refused while the session is active; the fix names the exact command.
    const blocked = cleo(root, ['project', 'reroot', 'app']);
    const refusal = parseSoleEnvelope(blocked.stdout) as {
      error?: { codeName?: string; fix?: string };
    };
    expect(refusal.error?.codeName).toBe('E_REROOT_BLOCKED');
    expect(refusal.error?.fix).toContain(`CLEO_SESSION_ID=${sessionId} cleo session end`);
    expect(blocked.status).toBe(ExitCode.CONCURRENT_MODIFICATION);
    expect(existsSync(join(child, '.cleo'))).toBe(false);

    expect(
      cleo(root, ['session', 'end', '--note', 'done'], { CLEO_SESSION_ID: sessionId }).status,
    ).toBe(0);
    const done = cleo(root, ['project', 'reroot', 'app']);
    expect(done.status).toBe(0);
    expect(parseSoleEnvelope(done.stdout).success).toBe(true);

    expect(existsSync(join(root, '.cleo'))).toBe(false);
    expect(existsSync(join(root, '.cleo-moved.json'))).toBe(true);
    expect(existsSync(join(child, '.cleo', 'cleo.db'))).toBe(true);
    expect(field(child, '/data/task/title', 'show', task)).toBe('reroot fixture task');
    expect(field(child, '/data/results/0/title', 'memory', 'find', 'zebra')).toBe('reroot-marker');
    expect(cleo(child, ['session', 'list', '--output', 'id']).stdout).toContain(sessionId);

    // The old root refuses — it does not answer "no tasks" from an empty store.
    const stale = cleo(root, ['find', 'reroot']);
    expect(parseSoleEnvelope(stale.stdout).success).toBe(false);
    expect(stale.stdout).toContain('E_PROJECT_MOVED');
    expect(stale.status).not.toBe(0);

    // `git checkout -- .` restores the tracked .cleo/project-id; still refused.
    git(root, 'checkout', '--', '.');
    expect(existsSync(join(root, '.cleo', 'project-id'))).toBe(true);
    const restored = cleo(root, ['find', 'reroot']);
    expect(parseSoleEnvelope(restored.stdout).success).toBe(false);
    expect(restored.stdout).toContain('E_PROJECT_MOVED');
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(false);

    // `reroot .` from the finished child has nothing to resume.
    const again = cleo(child, ['project', 'reroot', '.']);
    expect(parseSoleEnvelope(again.stdout).error?.codeName).toBe('E_SAME_PATH');
  }, 300_000);
});

/** The error half of a LAFS envelope, with the fields E_PROJECT_MOVED carries. */
interface MovedError {
  success: boolean;
  error?: { code?: number; codeName?: string; fix?: string; details?: { movedTo?: string } };
}

describe.skipIf(!CLI_DIST_AVAILABLE)('reroot protection layer (T12558 round 2)', () => {
  let root: string;
  let child: string;

  beforeAll(() => {
    root = join(sandbox, 'r2-mono');
    initProject(root);
    child = join(root, 'app');
    mkdirSync(child);
    expect(cleo(root, ['project', 'reroot', 'app']).status).toBe(0);
  }, 180_000);

  it('E_PROJECT_MOVED is typed on the resolution path: codeName, exit 9, cd fix, details.movedTo', () => {
    const run = cleo(root, ['find', 'x']);
    const env = parseSoleEnvelope(run.stdout) as MovedError;
    expect(env.success).toBe(false);
    expect(env.error?.codeName).toBe('E_PROJECT_MOVED');
    expect(env.error?.code).toBe(ExitCode.PROJECT_MOVED);
    expect(env.error?.fix).toContain(`cd "${child}"`);
    expect(env.error?.details?.movedTo).toBe(child);
    expect(run.status).toBe(ExitCode.PROJECT_MOVED);
  });

  it('`cleo doctor project-identity` is never blocked at the old root', () => {
    const run = cleo(root, ['doctor', 'project-identity']);
    expect(run.stdout).not.toContain('E_PROJECT_MOVED');
  });

  it('init in a sibling refuses with a typed error and writes nothing; `init --here` starts a new project', () => {
    const sibling = join(root, 'app2');
    mkdirSync(sibling);
    const refused = cleo(sibling, ['init']);
    const env = parseSoleEnvelope(refused.stdout) as MovedError;
    expect(env.error?.codeName).toBe('E_PROJECT_MOVED');
    expect(env.error?.fix).toContain('cleo init --here');
    expect(refused.status).toBe(ExitCode.PROJECT_MOVED);
    expect(existsSync(join(sibling, '.cleo'))).toBe(false);

    const here = cleo(sibling, ['init', '--here']);
    expect(parseSoleEnvelope(here.stdout).success).toBe(true);
    expect(here.status).toBe(0);
    expect(existsSync(join(sibling, '.cleo', 'project-info.json'))).toBe(true);
  });

  it('no tombstone + `git checkout -- .`: `cleo find` still refuses and creates no cleo.db', () => {
    rmSync(join(root, '.cleo-moved.json'));
    git(root, 'checkout', '--', '.');
    expect(existsSync(join(root, '.cleo', 'project-id'))).toBe(true);

    const run = cleo(root, ['find', 'x']);
    const env = parseSoleEnvelope(run.stdout) as MovedError;
    expect(env.success).toBe(false);
    expect(env.error?.codeName).toBe('E_PROJECT_MOVED');
    expect(env.error?.details?.movedTo).toBe(child);
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(false);
  });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('a committed or forged tombstone (T12558 round 2)', () => {
  it('is ignored: find, doctor and a fresh store all work in the project', () => {
    const root = join(sandbox, 'forged');
    initProject(root);
    writeFileSync(
      join(root, '.cleo-moved.json'),
      JSON.stringify({ projectId: 'not-this-project', movedTo: '/nonexistent/x', at: 'x' }),
    );
    git(root, 'add', '-f', '.cleo-moved.json');
    git(root, 'commit', '--no-verify', '-qm', 'committed tombstone');
    // A fresh clone carries the committed tombstone and has no store yet.
    const clone = join(sandbox, 'forged-clone');
    execFileSync('git', ['clone', '-q', root, clone]);

    for (const dir of [root, clone]) {
      const find = cleo(dir, ['find', 'x']);
      expect(find.stdout).not.toContain('E_PROJECT_MOVED');
      expect(parseSoleEnvelope(find.stdout).success).toBe(true);
      expect(cleo(dir, ['doctor', 'project-identity']).stdout).not.toContain('E_PROJECT_MOVED');
    }
    expect(existsSync(join(clone, '.cleo', 'cleo.db'))).toBe(true);
  }, 300_000);
});
