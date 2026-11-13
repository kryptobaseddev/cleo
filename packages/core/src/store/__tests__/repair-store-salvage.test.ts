import type { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoreRepairReceipt } from '@cleocode/contracts/db-recovery.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitRepairWal, prepareRepairCommit } from '../repair-store-files.js';
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

  it('commits a complete image for SQLite 65536-byte pages', () => {
    const { base, damaged } = fixture(65536);
    const staged = new DatabaseSync(base);
    staged.exec("INSERT INTO records VALUES('committed','new image', '2026-11-13T00:00:00Z')");
    staged.close();
    const wal = `${base}.install`;
    prepareRepairCommit(base, damaged, wal);
    commitRepairWal(wal, damaged);
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
    source.exec("INSERT INTO vectors VALUES('delta', '[4,5,6]')");
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
    } finally {
      check.close();
    }
  });
});
