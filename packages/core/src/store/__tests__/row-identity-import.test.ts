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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importTasks } from '../../admin/import.js';
import { importFromPackage } from '../../admin/import-tasks.js';
import { exportSnapshot, importSnapshot } from '../../snapshot/index.js';
import { coreTaskImport } from '../../tasks/task-import.js';
import { buildExportPackage } from '../export.js';
import {
  fillRowUids,
  mintedRowUid,
  naturalRowUid,
  ROW_IDENTITY_SYNCED_KEY,
} from '../row-identity.js';
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

  it('the same row (uid + fingerprint) already here under another id is skipped and reported, never duplicated (review 4)', async () => {
    const snapshot = await exportSnapshot(env.tempDir);
    // A re-mint moved T001 to T900 since the snapshot was taken (same uid and fingerprint).
    db.exec("UPDATE tasks_tasks SET id = 'T900' WHERE id = 'T001'");
    const result = await importSnapshot(snapshot, env.tempDir);
    expect(identity(db, 'T001')).toBeUndefined();
    expect(
      db.prepare("SELECT count(*) AS n FROM tasks_tasks WHERE title = 'Made by this build'").get(),
    ).toEqual({
      n: 1,
    });
    expect(result.conflicts.join('\n')).toContain('T001: already present as T900');
  });

  it('a carried uid another row holds with ANOTHER fingerprint is not reused (derived instead)', async () => {
    const snapshot = await exportSnapshot(env.tempDir);
    const t2 = snapshot.tasks.find((t) => t.id === 'T002');
    if (!t2) throw new Error('no T002');
    snapshot.tasks = [{ ...t2, id: 'T777', birthFp: 'another-fingerprint' }];
    await importSnapshot(snapshot, env.tempDir);
    expect(identity(db, 'T777')?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T777'], '2026-08-01 09:00:00'),
    );
    expect(identity(db, 'T002')?.uid).toBe(t2.uid);
  });

  it('a carried uid that was re-keyed here follows its alias; a held one is not restored (review 5)', async () => {
    const snapshot = await exportSnapshot(env.tempDir);
    const t1 = snapshot.tasks.find((t) => t.id === 'T001');
    if (!t1?.uid || !t1.birthFp) throw new Error('no T001 identity');
    db.prepare(
      "INSERT INTO tasks_uid_aliases (uid, entity_table, old_uid, old_birth_fp, new_uid, created_at) VALUES ('a1', 'tasks_tasks', ?, ?, '0199aaaa-0000-7000-8000-000000000001', '2026')",
    ).run(t1.uid, t1.birthFp);
    await env.accessor.transaction(async (tx) => tx.removeSingleTask('T001'));
    await importSnapshot({ ...snapshot, tasks: [t1] }, env.tempDir);
    expect(identity(db, 'T001')?.uid).toBe('0199aaaa-0000-7000-8000-000000000001');

    // Held in the identity quarantine: the row is on its way; not restored twice.
    const t2 = snapshot.tasks.find((t) => t.id === 'T002');
    if (!t2?.uid || !t2.birthFp) throw new Error('no T002 identity');
    await env.accessor.transaction(async (tx) => tx.removeSingleTask('T002'));
    db.prepare(
      "INSERT INTO tasks_identity_quarantine (entity_table, uid, birth_fp, reason, row_json, created_at) VALUES ('tasks_tasks', ?, ?, 'display-id-collision', '{}', '2026')",
    ).run(t2.uid, t2.birthFp);
    const result = await importSnapshot({ ...snapshot, tasks: [t2] }, env.tempDir);
    expect(identity(db, 'T002')).toBeUndefined();
    expect(result.conflicts.join('\n')).toContain('held for sync');
  });

  it('a snapshot task that is a DIFFERENT row under a local id is reported, never overwritten (review 6)', async () => {
    const snapshot = await exportSnapshot(env.tempDir);
    const t1 = snapshot.tasks.find((t) => t.id === 'T001');
    if (!t1) throw new Error('no T001');
    const newer = {
      ...t1,
      uid: '0199bbbb-0000-7000-8000-000000000001',
      title: 'Other work',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    const result = await importSnapshot({ ...snapshot, tasks: [newer] }, env.tempDir);
    expect(db.prepare("SELECT title FROM tasks_tasks WHERE id = 'T001'").get()).toEqual({
      title: 'Made by this build',
    });
    expect(result.conflicts.join('\n')).toContain('is a different row');
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
    db.prepare("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T002', 'bug')").run();
    expect(
      db.prepare("SELECT uid FROM tasks_task_labels WHERE task_id = 'T002'").get(),
    ).not.toEqual({ uid: null });
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    expect(identity(db, 'T500')?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T500'], '2026-07-01T08:00:00.000Z'),
    );
    // T002 is now a different task: the old identity is gone (filled at the next open),
    // and so are the identities derived from it (review 3).
    expect(identity(db, 'T002')).toEqual({ uid: null, fp: null });
    for (const row of db
      .prepare("SELECT uid FROM tasks_task_labels WHERE task_id = 'T002'")
      .all()) {
      expect(row).toEqual({ uid: null });
    }

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

describe('overwrite and file imports (T12806 review)', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'A',
        type: 'task',
        createdAt: '2026-09-01T10:00:00.000Z',
        labels: ['x'],
      },
    ]);
    db = getNativeTasksDb(env.tempDir) as DatabaseSync;
  });

  afterEach(async () => {
    process.env.CLEO_ROW_UID_FILL = '1';
    await env.cleanup();
  });

  const labelUid = () =>
    (
      db.prepare("SELECT uid FROM tasks_task_labels WHERE task_id = 'T001'").get() as {
        uid: string | null;
      }
    ).uid;

  it('re-importing the SAME task with overwrite keeps its identity (review 2)', async () => {
    const before = identity(db, 'T001');
    const label = labelUid();
    const file = join(env.tempDir, 'imp.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          {
            id: 'T001',
            title: 'A',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-09-01T10:00:00.000Z',
            labels: ['x'],
          },
        ],
      }),
    );
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    fillRowUids(db, 'project');
    expect(identity(db, 'T001')).toEqual(before);
    expect(labelUid()).toBe(label);
  });

  it('overwriting with DIFFERENT work re-derives the task and its edges from the new row (review 3)', async () => {
    const file = join(env.tempDir, 'imp.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          {
            id: 'T001',
            title: 'B',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-09-02T10:00:00.000Z',
            labels: ['x'],
          },
        ],
      }),
    );
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    fillRowUids(db, 'project');
    const after = identity(db, 'T001');
    expect(after?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T001'], '2026-09-02T10:00:00.000Z'),
    );
    expect(labelUid()).toBe(naturalRowUid('project', 'tasks_task_labels', [after?.uid ?? '', 'x']));
  });

  it('coreTaskImport: new tasks derive their uid, a missing createdAt never becomes identity, overwrite clears or keeps', async () => {
    const file = join(env.tempDir, 'core.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          {
            id: 'T050',
            title: 'With birth',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
          { id: 'T051', title: 'No birth', status: 'pending', priority: 'medium', type: 'task' },
          {
            id: 'T001',
            title: 'Replaced',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-06-02T00:00:00.000Z',
          },
        ],
      }),
    );
    await coreTaskImport(env.tempDir, readFileSync(file, 'utf8'), true);
    expect(identity(db, 'T050')?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T050'], '2026-06-01T00:00:00.000Z'),
    );
    // No creation time in the source: the recipe's unknown birth (timestamp 0), never "now".
    const noBirth = identity(db, 'T051');
    expect(noBirth?.uid).toBe(mintedRowUid('project', 'tasks_tasks', ['T051'], null));
    expect(uidMs(noBirth?.uid ?? '')).toBe(0);
    expect(identity(db, 'T001')).toEqual({ uid: null, fp: null });
  });

  it('importFromPackage: remapped tasks derive their uid from their new id and their own birth', async () => {
    const pkg = buildExportPackage(
      [
        {
          id: 'T001',
          title: 'Packaged',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          description: '',
          createdAt: '2026-05-01T00:00:00.000Z',
        } as Task,
      ],
      { mode: 'single', rootTaskIds: ['T001'], includeChildren: false },
    );
    const result = await importFromPackage(pkg, { cwd: env.tempDir, onConflict: 'duplicate' });
    const newId = Object.values(result.idRemap ?? {})[0] as string;
    expect(newId).toBeDefined();
    expect(identity(db, newId)?.uid).toBe(
      mintedRowUid('project', 'tasks_tasks', [newId], '2026-05-01T00:00:00.000Z'),
    );
  });
});

describe('row uids off (T12806 review 1)', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;

  beforeEach(async () => {
    delete process.env.CLEO_ROW_UID_FILL;
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'A', type: 'task', createdAt: '2026-09-01T10:00:00.000Z' },
    ]);
    db = getNativeTasksDb(env.tempDir) as DatabaseSync;
  });

  afterEach(async () => {
    process.env.CLEO_ROW_UID_FILL = '1';
    await env.cleanup();
  });

  it('snapshots carry no identity; restores and overwrites write none and refuse nothing', async () => {
    // Values an earlier flag-on run left behind.
    db.exec(
      "UPDATE tasks_tasks SET uid = '0199cccc-0000-7000-8000-000000000001', birth_fp = 'fp-1' WHERE id = 'T001'",
    );
    const snap = await exportSnapshot(env.tempDir);
    expect(snap.tasks[0]).not.toHaveProperty('uid');
    expect(snap.tasks[0]).not.toHaveProperty('birthFp');
    await env.accessor.transaction(async (tx) => tx.removeSingleTask('T001'));
    await importSnapshot(snap, env.tempDir);
    expect(identity(db, 'T001')).toEqual({ uid: null, fp: null });

    db.exec(
      "UPDATE tasks_tasks SET uid = '0199cccc-0000-7000-8000-000000000001', birth_fp = 'fp-1' WHERE id = 'T001'",
    );
    db.prepare('INSERT INTO tasks_row_identity_meta (key, value) VALUES (?, ?)').run(
      ROW_IDENTITY_SYNCED_KEY,
      '{}',
    );
    const file = join(env.tempDir, 'imp.json');
    writeFileSync(
      file,
      JSON.stringify({
        tasks: [{ id: 'T001', title: 'B', status: 'pending', priority: 'medium' }],
      }),
    );
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    expect(identity(db, 'T001')).toEqual({
      uid: '0199cccc-0000-7000-8000-000000000001',
      fp: 'fp-1',
    });
  });
});
