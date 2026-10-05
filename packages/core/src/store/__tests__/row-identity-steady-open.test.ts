/**
 * T12341 C1 — a store the fill already completed opens without a fill pass.
 *
 * Before C1 every fill-on open re-ran the whole pass (NULL counts and findings
 * over every declared table) and loaded the chokepoint writers: ~170 ms and
 * ~15 MB per open on a 6k-task store. Now `rowIdentityFillPending` decides by
 * index probes; an empty answer means only this connection's uid triggers are
 * installed.
 *
 * The probes look for the rows themselves, never a rowid watermark: SQLite
 * reuses the max rowid after a delete (no AUTOINCREMENT), so a row an older
 * build inserts can land at or below any watermark. The second test makes
 * exactly that happen and asserts the row is still found and filled.
 *
 * @task T12341
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  missingRowIdentitySchema,
  prepareRowIdentity,
  rowIdentityFillPending,
} from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const STEADY = {
  filled: {},
  refsFilled: {},
  fingerprinted: {},
  relinked: 0,
  unfilled: {},
  findings: { unknownBirth: {}, danglingRefs: {}, mirrorEdges: {} },
  healed: [],
  refill: 'none',
};

describe('row identity on a completed store (T12341 C1)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    process.env.CLEO_ROW_UID_FILL = '1';
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Root', type: 'task', labels: ['a'] },
      { id: 'T002', title: 'Second', type: 'task' },
      { id: 'T003', title: 'Third', type: 'task' },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
    delete process.env.CLEO_ROW_UID_FILL;
  });

  function native(): DatabaseSync {
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('no native handle');
    return db;
  }

  it('a completed store reports nothing pending and the pass writes nothing', () => {
    const db = native();
    prepareRowIdentity(db, 'project'); // whatever the seed left (the recipe marker)
    expect(rowIdentityFillPending(db, 'project')).toEqual([]);
    expect(prepareRowIdentity(db, 'project')).toEqual(STEADY);
    // The fast path still arms this connection's uid triggers.
    const triggers = db
      .prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'trg_row_uid_%'")
      .get() as { n: number };
    expect(triggers.n).toBeGreaterThan(0);
  });

  it('finds an older-build row that reused the deleted max rowid, and fills it', () => {
    const db = native();
    prepareRowIdentity(db, 'project');
    expect(rowIdentityFillPending(db, 'project')).toEqual([]);
    const maxBefore = (db.prepare('SELECT max(rowid) AS r FROM tasks_tasks').get() as { r: number })
      .r;

    // An older build: a plain connection without this build's TEMP uid triggers.
    // Delete the max-rowid task, then insert a new one with no identity; SQLite
    // hands it the freed rowid.
    const old = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      old.exec(`
        CREATE TEMP TABLE clone AS SELECT * FROM main.tasks_tasks WHERE rowid = ${maxBefore};
        DELETE FROM main.tasks_tasks WHERE rowid = ${maxBefore};
        UPDATE clone SET id = 'T004', title = 'Inserted by an older build', uid = NULL, birth_fp = NULL;
        INSERT INTO main.tasks_tasks SELECT * FROM clone;
      `);
    } finally {
      old.close();
    }
    const inserted = db
      .prepare("SELECT rowid AS r, uid, birth_fp AS fp FROM tasks_tasks WHERE id = 'T004'")
      .get() as { r: number; uid: string | null; fp: string | null };
    expect(inserted.r).toBeLessThanOrEqual(maxBefore); // the reuse a watermark would miss
    expect(inserted.uid).toBeNull();

    expect(rowIdentityFillPending(db, 'project')).toEqual(
      expect.arrayContaining(['uid:tasks_tasks', 'birth_fp:tasks_tasks']),
    );
    const report = prepareRowIdentity(db, 'project');
    expect(report?.filled).toMatchObject({ tasks_tasks: 1 });
    const after = db
      .prepare("SELECT uid, birth_fp AS fp FROM tasks_tasks WHERE id = 'T004'")
      .get() as { uid: string | null; fp: string | null };
    expect(after.uid).not.toBeNull();
    expect(after.fp).not.toBeNull();
    expect(rowIdentityFillPending(db, 'project')).toEqual([]);
  });

  it('a stale recipe marker is pending work, and the next pass clears it', () => {
    const db = native();
    prepareRowIdentity(db, 'project');
    db.exec("DELETE FROM tasks_row_identity_meta WHERE key = 'row_identity_recipe'");
    expect(rowIdentityFillPending(db, 'project')).toContain('recipe');
    prepareRowIdentity(db, 'project');
    expect(rowIdentityFillPending(db, 'project')).toEqual([]);
  });

  it('the fill partial indexes exist only once the fill ran: a fill-off store keeps the migration schema', async () => {
    const indexes = (db: DatabaseSync) =>
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_birth_fp' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
    expect(indexes(native())).toContain('idx_tasks_tasks_birth_fp');
    delete process.env.CLEO_ROW_UID_FILL;
    const off = await createTestDb();
    try {
      await seedTasks(off.accessor, [{ id: 'T001', title: 'Off', type: 'task' }]);
      const db = getNativeTasksDb(off.tempDir);
      if (!db) throw new Error('no native handle');
      expect(indexes(db)).toEqual([]);
      // Nothing for a fill-off open to heal (the heal runs on every open while this is non-empty).
      expect(missingRowIdentitySchema(db)).toEqual([]);
      expect(rowIdentityFillPending(db, 'project')).toContain('schema');
    } finally {
      process.env.CLEO_ROW_UID_FILL = '1';
      await off.cleanup();
    }
  });
});
