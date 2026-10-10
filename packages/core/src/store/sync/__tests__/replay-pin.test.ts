/**
 * The replay pin (journal spec §2.11 §7; T12343 S4-1b): the ordered
 * migration journal hash, and the literal-safe trigger-set hash.
 *
 * @task T12343
 */

import { DatabaseSync } from 'node:sqlite';
import { ReplayPin } from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import {
  migrationJournalHash,
  normalizeTriggerDdl,
  replayPinOf,
  triggerSetHash,
} from '../replay-pin.js';

const GUARD = `CREATE TRIGGER g BEFORE UPDATE ON t
  WHEN NEW.status = 'Done' AND OLD.status IS NOT 'Done'
  BEGIN SELECT RAISE(ABORT, 'no  way'); END`;

function store(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT)');
  db.exec(
    'CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)',
  );
  return db;
}

describe('normalizeTriggerDdl (literal-safe)', () => {
  it('ignores layout, keyword case and comments outside literals', () => {
    const relaid = `create   trigger G
      before update on T -- a comment
      when new.STATUS='Done' and old.status is not 'Done'
      begin select raise ( abort , 'no  way' ) ; end;`;
    expect(normalizeTriggerDdl(relaid)).toBe(normalizeTriggerDdl(GUARD));
  });

  it('keeps string literals byte for byte', () => {
    expect(normalizeTriggerDdl(GUARD.replaceAll("'Done'", "'done'"))).not.toBe(
      normalizeTriggerDdl(GUARD),
    );
    // Whitespace inside a literal is content.
    expect(normalizeTriggerDdl(GUARD.replace("'no  way'", "'no way'"))).not.toBe(
      normalizeTriggerDdl(GUARD),
    );
    expect(normalizeTriggerDdl("SELECT 'it''s'")).toBe("select 'it''s'");
  });

  it('unifies identifier quoting', () => {
    const forms = ['"t"', '`t`', '[t]'].map((q) =>
      normalizeTriggerDdl(`CREATE TRIGGER g AFTER INSERT ON ${q} BEGIN SELECT 1; END`),
    );
    expect(new Set(forms).size).toBe(1);
  });
});

describe('triggerSetHash', () => {
  /** An owned guard trigger (its name is in OWNED_TRIGGERS), with GUARD's body. */
  const OWNED = GUARD.replace(
    'CREATE TRIGGER g ',
    'CREATE TRIGGER tasks_tasks_parent_cycle_guard_insert ',
  );
  const freeze = (version: string) =>
    `CREATE TRIGGER t12535_freeze_docs_insert BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'docs frozen by ${version}'); END`;

  it('hashes the owned triggers only: device-local freeze and track triggers never split two devices (T13298)', () => {
    const a = store();
    const b = store();
    a.exec(OWNED);
    b.exec(OWNED.replaceAll('\n', ' ').replace('BEFORE UPDATE', 'before   update')); // same trigger, other layout
    // Device-local maintenance: frozen by different builds, track triggers on one store only.
    a.exec(freeze('2026.10.3'));
    b.exec(freeze('2026.10.5'));
    a.exec("CREATE TRIGGER t12535_track_docs_insert AFTER INSERT ON t BEGIN SELECT 'track'; END");
    a.exec("CREATE TRIGGER _sync_cap_t_i AFTER INSERT ON t BEGIN SELECT 'cap'; END");
    expect(triggerSetHash(a)).toBe(triggerSetHash(b));
  });

  it('changes when an owned trigger changes', () => {
    const a = store();
    a.exec(OWNED);
    const before = triggerSetHash(a);
    a.exec('DROP TRIGGER tasks_tasks_parent_cycle_guard_insert');
    a.exec(OWNED.replaceAll("'Done'", "'done'"));
    expect(triggerSetHash(a), 'an owned guard literal change kept the pin').not.toBe(before);
    a.exec('DROP TRIGGER tasks_tasks_parent_cycle_guard_insert');
    expect(triggerSetHash(a), 'a dropped owned guard kept the pin').not.toBe(before);
  });
});

describe('migrationJournalHash', () => {
  it('hashes the whole journal in (created_at, name) order, whatever the row order', () => {
    const a = store();
    const b = store();
    const ins = (db: DatabaseSync, hash: string, at: number, name: string) =>
      db
        .prepare('INSERT INTO "__drizzle_migrations" (hash, created_at, name) VALUES (?, ?, ?)')
        .run(hash, at, name);
    ins(a, 'h1', 1, 'm1');
    ins(a, 'h2', 2, 'm2');
    ins(b, 'h2', 2, 'm2'); // inserted out of order
    ins(b, 'h1', 1, 'm1');
    expect(migrationJournalHash(a)).toBe(migrationJournalHash(b));
    // A drifted row below the head changes it.
    a.prepare("UPDATE \"__drizzle_migrations\" SET hash = 'hx' WHERE name = 'm1'").run();
    expect(migrationJournalHash(a)).not.toBe(migrationJournalHash(b));
  });

  it('a store without the journal hashes an empty list', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrationJournalHash(db)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('replayPinOf', () => {
  it('is a valid wire replay pin and carries the transitions it is given', () => {
    const db = store();
    db.exec(GUARD);
    const rise = { seq: 4, schemaVersion: 2, journal: 'a'.repeat(64) };
    const pin = replayPinOf(db, [rise]);
    expect(ReplayPin.safeParse(pin).error?.issues ?? []).toEqual([]);
    expect(pin.transitions).toEqual([rise]);
    expect(replayPinOf(db).transitions).toEqual([]);
  });
});
