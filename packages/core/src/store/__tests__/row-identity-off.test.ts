/**
 * Row uids are OPT-IN (T12341 review round 2, item 7): without
 * CLEO_ROW_UID_FILL=1 the open pass does not run, no per-connection trigger
 * is installed, and new rows get no uid.
 *
 * @task T12341
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rowIdentityDoctorCheck } from '../../doctor/row-identity.js';
import { prepareRowIdentity } from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

describe('row uids are off by default', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    delete process.env.CLEO_ROW_UID_FILL;
    env = await createTestDb();
    await seedTasks(env.accessor, [{ id: 'T001', title: 'Root', type: 'task', labels: ['a'] }]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('fills nothing, installs no trigger, and mints no uid on insert', () => {
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('no native handle');
    expect(db.prepare("SELECT uid, birth_fp FROM tasks_tasks WHERE id = 'T001'").get()).toEqual({
      uid: null,
      birth_fp: null,
    });
    expect(db.prepare("SELECT uid FROM tasks_task_labels WHERE task_id = 'T001'").get()).toEqual({
      uid: null,
    });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'trg_row_uid_%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(prepareRowIdentity(db, 'project')).toBeNull();
    expect(rowIdentityDoctorCheck(env.tempDir).message).toContain('row uids are off');
  });

  it('guarded writes work on a store whose uid migration was stamped without its tables (live cleocode after 9.25)', async () => {
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('no native handle');
    // The live state: an early alias table (no displaced_hlc / entity_birth_fp),
    // no uid-alias, graveyard, meta or quarantine table, no graveyard trigger.
    db.exec(`DROP TRIGGER IF EXISTS trg_tasks_ac_uid_graveyard;
      DROP TABLE tasks_uid_aliases; DROP TABLE tasks_ac_uid_graveyard;
      DROP TABLE tasks_row_identity_meta; DROP TABLE tasks_identity_quarantine;
      ALTER TABLE tasks_display_id_aliases DROP COLUMN displaced_hlc;
      ALTER TABLE tasks_display_id_aliases DROP COLUMN entity_birth_fp;`);
    const task = await env.accessor.loadSingleTask('T001');
    await env.accessor.updateTaskFields(
      'T001',
      { title: 'Root, edited' },
      { expectedUpdatedAt: task?.updatedAt ?? task?.createdAt ?? '' },
    );
    expect(db.prepare("SELECT title FROM tasks_tasks WHERE id = 'T001'").get()).toEqual({
      title: 'Root, edited',
    });
  });
});
