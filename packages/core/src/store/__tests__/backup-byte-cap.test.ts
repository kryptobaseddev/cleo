/**
 * The backup byte cap (T14278) over small fake snapshot databases: the cap,
 * the coverage proof, the never-delete-newest rule, pinned and marked
 * pre-collapse snapshots, and migration snapshots joining the rotation.
 *
 * @task T14278
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBackupByteCap,
  DEFAULT_BACKUP_MAX_BYTES_FACTOR,
  enforceBackupByteCap,
} from '../backup-sidecar.js';

let root: string;
let cleoDir: string;
let dir: string;

/** A small real SQLite file with `rows` rows of padding. */
function fakeDb(path: string, rows = 50): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE t (v TEXT)');
  const insert = db.prepare('INSERT INTO t VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run('x'.repeat(200));
  db.close();
}

/** A `backup add` set: the store copy, a JSON copy and the sidecar. */
function snapshotSet(stamp: string, extra: Record<string, unknown> = {}): void {
  fakeDb(join(dir, `cleo.db.snapshot-${stamp}`));
  writeFileSync(join(dir, `config.json.snapshot-${stamp}`), '{}');
  writeFileSync(
    join(dir, `snapshot-${stamp}.meta.json`),
    JSON.stringify({
      backupId: `snapshot-${stamp}`,
      type: 'snapshot',
      timestamp: stamp,
      files: ['cleo.db', 'config.json'],
      ...extra,
    }),
  );
}

/** A store migration snapshot and its sidecar. */
function migrationSet(stamp: string, extra: Record<string, unknown> = {}): void {
  fakeDb(join(dir, `cleo.db.migration-${stamp}`));
  writeFileSync(
    join(dir, `migration-${stamp}.meta.json`),
    JSON.stringify({
      backupId: `migration-${stamp}`,
      type: 'migration',
      timestamp: stamp,
      files: ['cleo.db'],
      ...extra,
    }),
  );
}

const rotationLog = () =>
  readFileSync(join(dir, 'rotation.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { set: string; coveredBy: string; reason: string });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backup-cap-'));
  cleoDir = join(root, '.cleo');
  dir = join(cleoDir, 'backups', 'sqlite');
  mkdirSync(dir, { recursive: true });
  fakeDb(join(cleoDir, 'cleo.db'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('backup byte cap (T14278)', () => {
  it('under the cap nothing is removed', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    snapshotSet('20261102-100000');
    const r = enforceBackupByteCap(dir, 10 * 1024 * 1024);
    expect(r.removed).toEqual([]);
    expect(r.overCap).toBe(false);
  });

  it('over the cap removes oldest sets first, each covered by the newest verified snapshot, until under the cap', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    migrationSet('20261102-100000');
    snapshotSet('20261103-100000');
    fakeDb(join(dir, 'tasks-20261104-100000.db')); // newest
    fakeDb(join(dir, 'llmtxt-20261101-100000.db')); // another database: never touched
    const newestBytes = readFileSync(join(dir, 'tasks-20261104-100000.db')).length;
    // Room for the newest and about one more set.
    const cap =
      newestBytes * 2 + readFileSync(join(dir, 'llmtxt-20261101-100000.db')).length + 4096;
    const r = enforceBackupByteCap(dir, cap);

    expect(r.newestVerified).toBe('tasks-20261104-100000.db');
    expect(r.totalAfter).toBeLessThanOrEqual(cap);
    expect(r.overCap).toBe(false);
    // Oldest first: the session snapshot, then the migration snapshot (it joins the rotation).
    expect(r.removed.map((x) => x.set)).toEqual([
      'vacuum-20261101-100000',
      'migration-20261102-100000',
    ]);
    for (const x of r.removed) expect(x.coveredBy).toBe('tasks-20261104-100000.db');
    expect(existsSync(join(dir, 'tasks-20261101-100000.db'))).toBe(false);
    expect(existsSync(join(dir, 'cleo.db.migration-20261102-100000'))).toBe(false);
    expect(existsSync(join(dir, 'migration-20261102-100000.meta.json'))).toBe(false);
    // The newest and the set that fits stay; so does the unrelated database.
    expect(existsSync(join(dir, 'tasks-20261104-100000.db'))).toBe(true);
    expect(existsSync(join(dir, 'cleo.db.snapshot-20261103-100000'))).toBe(true);
    expect(existsSync(join(dir, 'llmtxt-20261101-100000.db'))).toBe(true);
    // Each removal is recorded with what covers it.
    expect(rotationLog()).toEqual([
      expect.objectContaining({
        set: 'vacuum-20261101-100000',
        coveredBy: 'tasks-20261104-100000.db',
        reason: 'byte-cap',
      }),
      expect.objectContaining({
        set: 'migration-20261102-100000',
        coveredBy: 'tasks-20261104-100000.db',
      }),
    ]);
  });

  it('never removes the newest verified snapshot, nor anything newer, even at a cap of one byte', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    snapshotSet('20261102-100000');
    writeFileSync(join(dir, 'tasks-20261103-100000.db'), 'not a database'); // newest, corrupt
    const r = enforceBackupByteCap(dir, 1);
    // The corrupt newest does not open, so the verified one is the snapshot set.
    expect(r.newestVerified).toBe('cleo.db.snapshot-20261102-100000');
    expect(r.removed.map((x) => x.set)).toEqual(['vacuum-20261101-100000']);
    expect(existsSync(join(dir, 'cleo.db.snapshot-20261102-100000'))).toBe(true);
    expect(existsSync(join(dir, 'tasks-20261103-100000.db'))).toBe(true);
    expect(r.overCap).toBe(true);
  });

  it('removes nothing when no snapshot opens: coverage cannot be proven', () => {
    writeFileSync(join(dir, 'tasks-20261101-100000.db'), 'x'.repeat(10_000));
    writeFileSync(join(dir, 'tasks-20261102-100000.db'), 'y'.repeat(10_000));
    const r = enforceBackupByteCap(dir, 1);
    expect(r.newestVerified).toBeNull();
    expect(r.removed).toEqual([]);
    expect(existsSync(join(dir, 'tasks-20261101-100000.db'))).toBe(true);
  });

  it('keeps a pinned backup and a pre-collapse snapshot a twin-collapse marker references', () => {
    migrationSet('20261101-100000', { pinned: true, pinnedReason: 'pre-collapse' });
    migrationSet('20261102-100000'); // referenced by a marker
    snapshotSet('20261103-100000', { pinned: true });
    fakeDb(join(dir, 'tasks-20261104-100000.db'));
    const store = new DatabaseSync(join(cleoDir, 'cleo.db'));
    store.exec('CREATE TABLE tasks_schema_meta (key TEXT PRIMARY KEY, value TEXT)');
    store
      .prepare('INSERT INTO tasks_schema_meta VALUES (?, ?)')
      .run(
        'twin_collapse:tasks',
        JSON.stringify({ snapshot: join(dir, 'cleo.db.migration-20261102-100000') }),
      );
    store.close();

    const r = enforceBackupByteCap(dir, 1);
    expect(r.removed).toEqual([]);
    for (const f of [
      'cleo.db.migration-20261101-100000',
      'cleo.db.migration-20261102-100000',
      'cleo.db.snapshot-20261103-100000',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
  });

  it('applyBackupByteCap defaults to a multiple of the store size and honours backup.maxBytes', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    fakeDb(join(dir, 'tasks-20261102-100000.db'));
    const storeBytes = readFileSync(join(cleoDir, 'cleo.db')).length;
    expect(applyBackupByteCap(dir)?.maxBytes).toBe(DEFAULT_BACKUP_MAX_BYTES_FACTOR * storeBytes);
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ backup: { maxBytes: 1 } }));
    const r = applyBackupByteCap(dir);
    expect(r?.maxBytes).toBe(1);
    expect(r?.removed.map((x) => x.set)).toEqual(['vacuum-20261101-100000']);
    expect(existsSync(join(dir, 'tasks-20261102-100000.db'))).toBe(true);
  });
});
