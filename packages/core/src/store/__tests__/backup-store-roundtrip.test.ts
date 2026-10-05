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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackupById } from '../../system/backup.js';
import { recoverProjectStore } from '../backup-recover.js';
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
    const backedUp = fingerprint(join(sqliteDir, `tasks.db.${backupId}`));
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

  it.each(['tasks', 'brain'])(
    'backup recover %s restores the live cleo.db from the freshest valid session snapshot',
    async (role) => {
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
    },
  );

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
});
