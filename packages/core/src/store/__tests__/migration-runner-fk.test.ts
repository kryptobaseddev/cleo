/**
 * The migration runner's per-file bracket and foreign-key discipline
 * (journal spec §2.3a rule 2; A T12774, NEW-1 T12781, NEW-6 T12786,
 * R5-2 T12795, R5-4 T12797, R6-6 T12809).
 *
 * Each test builds a synthetic migration lineage in a temp folder and a
 * temp store: a parent `p` and a child `c` with `ON DELETE CASCADE`.
 *
 * @task T12809
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dmlTables,
  foreignKeyViolations,
  MigrationForeignKeyError,
  rebuiltTables,
  runBracketedMigrations,
} from '../migration-runner.js';

let dir: string;
let db: DatabaseSync;
let folder: string;
let n = 0;

const BASE = `CREATE TABLE p (id TEXT PRIMARY KEY, v TEXT);
--> statement-breakpoint
CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT REFERENCES p(id) ON DELETE CASCADE, v TEXT);`;

/** Add a migration file to the lineage. */
function migration(sql: string): string {
  n += 1;
  const name = `2026010100${String(n).padStart(4, '0')}_m${n}`;
  mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, name, 'migration.sql'), sql);
  return name;
}

function run() {
  return runBracketedMigrations(db, drizzle({ client: db }), [{ folder }]);
}

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** drizzle-kit's table-rebuild idiom for `c` (optionally with extra DML). */
const REBUILD_C = `PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE \`__new_c\` (id TEXT PRIMARY KEY, pid TEXT REFERENCES p(id) ON DELETE CASCADE, v TEXT, extra TEXT);
--> statement-breakpoint
INSERT INTO \`__new_c\`(id, pid, v) SELECT id, pid, v FROM \`c\`;
--> statement-breakpoint
DROP TABLE \`c\`;
--> statement-breakpoint
ALTER TABLE \`__new_c\` RENAME TO \`c\`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

const REBUILD_P = `PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE \`__new_p\` (id TEXT PRIMARY KEY, v TEXT, extra TEXT);
--> statement-breakpoint
INSERT INTO \`__new_p\`(id, v) SELECT id, v FROM \`p\`;
--> statement-breakpoint
DROP TABLE \`p\`;
--> statement-breakpoint
ALTER TABLE \`__new_p\` RENAME TO \`p\`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-runner-fk-'));
  folder = join(dir, 'lineage');
  mkdirSync(folder);
  n = 0;
  db = new DatabaseSync(join(dir, 'store.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migration(BASE);
  run();
  db.exec(`INSERT INTO p VALUES ('P1', 'a'), ('P2', 'b');
           INSERT INTO c VALUES ('C1', 'P1', 'x'), ('C2', 'P1', 'y'), ('C3', 'P2', 'z');`);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('statement parsing', () => {
  it('finds rebuilt and DML-touched tables', () => {
    expect(rebuiltTables(REBUILD_C.split('--> statement-breakpoint'))).toEqual(['c']);
    expect(rebuiltTables(['ALTER TABLE p ADD COLUMN x TEXT', 'CREATE INDEX i ON p(v)'])).toEqual(
      [],
    );
    expect(dmlTables(["DELETE FROM p WHERE id = 'P1'", 'UPDATE `c` SET v = 1'])).toEqual([
      'c',
      'p',
    ]);
    expect(rebuiltTables(['-- DROP TABLE p (prose only)'])).toEqual([]);
  });
});

describe('one bracket per migration file', () => {
  it('writes one journal row per file, each in its own transaction', () => {
    migration('ALTER TABLE p ADD COLUMN a1 TEXT;');
    migration('ALTER TABLE p ADD COLUMN a2 TEXT;');
    const report = run();
    expect(report.applied).toHaveLength(2);
    expect(count('SELECT count(*) AS n FROM "__drizzle_migrations"')).toBe(3);
  });

  it('an ADD-COLUMN-only file runs no FK check and keeps foreign keys on', () => {
    migration('ALTER TABLE c ADD COLUMN a TEXT;');
    const report = run();
    expect(report.rebuilds).toEqual([]);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
  });

  it('a failing file rolls back alone; earlier files stay applied', () => {
    migration('ALTER TABLE p ADD COLUMN ok TEXT;');
    migration('ALTER TABLE nope ADD COLUMN x TEXT;');
    expect(() => run()).toThrow(/no such table/);
    expect(count(`SELECT count(*) AS n FROM pragma_table_info('p') WHERE name = 'ok'`)).toBe(1);
    expect(count('SELECT count(*) AS n FROM "__drizzle_migrations"')).toBe(2);
  });
});

describe('foreign keys in a rebuild bracket', () => {
  it('a CASCADE parent rebuild keeps every child row (A)', () => {
    migration(REBUILD_P);
    const report = run();
    expect(report.rebuilds).toHaveLength(1);
    expect(count('SELECT count(*) AS n FROM c')).toBe(3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a DML-only file deletes a parent with FK ON, so it cascades as at runtime (R5-4)', () => {
    migration("DELETE FROM p WHERE id = 'P1';");
    const report = run();
    expect(report.rebuilds).toEqual([]);
    expect(count('SELECT count(*) AS n FROM c')).toBe(1);
  });

  it('a rebuild file whose DML deletes a parent without its children rolls back (R5-4)', () => {
    migration(`${REBUILD_C}\n--> statement-breakpoint\nDELETE FROM p WHERE id = 'P2';`);
    expect(() => run()).toThrow(MigrationForeignKeyError);
    expect(count("SELECT count(*) AS n FROM p WHERE id = 'P2'")).toBe(1);
    expect(count(`SELECT count(*) AS n FROM pragma_table_info('c') WHERE name = 'extra'`)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('a pre-existing orphan never blocks a migration, and stays reported', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO c VALUES ('C9', 'GONE', 'orphan')");
    db.exec('PRAGMA foreign_keys = ON');
    migration(REBUILD_C);
    expect(() => run()).not.toThrow();
    expect(foreignKeyViolations(db, ['c']).size).toBe(1);
  });

  it('an orphan in a rebuilt TEXT-PK child with rowid gaps is not reported as new (R5-2)', () => {
    // Rowid gaps: delete rows so the orphan sits at rowid 5; the rebuild copies
    // it to a lower rowid. A rowid-keyed snapshot would call it new.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO c VALUES ('C4', 'P2', 'w'), ('C5', 'GONE', 'orphan')");
    db.exec("DELETE FROM c WHERE id IN ('C1', 'C2', 'C4')");
    db.exec('PRAGMA foreign_keys = ON');
    const orphanRowid = (
      db.prepare("SELECT rowid AS r FROM c WHERE id = 'C5'").get() as { r: number }
    ).r;
    migration(REBUILD_C);
    run();
    const after = (db.prepare("SELECT rowid AS r FROM c WHERE id = 'C5'").get() as { r: number }).r;
    expect(after).toBeLessThan(orphanRowid);
    expect(foreignKeyViolations(db, ['c']).size).toBe(1);
  });

  it('a rebuild that introduces a new violation rolls back', () => {
    migration(
      `${REBUILD_C}\n--> statement-breakpoint\nINSERT INTO c (id, pid, v) VALUES ('C8', 'NOPE', 'bad');`,
    );
    expect(() => run()).toThrow(MigrationForeignKeyError);
    expect(count("SELECT count(*) AS n FROM c WHERE id = 'C8'")).toBe(0);
  });

  it('a throw mid-bracket leaves foreign_keys = 1 and no open transaction (NEW-6)', () => {
    migration(`${REBUILD_C}\n--> statement-breakpoint\nTHIS IS NOT SQL;`);
    expect(() => run()).toThrow();
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    expect(db.isTransaction).toBe(false);
    expect(count(`SELECT count(*) AS n FROM pragma_table_info('c') WHERE name = 'extra'`)).toBe(0);
  });

  it('a WITHOUT ROWID child keys its violations by primary key', () => {
    migration(`CREATE TABLE w (k TEXT PRIMARY KEY, pid TEXT REFERENCES p(id)) WITHOUT ROWID;`);
    run();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO w VALUES ('K1', 'GONE'), ('K2', 'P1')");
    db.exec('PRAGMA foreign_keys = ON');
    const v = foreignKeyViolations(db, ['w']);
    expect([...v.keys()]).toHaveLength(1);
    expect([...v.keys()][0]).toContain('K1');
  });
});

describe('hook order at a migration (NEW-8, spec §2.3a rule 3)', () => {
  type Hooks = Parameters<typeof runBracketedMigrations>[3];
  const recorder = (log: string[], opts: { failOn?: string } = {}): Hooks => ({
    // S3 seals pending captures and runs the repair diff here, BEFORE any bracket.
    beforeMigrations: () => log.push('before'),
    suspendCapture: (d) => {
      const pending = (
        d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'q'").get() as {
          n: number;
        }
      ).n;
      log.push(`suspend(q=${pending})`);
    },
    reinstallCapture: () => log.push('reinstall'),
    // S3 re-baselines chash here, AFTER the bracket committed.
    afterMigration: (d, m) => {
      if (m.name === opts.failOn) throw new Error('unreachable: after a failed bracket');
      const committed = (
        d.prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE name = ?').get(m.name) as {
          n: number;
        }
      ).n;
      log.push(`after(${m.name.split('_').pop()},journaled=${committed})`);
    },
  });

  it('pending work first, then each bracket, then its re-baseline once committed', () => {
    migration('CREATE TABLE q (id TEXT PRIMARY KEY);');
    migration("INSERT INTO q VALUES ('Q1');");
    const log: string[] = [];
    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }], recorder(log));
    expect(log).toEqual([
      'before',
      'suspend(q=0)',
      'reinstall',
      'after(m2,journaled=1)',
      'suspend(q=1)',
      'reinstall',
      'after(m3,journaled=1)',
    ]);
  });

  it('nothing pending: no hook runs; a failed bracket gets no re-baseline', () => {
    const idle: string[] = [];
    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }], recorder(idle));
    expect(idle).toEqual([]);

    const bad = migration('INSERT INTO nope VALUES (1);');
    const log: string[] = [];
    expect(() =>
      runBracketedMigrations(
        db,
        drizzle({ client: db }),
        [{ folder }],
        recorder(log, { failOn: bad }),
      ),
    ).toThrow();
    expect(log.filter((l) => l.startsWith('after'))).toEqual([]);
    expect(log[0]).toBe('before');
  });
});
