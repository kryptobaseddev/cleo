/**
 * Backups round-trip onto the LIVE project store (T13245). `backup add` and
 * the session-end snapshots capture `.cleo/cleo.db` (tasks AND brain tables),
 * but the id restore and `backup recover tasks|brain` wrote the
 * pre-consolidation `.cleo/tasks.db` / `.cleo/brain.db`, which nothing reads.
 * Each test takes a backup, changes the store, restores or recovers, and
 * compares row counts and content checksums of the tasks and brain tables
 * with the backed-up state.
 *
 * @task T13245
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_GLOBAL_BACKUP_INTERVAL_MS,
  autoGlobalBackup,
  createBackup,
  createGlobalBackup,
  GLOBAL_BACKUP_LOCK_STALE_MS,
  listGlobalBackups,
  listSystemBackups,
  restoreBackupById,
} from '../../system/backup.js';
import { recoverProjectStore } from '../backup-recover.js';
import { getDualScopeNativeDb, openDualScopeDb } from '../dual-scope-db.js';
import { restoreStoreSnapshot } from '../restore-store.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let live: string;
let sqliteDir: string;

/** Row counts and a content checksum of the tasks and brain tables of a store file. */
function fingerprint(file: string): Record<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, string> = {};
    for (const [table, cols] of [
      ['tasks_tasks', 'id, title, status'],
      ['brain_observations', 'id, title, narrative'],
    ] as const) {
      const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY id`).all();
      out[table] =
        `${rows.length}:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
    }
    return out;
  } finally {
    db.close();
  }
}

function native(): DatabaseSync {
  const db = getNativeTasksDb(env.tempDir);
  if (!db) throw new Error('no native handle');
  return db;
}

function observe(id: string): void {
  native()
    .prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, content_hash, source_type, quality_score, created_at)
       VALUES (?, 'context', ?, 'kept by the backup', ?, 'agent', 0.7, '2026-10-05 10:00:00')`,
    )
    .run(id, `obs ${id}`, `hash-${id}`);
}

/** A session-end style snapshot (`<role>-YYYYMMDD-HHmmss.db`) of the live store. */
function sessionSnapshot(role: string, stamp: string): string {
  const file = join(sqliteDir, `${role}-${stamp}.db`);
  native().exec(`VACUUM INTO '${file}'`);
  return file;
}

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [
    { id: 'T001', title: 'backed up', type: 'task' },
    { id: 'T002', title: 'also backed up', type: 'task' },
  ]);
  observe('O-keep-1');
  live = join(env.tempDir, '.cleo', 'cleo.db');
  sqliteDir = join(env.tempDir, '.cleo', 'backups', 'sqlite');
  mkdirSync(sqliteDir, { recursive: true });
});

afterEach(async () => {
  resetDbState();
  await env.cleanup();
});

describe('backups restore onto the live cleo.db (T13245)', () => {
  it('backup add, change, restore by id: tasks and brain match the backup; the replaced store is kept', async () => {
    const { backupId } = await createBackup(env.tempDir, { type: 'snapshot' });
    const backedUp = fingerprint(join(sqliteDir, `cleo.db.${backupId}`));
    expect(fingerprint(live)).toEqual(backedUp);

    await seedTasks(env.accessor, [{ id: 'T003', title: 'after the backup', type: 'task' }]);
    native().prepare("DELETE FROM brain_observations WHERE id = 'O-keep-1'").run();
    const changed = fingerprint(live);
    expect(changed).not.toEqual(backedUp);

    const result = await restoreBackupById(env.tempDir, { backupId, cwd: env.tempDir });
    expect(result.store?.restored).toBe(true);
    expect(result.filesRestored).toContain('cleo.db');
    expect(fingerprint(live)).toEqual(backedUp);
    // No decoy was written.
    expect(existsSync(join(env.tempDir, '.cleo', 'tasks.db'))).toBe(false);
    expect(existsSync(join(env.tempDir, '.cleo', 'brain.db'))).toBe(false);
    // The replaced store is kept and restores the changed state.
    const kept = result.store?.kept;
    expect(kept && fingerprint(kept.path)).toEqual(changed);
  });

  it.each([
    'tasks',
    'brain',
  ])('backup recover %s restores the live cleo.db from the freshest valid session snapshot', async (role) => {
    const snap = sessionSnapshot(role, '20261005-100000');
    const backedUp = fingerprint(snap);
    await seedTasks(env.accessor, [{ id: 'T003', title: 'after', type: 'task' }]);
    // A pre-consolidation decoy is never the target.
    const decoy = join(env.tempDir, '.cleo', `${role}.db`);
    writeFileSync(decoy, 'decoy');
    resetDbState();

    const result = await recoverProjectStore({ role, projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.restored).toBe(true);
    expect(result.target).toBe(live);
    expect(fingerprint(live)).toEqual(backedUp);
    expect(readFileSync(decoy, 'utf8')).toBe('decoy');
  });

  it('a corrupt newest snapshot is skipped for the next valid one', async () => {
    const older = sessionSnapshot('tasks', '20261005-090000');
    const backedUp = fingerprint(older);
    await seedTasks(env.accessor, [{ id: 'T003', title: 'after', type: 'task' }]);
    const newest = sessionSnapshot('tasks', '20261005-100000');
    writeFileSync(newest, Buffer.alloc(8192, 0x5a));
    resetDbState();

    const result = await recoverProjectStore({
      role: 'tasks',
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(result.rejected).toEqual([newest]);
    expect(result.source.path).toBe(older);
    expect(fingerprint(live)).toEqual(backedUp);
  });

  it('a damaged live store: refused unless --force says every process is stopped', async () => {
    const snap = sessionSnapshot('tasks', '20261005-100000');
    const backedUp = fingerprint(snap);
    resetDbState();
    // Overwrite the header: the live store no longer reads as a database.
    const bytes = readFileSync(live);
    bytes.fill(0x42, 0, 100);
    writeFileSync(live, bytes);
    for (const s of ['-wal', '-shm']) if (existsSync(live + s)) writeFileSync(live + s, '');

    await expect(
      recoverProjectStore({ role: 'tasks', projectRoot: env.tempDir, cwd: env.tempDir }),
    ).rejects.toThrow(/E_RESTORE_STORE_BUSY/);
    const result = await recoverProjectStore({
      role: 'tasks',
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      force: true,
    });
    expect(result.restored).toBe(true);
    expect(fingerprint(live)).toEqual(backedUp);
    // The damaged file is kept raw, not checkpointed.
    expect(result.kept?.checkpointed).toBe(false);
  });

  it('a dry run picks the snapshot and writes nothing', async () => {
    sessionSnapshot('tasks', '20261005-100000');
    await seedTasks(env.accessor, [{ id: 'T003', title: 'after', type: 'task' }]);
    resetDbState();
    const before = fingerprint(live);
    const result = await recoverProjectStore({
      role: 'tasks',
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      dryRun: true,
    });
    expect(result).toMatchObject({ dryRun: true, restored: false });
    expect(fingerprint(live)).toEqual(before);
  });

  it('backup add writes ONE cleo.db copy; the list says what it holds, and old labels still read', async () => {
    const { backupId, files } = await createBackup(env.tempDir, { type: 'snapshot' });
    expect(files).toContain('cleo.db');
    expect(files).not.toContain('tasks.db');
    expect(files).not.toContain('brain.db');
    expect(existsSync(join(sqliteDir, `cleo.db.${backupId}`))).toBe(true);
    const entry = listSystemBackups(env.tempDir).find((b) => b.backupId === backupId);
    expect(entry).toMatchObject({ scope: 'project', contains: ['tasks', 'brain', 'conduit'] });
    // A pre-T13245 backup with the old labels: listed with its contents, restorable by id.
    copyFileSync(
      join(sqliteDir, `cleo.db.${backupId}`),
      join(sqliteDir, 'tasks.db.snapshot-20260101-000000'),
    );
    writeFileSync(
      join(sqliteDir, 'snapshot-20260101-000000.meta.json'),
      JSON.stringify({
        backupId: 'snapshot-20260101-000000',
        type: 'snapshot',
        timestamp: '2026-01-01T00:00:00.000Z',
        files: ['tasks.db', 'brain.db'],
      }),
    );
    const old = listSystemBackups(env.tempDir).find(
      (b) => b.backupId === 'snapshot-20260101-000000',
    );
    expect(old?.contains).toEqual(['tasks', 'brain', 'conduit']);
    const backedUp = fingerprint(join(sqliteDir, `cleo.db.${backupId}`));
    await seedTasks(env.accessor, [{ id: 'T003', title: 'after', type: 'task' }]);
    const r = await restoreBackupById(env.tempDir, {
      backupId: 'snapshot-20260101-000000',
      cwd: env.tempDir,
    });
    expect(r.store?.restored).toBe(true);
    expect(fingerprint(live)).toEqual(backedUp);
  });

  it('backup recover finds a backup-add copy when no session snapshot exists', async () => {
    const { backupId } = await createBackup(env.tempDir, { type: 'snapshot' });
    const backedUp = fingerprint(join(sqliteDir, `cleo.db.${backupId}`));
    await seedTasks(env.accessor, [{ id: 'T003', title: 'after', type: 'task' }]);
    resetDbState();
    const result = await recoverProjectStore({
      role: 'brain',
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(result.source.path).toBe(join(sqliteDir, `cleo.db.${backupId}`));
    expect(fingerprint(live)).toEqual(backedUp);
  });
});

describe('the global store backs up and restores (T13245)', () => {
  /** Row counts and checksums of the global brain and the nexus registry. */
  function globalFingerprint(file: string): Record<string, string> {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const out: Record<string, string> = {};
      for (const [table, cols] of [
        ['brain_observations', 'id, title'],
        ['nexus_project_registry', 'project_id, project_path'],
      ] as const) {
        const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY 1`).all();
        out[table] =
          `${rows.length}:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
      }
      return out;
    } finally {
      db.close();
    }
  }
  async function globalDb(): Promise<{ db: DatabaseSync; path: string }> {
    const h = await openDualScopeDb('global');
    const db = getDualScopeNativeDb(h);
    return { db, path: String(db.location()) };
  }
  function globalObserve(db: DatabaseSync, id: string): void {
    db.prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, content_hash, source_type, quality_score, created_at)
       VALUES (?, 'context', ?, 'global', ?, 'agent', 0.7, '2026-10-05 10:00:00')`,
    ).run(id, `g ${id}`, `ghash-${id}`);
  }

  it('backup add --global, change, restore --scope global --id: the global store matches; the replaced one is kept', async () => {
    const { db, path: gpath } = await globalDb();
    globalObserve(db, 'G-keep-1');
    const backup = await createGlobalBackup({ type: 'snapshot' });
    expect(backup.files).toEqual(['cleo.db']);
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    const backedUp = globalFingerprint(join(gdir, `cleo.db.${backup.backupId}`));
    expect(globalFingerprint(gpath)).toEqual(backedUp);
    expect(listGlobalBackups()[0]).toMatchObject({
      backupId: backup.backupId,
      scope: 'global',
      contains: ['global'],
    });

    globalObserve(db, 'G-after-2');
    const changed = globalFingerprint(gpath);
    expect(changed).not.toEqual(backedUp);
    resetDbState();

    const r = await restoreBackupById(env.tempDir, {
      backupId: backup.backupId,
      scope: 'global',
      cwd: env.tempDir,
    });
    expect(r.store).toMatchObject({ restored: true, scope: 'global', target: gpath });
    expect(r.store?.undo).toMatch(/^cleo restore backup --scope global --id pre-restore-/);
    expect(globalFingerprint(gpath)).toEqual(backedUp);
    const kept = r.store?.kept;
    expect(kept && globalFingerprint(kept.path)).toEqual(changed);
    // The project store was not touched.
    expect(existsSync(live)).toBe(true);
  });

  it('a project snapshot is never placed as the global store, nor the reverse', async () => {
    const { path: gpath } = await globalDb();
    const projectSnap = sessionSnapshot('tasks', '20261005-100000');
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    mkdirSync(gdir, { recursive: true });
    const misplaced = join(gdir, 'project-copy.db');
    copyFileSync(projectSnap, misplaced);
    resetDbState();
    await expect(
      restoreStoreSnapshot({
        scope: 'global',
        projectRoot: env.tempDir,
        snapshot: misplaced,
        cwd: env.tempDir,
      }),
    ).rejects.toThrow(/E_RESTORE_SNAPSHOT_SHAPE/);
    const backup = await createGlobalBackup({ type: 'snapshot' });
    const globalCopy = join(sqliteDir, 'global-copy.db');
    copyFileSync(join(gdir, `cleo.db.${backup.backupId}`), globalCopy);
    resetDbState();
    await expect(
      restoreStoreSnapshot({ projectRoot: env.tempDir, snapshot: globalCopy, cwd: env.tempDir }),
    ).rejects.toThrow(/E_RESTORE_SNAPSHOT_SHAPE/);
  });

  it('concurrent session ends take exactly ONE global backup (single-flight, T13286)', async () => {
    const { path: gpath } = await globalDb();
    const admit = async () => ({ release: async () => {} });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => autoGlobalBackup(new Date(), { admit })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    expect(readdirSync(gdir).filter((f) => f.startsWith('cleo.db.auto-'))).toHaveLength(1);
  });

  it('concurrent session ends in separate PROCESSES take exactly one global backup (T13286)', async () => {
    const { path: gpath } = await globalDb();
    resetDbState();
    const dist = join(import.meta.dirname, '../../../dist/system/backup.js');
    const script = `const { autoGlobalBackup } = await import(${JSON.stringify(`file://${dist}`)});
      const id = await autoGlobalBackup(new Date(), { admit: async () => ({ release: async () => {} }) });
      process.stdout.write(String(id));`;
    const runs = await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise<string>((ok) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
              env: { ...process.env },
              stdio: ['ignore', 'pipe', 'inherit'],
            });
            let out = '';
            child.stdout?.on('data', (d: Buffer) => {
              out += d.toString();
            });
            child.on('close', () => ok(out));
          }),
      ),
    );
    expect(runs.filter((r) => r !== 'null' && r !== '')).toHaveLength(1);
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    expect(readdirSync(gdir).filter((f) => f.startsWith('cleo.db.auto-'))).toHaveLength(1);
  });

  it('a global restore refused as busy tells the operator to stop every cleo process', async () => {
    const { path: gpath } = await globalDb();
    const backup = await createGlobalBackup({ type: 'snapshot' });
    resetDbState();
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.prepare('SELECT 1').get();
         process.stdout.write('ready\\n');
         setInterval(() => db.prepare('SELECT 1').get(), 50);`,
        gpath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((ok) => holder.stdout?.once('data', () => ok()));
      await expect(
        restoreBackupById(env.tempDir, {
          backupId: backup.backupId,
          scope: 'global',
          cwd: env.tempDir,
        }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/E_RESTORE_STORE_BUSY/),
        fix: expect.stringMatching(/stop ALL of them/),
      });
    } finally {
      holder.kill();
    }
  });

  it('a lock whose holder is blocked in a long copy (no refresh for 90 s) is not stolen (T13293)', async () => {
    const { path: gpath } = await globalDb();
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    mkdirSync(gdir, { recursive: true });
    // A holder blocked in a synchronous VACUUM INTO cannot refresh the
    // lock's mtime: the lock looks 90 s old.
    mkdirSync(`${gdir}.lock`);
    const old = new Date(Date.now() - 90_000);
    utimesSync(`${gdir}.lock`, old, old);
    expect(GLOBAL_BACKUP_LOCK_STALE_MS).toBeGreaterThanOrEqual(600_000);
    const id = await autoGlobalBackup(new Date(), {
      admit: async () => ({ release: async () => {} }),
    });
    expect(id).toBeNull();
    expect(readdirSync(gdir).filter((f) => f.startsWith('cleo.db.auto-'))).toEqual([]);
  });

  it('a deferred db-heavy admission takes no global backup', async () => {
    const { path: gpath } = await globalDb();
    expect(await autoGlobalBackup(new Date(), { admit: async () => null })).toBeNull();
    const gdir = join(dirname(gpath), 'backups', 'sqlite');
    const autos = existsSync(gdir)
      ? readdirSync(gdir).filter((f) => f.startsWith('cleo.db.auto-'))
      : [];
    expect(autos).toEqual([]);
  });

  it('the session-end global backup is debounced to one per interval', async () => {
    await globalDb();
    const t0 = new Date();
    const first = await autoGlobalBackup(t0);
    expect(first).not.toBeNull();
    expect(await autoGlobalBackup(new Date(t0.getTime() + 60_000))).toBeNull();
    const later = await autoGlobalBackup(
      new Date(t0.getTime() + AUTO_GLOBAL_BACKUP_INTERVAL_MS + 1),
    );
    // Same-second ids would collide; a later one is only taken past the interval.
    expect(later === null || later !== first).toBe(true);
  });
});
