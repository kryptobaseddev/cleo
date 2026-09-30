/**
 * Import and restore never mint import-time uids (T12806; T12341 spec §5.1).
 *
 * A task an import or a restore writes existed before the write: it carries
 * the uid its source had, or its uid is derived by the deterministic recipe
 * from its own key and birth. An overwrite import that replaces a task with a
 * different one clears the old identity, and refuses once identity is shared.
 *
 * @task T12806
 * @epic T12323
 */

// Row uids are opt-in (T12341); these tests exercise them.
process.env.CLEO_ROW_UID_FILL = '1';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importTasks } from '../../admin/import.js';
import { exportSnapshot, importSnapshot } from '../../snapshot/index.js';
import { mintedRowUid, ROW_IDENTITY_SYNCED_KEY } from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const identity = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT uid, birth_fp AS fp FROM tasks_tasks WHERE id = ?').get(id) as
    | { uid: string | null; fp: string | null }
    | undefined;

/** The 48-bit timestamp a v7-layout uid carries, in ms. */
const uidMs = (uid: string) => Number.parseInt(uid.replaceAll('-', '').slice(0, 12), 16);

describe('import and restore keep row identity (T12806)', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Made by this build',
        type: 'task',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    db = native;
    // An older build's row: no uid; this build derives it deterministically.
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T002', 'Backfilled', 'pending', 'medium', 'task', '2026-08-01 09:00:00')",
    ).run();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function deleteAndRestore(strip: boolean): Promise<void> {
    const snapshot = await exportSnapshot(env.tempDir);
    if (strip) {
      for (const t of snapshot.tasks) {
        delete t.uid;
        delete t.birthFp;
      }
    }
    await env.accessor.transaction(async (tx) => {
      await tx.removeSingleTask('T001');
      await tx.removeSingleTask('T002');
    });
    expect(identity(db, 'T001')).toBeUndefined();
    await importSnapshot(snapshot, env.tempDir);
  }

  it('a restore brings back the pre-delete uid and fingerprint (snapshot carries them)', async () => {
    const before = { t1: identity(db, 'T001'), t2: identity(db, 'T002') };
    expect(before.t1?.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(before.t2?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T002'], '2026-08-01 09:00:00'),
    );
    await deleteAndRestore(false);
    expect(identity(db, 'T001')).toEqual(before.t1);
    expect(identity(db, 'T002')).toEqual(before.t2);
  });

  it('a restore from a snapshot without uids derives them; never an import-time v7', async () => {
    const before = identity(db, 'T002');
    const startedAt = Date.now();
    await deleteAndRestore(true);
    // The backfilled row gets exactly its pre-delete (deterministic) uid back.
    expect(identity(db, 'T002')).toEqual(before);
    // The random-v7 row cannot get its random uid back, but its new uid is the
    // deterministic recipe: its timestamp is the task's birth, not now.
    const restored = identity(db, 'T001');
    expect(restored?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T001'], '2026-09-01T10:00:00.000Z'),
    );
    expect(uidMs(restored?.uid ?? '')).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(uidMs(restored?.uid ?? '')).toBeLessThan(startedAt);
  });

  it('a carried uid another row already holds is not reused (derived instead)', async () => {
    const snapshot = await exportSnapshot(env.tempDir);
    const t2 = snapshot.tasks.find((t) => t.id === 'T002');
    if (!t2) throw new Error('no T002');
    // A second copy of T002's row under a new id, carrying the same uid.
    snapshot.tasks = [{ ...t2, id: 'T777' }];
    await importSnapshot(snapshot, env.tempDir);
    expect(identity(db, 'T777')?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T777'], '2026-08-01 09:00:00'),
    );
    expect(identity(db, 'T002')?.uid).toBe(t2.uid);
  });

  it('a file import derives uids; an overwrite clears the replaced identity, or refuses once shared', async () => {
    const file = join(env.tempDir, 'import.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          {
            id: 'T500',
            title: 'Imported',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-07-01T08:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Different work under T002',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-07-02T08:00:00.000Z',
          },
        ],
      }),
    );
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    expect(identity(db, 'T500')?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T500'], '2026-07-01T08:00:00.000Z'),
    );
    // T002 is now a different task: the old identity is gone (filled at the next open).
    expect(identity(db, 'T002')).toEqual({ uid: null, fp: null });

    db.prepare('INSERT INTO tasks_row_identity_meta (key, value) VALUES (?, ?)').run(
      ROW_IDENTITY_SYNCED_KEY,
      '{"first":"send"}',
    );
    db.exec("UPDATE tasks_tasks SET uid = 'shared-uid', birth_fp = 'shared-fp' WHERE id = 'T001'");
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [{ id: 'T001', title: 'Overwrite', status: 'pending', priority: 'medium' }],
      }),
    );
    await expect(importTasks(env.tempDir, { file, onDuplicate: 'overwrite' })).rejects.toThrow(
      /shared with other devices/,
    );
    expect(identity(db, 'T001')).toEqual({ uid: 'shared-uid', fp: 'shared-fp' });
  });
});
