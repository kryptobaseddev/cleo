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
  it('covers every non-capture trigger, in name order, and ignores capture triggers', () => {
    const a = store();
    const b = store();
    a.exec(GUARD);
    a.exec("CREATE TRIGGER h AFTER INSERT ON t BEGIN SELECT 'h'; END");
    b.exec("CREATE TRIGGER h AFTER INSERT ON t BEGIN SELECT 'h'; END"); // other creation order
    b.exec(GUARD);
    expect(triggerSetHash(a)).toBe(triggerSetHash(b));
    const before = triggerSetHash(a);
    a.exec("CREATE TRIGGER _sync_cap_t_i AFTER INSERT ON t BEGIN SELECT 'cap'; END");
    expect(triggerSetHash(a), 'a capture trigger changed the pin').toBe(before);
    a.exec('DROP TRIGGER g');
    a.exec(GUARD.replaceAll("'Done'", "'done'"));
    expect(triggerSetHash(a), 'a guard literal change kept the pin').not.toBe(before);
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
