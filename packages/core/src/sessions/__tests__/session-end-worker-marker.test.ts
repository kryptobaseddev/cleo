/**
 * At most one session-end snapshot worker is queued per project (T12508).
 *
 * `requestSessionEndSnapshot` runs in-process with `detached` mode forced; the
 * worker it spawns is the real compiled entry (`dist/sessions/…-entry.js`).
 * Skipped, with the reason below, when dist is not built.
 *
 * 1. With the gate lock held (a snapshot "in flight"), a burst of 15 requests
 *    spawns ONE worker; the other 14 coalesce onto it.
 * 2. Once that worker has claimed its generation, a later request (a write
 *    after the claim) spawns a new worker, which takes a new snapshot.
 * 3. A marker whose pid is dead, or that is older than the stale bound, does
 *    not block a spawn.
 *
 * @task T12508
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY_DIST = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'dist',
  'sessions',
  'session-end-snapshot-entry.js',
);
const DIST_MISSING = !existsSync(ENTRY_DIST);
if (DIST_MISSING) {
  process.stderr.write(
    'session-end-worker-marker: SKIPPED — packages/core/dist is not built ' +
      '(run `pnpm --filter @cleocode/core run build`).\n',
  );
}

/** Env keys this test overrides; restored afterwards. */
const ENV_KEYS = [
  'CLEO_SESSION_END_SNAPSHOT',
  'CLEO_HOME',
  'XDG_DATA_HOME',
  'CLEO_DIR',
  'CLEO_ROOT',
] as const;

/** One outcome line written by the worker. */
interface WorkerLine {
  pid: number;
  result: { snapshotted: string[]; skipped: string | null } | null;
}

/** Poll until `done()` or the deadline. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

describe.skipIf(DIST_MISSING)('session-end worker marker (T12508)', { timeout: 120_000 }, () => {
  let workDir: string;
  let projectRoot: string;
  let backupDir: string;
  let saved: Record<string, string | undefined>;

  const markerPath = (): string => join(backupDir, '.session-end-worker.pending');
  const lockDir = (): string => join(backupDir, '.snapshot-gate.lock');
  const workerLines = (): WorkerLine[] => {
    const log = join(projectRoot, '.cleo', 'logs', 'session-end-snapshot.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('{') && l.includes('"session-end-snapshot"'))
      .map((l) => JSON.parse(l));
  };

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    workDir = mkdtempSync(join(tmpdir(), 'cleo-t12508-marker-'));
    projectRoot = join(workDir, 'project');
    backupDir = join(projectRoot, '.cleo', 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(join(workDir, 'home'), { recursive: true });
    process.env['CLEO_SESSION_END_SNAPSHOT'] = 'detached';
    process.env['CLEO_HOME'] = join(workDir, 'home');
    process.env['XDG_DATA_HOME'] = join(workDir, 'home');
    // The vitest fork pins CLEO_DIR/CLEO_ROOT to its own sandbox; this test
    // (and the worker, which inherits the env) must resolve projectRoot.
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    // Create the project store before any worker races to open it.
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
  });

  afterEach(async () => {
    rmSync(lockDir(), { recursive: true, force: true });
    await waitFor(() => !existsSync(markerPath()) && !existsSync(lockDir()), 60_000);
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('a burst of 15 queues one worker; a request after its claim spawns the next', async () => {
    const { requestSessionEndSnapshot } = await import('../session-end-snapshot.js');
    // A snapshot is "in flight": the first worker must wait for the lock.
    mkdirSync(lockDir(), { recursive: true });

    const burst = await Promise.all(
      Array.from({ length: 15 }, () => requestSessionEndSnapshot(projectRoot)),
    );
    const spawned = burst.filter((r) => r.mode === 'detached');
    expect(spawned).toHaveLength(1);
    expect(burst.filter((r) => r.mode === 'coalesced')).toHaveLength(14);
    expect(existsSync(markerPath())).toBe(true);

    // Release: the worker takes the lock, drops the marker, claims, snapshots.
    rmSync(lockDir(), { recursive: true, force: true });
    expect(await waitFor(() => workerLines().length === 1, 60_000)).toBe(true);
    expect(workerLines()[0]?.result?.snapshotted).toContain('tasks');
    expect(existsSync(markerPath())).toBe(false);

    // A session ending AFTER that claim is not covered by it: a new worker.
    const trailing = await requestSessionEndSnapshot(projectRoot);
    expect(trailing.mode).toBe('detached');
    expect(await waitFor(() => workerLines().length === 2, 60_000)).toBe(true);
    expect(workerLines()[1]?.result?.snapshotted).toContain('tasks');
  });

  it('a marker with a dead pid, or older than the stale bound, does not block', async () => {
    const { requestSessionEndSnapshot, SESSION_END_MARKER_STALE_MS } = await import(
      '../session-end-snapshot.js'
    );
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(markerPath(), JSON.stringify({ token: 'orphan', pid: dead }));
    expect((await requestSessionEndSnapshot(projectRoot)).mode).toBe('detached');
    await waitFor(() => workerLines().length === 1, 60_000);

    // Live pid (this process) but an old marker.
    writeFileSync(markerPath(), JSON.stringify({ token: 'old', pid: process.pid }));
    const old = (Date.now() - SESSION_END_MARKER_STALE_MS - 60_000) / 1000;
    utimesSync(markerPath(), old, old);
    expect((await requestSessionEndSnapshot(projectRoot)).mode).toBe('detached');
    await waitFor(() => workerLines().length === 2, 60_000);
  });
});
