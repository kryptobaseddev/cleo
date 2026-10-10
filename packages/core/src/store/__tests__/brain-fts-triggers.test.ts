/**
 * Brain FTS5 update triggers stay off the identity fill (T12894).
 *
 * The uid fill is a TEMP AFTER INSERT trigger that UPDATEs the new row, and it
 * fires before the FTS insert trigger. An unscoped external-content update
 * trigger replays a `'delete'` of a row the index does not hold yet, which
 * corrupts the index. Fresh stores open through the chokepoint under a
 * `mkdtemp` directory.
 *
 * @task T12894
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFts5Tables } from '../../memory/brain-search.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { brainFtsUpdateTriggerSql, upgradeBrainFtsUpdateTriggers } from '../row-identity.js';

let dir: string;
let dbPath: string;

async function open(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const handle = await openDualScopeDbAtPath('project', dbPath);
  return handle.db.$client as DatabaseSync;
}

const insertObservation = (db: DatabaseSync, id: string, title: string) =>
  db
    .prepare(
      "INSERT INTO brain_observations (id, type, title, created_at, valid_at) VALUES (?, 'discovery', ?, '2026-09-01 09:04:00', '2026-09-01 09:04:00')",
    )
    .run(id, title);

const integrity = (db: DatabaseSync) =>
  db.exec("INSERT INTO brain_observations_fts(brain_observations_fts) VALUES('integrity-check')");

const matches = (db: DatabaseSync, term: string) =>
  (
    db
      .prepare(
        'SELECT count(*) AS n FROM brain_observations_fts WHERE brain_observations_fts MATCH ?',
      )
      .get(term) as { n: number }
  ).n;

const triggerSql = (db: DatabaseSync, name: string) =>
  (
    db
      .prepare("SELECT sql FROM main.sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name) as { sql: string } | undefined
  )?.sql;

/** The trigger text every store held before T12894: fires on any column. */
const UNSCOPED_AU = `CREATE TRIGGER brain_observations_au AFTER UPDATE ON brain_observations BEGIN
  INSERT INTO brain_observations_fts(brain_observations_fts, rowid, id, title, narrative)
  VALUES('delete', old.rowid, old.id, old.title, old.narrative);
  INSERT INTO brain_observations_fts(rowid, id, title, narrative)
  VALUES (new.rowid, new.id, new.title, new.narrative);
END`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-fts-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('brain FTS update triggers and the uid fill', () => {
  it('a filled insert keeps the FTS index intact and searchable', async () => {
    const db = await open();
    expect(ensureFts5Tables(db)).toBe(true);
    insertObservation(db, 'O-1', 'uid fill meets fts');
    const row = db.prepare('SELECT uid FROM brain_observations WHERE id = ?').get('O-1') as {
      uid: string | null;
    };
    expect(row.uid).not.toBeNull();
    expect(() => integrity(db)).not.toThrow();
    expect(matches(db, 'fts')).toBe(1);
    db.prepare("UPDATE brain_observations SET title = 'retitled entry' WHERE id = 'O-1'").run();
    expect(matches(db, 'retitled')).toBe(1);
    expect(matches(db, 'fts')).toBe(0);
    expect(() => integrity(db)).not.toThrow();
  });

  it('a store holding the unscoped trigger is rewritten at open, before any fill', async () => {
    const first = await open();
    ensureFts5Tables(first);
    first.exec('DROP TRIGGER brain_observations_au');
    first.exec(UNSCOPED_AU);
    expect(triggerSql(first, 'brain_observations_au')).not.toMatch(/UPDATE OF/);
    const db = await open();
    expect(triggerSql(db, 'brain_observations_au')).toMatch(/AFTER UPDATE OF id, title, narrative/);
    insertObservation(db, 'O-2', 'after the upgrade');
    expect(() => integrity(db)).not.toThrow();
    expect(matches(db, 'upgrade')).toBe(1);
  });

  it('the upgrade is idempotent and leaves a store without FTS alone', async () => {
    const db = await open();
    expect(upgradeBrainFtsUpdateTriggers(db)).toEqual([]);
    ensureFts5Tables(db);
    expect(upgradeBrainFtsUpdateTriggers(db)).toEqual([]);
    expect(triggerSql(db, 'brain_decisions_au')).toBe(
      brainFtsUpdateTriggerSql('brain_decisions').replace(' IF NOT EXISTS', ''),
    );
  });
});
