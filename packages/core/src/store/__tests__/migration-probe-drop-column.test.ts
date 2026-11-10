/**
 * The journal probe treats `ALTER TABLE x DROP COLUMN y` as a probe target
 * (T14311): applied when the table exists and the column is gone.
 *
 * Each case uses a throwaway lineage: a baseline migration (stamped by
 * Scenario 1 when the journal table is missing) and one migration under test.
 * Timestamps after the consolidation cutover (`20260531000001`) model a new
 * migration; timestamps before it model a legacy one, which the zero-DDL path
 * stamps without running. Every case fails on the probe without DROP COLUMN
 * targets:
 * - (a) post-cutover, column gone: it was left unstamped, so the migrator
 *   re-ran it and threw "no such column".
 * - (b) pre-cutover, column present: it was stamped without running, so the
 *   archive rows were never written and the column stayed.
 * - (c) ADD + DROP, ADD present, DROP column still present: the ADD-only stamp
 *   journaled it while the column still existed.
 * - (d) pre-cutover, table missing: it was stamped without running.
 *
 * @task T14311
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileJournal } from '../migration-manager.js';
import { runBracketedMigrations } from '../migration-runner.js';

// The archive table comes from the baseline so the migration under test has
// no CREATE TABLE target of its own: its only probe target is the DROP COLUMN,
// like t14311-retire-ivtr-state (whose archive table already exists).
const BASE =
  'CREATE TABLE t (id TEXT PRIMARY KEY, gone TEXT);\n--> statement-breakpoint\nCREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT);';
const ARCHIVE_AND_DROP = [
  "INSERT INTO audit (id, note) SELECT 'x-' || id, gone FROM t WHERE gone IS NOT NULL ON CONFLICT (id) DO NOTHING;",
  'ALTER TABLE t DROP COLUMN gone;',
].join('\n--> statement-breakpoint\n');

describe('reconcileJournal — DROP COLUMN probe (T14311)', () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-probe-drop-'));
    db = new DatabaseSync(join(dir, 'store.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a lineage of `[folderName, sql]` migrations and return its path. */
  function lineage(migrations: ReadonlyArray<readonly [string, string]>): string {
    const folder = join(dir, `lineage-${Math.random().toString(36).slice(2)}`);
    for (const [name, sql] of migrations) {
      mkdirSync(join(folder, name), { recursive: true });
      writeFileSync(join(folder, name, 'migration.sql'), sql);
    }
    return folder;
  }

  /** Whether the migration named `name` has a journal row. */
  function journaled(name: string): boolean {
    return (
      db.prepare('SELECT 1 FROM "__drizzle_migrations" WHERE name = ?').get(name) !== undefined
    );
  }

  /** Column names of table `t`. */
  function columns(): string[] {
    return (db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>).map((c) => c.name);
  }

  it('(a) empty journal, column already gone: stamped, and the migrator does not re-run it', () => {
    const folder = lineage([
      ['20270101000001_base', BASE],
      ['20270101000002_drop', ARCHIVE_AND_DROP],
    ]);
    // The store already ran both migrations; only the journal was lost.
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('1');");
    db.exec('CREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT);');

    reconcileJournal(db, folder, 't', 'test');

    expect(journaled('20270101000002_drop')).toBe(true);
    expect(() => runBracketedMigrations(db, drizzle({ client: db }), [{ folder }])).not.toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM audit').get()).toEqual({ n: 0 });
  });

  it('(b) empty journal, column still present: not stamped, and the migration runs with its archive', () => {
    // Pre-cutover: the zero-DDL path used to stamp it without running.
    const folder = lineage([
      ['20260101000001_base', BASE],
      ['20260101000002_drop', ARCHIVE_AND_DROP],
    ]);
    db.exec(BASE);
    db.exec("INSERT INTO t VALUES ('1', 'kept'), ('2', NULL);");

    reconcileJournal(db, folder, 't', 'test');
    expect(journaled('20260101000002_drop')).toBe(false);

    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }]);
    expect(journaled('20260101000002_drop')).toBe(true);
    expect(columns()).toEqual(['id']);
    expect(db.prepare('SELECT id, note FROM audit').all()).toEqual([{ id: 'x-1', note: 'kept' }]);
  });

  it('(b) the same holds for a post-cutover migration', () => {
    const folder = lineage([
      ['20270101000001_base', BASE],
      ['20270101000002_drop', ARCHIVE_AND_DROP],
    ]);
    db.exec(BASE);
    db.exec("INSERT INTO t VALUES ('1', 'kept');");

    reconcileJournal(db, folder, 't', 'test');
    expect(journaled('20270101000002_drop')).toBe(false);

    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }]);
    expect(columns()).toEqual(['id']);
    expect(db.prepare('SELECT id, note FROM audit').all()).toEqual([{ id: 'x-1', note: 'kept' }]);
  });

  describe('(c) ADD COLUMN + DROP COLUMN in one migration: stamped only when both hold', () => {
    const ADD_AND_DROP =
      'ALTER TABLE t ADD COLUMN b TEXT;\n--> statement-breakpoint\nALTER TABLE t DROP COLUMN gone;';
    const cases: ReadonlyArray<{ schema: string; stamped: boolean; label: string }> = [
      {
        label: 'added present, dropped gone',
        schema: 'CREATE TABLE t (id TEXT PRIMARY KEY, b TEXT);',
        stamped: true,
      },
      {
        label: 'added present, dropped still present',
        schema: 'CREATE TABLE t (id TEXT PRIMARY KEY, gone TEXT, b TEXT);',
        stamped: false,
      },
      {
        label: 'added missing, dropped gone',
        schema: 'CREATE TABLE t (id TEXT PRIMARY KEY);',
        stamped: false,
      },
    ];
    for (const c of cases) {
      it(`${c.label} → ${c.stamped ? 'stamped' : 'not stamped'}`, () => {
        const folder = lineage([
          ['20270101000001_base', BASE],
          ['20270101000002_add_drop', ADD_AND_DROP],
        ]);
        db.exec(c.schema);
        reconcileJournal(db, folder, 't', 'test');
        expect(journaled('20270101000002_add_drop')).toBe(c.stamped);
      });
    }
  });

  it('(d) DROP COLUMN on a missing table: not stamped', () => {
    // Pre-cutover: the zero-DDL path used to stamp it without running.
    const folder = lineage([
      ['20260101000001_base', BASE],
      ['20260101000002_drop_other', 'ALTER TABLE other DROP COLUMN x;'],
    ]);
    db.exec(BASE);

    reconcileJournal(db, folder, 't', 'test');

    expect(journaled('20260101000002_drop_other')).toBe(false);
  });
});
