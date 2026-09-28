/**
 * `cleo session end` (the path the Claude Code Stop hook runs) takes the
 * session-end SQLite snapshot — in a DETACHED worker, so the command returns
 * without waiting for a VACUUM (T12508).
 *
 * Runs the BUILT CLI (`packages/cleo/dist/cli/index.js`) in a sandbox project
 * with its own `CLEO_HOME`. Skipped, with the reason below, when the CLI has
 * not been built.
 *
 * 1. With the snapshot lock held by someone else, `session end` still returns
 *    at CLI speed (an in-process snapshot would wait for the lock first) and
 *    no snapshot exists yet; once the lock is released, the worker writes it.
 * 2. Five concurrent `session end` calls produce one or two snapshots, not
 *    five: every request made before a snapshot started is covered by it.
 *
 * @task T12508
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);
if (!CLI_DIST_AVAILABLE) {
  process.stderr.write(
    'session-end-snapshot-cli: SKIPPED — packages/cleo/dist is not built (run `pnpm run build`).\n',
  );
}

/** Session end must return well below startup + the ~6.5 s in-process lock wait. */
const FAST_RETURN_MS = 5_000;

let sandbox: string;
let project: string;
let env: NodeJS.ProcessEnv;

/** The caller's environment without any CLEO binding, pointed at the sandbox home. */
function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CLEO_') && k !== 'VITEST' && !k.startsWith('VITEST_')) clean[k] = v;
  }
  return { ...clean, CLEO_HOME: home, XDG_DATA_HOME: home };
}

/** Run the built CLI synchronously in the sandbox project. */
function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { json: CliEnvelope; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: project,
    env: { ...env, ...extraEnv },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const ms = Date.now() - t0;
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let json: CliEnvelope;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`cleo ${args.join(' ')} → status ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return { json, ms };
}

/** Minimal LAFS envelope shape read by this test. */
interface CliEnvelope {
  success: boolean;
  data?: { id?: string; sessionId?: string; ended?: boolean };
}

/** Start a session and return its id. */
function startSession(name: string): string {
  // `--agent` lets several sessions be active at once (one per agent).
  const { json } = cli(['session', 'start', '--scope', 'global', '--name', name, '--agent', name]);
  const id = json.data?.id;
  if (!json.success || !id) throw new Error(`session start failed: ${JSON.stringify(json)}`);
  return id;
}

const backupDir = (): string => join(project, '.cleo', 'backups', 'sqlite');
const tasksSnapshots = (): string[] =>
  existsSync(backupDir())
    ? readdirSync(backupDir()).filter((f) => /^tasks-\d{8}-\d{6}\.db$/.test(f))
    : [];

/** One outcome line written by the detached worker. */
interface WorkerLine {
  result: { snapshotted: string[]; skipped: string | null } | null;
}

const workerLines = (): WorkerLine[] => {
  const log = join(project, '.cleo', 'logs', 'session-end-snapshot.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith('{') && l.includes('"session-end-snapshot"'))
    .map((l) => JSON.parse(l));
};

/** Poll until `done()` or the deadline. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo session end — detached snapshot (T12508)', () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12508-cli-'));
    project = join(sandbox, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    env = sandboxEnv(join(sandbox, 'home'));
    spawnSync('git', ['init', '-q', '.'], { cwd: project });
    const init = cli(['init', '--quiet']);
    if (!init.json.success) throw new Error(`init failed: ${JSON.stringify(init.json)}`);
  });

  afterEach(async () => {
    // Let any worker finish before removing its project.
    await waitFor(() => !existsSync(join(backupDir(), '.snapshot-gate.lock')), 30_000);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns at CLI speed and the snapshot appears afterwards', async () => {
    const id = startSession('fast-return');
    // Someone else holds the snapshot lock: an in-process snapshot would
    // have to wait for it before `session end` could return.
    const lockDir = join(backupDir(), '.snapshot-gate.lock');
    mkdirSync(lockDir, { recursive: true });

    const { json, ms } = cli(['session', 'end'], { CLEO_SESSION_ID: id });
    expect(json.success).toBe(true);
    expect(json.data?.ended).toBe(true);
    expect(ms).toBeLessThan(FAST_RETURN_MS);
    expect(tasksSnapshots()).toEqual([]);

    rmSync(lockDir, { recursive: true, force: true });
    const appeared = await waitFor(() => tasksSnapshots().length === 1, 30_000);
    expect(appeared).toBe(true);
    await waitFor(() => workerLines().length === 1, 10_000);
    expect(workerLines()[0]?.result?.snapshotted).toContain('tasks');
  }, 120_000);

  it('a burst of 5 concurrent session ends yields 1 or 2 snapshots, not 5', async () => {
    const ids = [1, 2, 3, 4, 5].map((i) => startSession(`burst-${i}`));
    const before = workerLines().length;

    await Promise.all(
      ids.map(
        (id) =>
          new Promise<void>((res, rej) => {
            const child: ChildProcess = spawn(process.execPath, [CLI_DIST, 'session', 'end'], {
              cwd: project,
              env: { ...env, CLEO_SESSION_ID: id },
              stdio: 'ignore',
            });
            child.on('error', rej);
            child.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`session end exited ${code}`)),
            );
          }),
      ),
    );

    // Wait until no worker is queued or running, then for the log to settle.
    const marker = join(backupDir(), '.session-end-worker.pending');
    const lock = join(backupDir(), '.snapshot-gate.lock');
    const idle = (): boolean =>
      workerLines().length > before && !existsSync(marker) && !existsSync(lock);
    expect(await waitFor(idle, 90_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(idle()).toBe(true);

    // One queued worker at a time (T12508 spawn marker): 1 or 2 workers ran,
    // not 5, and each one that ran either snapshotted or was covered.
    const lines = workerLines().slice(before);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    const snapshotted = lines.filter((l) => l.result?.snapshotted.includes('tasks'));
    expect(snapshotted.length).toBeGreaterThanOrEqual(1);
    expect(snapshotted.length).toBeLessThanOrEqual(2);
    for (const l of lines) {
      if (!l.result?.snapshotted.includes('tasks')) expect(l.result?.skipped).toBe('covered');
    }
  }, 180_000);
});
