/**
 * What the heavy-command hook (T12983) needs from the `cleo run` CLI (#1777).
 *
 * The hook wraps an agent's command in place as
 * `cleo run --wait --passthrough … -- <command>`, leaving pipes and
 * redirections to the agent's shell. That is only safe when:
 *
 * 1. `--passthrough` hands the child the line's stdio: the child's stdout
 *    reaches stdout byte for byte, its stderr and exit code are kept, and
 *    `cleo run`'s own envelopes (a failed command, a deferral with exit 75)
 *    go to stderr, never stdout;
 * 2. an unwritable `CLEO_HOME` (sandboxed shells) does not stop the command:
 *    it runs ungoverned and a notice says so.
 *
 * Both landed in #1777 (these cases were `it.fails` pins until then). The
 * compiled CLI runs with a temp HOME, CLEO_HOME and cwd, and the commands it
 * runs are `sh -c` one-liners, never real tools. Skipped without a build.
 *
 * @task T12983
 * @epic T12978
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
/** A case that needs the compiled CLI: skipped without a build. */
const live = existsSync(CLI_DIST) ? it : it.skip;

let dir: string;
let cleoHome: string;
let holder: ChildProcess | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-run-hook-contract-'));
  cleoHome = join(dir, 'cleo-home');
  mkdirSync(cleoHome);
  mkdirSync(join(dir, 'home'));
});

afterEach(async () => {
  if (holder !== null && holder.exitCode === null) {
    await new Promise((done) => holder?.once('exit', done));
  }
  holder = null;
  chmodSync(cleoHome, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    CLEO_HOME: cleoHome,
    TMPDIR: dir,
  };
}

function cleo(args: readonly string[]) {
  const r = spawnSync('node', [CLI_DIST, ...args], {
    cwd: dir,
    env: env(),
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('cleo run --passthrough (#1777)', () => {
  live(
    'keeps the child stdout byte for byte; stderr, exit code and its own envelope go to stderr',
    () => {
      const r = cleo([
        'run',
        '--wait',
        '--passthrough',
        '--class',
        'test',
        '--',
        'sh',
        '-c',
        'printf "child-out\\nno newline at end"; printf "child-err\\n" >&2; exit 3',
      ]);
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('child-out\nno newline at end');
      expect(r.stderr).toContain('child-err');
      expect(r.stderr).toContain('[cleo run] E_COMMAND_FAILED: command exited with 3');
    },
  );

  live('reports a deferral (exit 75) on stderr and leaves stdout empty', async () => {
    // full-build is one slot machine-wide (here: per temp CLEO_HOME). Hold it.
    holder = spawn(
      'node',
      [CLI_DIST, 'run', '--class', 'full-build', '--', 'sh', '-c', 'echo held >&2; sleep 4'],
      { cwd: dir, env: env(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('holder was never admitted')), 30_000);
      holder?.stderr?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('held')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const r = cleo([
      'run',
      '--passthrough',
      '--class',
      'full-build',
      '--',
      'sh',
      '-c',
      'touch ran',
    ]);
    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('E_RESOURCE_DEFERRED');
    // The deferral's suggestions quote the command, so prove it never ran by
    // its side effect instead.
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
});

describe('cleo run fails open when CLEO_HOME is unwritable (#1777)', () => {
  live('runs the command ungoverned with a notice', () => {
    chmodSync(cleoHome, 0o555);
    const r = cleo([
      'run',
      '--wait',
      '--timeout',
      '10',
      '--class',
      'test',
      '--',
      'sh',
      '-c',
      'echo CHILD-RAN; exit 3',
    ]);
    expect(r.status).toBe(3);
    expect(`${r.stdout}${r.stderr}`).toContain('CHILD-RAN');
    expect(r.stderr).toMatch(/ungoverned|EACCES|EPERM|EROFS|ENOSPC/i);
  });
});
