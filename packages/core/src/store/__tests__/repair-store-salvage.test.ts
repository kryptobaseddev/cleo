import type { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoreRepairReceipt } from '@cleocode/contracts/db-recovery.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitRepairImage, prepareRepairCommit } from '../repair-store-files.js';
import { salvageIntoSnapshot } from '../repair-store-salvage.js';
import { loadSqliteVecExtension } from '../sqlite-native.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof spawnSync>) =>
      actual.spawnSync(
        args[0] === 'sqlite3' ? '/no-sqlite-recovery-binary' : args[0],
        args[1],
        args[2],
      ),
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(pageSize = 4096): { base: string; damaged: string; receipt: StoreRepairReceipt } {
  const root = mkdtempSync(join(tmpdir(), 'cleo-salvage-'));
  roots.push(root);
  const base = join(root, 'base.db');
  const damaged = join(root, 'damaged.db');
  const db = new DatabaseSync(base);
  db.exec(`PRAGMA page_size=${pageSize}`);
  db.exec(`CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO records VALUES ('base', 'preserved', '2026-10-01T00:00:00Z');
    INSERT INTO records VALUES ('newer', 'base-newer', '2026-11-10T00:00:00Z');
    INSERT INTO records VALUES ('updated', 'old', '2026-10-01T00:00:00Z');
    CREATE TABLE sparse (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent TEXT REFERENCES records(id) ON DELETE CASCADE);
    INSERT INTO children VALUES (1, 'updated');`);
  db.close();
  copyFileSync(base, damaged);
  const receipt: StoreRepairReceipt = {
    version: 1,
    scope: 'project',
    target: damaged,
    startedAt: new Date().toISOString(),
    status: 'prepared',
    quarantineDir: root,
    snapshot: base,
    snapshotAt: null,
    delta: true,
    files: [],
    tables: {},
    missingTaskIds: [],
    diagnostics: [],
    integrityOK: false,
  };
  return { base, damaged, receipt };
}

describe('Node SQLite salvage and merge', () => {
  it('inserts missing rows, keeps newer base values and updates without cascading children', () => {
    const { base, damaged, receipt } = fixture();
    const db = new DatabaseSync(damaged);
    db.exec(`UPDATE records SET value='damaged-older', updated_at='2026-10-02T00:00:00Z' WHERE id='newer';
      UPDATE records SET value='latest', updated_at='2026-11-12T00:00:00Z' WHERE id='updated';
      INSERT INTO records VALUES ('delta', 'after snapshot', '2026-11-12T00:00:00Z');
      INSERT INTO sparse VALUES (9223372036854775806, 'large key');`);
    db.exec('CREATE TABLE created_after_large_key (id INTEGER PRIMARY KEY)');
    db.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare('SELECT id,value FROM records ORDER BY id').all()).toEqual([
        { id: 'base', value: 'preserved' },
        { id: 'delta', value: 'after snapshot' },
        { id: 'newer', value: 'base-newer' },
        { id: 'updated', value: 'latest' },
      ]);
      expect(check.prepare('SELECT value FROM sparse').get()?.value).toBe('large key');
      expect(check.prepare('SELECT count(*) AS n FROM children').get()?.n).toBe(1);
      expect(receipt.tables.records).toMatchObject({ salvaged: 4, merged: 2, unreadable: 0 });
    } finally {
      check.close();
    }
  });

  it('skips a zeroed leaf and reads later rowid ranges with no sqlite3 binary', () => {
    const { base, damaged, receipt } = fixture();
    const db = new DatabaseSync(damaged);
    db.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, body TEXT)');
    const insert = db.prepare('INSERT INTO pages VALUES (?, ?)');
    for (let i = 1; i <= 90; i++) insert.run(i * 100_000, 'x'.repeat(1500));
    const root = Number(
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='pages'").get()?.rootpage,
    );
    db.close();
    // The first child leaf of the table's interior root is independently unreadable.
    const fd = openSync(damaged, 'r+');
    try {
      const bytes = readFileSync(damaged);
      const cell = bytes.readUInt16BE((root - 1) * 4096 + 12);
      const child = bytes.readUInt32BE((root - 1) * 4096 + cell);
      writeSync(fd, Buffer.alloc(4096), 0, 4096, (child - 1) * 4096);
    } finally {
      closeSync(fd);
    }
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(Number(check.prepare('SELECT max(id) AS n FROM pages').get()?.n)).toBe(9_000_000);
      expect(Number(check.prepare('SELECT count(*) AS n FROM pages').get()?.n)).toBeGreaterThan(80);
      expect(receipt.tables.pages?.unreadable).toBeNull();
    } finally {
      check.close();
    }
  });

  it('compares UTC and offset-bearing update timestamps consistently', () => {
    const { base, damaged, receipt } = fixture();
    const db = new DatabaseSync(damaged);
    db.exec(
      "UPDATE records SET value='offset newer', updated_at='2026-11-12 11:00:00-07:00' WHERE id='updated'",
    );
    db.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare("SELECT value FROM records WHERE id='updated'").get()?.value).toBe(
        'offset newer',
      );
    } finally {
      check.close();
    }
  });

  it('reports unknown unreadable counts when schema damage prevents table enumeration', () => {
    const { base, damaged, receipt } = fixture();
    receipt.tables.records = { snapshot: 3, salvaged: 0, merged: 0, unreadable: 0, final: 3 };
    const bytes = readFileSync(damaged);
    bytes.fill(0, 100, 4096);
    writeFileSync(damaged, bytes);
    salvageIntoSnapshot(base, [damaged], receipt);
    expect(receipt.tables.records.unreadable).toBeNull();
    expect(receipt.diagnostics.some((line) => line.includes('schema'))).toBe(true);
  });

  it('commits a complete image for SQLite 65536-byte pages', () => {
    const { base, damaged } = fixture(65536);
    const staged = new DatabaseSync(base);
    staged.exec("INSERT INTO records VALUES('committed','new image', '2026-11-13T00:00:00Z')");
    staged.close();
    chmodSync(damaged, 0o600);
    const wal = `${base}.install`;
    prepareRepairCommit(base, damaged, wal);
    if (process.platform !== 'win32') expect(statSync(wal).mode & 0o777).toBe(0o600);
    commitRepairImage(wal, damaged);
    const check = new DatabaseSync(damaged);
    try {
      expect(check.prepare("SELECT value FROM records WHERE id='committed'").get()?.value).toBe(
        'new image',
      );
    } finally {
      check.close();
    }
  });

  it('preserves readable vector tables and their shadow storage', (context) => {
    const { base, damaged, receipt } = fixture();
    const baseDb = new DatabaseSync(base, { allowExtension: true });
    if (!loadSqliteVecExtension(baseDb)) {
      baseDb.close();
      context.skip();
      return;
    }
    baseDb.exec(
      "CREATE VIRTUAL TABLE vectors USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]); INSERT INTO vectors VALUES('base', '[1,2,3]')",
    );
    baseDb.close();
    copyFileSync(base, damaged);
    const source = new DatabaseSync(damaged, { allowExtension: true });
    loadSqliteVecExtension(source);
    source.exec(
      "INSERT INTO vectors VALUES('delta', '[4,5,6]'); UPDATE vectors SET embedding='[7,8,9]' WHERE id='base'",
    );
    source.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base, { allowExtension: true });
    loadSqliteVecExtension(check);
    try {
      expect(
        check
          .prepare('SELECT id FROM vectors ORDER BY id')
          .all()
          .map((r) => r.id),
      ).toEqual(['base', 'delta']);
      expect(
        JSON.parse(
          String(
            check.prepare("SELECT vec_to_json(embedding) AS v FROM vectors WHERE id='base'").get()
              ?.v,
          ),
        ),
      ).toEqual([7, 8, 9]);
      expect(receipt.tables.vectors_chunks.rebuilt).toBe(true);
    } finally {
      check.close();
    }
  });

  it('keeps ended session values without an update timestamp and reports proven deletions', () => {
    const { base, damaged, receipt } = fixture();
    for (const file of [base, damaged]) {
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT, ended_at TEXT); INSERT INTO sessions VALUES('s','active',NULL)",
      );
      db.close();
    }
    const older = `${damaged}.older`;
    copyFileSync(damaged, older);
    const db = new DatabaseSync(damaged);
    db.exec(
      "UPDATE sessions SET status='ended', ended_at='2026-11-13T00:00:00Z'; DELETE FROM records WHERE id='base'",
    );
    db.close();
    salvageIntoSnapshot(base, [damaged, older], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare('SELECT status,ended_at FROM sessions').get()).toEqual({
        status: 'ended',
        ended_at: '2026-11-13T00:00:00Z',
      });
      expect(check.prepare("SELECT 1 FROM records WHERE id='base'").get()).toBeUndefined();
      expect(receipt.tables.records.deleted).toBe(1);
      expect(receipt.recovery?.rows).toContainEqual(
        expect.objectContaining({
          kind: 'deleted',
          table: 'records',
          values: expect.objectContaining({ id: 'base' }),
        }),
      );
    } finally {
      check.close();
    }
  });

  it('keeps and identifies possibly resurrected snapshot rows when their leaf is unreadable', () => {
    const { base, damaged, receipt } = fixture();
    const db = new DatabaseSync(damaged);
    const page = Number(
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='records'").get()?.rootpage,
    );
    db.close();
    const bytes = readFileSync(damaged);
    bytes.fill(0, (page - 1) * 4096, page * 4096);
    writeFileSync(damaged, bytes);
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare('SELECT count(*) AS n FROM records').get()?.n).toBe(3);
      expect(receipt.tables.records.possiblyResurrected).toBe(3);
      expect(receipt.tables.records.unreadable).toBeNull();
      expect(receipt.recovery?.rows.filter((r) => r.kind === 'possibly-resurrected')).toHaveLength(
        3,
      );
    } finally {
      check.close();
    }
  });

  it('preserves columns outside the current schema, including binary and 64-bit values', () => {
    const { base, damaged, receipt } = fixture();
    const db = new DatabaseSync(damaged);
    db.exec(
      "ALTER TABLE records ADD COLUMN future BLOB; UPDATE records SET future=x'00ff' WHERE id='base'",
    );
    db.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    expect(receipt.recovery?.rows).toContainEqual(
      expect.objectContaining({
        kind: 'unmerged-columns',
        table: 'records',
        values: expect.objectContaining({ id: 'base', future: { type: 'blob', value: 'AP8=' } }),
      }),
    );
  });

  it('quarantines one UNIQUE collision and its orphan children while merging other rows', () => {
    const { base, damaged, receipt } = fixture();
    const baseDb = new DatabaseSync(base);
    baseDb.exec('CREATE UNIQUE INDEX record_unique_value ON records(value)');
    baseDb.close();
    const db = new DatabaseSync(damaged);
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO records VALUES('collision','preserved','2026-11-13T00:00:00Z'); INSERT INTO records VALUES('good','healthy delta','2026-11-13T00:00:00Z'); INSERT INTO children VALUES(2,'collision'); CREATE TABLE composite_child(id TEXT PRIMARY KEY,parent TEXT REFERENCES records(id)) WITHOUT ROWID; INSERT INTO composite_child VALUES('orphan2','missing')",
    );
    db.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare("SELECT value FROM records WHERE id='good'").get()?.value).toBe(
        'healthy delta',
      );
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(receipt.recovery?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'conflict',
            table: 'records',
            values: expect.objectContaining({ id: 'collision' }),
          }),
          expect.objectContaining({
            kind: 'conflict',
            table: 'children',
            values: expect.objectContaining({ parent: 'collision' }),
          }),
        ]),
      );
    } finally {
      check.close();
    }
  });

  it('rebuilds external-content FTS shadows from merged content even when a source shadow is damaged', () => {
    const { base, damaged, receipt } = fixture();
    const baseDb = new DatabaseSync(base);
    baseDb.exec(
      "CREATE TABLE documents(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO documents VALUES(1,'snapshot'); CREATE VIRTUAL TABLE document_search USING fts5(body, content=documents, content_rowid=id); INSERT INTO document_search(document_search) VALUES('rebuild')",
    );
    baseDb.close();
    copyFileSync(base, damaged);
    const db = new DatabaseSync(damaged);
    db.exec(
      "INSERT INTO documents VALUES(2,'newest readable'); INSERT INTO document_search(document_search) VALUES('rebuild')",
    );
    const page = Number(
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='document_search_idx'").get()
        ?.rootpage,
    );
    db.close();
    const bytes = readFileSync(damaged);
    bytes.fill(0, (page - 1) * 4096, page * 4096);
    writeFileSync(damaged, bytes);
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(
        check
          .prepare("SELECT rowid FROM document_search WHERE document_search MATCH 'newest'")
          .all(),
      ).toEqual([{ rowid: 2 }]);
      expect(check.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(receipt.tables.document_search_idx.rebuilt).toBe(true);
    } finally {
      check.close();
    }
  });
  it('rebuilds standalone FTS from logical documents while retaining rowids and duplicate content', () => {
    const { base, damaged, receipt } = fixture();
    const baseDb = new DatabaseSync(base);
    baseDb.exec(
      "CREATE VIRTUAL TABLE notes USING fts5(body); INSERT INTO notes(rowid,body) VALUES(20,'same content'),(30,'same content')",
    );
    baseDb.close();
    copyFileSync(base, damaged);
    const source = new DatabaseSync(damaged);
    source.exec(
      "DELETE FROM notes WHERE rowid=20; INSERT INTO notes(rowid,body) VALUES(40,'latest')",
    );
    source.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare('SELECT rowid,body FROM notes ORDER BY rowid').all()).toEqual([
        { rowid: 30, body: 'same content' },
        { rowid: 40, body: 'latest' },
      ]);
    } finally {
      check.close();
    }
  });
  it('reports unknown unreadable rows when the migration-journal root is zeroed', () => {
    const { base, damaged, receipt } = fixture();
    const source = new DatabaseSync(damaged);
    source.exec(
      "CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY,hash TEXT); INSERT INTO __drizzle_migrations VALUES(1,'migration')",
    );
    const page = Number(
      source.prepare("SELECT rootpage FROM sqlite_schema WHERE name='__drizzle_migrations'").get()
        ?.rootpage,
    );
    source.close();
    const bytes = readFileSync(damaged);
    bytes.fill(0, (page - 1) * 4096, page * 4096);
    writeFileSync(damaged, bytes);
    salvageIntoSnapshot(base, [damaged], receipt);
    expect(receipt.tables.__drizzle_migrations.unreadable).toBeNull();
    expect(receipt.diagnostics).toContainEqual(
      expect.stringContaining('unreadable migration-journal'),
    );
  });
  it.each([
    4096, 65536,
  ])('a complete WAL replaces stale schema frames over a destroyed main header (%s-byte pages)', (pageSize) => {
    const { base, damaged, receipt } = fixture(pageSize);
    const writer = `${damaged}.writer`;
    copyFileSync(damaged, writer);
    const db = new DatabaseSync(writer);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT); INSERT INTO notes VALUES('n','new schema'); INSERT INTO records VALUES('wal','readable WAL','2026-11-13T00:00:00Z')",
    );
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(writer + suffix, damaged + suffix);
    db.close();
    const bytes = readFileSync(damaged);
    bytes.fill(0, 0, 100);
    writeFileSync(damaged, bytes);
    const view = `${damaged}.view`;
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(damaged + suffix, view + suffix);
    salvageIntoSnapshot(base, [view], receipt);
    const install = `${base}.complete-wal`;
    // A valid staged header supplies the page size, not the damaged main header.
    prepareRepairCommit(base, base, install);
    commitRepairImage(install, damaged);
    const check = new DatabaseSync(damaged);
    try {
      expect(check.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(check.prepare("SELECT value FROM records WHERE id='wal'").get()?.value).toBe(
        'readable WAL',
      );
      expect(check.prepare('SELECT body FROM notes').get()?.body).toBe('new schema');
    } finally {
      check.close();
    }
  });

  it('keeps a newer snapshot value and records an older fallback version with its source view', () => {
    const { base, damaged, receipt } = fixture();
    const older = `${damaged}.older`;
    copyFileSync(damaged, older);
    const old = new DatabaseSync(older);
    old.exec(
      "CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT);INSERT INTO notes VALUES('n','v1-older')",
    );
    old.close();
    for (const file of [base, damaged]) {
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT);INSERT INTO notes VALUES('n','v2-snapshot')",
      );
      db.close();
    }
    const primary = new DatabaseSync(damaged);
    primary.exec("INSERT INTO sparse VALUES(1,'newest readable')");
    const page = Number(
      primary.prepare("SELECT rootpage FROM sqlite_schema WHERE name='notes'").get()?.rootpage,
    );
    primary.close();
    const bytes = readFileSync(damaged);
    bytes.fill(0, (page - 1) * 4096, page * 4096);
    writeFileSync(damaged, bytes);
    salvageIntoSnapshot(base, [damaged, older], receipt);
    const check = new DatabaseSync(base);
    try {
      expect(check.prepare('SELECT body FROM notes').get()?.body).toBe('v2-snapshot');
      expect(receipt.tables.notes.possiblyResurrected).toBe(1);
      expect(check.prepare('SELECT value FROM sparse').get()?.value).toBe('newest readable');
      expect(receipt.recovery?.rows).toContainEqual(
        expect.objectContaining({
          kind: 'conflict',
          table: 'notes',
          source: older,
          values: expect.objectContaining({ body: 'v1-older' }),
        }),
      );
    } finally {
      check.close();
    }
  });
  it('retains a live version before a later timestamped view overwrites it', () => {
    const { base, damaged, receipt } = fixture();
    const alternate = `${damaged}.future`;
    const db = new DatabaseSync(damaged);
    db.exec(
      "UPDATE records SET value='real live edit',updated_at='2026-11-14T00:00:00Z' WHERE id='updated'",
    );
    db.close();
    copyFileSync(damaged, alternate);
    const peer = new DatabaseSync(alternate);
    peer.exec(
      "UPDATE records SET value='future peer',updated_at='2099-01-01T00:00:00Z' WHERE id='updated'",
    );
    peer.close();
    salvageIntoSnapshot(base, [damaged, alternate], receipt);
    const check = new DatabaseSync(base);
    expect(check.prepare("SELECT value FROM records WHERE id='updated'").get()?.value).toBe(
      'future peer',
    );
    check.close();
    expect(receipt.recovery?.rows).toContainEqual(
      expect.objectContaining({
        kind: 'conflict',
        table: 'records',
        values: expect.objectContaining({ id: 'updated', value: 'real live edit' }),
      }),
    );
  });

  it('preserves valid SQLite names that coincide with JavaScript prototype properties', () => {
    const { base, damaged, receipt } = fixture();
    const source = new DatabaseSync(damaged);
    source.exec(
      `CREATE TABLE "__proto__"(id TEXT PRIMARY KEY, value TEXT); INSERT INTO "__proto__" VALUES('p','readable'); ALTER TABLE records ADD COLUMN "__proto__" TEXT; UPDATE records SET "__proto__"='excluded column' WHERE id='base'`,
    );
    source.close();
    salvageIntoSnapshot(base, [damaged], receipt);
    expect(receipt.tables['__proto__'].salvaged).toBe(1);
    const recovered = receipt.recovery?.rows.find(
      (r) => r.kind === 'unmerged-columns' && r.values.id === 'base',
    );
    expect(Object.hasOwn(recovered?.values ?? {}, '__proto__')).toBe(true);
    expect(recovered?.values['__proto__']).toBe('excluded column');
  });
});
