/**
 * The restore-in-progress marker (T13258): while another live process holds
 * `<cleo.db>.restoring`, every store open refuses; the holder itself, a stale
 * marker (its process is gone) and a marker that clears in time do not block.
 *
 * @task T13258
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import {
  assertStoreNotRestoring,
  RESTORE_MARKER_SUFFIX,
  writeRestoreMarker,
} from '../restore-marker.js';
import { openNativeDatabase } from '../sqlite-native.js';

let dir: string;
let db: string;

/** A marker as another process would write it. */
function markerOf(pid: number): void {
  writeFileSync(
    db + RESTORE_MARKER_SUFFIX,
    JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString(), kind: 'restore' }),
  );
}

/** A pid that existed and is gone. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-restore-marker-'));
  db = join(dir, 'cleo.db');
  vi.stubEnv('CLEO_RESTORE_WAIT_MS', '50');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('restore-in-progress marker (T13258)', () => {
  it('no marker: nothing blocks', () => {
    expect(() => assertStoreNotRestoring(db)).not.toThrow();
  });

  it('another live process holds it: the guard and the store openers refuse', () => {
    markerOf(process.ppid);
    expect(() => assertStoreNotRestoring(db)).toThrow(/E_STORE_RESTORING/);
    expect(() => openNativeDatabase(db)).toThrow(/E_STORE_RESTORING/);
    expect(() => openCleoDbSnapshot(db)).toThrow(/E_STORE_RESTORING/);
    // Nothing was created beside the store.
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
  });

  it('this process holds it (the restorer itself): allowed', () => {
    const release = writeRestoreMarker(db, 'restore');
    expect(() => assertStoreNotRestoring(db)).not.toThrow();
    release();
    expect(existsSync(db + RESTORE_MARKER_SUFFIX)).toBe(false);
  });

  it('a stale marker (its process is gone) is ignored, and a new restore replaces it', () => {
    markerOf(deadPid());
    expect(() => assertStoreNotRestoring(db)).not.toThrow();
    const release = writeRestoreMarker(db, 'vault');
    release();
  });

  it('a second restore refuses while a live one holds the marker', () => {
    markerOf(process.ppid);
    expect(() => writeRestoreMarker(db, 'restore')).toThrow(/E_STORE_RESTORING/);
  });

  it('an unreadable marker blocks', () => {
    writeFileSync(db + RESTORE_MARKER_SUFFIX, '{not json');
    expect(() => assertStoreNotRestoring(db)).toThrow(/E_STORE_RESTORING/);
  });

  it('a marker cleared while the open waits lets it through', () => {
    markerOf(process.ppid);
    // Another process clears it while this thread is blocked in the wait.
    const clearer = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(db + RESTORE_MARKER_SUFFIX)}, { force: true }), 300)`,
    ]);
    try {
      expect(() => assertStoreNotRestoring(db, 10_000)).not.toThrow();
    } finally {
      clearer.kill();
    }
  });
});
