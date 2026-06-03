/**
 * T11568 — regression: write-path commands must EXIT, not hang at rc:124.
 *
 * ## The bug
 *
 * The CLEO CLI success path does NOT call `process.exit()`; it emits the LAFS
 * envelope and returns, relying on the libuv event loop draining naturally so
 * the process exits rc:0 (see `runMainWithLafsEnvelope` in `../index.ts`).
 *
 * Post-E6, every hot-path `brain.db` write (`cleo memory observe`, decisions,
 * the dialectic pipeline) was funneled through a `worker_threads.Worker`
 * (T10351 single-writer chokepoint). That worker's `MessagePort` keeps the
 * event loop alive forever, and its `process.on('exit')` shutdown can never run
 * (the loop never drains to fire it). So `cleo memory observe` printed its
 * success envelope and then **hung** until the shell timed it out (rc:124).
 *
 * The fix: the CLI success-path `finally` calls `shutdownCliRuntime()` (core),
 * which terminates the brain-writer worker thread + pino-roll transport worker
 * + closes DB handles, AFTER the envelope is written. The loop then drains and
 * the process exits rc:0.
 *
 * ## What this test proves
 *
 * Spawns the COMPILED CLI as a subprocess with a hard timeout. `spawnSync`
 * surfaces a hang as `status: null` + `signal: 'SIGTERM'`. We assert the
 * process exits on its own (status is a number, signal is null) — i.e. it did
 * NOT have to be killed. A pre-fix binary fails this assertion; the fixed
 * binary exits rc:0.
 *
 * This is a subprocess test (not the inline brain-writer unit test) on purpose:
 * the worker only spawns when `brain-writer-worker.js` is resolvable on disk,
 * which is true for the shipped dist but not inside the vitest worker. Only a
 * real CLI subprocess exercises the exact hang.
 *
 * ## T11655 — briefing residual spin/hang
 *
 * #914 (T11568 above) tore down the brain-writer worker but NOT the
 * `EmbeddingQueue` worker, and the opportunistic dream in `cleo briefing` could
 * run transformers.js embeddings on the main thread (the worker-unavailable
 * fallback) → CPU spin (state Rl) holding the brain WAL open. The T11655 fix
 * (a) tears down the embedding worker in `shutdownCliRuntime` and (b) gates the
 * opportunistic dream OFF for one-shot read commands. The added case below
 * proves a one-shot `cleo briefing` exits on its own (no lingering worker).
 *
 * @task T11568
 * @task T11655
 * @epic T11249 (E6)
 * @saga T11242
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to the compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Run the compiled CLI as a subprocess against an isolated tmp project root +
 * global data home. A 20s hard timeout converts a hang into a `SIGTERM` kill so
 * the assertion can distinguish "exited on its own" from "had to be killed".
 */
function runCli(args: readonly string[], projectRoot: string, dataHome: string): CliResult {
  const env = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    XDG_DATA_HOME: dataHome,
    CLEO_OUTPUT_FORMAT: 'json',
  };
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 20_000,
    cwd: projectRoot,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal ?? null,
  };
}

let projectRoot: string;
let dataHome: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T11568-'));
  dataHome = await mkdtemp(join(tmpdir(), 'cleo-T11568-xdg-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!CLI_DIST_AVAILABLE)('T11568 — write commands exit, never hang (rc:124)', () => {
  it('cleo init then `memory observe` exits on its own (not killed by timeout)', () => {
    const init = runCli(['init'], projectRoot, dataHome);
    expect(init.signal, `init was killed (hang); stderr:\n${init.stderr}`).toBeNull();

    const observe = runCli(
      ['memory', 'observe', 'process exits cleanly', '--title', 'T11568 regression'],
      projectRoot,
      dataHome,
    );

    // The core regression assertion: a hang manifests as a SIGTERM kill from
    // the spawnSync timeout. The process MUST exit on its own.
    expect(
      observe.signal,
      `memory observe was KILLED by the timeout (process hang regression).\nstdout:\n${observe.stdout}\nstderr:\n${observe.stderr}`,
    ).toBeNull();
    expect(observe.status).toBe(0);

    // Sanity: it actually did the write (success envelope on stdout).
    expect(observe.stdout).toContain('"success":true');
    expect(observe.stdout).toContain('"operation":"memory.observe"');
  }, 60_000);

  it('a second `memory observe` in the same project also exits cleanly', () => {
    runCli(['init'], projectRoot, dataHome);
    runCli(['memory', 'observe', 'first', '--title', 'first'], projectRoot, dataHome);
    const second = runCli(
      ['memory', 'observe', 'second', '--title', 'second'],
      projectRoot,
      dataHome,
    );

    expect(
      second.signal,
      `second memory observe was killed (hang).\nstderr:\n${second.stderr}`,
    ).toBeNull();
    expect(second.status).toBe(0);
  }, 60_000);

  it('a read-path command (`find`) also exits on its own (control — never hangs)', () => {
    runCli(['init'], projectRoot, dataHome);
    const find = runCli(['find', 'anything'], projectRoot, dataHome);
    // The regression property is "exits on its own", not a specific code:
    // `find` with no matches conventionally exits 100, which is still a clean
    // self-exit (signal === null), NOT a timeout kill. Assert non-hang only.
    expect(find.signal, `find was killed (hang).\nstderr:\n${find.stderr}`).toBeNull();
    expect(typeof find.status).toBe('number');
  }, 60_000);

  it('T11655: a one-shot `cleo briefing` exits on its own (no lingering embedding worker / dream spin)', () => {
    const init = runCli(['init'], projectRoot, dataHome);
    expect(init.signal, `init was killed (hang); stderr:\n${init.stderr}`).toBeNull();

    const briefing = runCli(['briefing'], projectRoot, dataHome);

    // The regression: an undismissed EmbeddingQueue worker MessagePort — or an
    // opportunistic main-thread dream — keeps the loop alive and the spawnSync
    // timeout kills the process (signal === 'SIGTERM'). A one-shot read command
    // MUST exit on its own.
    expect(
      briefing.signal,
      `cleo briefing was KILLED by the timeout (spin/hang regression).\nstdout:\n${briefing.stdout}\nstderr:\n${briefing.stderr}`,
    ).toBeNull();
    expect(typeof briefing.status).toBe('number');
  }, 60_000);
});
