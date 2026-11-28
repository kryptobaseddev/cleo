#!/usr/bin/env node
/**
 * Smoke: the BUILT `cleo review verdict` exits in bounded time and leaves no
 * defunct children (T14670 AC3).
 *
 * A `cleo review verdict` from the field printed its envelope, then stayed
 * resident for 7 days with two zombie children and ignored SIGTERM. This runs
 * the built CLI's verdict path in a throwaway sandbox (its own HOME, XDG dirs
 * and CLEO_HOME, a fresh `cleo init`), with a stub `gh` first on PATH that
 * answers `gh pr view` and `gh pr diff` and logs each call. An author agent
 * creates a saga with two criteria and claims it; a second agent (the reviewer)
 * builds the packet with `cleo review packet` and records a `met` verdict with
 * that packet's hash, so the verdict succeeds: session binding, the task and
 * claim reads, both `gh` calls, the verdict row write and the CLI's success
 * exit. It runs twice, one criterion each: inline brain writes (the CLI
 * default), and `CLEO_BRAIN_WRITER_THREAD=1`, the only way this path starts a
 * worker thread.
 *
 * Each run is one process (`NODE_OPTIONS` carries the heap cap, so the bin
 * shim does not re-exec). While it runs, `ps` is polled; a child of it in state
 * `Z` for {@link DEFUNCT_POLLS} consecutive polls is a defunct child that is
 * not being reaped. A run fails when it outlives {@link EXIT_BOUND_MS}, leaves
 * a defunct child, exits other than 0, prints anything but one successful
 * JSON envelope, made no `gh pr view` + `gh pr diff` call, or when `cleo review
 * check` does not then list its criterion as met (the verdict row).
 *
 * Needs a current build (`packages/cleo/dist`). POSIX only (`ps`, a shell stub).
 *
 * Usage: node scripts/smoke-review-verdict-exit.mjs
 *
 * @task T14670
 */

import { spawn, spawnSync } from 'node:child_process';
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
    `echo "$*" >> ${JSON.stringify(join(sandbox, 'gh-calls.log'))}`,
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
  CLEO_AGENT_ID: 'smoke-author',
  CLEO_NO_UPDATE_NOTICE: '1',
};
/** The reviewer: a different agent, so it is not an author of the task. */
const reviewerEnv = { ...baseEnv, CLEO_AGENT_ID: 'smoke-reviewer' };

/** Run the built CLI to completion; exit the smoke on failure. */
function cleo(args, env = baseEnv) {
  const run = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    env,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  if (run.status !== 0) {
    process.stderr.write(
      `smoke-review-verdict-exit: cleo ${args.slice(0, 2).join(' ')} failed (${run.status})\n${run.stdout}\n${run.stderr}\n`,
    );
    rmSync(sandbox, { recursive: true, force: true });
    process.exit(1);
  }
  return run.stdout.trim();
}

/** Lines in the stub's call log. */
function ghCalls() {
  const file = join(sandbox, 'gh-calls.log');
  return existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
}
for (const dir of ['home', 'xdg-data', 'xdg-config', 'xdg-cache', 'xdg-state', 'cleo-home']) {
  mkdirSync(join(sandbox, dir), { recursive: true });
}

spawnSync('git', ['init', '-q'], { cwd: project });
cleo(['init', 'verdict-smoke']);
// The author: a session, then a saga (a fresh project's first task must be one)
// with one criterion per run, claimed so the verdict has an author to differ from.
cleo(['session', 'start', '--scope', 'global', '--name', 'verdict smoke author']);
const taskId = cleo([
  'saga',
  'create',
  '--title',
  'verdict exit smoke',
  '--description',
  'T14670 smoke target',
  '--acceptance',
  'inline run exits|writer-thread run exits',
  '--field',
  '/data/created/0',
]);
if (!/^T\d+$/.test(taskId)) {
  process.stderr.write(`smoke-review-verdict-exit: unexpected task id ${taskId}\n`);
  process.exit(1);
}
cleo(['start', taskId]);
// The reviewer records under its own session (E_SESSION_UNBOUND otherwise).
cleo(['session', 'start', '--scope', 'global', '--name', 'review #1'], reviewerEnv);
const reviewerSession = cleo(
  ['session', 'status', '--field', '/data/session/session/id'],
  reviewerEnv,
);
if (!/^ses_/.test(reviewerSession)) {
  process.stderr.write(`smoke-review-verdict-exit: no reviewer session (${reviewerSession})\n`);
  process.exit(1);
}
reviewerEnv.CLEO_SESSION_ID = reviewerSession;
// The reviewer reads the packet; its hash is what the verdict binds to.
const packetSha256 = cleo(
  ['review', 'packet', '1', '--task', taskId, '--field', '/data/packetSha256'],
  reviewerEnv,
);

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
function runVerdict(label, ac, extraEnv) {
  return new Promise((done) => {
    const callsBefore = ghCalls().length;
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
        ac,
        '--met',
        '--reason',
        'exit smoke',
        '--packet',
        packetSha256,
      ],
      { cwd: project, env: { ...reviewerEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
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
      if (code !== 0) problems.push(`exit ${code ?? signal}, expected 0`);
      const lines = stdout.trim().split('\n').filter(Boolean);
      let envelope = null;
      try {
        if (lines.length === 1) envelope = JSON.parse(lines[0]);
      } catch {
        envelope = null;
      }
      if (envelope?.success !== true || envelope.data?.verdict !== 'met') {
        problems.push(`stdout is not one successful verdict envelope: ${stdout.slice(0, 300)}`);
      }
      const calls = ghCalls().slice(callsBefore);
      if (
        !calls.some((c) => c.startsWith('pr view')) ||
        !calls.some((c) => c.startsWith('pr diff'))
      ) {
        problems.push(`the verdict made no gh pr view + pr diff call (saw: ${calls.join(' | ')})`);
      }
      // The verdict row: `review check` must now list this criterion as met.
      const check = spawnSync(
        process.execPath,
        [bin, 'review', 'check', '1', '--task', taskId, '--field', '/data/checks/0/met'],
        { cwd: project, env: reviewerEnv, encoding: 'utf-8', timeout: 120_000 },
      );
      let met = [];
      try {
        met = JSON.parse(check.stdout.trim() || '[]');
      } catch {
        met = [];
      }
      if (!Array.isArray(met) || !met.includes(ac)) {
        problems.push(
          `no verdict row: review check lists met=${check.stdout.trim()} ${check.stderr.slice(0, 200)}`,
        );
      }
      process.stdout.write(
        `${label}: exit ${code ?? signal} in ${elapsed} ms; ${problems.length ? 'FAIL' : 'ok'}\n`,
      );
      if (problems.length) process.stderr.write(`${label}: ${problems.join('; ')}\n${stderr}\n`);
      done(problems);
    });
  });
}

const failures = [
  ...(await runVerdict('inline brain writes', 'AC1', {})),
  ...(await runVerdict('brain writer thread', 'AC2', { CLEO_BRAIN_WRITER_THREAD: '1' })),
];
rmSync(sandbox, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
