/** Independent resource ownership and atomicity oracles for Exodus (T12260). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  insertWithExodusReceipts,
  prepareExodusRecovery,
  rollbackExodusReceipts,
} from '../exodus/recovery.js';

let root: string;
let db: DatabaseSync;
const operation = 'synthetic-staging-operation';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-exodus-recovery-'));
  db = new DatabaseSync(join(root, 'cleo.db'));
  db.exec(
    'CREATE TABLE records(id INTEGER PRIMARY KEY, text_value TEXT, binary_value BLOB, optional_value TEXT)',
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function insert(sql: string, table = 'records'): number {
  db.exec('BEGIN');
  try {
    const count = insertWithExodusReceipts(db, 'main', table, sql, operation, 'source.db', table);
    db.exec('COMMIT');
    return count;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

it('preserves pre-existing rows and unrelated later writes in the same table', () => {
  db.exec("INSERT INTO records VALUES(1,'existing',NULL,NULL)");
  expect(
    insert("INSERT OR IGNORE INTO records VALUES(1,'ignored',NULL,NULL),(2,'owned',NULL,NULL)"),
  ).toBe(1);
  db.exec("INSERT INTO records VALUES(3,'later',NULL,NULL)");
  expect(db.prepare('SELECT count(*) AS n FROM _exodus_recovery_rows').get()?.n).toBe(1);
  expect(rollbackExodusReceipts(db, operation)).toBe(1);
  expect(db.prepare('SELECT id,text_value FROM records ORDER BY id').all()).toEqual([
    { id: 1, text_value: 'existing' },
    { id: 3, text_value: 'later' },
  ]);
  expect(rollbackExodusReceipts(db, operation)).toBe(0);
  expect(db.prepare('SELECT state,source_db,target_db FROM _exodus_recovery_rows').get()).toEqual({
    state: 'rolled_back',
    source_db: 'source.db',
    target_db: join(root, 'cleo.db'),
  });
});

it('uses rowid identity so identical unrelated duplicates survive', () => {
  db.exec("CREATE TABLE duplicates(value TEXT); INSERT INTO duplicates VALUES('same')");
  insert("INSERT INTO duplicates VALUES('same')", 'duplicates');
  db.exec("INSERT INTO duplicates VALUES('same')");
  expect(rollbackExodusReceipts(db, operation)).toBe(1);
  expect(db.prepare('SELECT rowid FROM duplicates ORDER BY rowid').all()).toEqual([
    { rowid: 1 },
    { rowid: 3 },
  ]);
});

it('captures Unicode, embedded NUL, blobs, NULL and exact large integer values', () => {
  insert(
    "INSERT INTO records VALUES(9007199254740993,'解析🌱' || char(0) || 'end',X'00FF80',NULL)",
  );
  expect(rollbackExodusReceipts(db, operation)).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM records').get()?.n).toBe(0);
});

it('refuses all deletes when any affected row changed and retains committed receipts', () => {
  insert("INSERT INTO records VALUES(1,'one',NULL,NULL),(2,'two',NULL,NULL)");
  db.exec("UPDATE records SET text_value='user edit' WHERE id=1");
  expect(() => rollbackExodusReceipts(db, operation)).toThrow(/row changed/);
  expect(db.prepare('SELECT id,text_value FROM records ORDER BY id').all()).toEqual([
    { id: 1, text_value: 'user edit' },
    { id: 2, text_value: 'two' },
  ]);
  expect(
    db.prepare("SELECT count(*) AS n FROM _exodus_recovery_rows WHERE state='committed'").get()?.n,
  ).toBe(2);
});

it('rolls back the inserted data if receipt persistence fails inside a caller transaction', () => {
  prepareExodusRecovery(db, operation);
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON _exodus_recovery_rows BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
  );
  db.exec('BEGIN');
  expect(() =>
    insertWithExodusReceipts(
      db,
      'main',
      'records',
      "INSERT INTO records VALUES(1,'must rollback',NULL,NULL)",
      operation,
      'source.db',
      'records',
    ),
  ).toThrow(/injected receipt failure/);
  db.exec("INSERT INTO records VALUES(2,'outer survives',NULL,NULL); COMMIT");
  expect(db.prepare('SELECT id FROM records').all()).toEqual([{ id: 2 }]);
  expect(db.prepare('SELECT count(*) AS n FROM _exodus_recovery_rows').get()?.n).toBe(0);
});

it('uses composite primary keys for WITHOUT ROWID tables', () => {
  db.exec('CREATE TABLE composite(a TEXT,b INTEGER,value TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID');
  insert("INSERT INTO composite VALUES('a',1,'owned')", 'composite');
  db.exec("INSERT INTO composite VALUES('a',2,'unrelated')");
  expect(rollbackExodusReceipts(db, operation)).toBe(1);
  expect(db.prepare('SELECT b FROM composite').all()).toEqual([{ b: 2 }]);
});

it('refuses untracked trigger side effects before inserting any source rows', () => {
  db.exec(
    'CREATE TABLE effects(value TEXT); CREATE TRIGGER effects_trigger AFTER INSERT ON records BEGIN INSERT INTO effects VALUES(new.text_value); END',
  );
  expect(() => insert("INSERT INTO records VALUES(1,'unsafe',NULL,NULL)")).toThrow(
    /trigger side effects/,
  );
  expect(db.prepare('SELECT count(*) AS n FROM records').get()?.n).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM effects').get()?.n).toBe(0);
});

it('commits cross-scope receipts on the database that owns their affected rows', () => {
  const attached = join(root, 'attached.db');
  db.prepare('ATTACH DATABASE ? AS target').run(attached);
  db.exec('CREATE TABLE target.records(id INTEGER PRIMARY KEY, value TEXT); BEGIN');
  insertWithExodusReceipts(
    db,
    'target',
    'records',
    "INSERT INTO target.records VALUES(1,'owned')",
    operation,
    'source.db',
    'records',
  );
  db.exec('COMMIT; DETACH DATABASE target');
  const target = new DatabaseSync(attached);
  try {
    expect(rollbackExodusReceipts(target, operation)).toBe(1);
    expect(target.prepare('SELECT count(*) AS n FROM records').get()?.n).toBe(0);
  } finally {
    target.close();
  }
});
