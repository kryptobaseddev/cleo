/**
 * The docs byte surfaces in `cleo backup add` / `cleo restore backup --id`
 * (T13704): the shared content-addressed pool and per-backup rotation
 * (T13710), the restore through {@link restoreStoreSnapshot} with its
 * live-writer refusal and pre-restore safety copy (T13708), and partial
 * restores that are never reported as clean (T13709).
 *
 * Every store lives in a temp project (createTestDb).
 *
 * @task T13704
 * @task T13708
 * @task T13709
 * @task T13710
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup, restoreBackupById } from '../../system/backup.js';
import { docsBytePoolDir } from '../docs-bytes-backup.js';
import { restoreStoreSnapshot } from '../restore-store.js';
import { resetDbState } from '../sqlite.js';
import { createTestDb, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let cleoDir: string;
let backupDir: string;
let pool: string;

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

/** Write a blob-store byte file (named by its sha256) and return the sha. */
function addBlob(content: string): string {
  const s = sha(content);
  mkdirSync(join(cleoDir, 'blobs', 'blobs'), { recursive: true });
  writeFileSync(join(cleoDir, 'blobs', 'blobs', s), content);
  return s;
}

/** Create a WAL-mode docs database with one row. */
function makeDb(rel: string, value: string): void {
  mkdirSync(join(cleoDir, rel, '..'), { recursive: true });
  const db = new DatabaseSync(join(cleoDir, rel));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run(value);
  } finally {
    db.close();
  }
}

function dbValues(rel: string): string[] {
  const db = new DatabaseSync(join(cleoDir, rel), { readOnly: true });
  try {
    return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
}

/** Seed a doc: manifest + blob + legacy attachment + attachment index. */
function seedDocs(content: string): string {
  makeDb('blobs/manifest.db', `manifest:${content}`);
  makeDb('attachments/index.db', `index:${content}`);
  const s = addBlob(content);
  const att = join(cleoDir, 'attachments', 'sha256', s.slice(0, 2));
  mkdirSync(att, { recursive: true });
  writeFileSync(join(att, `${s.slice(2)}.md`), content);
  return s;
}

/** Back up at a distinct second (backup ids are second-resolution) with distinct mtimes. */
async function backupAt(second: number, maxSnapshots?: number): Promise<string> {
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, 12, 0, second)));
  const { backupId } = await createBackup(env.tempDir, {
    type: 'snapshot',
    ...(maxSnapshots !== undefined ? { maxSnapshots } : {}),
  });
  // In the past: the next backup, rotated at its real mtime, is the newest.
  const t = 1_700_000_000 + second;
  for (const f of readdirSync(backupDir).filter((n) => n.endsWith(`.${backupId}`))) {
    utimesSync(join(backupDir, f), t, t);
  }
  return backupId;
}

interface DocsSidecar {
  dbs: { label: string; path: string; sha256: string }[];
  files: { path: string; sha256: string }[];
}
const sidecarOf = (id: string): DocsSidecar =>
  JSON.parse(readFileSync(join(backupDir, `docs-bytes.json.${id}`), 'utf-8')) as DocsSidecar;

/** Remove everything in `.cleo/` except the backups (the qualification's empty store). */
function wipeKeepingBackups(): void {
  resetDbState();
  const saved = join(env.tempDir, 'saved-backups');
  renameSync(join(cleoDir, 'backups'), saved);
  rmSync(cleoDir, { recursive: true, force: true });
  mkdirSync(cleoDir, { recursive: true });
  renameSync(saved, join(cleoDir, 'backups'));
}

const restoreId = (backupId: string) =>
  restoreStoreSnapshot({ projectRoot: env.tempDir, cwd: env.tempDir, backupId });

beforeEach(async () => {
  env = await createTestDb();
  cleoDir = join(env.tempDir, '.cleo');
  backupDir = join(cleoDir, 'backups', 'sqlite');
  pool = docsBytePoolDir(backupDir);
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  resetDbState();
  await env.cleanup();
});

describe('backup: one shared pool, rotation per backup (T13710)', () => {
  it('pools bytes once and keeps the databases as verified VACUUM INTO snapshots', async () => {
    const s = seedDocs('# doc one\n');
    const first = await backupAt(1);
    const second = await backupAt(2);

    // Bytes live once in the pool, never as per-backup copies.
    expect(readdirSync(pool)).toEqual([s]);
    expect(readdirSync(backupDir).some((f) => f.startsWith('blob-') || f.startsWith('att-'))).toBe(
      false,
    );
    for (const id of [first, second]) {
      const sidecar = sidecarOf(id);
      expect(sidecar.files.map((f) => f.path).sort()).toEqual(
        [`attachments/sha256/${s.slice(0, 2)}/${s.slice(2)}.md`, `blobs/blobs/${s}`].sort(),
      );
      expect(sidecar.dbs.map((d) => d.label).sort()).toEqual([
        'attachments.index.db',
        'blobs.manifest.db',
      ]);
      // The live -wal/-shm and index.db are never copied as bytes.
      expect(sidecar.files.some((f) => f.path.includes('index.db'))).toBe(false);
      for (const db of sidecar.dbs) {
        const file = join(backupDir, `${db.label}.${id}`);
        expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(db.sha256);
      }
    }
  });

  it('with more files than the cap, keeps the newest N backups whole and every blob they reference', async () => {
    seedDocs('# seed\n');
    const early = Array.from({ length: 15 }, (_, i) => addBlob(`early blob ${i}\n`));
    const b1 = await backupAt(1, 2);
    // Five early blobs leave the live tree: only b1 references them.
    for (const s of early.slice(0, 5)) rmSync(join(cleoDir, 'blobs', 'blobs', s));
    const late = addBlob('late blob\n');
    const b2 = await backupAt(2, 2);
    const b3 = await backupAt(3, 2);

    const names = readdirSync(backupDir);
    // The rotated backup went whole: store snapshot, sidecars, db snapshots.
    expect(names.filter((n) => n.includes(b1))).toEqual([]);
    for (const id of [b2, b3]) {
      expect(names).toContain(`cleo.db.${id}`);
      expect(names).toContain(`${id}.meta.json`);
      expect(names).toContain(`docs-bytes.json.${id}`);
      expect(names).toContain(`blobs.manifest.db.${id}`);
      // No blob a surviving backup references is gone.
      for (const f of sidecarOf(id).files) expect(existsSync(join(pool, f.sha256))).toBe(true);
    }
    // Only b1 referenced the five removed blobs: the sweep unlinked them.
    for (const s of early.slice(0, 5)) expect(existsSync(join(pool, s))).toBe(false);
    for (const s of [...early.slice(5), late]) expect(existsSync(join(pool, s))).toBe(true);
  });
});

describe('restore --id brings the docs bytes back (T13708)', () => {
  it('restores into an empty store through restoreStoreSnapshot; the doc bytes read back', async () => {
    const content = '# Restored doc\n\nhello bytes.\n';
    const s = seedDocs(content);
    const id = await backupAt(1);
    wipeKeepingBackups();

    const result = await restoreId(id);

    expect(result.restored).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(result.docsBytes).toEqual({
      complete: true,
      dbsRestored: ['blobs/manifest.db', 'attachments/index.db'],
      filesRestored: 2,
      failed: [],
    });
    expect(readFileSync(join(cleoDir, 'blobs', 'blobs', s), 'utf-8')).toBe(content);
    expect(
      readFileSync(
        join(cleoDir, 'attachments', 'sha256', s.slice(0, 2), `${s.slice(2)}.md`),
        'utf-8',
      ),
    ).toBe(content);
    expect(dbValues('blobs/manifest.db')).toEqual([`manifest:${content}`]);
    expect(dbValues('attachments/index.db')).toEqual([`index:${content}`]);
  });

  it('restoreBackupById (dispatch) takes the same path', async () => {
    const s = seedDocs('# via dispatch\n');
    const id = await backupAt(1);
    wipeKeepingBackups();

    const result = await restoreBackupById(env.tempDir, { backupId: id, cwd: env.tempDir });

    expect(result.store?.docsBytes?.complete).toBe(true);
    expect(existsSync(join(cleoDir, 'blobs', 'blobs', s))).toBe(true);
  });

  it('keeps the live blobs and databases under the pre-restore undo backup', async () => {
    seedDocs('# in the backup\n');
    const id = await backupAt(1);
    const liveOnly = addBlob('# written after the backup\n');
    makeDb('blobs/manifest.db', 'added after the backup');

    const result = await restoreId(id);

    const undo = result.kept?.backupId;
    expect(undo).toMatch(/^pre-restore-/);
    const kept = sidecarOf(String(undo));
    expect(kept.files.map((f) => f.sha256)).toContain(liveOnly);
    expect(existsSync(join(pool, liveOnly))).toBe(true);
    expect(kept.dbs.map((d) => d.label)).toContain('blobs.manifest.db');
    // The kept manifest holds the row the restore replaced.
    const keptManifest = new DatabaseSync(join(backupDir, `blobs.manifest.db.${undo}`), {
      readOnly: true,
    });
    try {
      expect(keptManifest.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 });
    } finally {
      keptManifest.close();
    }
    // And the restore really replaced it.
    expect(dbValues('blobs/manifest.db')).toHaveLength(1);
  });

  it('refuses while another connection holds the live manifest open, before anything changes', async () => {
    seedDocs('# busy\n');
    const id = await backupAt(1);
    const holder = new DatabaseSync(join(cleoDir, 'blobs', 'manifest.db'));
    try {
      holder.exec('PRAGMA journal_mode = WAL');
      holder.prepare('SELECT count(*) FROM t').get();
      await expect(restoreId(id)).rejects.toThrow(/E_RESTORE_STORE_BUSY/);
    } finally {
      holder.close();
    }
    expect(readdirSync(backupDir).some((f) => f.startsWith('pre-restore-'))).toBe(false);
  });
});

describe('a partial restore is never clean (T13709)', () => {
  it('a missing or corrupt pool blob is listed, not placed, and the result is partial', async () => {
    const content = '# good\n';
    const s = seedDocs(content);
    const bad = addBlob('# to be corrupted\n');
    const gone = addBlob('# to be lost\n');
    const id = await backupAt(1);
    writeFileSync(join(pool, bad), 'flipped bits');
    rmSync(join(pool, gone));
    wipeKeepingBackups();

    const result = await restoreId(id);

    expect(result.restored).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.docsBytes?.complete).toBe(false);
    expect(result.docsBytes?.failed).toEqual(
      expect.arrayContaining([
        `blobs/blobs/${bad}: sha256 mismatch`,
        `blobs/blobs/${gone}: missing from the backup pool`,
      ]),
    );
    expect(result.warnings).toHaveLength(2);
    expect(existsSync(join(cleoDir, 'blobs', 'blobs', bad))).toBe(false);
    expect(existsSync(join(cleoDir, 'blobs', 'blobs', gone))).toBe(false);
    expect(readFileSync(join(cleoDir, 'blobs', 'blobs', s), 'utf-8')).toBe(content);
  });

  it('a database snapshot that fails its sha256 or integrity_check is not placed over the live file', async () => {
    seedDocs('# db\n');
    const id = await backupAt(1);
    writeFileSync(join(backupDir, `blobs.manifest.db.${id}`), 'SQLite format 3\0garbage');
    makeDb('blobs/manifest.db', 'live row');

    const result = await restoreId(id);

    expect(result.partial).toBe(true);
    expect(result.docsBytes?.failed).toEqual(['blobs/manifest.db: sha256 mismatch']);
    expect(result.docsBytes?.dbsRestored).toEqual(['attachments/index.db']);
    // The live manifest is untouched.
    expect(dbValues('blobs/manifest.db')).toEqual(['manifest:# db\n', 'live row']);

    // A sidecar that vouches for the garbage still cannot get it past integrity_check.
    const sidecarPath = join(backupDir, `docs-bytes.json.${id}`);
    const sidecar = sidecarOf(id);
    const garbage = createHash('sha256')
      .update(readFileSync(join(backupDir, `blobs.manifest.db.${id}`)))
      .digest('hex');
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        ...sidecar,
        dbs: sidecar.dbs.map((d) =>
          d.label === 'blobs.manifest.db' ? { ...d, sha256: garbage } : d,
        ),
      }),
    );
    const again = await restoreId(id);
    expect(again.partial).toBe(true);
    expect(again.docsBytes?.failed[0]).toMatch(/^blobs\/manifest\.db: /);
    expect(again.docsBytes?.failed[0]).not.toMatch(/sha256 mismatch/);
    expect(dbValues('blobs/manifest.db')).toEqual(['manifest:# db\n', 'live row']);
  });
});

describe('review hardening (#2253)', () => {
  const tamper = (id: string, edit: (s: DocsSidecar) => DocsSidecar): void => {
    writeFileSync(
      join(backupDir, `docs-bytes.json.${id}`),
      JSON.stringify({ version: 1, ...edit(sidecarOf(id)) }),
    );
  };
  const storeTaskCount = (): number => {
    const db = new DatabaseSync(join(cleoDir, 'cleo.db'), { readOnly: true });
    try {
      return (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('a sidecar db entry that is not a known docs database is refused (cleo.db, ../x)', async () => {
    seedDocs('# tamper\n');
    const id = await backupAt(1);
    tamper(id, (s) => ({
      ...s,
      dbs: [
        ...s.dbs,
        { ...(s.dbs[0] as DocsSidecar['dbs'][number]), path: 'cleo.db' },
        { ...(s.dbs[0] as DocsSidecar['dbs'][number]), path: '../x' },
      ],
    }));
    const before = readFileSync(join(backupDir, `cleo.db.${id}`));

    const result = await restoreId(id);

    expect(result.partial).toBe(true);
    expect(result.docsBytes?.failed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^cleo\.db: not a docs database/),
        expect.stringMatching(/^\.\.\/x: not a docs database/),
      ]),
    );
    // The restored store is the backup's, not a docs snapshot renamed over it.
    expect(readFileSync(join(cleoDir, 'cleo.db')).equals(before)).toBe(true);
    expect(storeTaskCount()).toBe(0);
    expect(existsSync(join(env.tempDir, 'x'))).toBe(false);
  });

  it('a sidecar file path with a backslash or an absolute path is refused', async () => {
    const s = seedDocs('# paths\n');
    const id = await backupAt(1);
    tamper(id, (sc) => ({
      ...sc,
      files: [
        ...sc.files,
        { path: 'attachments\\..\\..\\evil', sha256: s },
        { path: '/tmp/evil', sha256: s },
      ],
    }));

    const result = await restoreId(id);

    expect(result.partial).toBe(true);
    expect(result.docsBytes?.failed).toEqual(
      expect.arrayContaining([
        'attachments\\..\\..\\evil: not a docs byte path',
        '/tmp/evil: not a docs byte path',
      ]),
    );
  });

  it('aborts before any swap when a live docs database cannot be kept', async () => {
    seedDocs('# keep\n');
    const id = await backupAt(1);
    // A live index.db whose b-tree pages are corrupt: it opens and locks,
    // but its snapshot fails (VACUUM INTO or integrity_check).
    const index = join(cleoDir, 'attachments', 'index.db');
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${index}${suffix}`, { force: true });
    const db = new DatabaseSync(index);
    db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE t (v TEXT);');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 200; i++) insert.run(`row ${i} ${'x'.repeat(100)}`);
    db.close();
    const bytes = readFileSync(index);
    for (let off = 4096; off < bytes.length; off += 4096) bytes.fill(0xa5, off + 8, off + 200);
    writeFileSync(index, bytes);
    const liveStore = readFileSync(join(cleoDir, 'cleo.db'));

    await expect(restoreId(id)).rejects.toThrow(/E_RESTORE_KEEP_FAILED/);
    expect(readFileSync(index).equals(bytes)).toBe(true);
    expect(readFileSync(join(cleoDir, 'cleo.db')).equals(liveStore)).toBe(true);
  });

  it('a backup whose meta records docs bytes but whose sidecar is gone restores as partial', async () => {
    seedDocs('# meta\n');
    const id = await backupAt(1);
    const meta = JSON.parse(readFileSync(join(backupDir, `${id}.meta.json`), 'utf-8')) as {
      docsBytes?: { files?: number };
    };
    expect(meta.docsBytes?.files).toBe(2);
    rmSync(join(backupDir, `docs-bytes.json.${id}`));
    wipeKeepingBackups();

    const result = await restoreId(id);

    expect(result.restored).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual([
      `docs-bytes.json.${id} is missing (the backup recorded docs bytes)`,
    ]);
  });

  it('with no live store, the docs-only keep is undone by --id', async () => {
    seedDocs('# in the backup\n');
    const id = await backupAt(1);
    const liveOnly = addBlob('# live only\n');
    makeDb('blobs/manifest.db', 'live row');
    resetDbState();
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(cleoDir, `cleo.db${suffix}`), { force: true });

    const result = await restoreId(id);
    expect(result.kept).toBeNull();
    expect(result.undo).toMatch(/^cleo restore backup --id pre-restore-/);
    expect(dbValues('blobs/manifest.db')).toHaveLength(1);

    const undoId = String(result.undo).split(' ').pop() as string;
    resetDbState();
    const undone = await restoreId(undoId);

    expect(undone.restored).toBe(true);
    expect(undone.docsBytes?.complete).toBe(true);
    expect(existsSync(join(cleoDir, 'blobs', 'blobs', liveOnly))).toBe(true);
    expect(dbValues('blobs/manifest.db')).toEqual(['manifest:# in the backup\n', 'live row']);
  });
});
