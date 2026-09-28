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
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  const logLines = (): string[] => {
    const log = join(projectRoot, '.cleo', 'logs', 'session-end-snapshot.log');
    return existsSync(log) ? readFileSync(log, 'utf-8').split('\n') : [];
  };
  const coalescedLines = (): string[] =>
    logLines().filter((l) => l.includes('"session-end-snapshot-coalesced"'));
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
    // Every coalesced request is recorded in the worker log (T12508 round 5).
    expect(coalescedLines()).toHaveLength(14);
    // The marker is written once and never rewritten (so a hand-off can never
    // recreate a marker the worker already dropped): it still names this
    // requester, and the worker's identity is in the per-token sidecar.
    const marker: { token: string; pid: number } = JSON.parse(readFileSync(markerPath(), 'utf-8'));
    expect(marker.pid).toBe(process.pid);
    const sidecar: { pid: number } = JSON.parse(
      readFileSync(`${markerPath()}.${marker.token}.worker`, 'utf-8'),
    );
    expect(sidecar.pid).toBe(spawned[0]?.pid);

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

  /**
   * r5-race (T12508 round 5): A reads generation G and queues worker W_A; a
   * snapshot already in flight (W0) then claims G+1 and completes; C writes
   * and coalesces onto W_A. W_A must still snapshot — its snapshot is the only
   * one that can contain C's write — even though a generation above A's read
   * exists. Also when the intervening claim was a tasks-only pre-destructive
   * snapshot.
   */
  for (const scope of ['all prefixes', 'tasks only (pre-destructive)'] as const) {
    it(`a queued worker is not covered by a claim made while it waited: ${scope}`, async () => {
      const { requestSessionEndSnapshot } = await import('../session-end-snapshot.js');
      const { getNativeDb } = await import('../../store/sqlite.js');
      const db = getNativeDb(projectRoot);
      if (!db) throw new Error('project store not open');
      db.exec('CREATE TABLE IF NOT EXISTS zz (x TEXT)');

      // W0 is in flight (holds the lock); A ends its session and queues W_A.
      mkdirSync(lockDir(), { recursive: true });
      const a = await requestSessionEndSnapshot(projectRoot);
      expect(a.mode).toBe('detached');

      // W0 claims G+1 and records its snapshot — after A's generation read.
      const g = (a.seenGeneration ?? 0) + 1;
      const now = Date.now();
      const prefixes =
        scope === 'all prefixes'
          ? ['tasks', 'brain', 'conduit', 'llmtxt', 'signaldock-project']
          : ['tasks'];
      db.prepare(
        'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(
        'sqlite_snapshot_gate',
        JSON.stringify({
          generation: g,
          prefixes: Object.fromEntries(
            prefixes.map((p) => [p, { generation: g, startedAt: now, completedAt: now }]),
          ),
        }),
      );

      // C's final write lands after W0's claim; C coalesces onto W_A.
      db.exec("INSERT INTO zz VALUES ('C-final-write')");
      expect((await requestSessionEndSnapshot(projectRoot)).mode).toBe('coalesced');

      rmSync(lockDir(), { recursive: true, force: true });
      expect(await waitFor(() => workerLines().length === 1, 60_000)).toBe(true);
      expect(workerLines()[0]?.result?.snapshotted).toContain('tasks');

      const newest = readdirSync(backupDir)
        .filter((f) => /^tasks-\d{8}-\d{6}\.db$/.test(f))
        .sort()
        .pop();
      expect(newest).toBeDefined();
      const copy = new DatabaseSync(join(backupDir, newest ?? ''), { readOnly: true });
      const rows = copy.prepare('SELECT x FROM zz').all() as Array<{ x: string }>;
      copy.close();
      expect(rows.map((r) => r.x)).toContain('C-final-write');
    });
  }

  it('a marker naming a live pid that is a DIFFERENT process (pid 1) does not block', async () => {
    const { requestSessionEndSnapshot } = await import('../session-end-snapshot.js');
    // pid 1 is always alive, but it is not the worker that wrote this marker.
    writeFileSync(
      markerPath(),
      JSON.stringify({ token: 'impostor', pid: 1, pidStart: 'Thu Jan  1 00:00:00 1970' }),
    );
    expect((await requestSessionEndSnapshot(projectRoot)).mode).toBe('detached');
    await waitFor(() => workerLines().length === 1, 60_000);
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
