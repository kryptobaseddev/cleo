/**
 * The rule-1 bracket applies rule 2 to a declared rebuild (journal spec §2.3a
 * rule 2; A T12774): foreign keys off before BEGIN, only new violations
 * refused, the FK mode restored after.
 *
 * Inside a transaction `PRAGMA foreign_keys` is a no-op, so a drizzle-style
 * rebuild's `DROP TABLE` of a parent cascade-deletes its children. These
 * tests use a plain temp database with an `ON DELETE CASCADE` child.
 *
 * @task T12774
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BracketForeignKeyError, withSyncTriggersSuspended } from '../structural.js';

let dir: string;
let db: DatabaseSync;

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const fkMode = (): number =>
  (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;

/** Rebuild `p` the way drizzle does: copy, drop, rename. */
function rebuildParent(): void {
  db.exec('CREATE TABLE __new_p (id TEXT PRIMARY KEY, name TEXT, extra TEXT)');
  db.exec('INSERT INTO __new_p (id, name) SELECT id, name FROM p');
  db.exec('DROP TABLE p');
  db.exec('ALTER TABLE __new_p RENAME TO p');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-bracket-fk-'));
  db = new DatabaseSync(join(dir, 'store.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE p (id TEXT PRIMARY KEY, name TEXT)');
  db.exec(
    'CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT REFERENCES p(id) ON DELETE CASCADE, v TEXT)',
  );
  db.exec("INSERT INTO p VALUES ('P1', 'one'), ('P2', 'two')");
  db.exec("INSERT INTO c VALUES ('C1', 'P1', 'a'), ('C2', 'P1', 'b'), ('C3', 'P2', 'c')");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('withSyncTriggersSuspended — declared rebuilds (A, T12774)', () => {
  it('without a declaration, a parent rebuild inside the bracket cascade-deletes its children', () => {
    // The hazard the option exists for: FK stays on, and the DROP cascades.
    withSyncTriggersSuspended(db, 'project', rebuildParent);
    expect(count('SELECT count(*) AS n FROM c')).toBe(0);
  });

  it('a declared parent rebuild keeps every child, and foreign keys are back on', () => {
    withSyncTriggersSuspended(db, 'project', rebuildParent, { rebuilds: ['p'] });
    expect(count('SELECT count(*) AS n FROM c')).toBe(3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(fkMode()).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('a pre-existing orphan never blocks the rebuild', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO c VALUES ('C9', 'GONE', 'orphan')");
    db.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      withSyncTriggersSuspended(db, 'project', rebuildParent, { rebuilds: ['p'] }),
    ).not.toThrow();
    expect(count('SELECT count(*) AS n FROM c')).toBe(4);
    expect(fkMode()).toBe(1);
  });

  it('a rebuild that creates a new violation rolls back and restores foreign keys', () => {
    expect(() =>
      withSyncTriggersSuspended(
        db,
        'project',
        () => {
          rebuildParent();
          db.exec("DELETE FROM p WHERE id = 'P2'"); // FK off: no cascade, C3 orphaned
        },
        { rebuilds: ['p'] },
      ),
    ).toThrow(BracketForeignKeyError);
    expect(count("SELECT count(*) AS n FROM p WHERE id = 'P2'")).toBe(1);
    expect(count("SELECT count(*) AS n FROM sqlite_master WHERE name = '__new_p'")).toBe(0);
    expect(fkMode()).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('a throwing body leaves foreign keys on and no open transaction', () => {
    expect(() =>
      withSyncTriggersSuspended(
        db,
        'project',
        () => {
          rebuildParent();
          throw new Error('boom');
        },
        { rebuilds: ['p'] },
      ),
    ).toThrow('boom');
    expect(fkMode()).toBe(1);
    expect(db.isTransaction).toBe(false);
    expect(count('SELECT count(*) AS n FROM c')).toBe(3);
  });

  it('restores the mode it found: a handle with foreign keys off stays off', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    withSyncTriggersSuspended(db, 'project', rebuildParent, { rebuilds: ['p'] });
    expect(fkMode()).toBe(0);
  });
});
