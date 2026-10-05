/**
 * Restoring the live project `cleo.db` from a named snapshot or a backup id
 * (T13240), attacked: a live writer in another process, truncated, garbage and
 * page-corrupted snapshots, a snapshot with its own WAL, a live store with
 * uncheckpointed WAL commits, another store's file, path traversal, and the
 * kept pre-restore store as the undo.
 *
 * Every store lives in a temp project (createTestDb).
 *
 * @task T13240
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSystemBackups, restoreBackup } from '../../system/backup.js';
import { restoreStoreSnapshot } from '../restore-store.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let live: string;
let backups: string;

/** Task ids in a store file, read through a private read-only handle. */
function taskIds(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT id FROM tasks_tasks ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
  } finally {
    db.close();
  }
}

/** A VACUUM INTO snapshot of the live store, under .cleo/backups/sqlite. */
function snapshot(name: string): string {
  const db = getNativeTasksDb(env.tempDir);
  if (!db) throw new Error('no native handle');
  const file = join(backups, name);
  db.exec(`VACUUM INTO '${file}'`);
  return file;
}

/** Leftover private copies next to the live store. */
const staged = () => readdirSync(join(env.tempDir, '.cleo')).filter((f) => f.includes('.restore-'));

const restore = (o: {
  snapshot?: string;
  backupId?: string;
  dryRun?: boolean;
  allowExternal?: boolean;
}) => restoreStoreSnapshot({ projectRoot: env.tempDir, cwd: env.tempDir, ...o });

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [{ id: 'T001', title: 'kept in the snapshot', type: 'task' }]);
  live = join(env.tempDir, '.cleo', 'cleo.db');
  backups = join(env.tempDir, '.cleo', 'backups', 'sqlite');
  mkdirSync(backups, { recursive: true });
});

afterEach(async () => {
  resetDbState();
  await env.cleanup();
});

describe('restoreStoreSnapshot (T13240)', () => {
  it('restores a named snapshot, keeps the replaced store, and --id of the kept store undoes it', async () => {
    const snap = snapshot('snap.db');
    await seedTasks(env.accessor, [{ id: 'T002', title: 'after the snapshot', type: 'task' }]);
    const result = await restore({ snapshot: snap });
    expect(result.restored).toBe(true);
    expect(result.verification).toMatchObject({ integrity: 'ok', tasks: 1 });
    expect(taskIds(live)).toEqual(['T001']);
    // The replaced store is kept, listed, and holds what the restore replaced.
    expect(result.kept).not.toBeNull();
    const kept = result.kept as NonNullable<typeof result.kept>;
    expect(taskIds(kept.path)).toEqual(['T001', 'T002']);
    expect(listSystemBackups(env.tempDir).map((b) => b.backupId)).toContain(kept.backupId);
    expect(result.undo).toBe(`cleo restore backup --id ${kept.backupId}`);
    expect(staged()).toEqual([]);

    const undo = await restore({ backupId: kept.backupId });
    expect(undo.restored).toBe(true);
    expect(taskIds(live)).toEqual(['T001', 'T002']);
  });

  it('a dry run verifies and reports, and writes nothing', async () => {
    const snap = snapshot('snap.db');
    await seedTasks(env.accessor, [{ id: 'T002', title: 'after', type: 'task' }]);
    resetDbState();
    const before = readFileSync(live);
    const result = await restore({ snapshot: snap, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, restored: false, kept: null, undo: null });
    expect(result.verification.tasks).toBe(1);
    expect(readFileSync(live).equals(before)).toBe(true);
    expect(readdirSync(backups).filter((f) => f.startsWith('pre-restore'))).toEqual([]);
    expect(staged()).toEqual([]);
  });

  describe('a live writer refuses the restore', () => {
    let child: ChildProcess | undefined;
    afterEach(() => {
      child?.kill('SIGTERM');
      child = undefined;
    });

    it('another process holding the store open: refused, the live store untouched', async () => {
      const snap = snapshot('snap.db');
      await seedTasks(env.accessor, [{ id: 'T002', title: 'live', type: 'task' }]);
      child = spawn(
        process.execPath,
        [
          '-e',
          `const { DatabaseSync } = require('node:sqlite');
           const db = new DatabaseSync(process.argv[1]);
           db.prepare('SELECT count(*) FROM tasks_tasks').get();
           process.stdout.write('ready\\n');
           setInterval(() => db.prepare('SELECT 1').get(), 50);`,
          live,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await new Promise<void>((ok, fail) => {
        child?.stdout?.once('data', () => ok());
        child?.once('exit', (code) => fail(new Error(`holder exited ${code}`)));
      });
      await expect(restore({ snapshot: snap })).rejects.toThrow(/E_RESTORE_STORE_BUSY/);
      expect(taskIds(live)).toEqual(['T001', 'T002']);
      expect(staged()).toEqual([]);
      expect(readdirSync(backups).filter((f) => f.startsWith('pre-restore'))).toEqual([]);
    });
  });

  describe('a bad snapshot is refused before anything is touched', () => {
    async function expectRefused(file: string, pattern: RegExp): Promise<void> {
      resetDbState();
      const before = readFileSync(live);
      await expect(restore({ snapshot: file })).rejects.toThrow(pattern);
      expect(readFileSync(live).equals(before)).toBe(true);
      expect(staged()).toEqual([]);
    }

    it('a truncated snapshot', async () => {
      const snap = snapshot('snap.db');
      truncateSync(snap, Math.floor(statSync(snap).size / 2));
      await expectRefused(snap, /E_RESTORE_SNAPSHOT_CORRUPT/);
    });

    it('a file that is not a database', async () => {
      const junk = join(backups, 'junk.db');
      writeFileSync(junk, 'not a database at all, just text that is long enough');
      await expectRefused(junk, /E_RESTORE_SNAPSHOT_CORRUPT/);
    });

    it('an empty file', async () => {
      const empty = join(backups, 'empty.db');
      writeFileSync(empty, '');
      await expectRefused(empty, /E_RESTORE_SNAPSHOT_CORRUPT/);
    });

    it('a snapshot with corrupted pages', async () => {
      const snap = snapshot('snap.db');
      const bytes = readFileSync(snap);
      const page = 4096;
      // Overwrite every page after the first (the schema survives, the b-trees do not).
      for (let off = page; off < bytes.length; off += page) bytes.fill(0xa5, off + 8, off + 200);
      writeFileSync(snap, bytes);
      await expectRefused(snap, /E_RESTORE_SNAPSHOT_CORRUPT/);
    });

    it('a snapshot with a non-empty WAL beside it (its newest commits are not in the file)', async () => {
      const snap = snapshot('snap.db');
      writeFileSync(`${snap}-wal`, Buffer.alloc(4096, 1));
      await expectRefused(snap, /E_RESTORE_SNAPSHOT_INCOMPLETE/);
    });

    it('a database that is not a project store', async () => {
      const other = join(backups, 'other.db');
      const db = new DatabaseSync(other);
      db.exec('CREATE TABLE notes (x TEXT); INSERT INTO notes VALUES (1);');
      db.close();
      await expectRefused(other, /E_RESTORE_SNAPSHOT_SHAPE/);
    });
  });

  describe('the source is checked', () => {
    it("a file outside this project's backups needs --allow-external", async () => {
      const snap = snapshot('snap.db');
      const outside = join(env.tempDir, 'elsewhere.db');
      copyFileSync(snap, outside);
      await expect(restore({ snapshot: outside })).rejects.toThrow(/E_RESTORE_EXTERNAL/);
      const ok = await restore({ snapshot: outside, allowExternal: true });
      expect(ok.restored).toBe(true);
    });

    it('a backup id cannot traverse out of the backup directory', async () => {
      await expect(restore({ backupId: '../../cleo' })).rejects.toThrow(/invalid backup id/);
      await expect(restore({ backupId: 'missing-1' })).rejects.toThrow(/backup not found/);
    });

    it('the live store is not its own snapshot', async () => {
      await expect(restore({ snapshot: live, allowExternal: true })).rejects.toThrow(
        /the source is the live store/,
      );
    });

    it('exactly one source', async () => {
      await expect(restore({})).rejects.toThrow(/E_RESTORE_SOURCE/);
      await expect(restore({ snapshot: 'a.db', backupId: 'b' })).rejects.toThrow(
        /E_RESTORE_SOURCE/,
      );
    });
  });

  it('uncheckpointed WAL commits of the live store go into the kept copy, never into the restored file', async () => {
    const snap = snapshot('snap.db');
    resetDbState();
    // Make a live store whose newest commit (T003) is only in its WAL.
    const writer = new DatabaseSync(live);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec(
      "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T003', 'only in the wal', 'task', 'pending')",
    );
    const frozen = join(env.tempDir, 'frozen');
    mkdirSync(frozen);
    copyFileSync(live, join(frozen, 'cleo.db'));
    copyFileSync(`${live}-wal`, join(frozen, 'cleo.db-wal'));
    writer.close();
    copyFileSync(join(frozen, 'cleo.db'), live);
    copyFileSync(join(frozen, 'cleo.db-wal'), `${live}-wal`);
    expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);

    const result = await restore({ snapshot: snap });
    // The liveness probes may fold the WAL into the live file first (SQLite's
    // close-time checkpoint); either way the commit must reach the kept copy.
    expect(existsSync(`${live}-wal`) && statSync(`${live}-wal`).size > 0).toBe(false);
    expect(taskIds(live)).toEqual(['T001']);
    const kept = result.kept as NonNullable<typeof result.kept>;
    expect(kept.checkpointed).toBe(true);
    // Self-contained: no WAL was kept beside it (the read below may create an empty one).
    expect(existsSync(`${kept.path}-wal`)).toBe(false);
    expect(kept.sidecars).toEqual([]);
    expect(taskIds(kept.path)).toEqual(['T001', 'T003']);
  });

  it('the legacy id restore never plain-copies the live store', async () => {
    const snap = snapshot('snap.db');
    await seedTasks(env.accessor, [{ id: 'T002', title: 'live', type: 'task' }]);
    resetDbState();
    copyFileSync(snap, join(backups, 'cleo.db.legacy-1'));
    writeFileSync(
      join(backups, 'legacy-1.meta.json'),
      JSON.stringify({
        backupId: 'legacy-1',
        type: 'snapshot',
        timestamp: 'now',
        files: ['cleo.db'],
      }),
    );
    const before = readFileSync(live);
    const result = restoreBackup(env.tempDir, { backupId: 'legacy-1', cwd: env.tempDir });
    expect(result.filesRestored).toEqual([]);
    expect(readFileSync(live).equals(before)).toBe(true);
  });
});
