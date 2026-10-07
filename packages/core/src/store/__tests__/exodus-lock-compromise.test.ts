/**
 * The exodus single-flight lock under a long stage (T12785).
 *
 * Each exodus stage is one synchronous transaction, so proper-lockfile's
 * refresh timer cannot fire while it runs. The lock's stale window must
 * exceed the longest stage, and a holder that loses the lock anyway must stop
 * at its next stage boundary instead of crashing from the timer.
 *
 * Contenders run in child processes: the holder's event loop is blocked, as
 * it is during a real stage.
 *
 * @task T12785
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exodusRefusalToEngineResult } from '../../errors-to-engine.js';
import {
  _resetDualScopeDbCache,
  assertExodusWriteSafe,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import {
  EXODUS_LOCK_STALE_MS,
  ExodusRunInProgressError,
  exodusRunLockPath,
  markExodusRunHeld,
} from '../exodus/abort-events.js';
import { runExodusMigrate } from '../exodus/migrate.js';
import type { ExodusPlan } from '../exodus/types.js';
import { acquireLock, lockCompromiseTracker } from '../lock.js';

const require = createRequire(import.meta.url);
const LOCKFILE = require.resolve('proper-lockfile');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-exodus-lock-'));
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(dir, { recursive: true, force: true });
});

/** Block this process's event loop for `ms`, as one long synchronous stage does. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A child that tries to take `path` once (no retries) with `stale`; exit 0 = took it. */
function contenderScript(path: string, stale: number, delayMs: number): string {
  return [
    `const lockfile = require(${JSON.stringify(LOCKFILE)});`,
    `setTimeout(() => {`,
    `  lockfile.lock(${JSON.stringify(path)}, { stale: ${stale}, realpath: false, retries: 0 })`,
    `    .then(() => process.exit(0), () => process.exit(3));`,
    `}, ${delayMs});`,
  ].join('\n');
}

describe('the exodus lock window outlasts a long stage (T12785)', () => {
  it('the shipped window outlasts the longest measured stage with margin', () => {
    // A 1.3 GB snapshot copied as one stage took 38.0 s (T12785 measurement).
    expect(EXODUS_LOCK_STALE_MS).toBeGreaterThanOrEqual(3 * 38_000);
  });

  it('a stage longer than the refresh interval but inside the window keeps exclusivity', async () => {
    // Injected short window: the holder refreshes every stale/2, and one
    // synchronous "stage" of 3/4 of the window blocks that refresh, as a real
    // stage does — with a quarter of the window as margin for a loaded runner.
    const stale = 8_000;
    const path = join(dir, 'cleo.db.exodus-on-open.lock');
    writeFileSync(path, '');
    const lock = lockCompromiseTracker();
    const release = await acquireLock(path, { stale, onCompromised: lock.onCompromised });
    try {
      blockEventLoop((stale * 3) / 4);
      const contender = spawnSync(process.execPath, ['-e', contenderScript(path, stale, 0)], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(contender.status, contender.stderr).toBe(3);
      expect(lock.reason()).toBeNull();
    } finally {
      await release();
    }
  }, 30_000);

  it('a holder that loses the lock records it instead of crashing from the timer', async () => {
    // proper-lockfile's smallest stale window is 2 s; the holder's loop is
    // blocked past it while a contender takes the lock as stale.
    const path = join(dir, 'short.lock');
    writeFileSync(path, '');
    const lock = lockCompromiseTracker();
    const release = await acquireLock(path, { stale: 2_000, onCompromised: lock.onCompromised });
    const child = spawn(process.execPath, ['-e', contenderScript(path, 2_000, 2_500)]);
    const took = new Promise<number | null>((done) => child.on('exit', done));
    blockEventLoop(4_500);
    expect(await took).toBe(0);
    // The holder's next refresh finds the lock taken: recorded, not thrown.
    await new Promise((done) => setTimeout(done, 1_500));
    expect(lock.reason()).not.toBeNull();
    await release().catch(() => undefined);
  }, 30_000);
});

describe('an exodus run stops between stages when its lock is lost (T12785)', () => {
  it('the next stage never starts, and the run reports E_EXODUS_LOCK_LOST', async () => {
    const tasks = new DatabaseSync(join(dir, 'tasks.db'));
    tasks.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    tasks.exec("INSERT INTO tasks VALUES ('T1', 'legacy')");
    tasks.close();
    const brain = new DatabaseSync(join(dir, 'brain.db'));
    brain.exec('CREATE TABLE brain_observations (id TEXT PRIMARY KEY, title TEXT)');
    brain.exec("INSERT INTO brain_observations VALUES ('O1', 'legacy')");
    brain.close();
    const plan: ExodusPlan = {
      sources: [
        { name: 'tasks', path: join(dir, 'tasks.db'), targetScope: 'project' },
        { name: 'brain', path: join(dir, 'brain.db'), targetScope: 'project' },
      ],
      totalSourceBytes: 0,
      largestSourceBytes: 0,
      requiredBytes: 0,
      stagingCopyThresholdBytes: 256 * 1024 * 1024,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir: join(dir, 'staging'),
      resumeFromStaging: false,
      projectDbPath: join(dir, 'cleo.db'),
      globalDbPath: join(dir, 'global.db'),
    };
    // The lock is lost after the first stage committed.
    let checks = 0;
    const attached: string[] = [];
    const result = await runExodusMigrate(
      plan,
      false,
      (m) => {
        if (m.includes('Attached')) attached.push(m);
      },
      {
        projectOnly: true,
        abortReason: () => (checks++ === 0 ? null : 'taken by another process'),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/E_EXODUS_LOCK_LOST: taken by another process/);
    expect(attached.some((m) => m.includes('[brain]'))).toBe(false);
  });
});

describe('ordinary writes are refused while another process runs exodus or a reconcile (T12785)', () => {
  it('a write chokepoint refuses during the run, allows the holder, and allows after release', async () => {
    const dbPath = join(dir, 'cleo.db');
    const handle = await openDualScopeDbAtPath('project', dbPath);
    const native = getDualScopeNativeDb(handle);
    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();

    // Another process takes the store's exodus lock, as a reconcile does.
    const lockPath = exodusRunLockPath(dbPath);
    writeFileSync(lockPath, '');
    const held = join(dir, 'held');
    const done = join(dir, 'done');
    const child = spawn(process.execPath, [
      '-e',
      [
        `const fs = require('node:fs');`,
        `const lockfile = require(${JSON.stringify(LOCKFILE)});`,
        `lockfile.lock(${JSON.stringify(lockPath)}, { stale: ${EXODUS_LOCK_STALE_MS}, realpath: false }).then((release) => {`,
        `  fs.writeFileSync(${JSON.stringify(held)}, '');`,
        `  const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(done)})) { clearInterval(t); release().then(() => process.exit(0)); } }, 50);`,
        `});`,
      ].join('\n'),
    ]);
    const exited = new Promise<number | null>((resolveExit) => child.on('exit', resolveExit));
    while (!existsSync(held)) await new Promise((r) => setTimeout(r, 50));

    // An ordinary write through the chokepoint is refused, with its code and remedy.
    const refused = await assertExodusWriteSafe(native).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ExodusRunInProgressError);
    const envelope = exodusRefusalToEngineResult(refused);
    expect(envelope?.success).toBe(false);
    expect(JSON.stringify(envelope)).toContain('E_EXODUS_RUN_WRITE_UNSAFE');
    // The remedy covers a crashed holder: how long it blocks, and what to remove.
    const fix = (refused as ExodusRunInProgressError).fix;
    expect(fix).toContain(`up to ${EXODUS_LOCK_STALE_MS / 60_000} minutes`);
    expect(fix).toContain(`"${lockPath}.lock"`);

    // The holder's own writes are never refused, and overlapping holds of one
    // lock count: releasing the inner hold keeps the outer one (T13225).
    markExodusRunHeld(lockPath, true);
    markExodusRunHeld(lockPath, true);
    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
    markExodusRunHeld(lockPath, false);
    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
    markExodusRunHeld(lockPath, false);
    await expect(assertExodusWriteSafe(native)).rejects.toBeInstanceOf(ExodusRunInProgressError);

    writeFileSync(done, '');
    expect(await exited).toBe(0);
    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
  }, 30_000);
});
