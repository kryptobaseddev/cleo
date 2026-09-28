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
 * ## T12024 — dialectic evaluation deadline (post-mutate hook hang)
 *
 * The dispatcher fires a background `evaluateDialectic` after every successful
 * mutate. That evaluation makes an HTTP fetch to the resolved LLM backend
 * (Ollama in warm tier), which keeps the event loop alive after
 * `shutdownCliRuntime` tears down workers and databases. The fix wraps the
 * evaluation with an AbortController whose unrefed 10-second deadline cancels
 * the HTTP fetch when the LLM backend is hung, allowing the loop to drain.
 * The fake-Ollama-server case below proves this end-to-end.
 *
 * @task T11568
 * @task T11655
 * @task T12024
 * @epic T11249 (E6)
 * @saga T11242
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
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
    // getCleoHome() ignores XDG_DATA_HOME off Linux; pin it too (T12602).
    CLEO_HOME: join(dataHome, 'cleo'),
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

// ============================================================================
// T12024 — mutation commands exit despite a hung dialectic LLM backend
// ============================================================================

/**
 * The dispatcher fires a background dialectic evaluation (→ Ollama) after
 * every successful mutate. When the LLM backend accepts the connection but
 * never responds, the pending HTTP fetch keeps the event loop alive after
 * `shutdownCliRuntime` tears down everything else.
 *
 * This test starts a fake Ollama HTTP server on localhost:11434 that:
 *   - Responds to GET /api/tags (so the warm-tier probe finds a backend),
 *   - Writes HTTP headers for POST /v1/chat/completions but never calls
 *     res.end() so the response body never arrives → fetch hangs.
 *
 * Without the abort-signal deadline the subprocess would hang until the
 * 20-second spawnSync timeout kills it (signal: SIGTERM). With the fix,
 * the 10-second unrefed deadline fires, cancelling the fetch so the
 * event loop drains and the CLI exits on its own.
 *
 * The describe block skips if port 11434 cannot be bound (e.g. real Ollama
 * is running) or the compiled CLI dist is unavailable.
 *
 * @task T12024
 */
describe('T12024 — mutation exit with hung dialectic backend (fake Ollama)', () => {
  let projectRoot: string;
  let dataHome: string;
  let fakeOllama: ReturnType<typeof createServer> | null = null;
  let fakeOllamaBound = false;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T12024-'));
    dataHome = await mkdtemp(join(tmpdir(), 'cleo-T12024-xdg-'));
    await mkdir(join(projectRoot, '.cleo'), { recursive: true });

    // tryOllama() hardcodes localhost:11434 for both the /api/tags probe
    // AND the AI-SDK-compatible provider base URL.
    fakeOllama = createServer((_req, res) => {
      if (_req.method === 'GET' && _req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b' }] }));
        return;
      }
      if (_req.method === 'POST' && _req.url === '/v1/chat/completions') {
        // Write the HTTP status line so the connection is established, then
        // NEVER call res.end(). The client's fetch blocks on the body and
        // the dispatcher's AbortController must cancel it.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    fakeOllama.timeout = 0;
    fakeOllama.keepAliveTimeout = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        fakeOllama!.once('error', reject);
        fakeOllama!.listen(11434, '127.0.0.1', () => {
          fakeOllama!.removeAllListeners('error');
          fakeOllama!.on('error', () => {
            /* swallow late errors during teardown */
          });
          resolve();
        });
      });
      fakeOllamaBound = true;
    } catch {
      fakeOllamaBound = false;
      if (fakeOllama) {
        try {
          fakeOllama.closeAllConnections?.();
        } catch {
          /* best-effort */
        }
        await new Promise<void>((r) => fakeOllama!.close(() => r()));
        fakeOllama = null;
      }
    }
  });

  afterEach(async () => {
    if (fakeOllama) {
      try {
        fakeOllama.closeAllConnections?.();
      } catch {
        /* best-effort */
      }
      await new Promise<void>((resolve) => {
        fakeOllama!.close(() => resolve());
      });
      fakeOllama = null;
    }
    fakeOllamaBound = false;
    await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
  });

  function runCliWithFakeOllama(
    args: readonly string[],
    _projectRoot: string,
    _dataHome: string,
  ): CliResult {
    const env = {
      ...process.env,
      CLEO_PROJECT_ROOT: _projectRoot,
      CLEO_ROOT: _projectRoot,
      CLEO_DIR: join(_projectRoot, '.cleo'),
      XDG_DATA_HOME: _dataHome,
      CLEO_HOME: join(_dataHome, 'cleo'),
      CLEO_OUTPUT_FORMAT: 'json',
    };
    const result = spawnSync('node', [CLI_DIST, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 20_000,
      cwd: _projectRoot,
      env,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      signal: result.signal ?? null,
    };
  }

  it(
    'mutation exits on its own when dialectic backend hangs (deadline abort → loop drain)',
    {
      skip: !CLI_DIST_AVAILABLE || !fakeOllamaBound,
    },
    () => {
      const init = runCliWithFakeOllama(['init'], projectRoot, dataHome);
      expect(init.signal, `init was killed (hang); stderr:\n${init.stderr}`).toBeNull();

      // Start a session so the dispatcher has a sessionId for dialectic eval.
      const session = runCliWithFakeOllama(
        ['session', 'start', 'epic:T12024', 'test-session'],
        projectRoot,
        dataHome,
      );
      expect(
        session.signal,
        `session start was killed (hang); stderr:\n${session.stderr}`,
      ).toBeNull();
      expect(session.status).toBe(0);

      // Create a task — this mutate triggers the dispatcher's setImmediate
      // dialectic evaluation, which resolves the fake Ollama backend and
      // calls generateObject → POST /v1/chat/completions → hangs.
      const add = runCliWithFakeOllama(
        ['add', 'T12024 regression task', '--type', 'task'],
        projectRoot,
        dataHome,
      );
      expect(add.stdout).toContain('"success":true');
      expect(add.stdout).toContain('"operation":"tasks.add"');

      // The key assertion: the process MUST exit on its own. Without the
      // deadline, the hung fetch keeps the event loop alive → spawnSync
      // kills it after 20s → signal === 'SIGTERM'. With T12024, the 10s
      // unrefed deadline aborts the fetch and the event loop drains
      // naturally.
      expect(
        add.signal,
        `cleo add was KILLED by timeout (dialectic fetch hang regression).\nstdout:\n${add.stdout}\nstderr:\n${add.stderr}`,
      ).toBeNull();
      expect(typeof add.status).toBe('number');
    },
    60_000,
  );
});
