/**
 * Superseded-store detection (T12095).
 *
 * The behaviour under test is a diagnosis, so the assertions are about not
 * lying in either direction: a migrated project's leftover `tasks.db` must be
 * named as dead, and a project that has NOT migrated must never be told its
 * live database is a leftover.
 *
 * @task T12095
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // db-open-allowed: test fixture seeding
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_STORE_FILENAME, scanSupersededStores } from '../superseded-store.js';

let root: string;
let cleoDir: string;

/** Create a SQLite file with `table` populated by `rows` empty records. */
function seed(path: string, table: string, rows: number, firstId = 1): void {
  const db = new DatabaseSync(path); // db-open-allowed: test fixture seeding
  db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY)`);
  for (let i = 0; i < rows; i++) db.exec(`INSERT INTO "${table}" (id) VALUES (${i + firstId})`);
  db.close();
}

/** Backdate a file so mtime ordering is deterministic, not race-dependent. */
function backdate(path: string, daysAgo: number): void {
  const t = new Date(Date.parse('2026-08-09T00:00:00Z') - daysAgo * 86_400_000);
  utimesSync(path, t, t);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-superseded-'));
  cleoDir = join(root, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanSupersededStores (T12095)', () => {
  it('names a leftover tasks.db as superseded and proves it with row counts', () => {
    // The measured PepsVida shape: empty legacy file, populated prefixed table.
    seed(join(cleoDir, 'tasks.db'), 'tasks', 0);
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 1123);
    backdate(join(cleoDir, 'tasks.db'), 60);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 0);

    const { entries } = scanSupersededStores(root);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e?.name).toBe('tasks.db');
    expect(e?.rowsInSuperseded).toBe(0);
    expect(e?.rowsInLive).toBe(1123);
    expect(e?.safeToArchive).toBe(true);
    // The reason must carry the evidence, because it is printed verbatim to an
    // agent that has already convinced itself the DB is truncated.
    expect(e?.reason).toContain('1123');
    expect(e?.reason).toContain(LIVE_STORE_FILENAME);
  });

  it('reports NOTHING when the project never migrated', () => {
    // Without cleo.db, `tasks.db` IS the live store. Flagging it would tell an
    // operator to delete their only database.
    seed(join(cleoDir, 'tasks.db'), 'tasks', 42);

    const result = scanSupersededStores(root);
    expect(result.liveStoreExists).toBe(false);
    expect(result.entries).toEqual([]);
  });

  it('withholds the archive recommendation when the legacy file still holds rows', () => {
    // Both populated, but the legacy rows are NOT in cleo.db (ids 5000+) → the
    // migration is incomplete. Naming it is useful; recommending deletion is not.
    seed(join(cleoDir, 'tasks.db'), 'tasks', 7, 5000);
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 1123);
    backdate(join(cleoDir, 'tasks.db'), 30);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 0);

    const [e] = scanSupersededStores(root).entries;
    expect(e?.rowsInSuperseded).toBe(7);
    expect(e?.missingInLive).toBe(7);
    expect(e?.safeToArchive).toBe(false);
    expect(e?.reason).toContain('NOT recommended');
    // T12319: the dead end now names the supported remedy.
    expect(e?.reason).toContain('cleo doctor superseded-store --reconcile');
  });

  it('recommends archiving once every legacy row is present in cleo.db by key (T12319)', () => {
    seed(join(cleoDir, 'tasks.db'), 'tasks', 7);
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 1123);
    backdate(join(cleoDir, 'tasks.db'), 30);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 0);

    const [e] = scanSupersededStores(root).entries;
    expect(e?.missingInLive).toBe(0);
    expect(e?.safeToArchive).toBe(true);
    expect(e?.reason).toContain('reconciled');
  });

  it('ignores a legacy file NEWER than cleo.db', () => {
    // Newer means something may still be writing it — stay silent rather than
    // advise removal of live data.
    seed(join(cleoDir, 'tasks.db'), 'tasks', 0);
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 5);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 10);
    backdate(join(cleoDir, 'tasks.db'), 0);

    expect(scanSupersededStores(root).entries).toEqual([]);
  });

  it('is clean on a tidied project', () => {
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 5);
    expect(scanSupersededStores(root).entries).toEqual([]);
  });

  it('reports a 0-byte legacy file as provably empty and safe to archive (T12099)', () => {
    // The measured PepsVida shape: brain.db is 0 bytes. A 0-byte file holds
    // zero rows BY DEFINITION — reporting "an unknown number of rows" and
    // withholding the verdict manufactures the corruption signal this check
    // exists to eliminate.
    writeFileSync(join(cleoDir, 'brain.db'), '');
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'brain_observations', 1309);
    backdate(join(cleoDir, 'brain.db'), 7);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 0);

    const { entries } = scanSupersededStores(root);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e?.name).toBe('brain.db');
    expect(e?.sizeBytes).toBe(0);
    expect(e?.rowsInSuperseded).toBe(0);
    expect(e?.rowsInLive).toBe(1309);
    expect(e?.safeToArchive).toBe(true);
    expect(e?.reason).toContain('0 bytes');
    expect(e?.reason).not.toContain('unknown number');
  });

  it('survives a legacy file that is not valid SQLite', () => {
    // A truncated or garbage file must degrade to "unreadable", not throw and
    // take the whole doctor run down.
    seed(join(cleoDir, LIVE_STORE_FILENAME), 'tasks_tasks', 5);
    backdate(join(cleoDir, LIVE_STORE_FILENAME), 0);
    const junk = join(cleoDir, 'tasks.db');
    writeFileSync(junk, 'not a database', 'utf-8');
    backdate(junk, 30);

    const [e] = scanSupersededStores(root).entries;
    expect(e?.rowsInSuperseded).toBeNull();
    expect(e?.safeToArchive).toBe(false);
  });
});
