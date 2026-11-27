#!/usr/bin/env node
/**
 * Smoke: the BUILT `cleo review verdict` exits in bounded time and leaves no
 * defunct children (T14670 AC3).
 *
 * A `cleo review verdict` from the field printed its envelope, then stayed
 * resident for 7 days with two zombie children and ignored SIGTERM. This runs
 * the built CLI's verdict path in a throwaway sandbox (its own HOME, XDG dirs
 * and CLEO_HOME, a fresh `cleo init`), with a stub `gh` first on PATH that
 * answers `gh pr view` and `gh pr diff`. The verdict names a real task with one
 * criterion and a wrong packet hash, so it is refused at the packet check: the
 * path runs session binding, the task lookup, both `gh` calls, the refusal and
 * the CLI's error exit. It runs twice: inline brain writes (the CLI
 * default), and `CLEO_BRAIN_WRITER_THREAD=1`, the only way this path starts a
 * worker thread.
 *
 * Each run is one process (`NODE_OPTIONS` carries the heap cap, so the bin
 * shim does not re-exec). While it runs, `ps` is polled; a child of it in state
 * `Z` for {@link DEFUNCT_POLLS} consecutive polls is a defunct child that is
 * not being reaped. It fails when a run outlives {@link EXIT_BOUND_MS}, leaves
 * a defunct child, or prints anything but one JSON envelope on stdout.
 *
 * Needs a current build (`packages/cleo/dist`). POSIX only (`ps`, a shell stub).
 *
 * Usage: node scripts/smoke-review-verdict-exit.mjs
 *
 * @task T14670
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A run that has not exited by now has hung. */
const EXIT_BOUND_MS = 30_000;
/** `ps` poll interval. */
const POLL_MS = 100;
/** Consecutive polls a zombie may be seen before it counts as defunct (~1 s). */
const DEFUNCT_POLLS = 10;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repoRoot, 'packages/cleo/bin/cleo.js');
if (!existsSync(join(repoRoot, 'packages/cleo/dist/cli/index.js'))) {
  process.stderr.write('smoke-review-verdict-exit: packages/cleo/dist is missing; build first.\n');
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'cleo-verdict-smoke-'));
const project = join(sandbox, 'project');
const stubBin = join(sandbox, 'bin');
mkdirSync(project, { recursive: true });
mkdirSync(stubBin, { recursive: true });
writeFileSync(
  join(stubBin, 'gh'),
  [
    '#!/bin/sh',
    'case "$*" in',
    '  *"pr view"*) echo 0123456789abcdef0123456789abcdef01234567 ;;',
    '  *"pr diff"*) printf "diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-a\\n+b\\n" ;;',
    '  *) echo "stub gh: unsupported: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'),
);
chmodSync(join(stubBin, 'gh'), 0o755);

const baseEnv = {
  ...process.env,
  PATH: `${stubBin}:${process.env.PATH ?? ''}`,
  HOME: join(sandbox, 'home'),
  XDG_DATA_HOME: join(sandbox, 'xdg-data'),
  XDG_CONFIG_HOME: join(sandbox, 'xdg-config'),
  XDG_CACHE_HOME: join(sandbox, 'xdg-cache'),
  XDG_STATE_HOME: join(sandbox, 'xdg-state'),
  CLEO_HOME: join(sandbox, 'cleo-home'),
  NODE_OPTIONS: '--max-old-space-size=1536',
  CLEO_SESSION_ID: '',
  CLEO_AGENT_ID: 'verdict-smoke',
};
for (const dir of ['home', 'xdg-data', 'xdg-config', 'xdg-cache', 'xdg-state', 'cleo-home']) {
  mkdirSync(join(sandbox, dir), { recursive: true });
}

spawnSync('git', ['init', '-q'], { cwd: project });
const init = spawnSync(process.execPath, [bin, 'init', 'verdict-smoke'], {
  cwd: project,
  env: baseEnv,
  encoding: 'utf-8',
  timeout: 120_000,
});
if (init.status !== 0) {
  process.stderr.write(
    `smoke-review-verdict-exit: cleo init failed (${init.status})\n${init.stderr}\n`,
  );
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

// Creating a task needs a session; it binds to this agent id for every later call.
const session = spawnSync(
  process.execPath,
  [bin, 'session', 'start', '--scope', 'global', '--name', 'verdict exit smoke'],
  { cwd: project, env: baseEnv, encoding: 'utf-8', timeout: 120_000 },
);
if (session.status !== 0) {
  process.stderr.write(
    `smoke-review-verdict-exit: cleo session start failed (${session.status})\n${session.stdout}\n${session.stderr}\n`,
  );
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

// A real task with one criterion, so the verdict gets past the task lookup to
// the packet check, after both `gh` calls.
const add = spawnSync(
  process.execPath,
  // A fresh project's first task must be a saga (strict-spine containment).
  [
    bin,
    'saga',
    'create',
    '--title',
    'verdict exit smoke',
    '--description',
    'T14670 smoke target',
    '--acceptance',
    'exits',
    '--field',
    '/data/created/0',
  ],
  { cwd: project, env: baseEnv, encoding: 'utf-8', timeout: 120_000 },
);
const taskId = add.stdout.trim();
if (add.status !== 0 || !/^T\d+$/.test(taskId)) {
  process.stderr.write(
    `smoke-review-verdict-exit: cleo saga create failed (${add.status})\n${add.stdout}\n${add.stderr}\n`,
  );
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

/** Zombie children of `pid`, from one `ps` snapshot. */
function zombieChildren(pid) {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,stat='], { encoding: 'utf-8' });
  return ps.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, stat]) => ppid === String(pid) && stat?.startsWith('Z'))
    .map(([child]) => child);
}

/** Run the verdict once; resolves with what went wrong, or [] when clean. */
function runVerdict(label, extraEnv) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        bin,
        'review',
        'verdict',
        '1',
        '--task',
        taskId,
        '--ac',
        'AC1',
        '--met',
        '--reason',
        'exit smoke',
        '--packet',
        '0'.repeat(64),
      ],
      { cwd: project, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const seen = new Map();
    const defunct = new Set();
    const poll = setInterval(() => {
      const now = new Set(zombieChildren(child.pid));
      for (const pid of [...seen.keys()]) if (!now.has(pid)) seen.delete(pid);
      for (const pid of now) {
        const count = (seen.get(pid) ?? 0) + 1;
        seen.set(pid, count);
        if (count >= DEFUNCT_POLLS) defunct.add(pid);
      }
    }, POLL_MS);
    const bound = setTimeout(() => child.kill('SIGKILL'), EXIT_BOUND_MS);
    child.on('exit', (code, signal) => {
      clearInterval(poll);
      clearTimeout(bound);
      const elapsed = Date.now() - started;
      const problems = [];
      if (elapsed >= EXIT_BOUND_MS) problems.push(`did not exit within ${EXIT_BOUND_MS} ms`);
      if (defunct.size > 0) problems.push(`left defunct children: ${[...defunct].join(', ')}`);
      const lines = stdout.trim().split('\n').filter(Boolean);
      let envelopeOk = lines.length === 1;
      try {
        if (envelopeOk) JSON.parse(lines[0]);
      } catch {
        envelopeOk = false;
      }
      if (!envelopeOk) problems.push(`stdout is not one JSON envelope: ${stdout.slice(0, 300)}`);
      process.stdout.write(
        `${label}: exit ${code ?? signal} in ${elapsed} ms; ${problems.length ? 'FAIL' : 'ok'}\n`,
      );
      if (problems.length) process.stderr.write(`${label}: ${problems.join('; ')}\n${stderr}\n`);
      done(problems);
    });
  });
}

const failures = [
  ...(await runVerdict('inline brain writes', {})),
  ...(await runVerdict('brain writer thread', { CLEO_BRAIN_WRITER_THREAD: '1' })),
];
rmSync(sandbox, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
