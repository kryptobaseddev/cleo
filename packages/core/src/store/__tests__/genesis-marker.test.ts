/**
 * The genesis marker (T12343 S4-1b): while another live process snapshots
 * the store for its genesis checkpoint, a store open and the write chokepoint
 * (`assertExodusWriteSafe`) wait, then refuse with `E_STORE_GENESIS`; a
 * write that waits it out lands once the marker clears.
 *
 * "Another process" is a marker naming this test's parent process, as the
 * restore-marker tests do: the holder's own pid is exempt by design.
 *
 * @task T12343
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertExodusWriteSafe } from '../dual-scope-db.js';
import { awaitStoreWritable, RESTORE_MARKER_SUFFIX } from '../restore-marker.js';
import { openNativeDatabase } from '../sqlite-native.js';

let dir: string;
let dbPath: string;

/** A genesis marker as another live process (the parent) would hold it. */
function genesisHeldElsewhere(): void {
  writeFileSync(
    dbPath + RESTORE_MARKER_SUFFIX,
    JSON.stringify({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      kind: 'genesis',
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-genesis-marker-'));
  dbPath = join(dir, 'cleo.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (v TEXT)');
  db.close();
  vi.stubEnv('CLEO_RESTORE_WAIT_MS', '50');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('genesis marker (T12343 S4-1b)', () => {
  it('a handle opened before the snapshot refuses its write cleanly, naming the genesis cut', async () => {
    const db = new DatabaseSync(dbPath);
    try {
      genesisHeldElsewhere();
      await expect(assertExodusWriteSafe(db)).rejects.toThrow(/E_STORE_GENESIS/);
      expect(() => openNativeDatabase(dbPath)).toThrow(/E_STORE_GENESIS/);
      // Refused before any SQL: nothing was written.
      expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a write that waits out the snapshot lands after it', async () => {
    const db = new DatabaseSync(dbPath);
    genesisHeldElsewhere();
    // The snapshot finishes (its marker is released) while the writer waits.
    const finisher = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(dbPath + RESTORE_MARKER_SUFFIX)}, { force: true }), 300)`,
    ]);
    try {
      const started = Date.now();
      await awaitStoreWritable(db.location(), 10_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      await assertExodusWriteSafe(db);
      db.exec("INSERT INTO t (v) VALUES ('after')");
      expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'after' }]);
    } finally {
      finisher.kill();
      db.close();
    }
  });

  it('an in-memory database is never blocked', async () => {
    await expect(awaitStoreWritable(null)).resolves.toBeUndefined();
  });
});
