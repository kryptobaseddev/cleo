/**
 * The backup byte cap (T14278) over small fake snapshot databases: the cap,
 * the coverage proof, the never-delete-newest rule, pinned and marked
 * pre-collapse snapshots, and migration snapshots joining the rotation.
 *
 * @task T14278
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBackupByteCap,
  DEFAULT_BACKUP_MAX_BYTES_FACTOR,
  EMPTY_COPY,
  enforceBackupByteCap,
  resolveBackupMaxBytes,
  rotateBackupDir,
} from '../backup-sidecar.js';
import { advanceStoreGeneration, snapshotRecoveryReason } from '../recover-malformed-db.js';

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
    .map(
      (l) => JSON.parse(l) as { set: string; coveredBy: Record<string, string>; reason: string },
    );

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
  const NEWEST = 'tasks-20261104-100000.db';

  it('under the cap nothing is removed', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    snapshotSet('20261102-100000');
    const r = enforceBackupByteCap(dir, 10 * 1024 * 1024);
    expect(r.removed).toEqual([]);
    expect(r.overCap).toBe(false);
  });

  it('over the cap removes oldest sets first, each covered per role by a newer verified copy, until under the cap', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    migrationSet('20261102-100000');
    snapshotSet('20261103-100000');
    fakeDb(join(dir, NEWEST));
    fakeDb(join(dir, 'llmtxt-20261101-100000.db')); // another database: never touched
    const newestBytes = readFileSync(join(dir, NEWEST)).length;
    // Room for the newest and about one more set.
    const cap =
      newestBytes * 2 + readFileSync(join(dir, 'llmtxt-20261101-100000.db')).length + 4096;
    const r = enforceBackupByteCap(dir, cap);

    expect(r.totalAfter).toBeLessThanOrEqual(cap);
    expect(r.overCap).toBe(false);
    // Oldest first: the session snapshot, then the migration snapshot (it joins the rotation).
    expect(r.removed.map((x) => x.set)).toEqual([
      'vacuum-20261101-100000',
      'migration-20261102-100000',
    ]);
    for (const x of r.removed) expect(x.coveredBy).toEqual({ 'cleo.db': NEWEST });
    expect(existsSync(join(dir, 'tasks-20261101-100000.db'))).toBe(false);
    expect(existsSync(join(dir, 'cleo.db.migration-20261102-100000'))).toBe(false);
    expect(existsSync(join(dir, 'migration-20261102-100000.meta.json'))).toBe(false);
    expect(existsSync(join(dir, NEWEST))).toBe(true);
    expect(existsSync(join(dir, 'cleo.db.snapshot-20261103-100000'))).toBe(true);
    expect(existsSync(join(dir, 'llmtxt-20261101-100000.db'))).toBe(true);
    // Each removal is recorded with its covering file per role.
    expect(rotationLog()).toEqual([
      expect.objectContaining({
        set: 'vacuum-20261101-100000',
        coveredBy: { 'cleo.db': NEWEST },
        reason: 'byte-cap',
      }),
      expect.objectContaining({
        set: 'migration-20261102-100000',
        coveredBy: { 'cleo.db': NEWEST },
      }),
    ]);
  });

  it('a newer project snapshot never covers an older set holding the only copy of another role', () => {
    // An older run with conduit in its own database file, and a backup add
    // holding the only blob-manifest copy.
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    fakeDb(join(dir, 'conduit-20261101-100000.db'));
    snapshotSet('20261102-100000');
    fakeDb(join(dir, 'blobs.manifest.db.snapshot-20261102-100000'));
    fakeDb(join(dir, NEWEST)); // the newer verified project store copy
    const r = enforceBackupByteCap(dir, 1);
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          set: 'vacuum-20261101-100000',
          reason: 'no newer verified snapshot of conduit.db',
        }),
        expect.objectContaining({
          set: 'snapshot-20261102-100000',
          reason: 'no newer verified snapshot of blobs.manifest.db',
        }),
      ]),
    );
    expect(existsSync(join(dir, 'conduit-20261101-100000.db'))).toBe(true);
    expect(existsSync(join(dir, 'blobs.manifest.db.snapshot-20261102-100000'))).toBe(true);
    // Once a newer conduit copy verifies, the older set is covered on every role.
    fakeDb(join(dir, 'conduit-20261104-100000.db'));
    const again = enforceBackupByteCap(dir, 1);
    expect(again.removed.map((x) => x.set)).toContain('vacuum-20261101-100000');
    expect(again.removed.find((x) => x.set === 'vacuum-20261101-100000')?.coveredBy).toEqual({
      'cleo.db': NEWEST,
      'conduit.db': 'conduit-20261104-100000.db',
    });
  });

  it('an empty copy of a role holds nothing to lose; a non-empty one needs a newer verified copy', () => {
    snapshotSet('20261101-100000');
    // An empty store's copy: a database with no schema object.
    new DatabaseSync(join(dir, 'attachments.index.db.snapshot-20261101-100000')).close();
    snapshotSet('20261102-100000');
    writeFileSync(join(dir, 'attachments.index.db.snapshot-20261102-100000'), '');
    const r = enforceBackupByteCap(dir, 1);
    expect(r.removed.map((x) => x.set)).toEqual(['snapshot-20261101-100000']);
    expect(r.removed[0]?.coveredBy).toEqual({
      'attachments.index.db': EMPTY_COPY,
      'cleo.db': 'cleo.db.snapshot-20261102-100000',
      'config.json': 'config.json.snapshot-20261102-100000',
    });
  });

  it('never removes the newest verified copy of a role, nor anything newer, even at a cap of one byte', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    snapshotSet('20261102-100000');
    writeFileSync(join(dir, 'tasks-20261103-100000.db'), 'not a database'); // newest, corrupt
    const r = enforceBackupByteCap(dir, 1);
    expect(r.removed.map((x) => x.set)).toEqual(['vacuum-20261101-100000']);
    expect(r.removed[0]?.coveredBy).toEqual({ 'cleo.db': 'cleo.db.snapshot-20261102-100000' });
    expect(existsSync(join(dir, 'cleo.db.snapshot-20261102-100000'))).toBe(true);
    expect(existsSync(join(dir, 'tasks-20261103-100000.db'))).toBe(true);
    expect(r.overCap).toBe(true);
  });

  it('removes nothing when no snapshot opens: coverage cannot be proven', () => {
    writeFileSync(join(dir, 'tasks-20261101-100000.db'), 'x'.repeat(10_000));
    writeFileSync(join(dir, 'tasks-20261102-100000.db'), 'y'.repeat(10_000));
    const r = enforceBackupByteCap(dir, 1);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(dir, 'tasks-20261101-100000.db'))).toBe(true);
  });

  it('keeps a pinned backup and a pre-collapse snapshot a twin-collapse marker references', () => {
    migrationSet('20261101-100000', { pinned: true, pinnedReason: 'pre-collapse' });
    migrationSet('20261102-100000'); // referenced by a marker
    snapshotSet('20261103-100000', { pinned: true });
    fakeDb(join(dir, NEWEST));
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
    expect(r.kept.map((k) => k.reason)).toEqual([
      'pinned',
      'a twin-collapse marker references cleo.db.migration-20261102-100000',
      'pinned',
      'no newer verified snapshot of cleo.db',
    ]);
  });

  it('keeps a rollback point a receipt field names; a prose note is not a reference', () => {
    snapshotSet('20261101-100000'); // named by backupReceiptPath
    snapshotSet('20261102-100000'); // named by backup id in a nested field
    snapshotSet('20261103-100000'); // named in an unparsable line
    snapshotSet('20261103-200000'); // named only in prose: rotates
    snapshotSet('20261105-100000'); // the newest copy of each role
    const audit = join(cleoDir, 'audit');
    mkdirSync(join(audit, 'nested'), { recursive: true });
    writeFileSync(
      join(audit, 'docs-publications-prune.jsonl'),
      `${JSON.stringify({ op: 'prune', backupReceiptPath: join(dir, 'cleo.db.snapshot-20261101-100000') })}\n`,
    );
    writeFileSync(
      join(audit, 'nested', 'repair.json'),
      JSON.stringify({ repair: { backups: ['snapshot-20261102-100000'] } }),
    );
    writeFileSync(
      join(audit, 'gates.jsonl'),
      `{"broken": "cleo.db.snapshot-20261103-100000"\n${JSON.stringify({ note: 'backups snapshot-20261103-200000 and more' })}\n`,
    );

    const r = enforceBackupByteCap(dir, 1, { dryRun: true });
    expect(r.kept.map((k) => [k.set, k.reason])).toEqual([
      [
        'snapshot-20261101-100000',
        'referenced by audit/docs-publications-prune.jsonl#1:backupReceiptPath',
      ],
      ['snapshot-20261102-100000', 'referenced by audit/nested/repair.json:repair.backups[0]'],
      ['snapshot-20261103-100000', 'referenced by audit/gates.jsonl#1 (unparsed)'],
      ['snapshot-20261105-100000', 'no newer verified snapshot of cleo.db'],
    ]);
    expect(r.removed.map((x) => x.set)).toEqual(['snapshot-20261103-200000']);
  });

  it('keeps every set while a receipt cannot be read', () => {
    snapshotSet('20261101-100000');
    fakeDb(join(dir, NEWEST));
    // A receipt that cannot be read: a dangling link.
    mkdirSync(join(cleoDir, 'audit'), { recursive: true });
    symlinkSync(join(root, 'missing'), join(cleoDir, 'audit', 'bad.jsonl'));
    const r = enforceBackupByteCap(dir, 1, { dryRun: true });
    expect(r.removed).toEqual([]);
    expect(r.kept[0]?.reason).toMatch(/^receipts unreadable/);
  });

  it('a dry run plans the same removals and deletes nothing', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    fakeDb(join(dir, NEWEST));
    const plan = enforceBackupByteCap(dir, 1, { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.removed.map((x) => x.set)).toEqual(['vacuum-20261101-100000']);
    expect(existsSync(join(dir, 'tasks-20261101-100000.db'))).toBe(true);
    expect(existsSync(join(dir, 'rotation.jsonl'))).toBe(false);
  });

  it('applyBackupByteCap defaults to a multiple of the store size and honours backup.maxBytes', () => {
    fakeDb(join(dir, 'tasks-20261101-100000.db'));
    fakeDb(join(dir, 'tasks-20261102-100000.db'));
    const storeBytes = readFileSync(join(cleoDir, 'cleo.db')).length;
    expect(resolveBackupMaxBytes(dir)).toBe(DEFAULT_BACKUP_MAX_BYTES_FACTOR * storeBytes);
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ backup: { maxBytes: 1 } }));
    const r = applyBackupByteCap(dir);
    expect(r?.maxBytes).toBe(1);
    expect(r?.removed.map((x) => x.set)).toEqual(['vacuum-20261101-100000']);
    expect(existsSync(join(dir, 'tasks-20261102-100000.db'))).toBe(true);
  });
});

it('keeps missing keys and newer versions past both caps until the live store recovers them', () => {
  const live = join(cleoDir, 'cleo.db');
  const db = new DatabaseSync(live);
  db.exec(
    "CREATE TABLE tasks_tasks(id TEXT PRIMARY KEY, updated_at TEXT); INSERT INTO tasks_tasks VALUES ('shared','2026-01-01')",
  );
  const checkout = join(root, 'old.db');
  advanceStoreGeneration(db, live);
  copyFileSync(live, checkout);
  db.exec(
    "UPDATE tasks_tasks SET updated_at='2026-11-13'; INSERT INTO tasks_tasks VALUES ('missing','2026-11-13')",
  );
  const good = join(dir, 'cleo.db.snapshot-20260101-000000');
  advanceStoreGeneration(db, live);
  db.exec(`VACUUM INTO '${good.replaceAll("'", "''")}'`);
  db.close();
  copyFileSync(checkout, live);
  const stale = join(dir, 'cleo.db.snapshot-20260102-000000');
  copyFileSync(live, stale);
  copyFileSync(live, join(dir, 'tasks-20260103-000000.db'));
  utimesSync(good, new Date('2026-01-01'), new Date('2026-01-01'));
  utimesSync(stale, new Date('2026-01-02'), new Date('2026-01-02'));
  const countCap = rotateBackupDir(dir, 1, 'snapshot');
  expect(countCap.deleted).not.toContain('cleo.db.snapshot-20260101-000000');
  expect(countCap.retained['cleo.db.snapshot-20260101-000000']).toContain(
    '1 missing keys, 1 older versions',
  );
  const byteCap = enforceBackupByteCap(dir, 1);
  expect(byteCap.kept).toContainEqual(
    expect.objectContaining({
      set: 'snapshot-20260101-000000',
      reason: expect.stringContaining('1 missing keys, 1 older versions'),
    }),
  );
  expect(existsSync(good)).toBe(true);
  copyFileSync(good, live);
  copyFileSync(live, stale);
  utimesSync(stale, new Date('2026-01-02'), new Date('2026-01-02'));
  const recovered = rotateBackupDir(dir, 1, 'snapshot');
  expect(recovered.retained).toEqual({});
  expect(recovered.deleted).toContain('cleo.db.snapshot-20260101-000000');
});

it('does not pin a damaged checkpoint when the live store is unreadable', () => {
  const live = join(cleoDir, 'cleo.db');
  const source = join(dir, 'tasks-20260101-000000.db');
  const db = new DatabaseSync(live);
  advanceStoreGeneration(db, live);
  db.exec(`VACUUM INTO '${source.replaceAll("'", "''")}'`);
  db.close();
  const snapshot = new DatabaseSync(source);
  const rootPage = Number(
    snapshot.prepare("SELECT rootpage FROM sqlite_schema WHERE name='t'").get()?.rootpage,
  );
  const pageSize = Number(snapshot.prepare('PRAGMA page_size').get()?.page_size);
  snapshot.close();
  const original = readFileSync(source);
  const bytes = Buffer.from(original);
  bytes.fill(0, (rootPage - 1) * pageSize, rootPage * pageSize);
  writeFileSync(source, bytes);
  writeFileSync(live, Buffer.alloc(4096));
  expect(snapshotRecoveryReason(live, source)).toBeUndefined();
  writeFileSync(source, original);
  expect(snapshotRecoveryReason(live, source)).toContain('Live recovery ancestry unavailable');
});
