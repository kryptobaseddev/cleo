/**
 * `cleo run --passthrough` end to end (#1777 R7): the compiled CLI with a
 * temp HOME, CLEO_HOME and cwd, and `node -e` / `sh -c` one-liners as the
 * child, never a real tool. stdout must be exactly the child's bytes; cleo
 * run's own words go to stderr, and only when something is out of the
 * ordinary. Skipped without a build (CI restores one before unit tests).
 *
 * @task T12979
 * @epic T12978
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const live = existsSync(CLI_DIST) ? it : it.skip;

let dir: string;
let cleoHome: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-run-passthrough-'));
  cleoHome = join(dir, 'cleo-home');
  mkdirSync(cleoHome);
  mkdirSync(join(dir, 'home'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cleo(args: readonly string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: join(dir, 'home'), CLEO_HOME: cleoHome, TMPDIR: dir },
    input,
    timeout: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr.toString('utf-8'), status: r.status };
}

/** Bytes no text pipeline would leave alone: NUL, high bytes, an escape, CR without LF at the end. */
const BYTES = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x7b, 0x7d, 0x0d];

describe('cleo run --passthrough (compiled CLI)', () => {
  live('stdout is byte-identical to the child, with no envelope; stderr passes through', () => {
    const r = cleo([
      'run',
      '--passthrough',
      '--class',
      'test',
      '--',
      process.execPath,
      '-e',
      `process.stdout.write(Buffer.from(${JSON.stringify(BYTES)})); process.stderr.write('child-err\\n')`,
    ]);
    expect(r.status).toBe(0);
    expect(Buffer.compare(r.stdout, Buffer.from(BYTES))).toBe(0);
    expect(r.stderr).toBe('child-err\n'); // quiet: nothing of cleo run's own
  });

  live("the child reads this process's stdin", () => {
    const r = cleo(['run', '--passthrough', '--', 'sh', '-c', 'cat'], 'piped-in');
    expect(r.status).toBe(0);
    expect(r.stdout.toString('utf-8')).toBe('piped-in');
  });

  live(
    'exit codes pass through: the child code, 128+n for a signal, 127 when it cannot start',
    () => {
      const failed = cleo([
        'run',
        '--passthrough',
        '--',
        'sh',
        '-c',
        'printf out; printf "child-err\\n" >&2; exit 3',
      ]);
      expect(failed.status).toBe(3);
      expect(failed.stdout.toString('utf-8')).toBe('out');
      expect(failed.stderr).toContain('child-err');
      expect(failed.stderr).toContain('E_COMMAND_FAILED');

      const killed = cleo(['run', '--passthrough', '--', 'sh', '-c', 'kill -TERM $$']);
      expect(killed.status).toBe(143);
      expect(killed.stdout.length).toBe(0);

      const missing = cleo(['run', '--passthrough', '--', 'cleo-run-no-such-command-x9']);
      expect(missing.status).toBe(127);
      expect(missing.stdout.length).toBe(0);
      expect(missing.stderr).toContain('E_COMMAND_FAILED');
    },
  );

  live('a deferral exits 75 with E_RESOURCE_DEFERRED on stderr and nothing on stdout', () => {
    // Someone is already waiting for the single full-build slot (this test
    // process, alive): a newcomer without --wait defers without trying.
    const queue = join(cleoHome, 'run', 'queue', 'full-build');
    mkdirSync(queue, { recursive: true });
    const ticket = {
      id: 'ahead',
      pid: process.pid,
      runnerStart: null,
      enqueuedAtMs: 1,
      heartbeatAtMs: Date.now(),
      command: 'turbo run build',
    };
    writeFileSync(join(queue, 'ahead.json'), `${JSON.stringify(ticket)}\n`);
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
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain('E_RESOURCE_DEFERRED');
    // The child never ran (the envelope's alternatives quote the command, so
    // only a side effect can prove it).
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  live('invalid input exits 6 on stderr, nothing on stdout', () => {
    const r = cleo(['run', '--passthrough', '--']);
    expect(r.status).toBe(6);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain('E_VALIDATION');
  });
});
