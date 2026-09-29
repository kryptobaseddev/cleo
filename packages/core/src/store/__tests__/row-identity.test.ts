/**
 * Row uids (T12341): the uid recipes, and the fill through the real open path.
 *
 * Spec: `cleo docs fetch t12341-uid-scheme` (§5 recipes, §6 filling, §8 ACs).
 *
 * @task T12341
 * @epic T12323
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAcPlan, planAcUpdate } from '../../tasks/ac-table.js';
import {
  encodeUidInputs,
  ensureRowIdentitySchema,
  fillRowUids,
  mintedRowUid,
  mintRowUid,
  naturalRowUid,
  prepareRowIdentity,
  ROW_IDENTITY,
  rowIdentityColumns,
} from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uid recipes', () => {
  it('encodes inputs without ambiguity', () => {
    const enc = (v: Parameters<typeof encodeUidInputs>[0]) => encodeUidInputs(v).toString('hex');
    expect(enc(['ab', 'c'])).not.toBe(enc(['a', 'bc']));
    expect(enc([null])).not.toBe(enc(['']));
    expect(enc([1])).not.toBe(enc(['1']));
    expect(enc([1])).toBe(enc([1n]));
    expect(enc([1.5])).not.toBe(enc(['1.5']));
  });

  it('mints a random UUIDv7 for a new row', () => {
    const a = mintRowUid();
    expect(a).toMatch(V7);
    expect(mintRowUid()).not.toBe(a);
  });

  it('backfills a v7-layout uid that carries the birth and is stable', () => {
    const birth = '2026-09-24T17:59:09.740Z';
    const uid = mintedRowUid('project', 'tasks_tasks', ['T12188'], birth);
    expect(uid).toMatch(V7);
    expect(uid).toBe(mintedRowUid('project', 'tasks_tasks', ['T12188'], birth));
    expect(Number.parseInt(uid.replaceAll('-', '').slice(0, 12), 16)).toBe(Date.parse(birth));
  });

  it('gives a pure format difference of the birth the same uid', () => {
    expect(mintedRowUid('project', 'tasks_tasks', ['T1'], '2026-09-24 17:59:09')).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T1'], '2026-09-24T17:59:09.000Z'),
    );
  });

  it('separates the split-brain case: same display id, different birth', () => {
    expect(mintedRowUid('project', 'tasks_tasks', ['T12188'], '2026-09-14T10:00:00.000Z')).not.toBe(
      mintedRowUid('project', 'tasks_tasks', ['T12188'], '2026-09-14T10:00:00.001Z'),
    );
  });

  it('keeps an unparseable or missing birth stable, with a zero timestamp', () => {
    const odd = mintedRowUid('project', 'tasks_tasks', ['T1'], 'yesterday');
    expect(odd).toBe(mintedRowUid('project', 'tasks_tasks', ['T1'], 'yesterday'));
    expect(odd.startsWith('00000000-0000-7')).toBe(true);
    expect(mintedRowUid('project', 'tasks_tasks', ['T1'], null)).not.toBe(odd);
  });

  it('puts the owning row into the identity', () => {
    const birth = '2026-09-24 17:59:09';
    expect(
      mintedRowUid('project', 'tasks_task_acceptance_criteria', ['ac-1'], birth, [mintRowUid()]),
    ).not.toBe(
      mintedRowUid('project', 'tasks_task_acceptance_criteria', ['ac-1'], birth, [mintRowUid()]),
    );
  });

  it('makes a UUIDv8 natural uid that depends on scope, table and parts', () => {
    const uid = naturalRowUid('project', 'tasks_task_labels', ['u1', 'bug']);
    expect(uid).toMatch(V8);
    expect(naturalRowUid('project', 'tasks_task_labels', ['u1', 'bug'])).toBe(uid);
    expect(naturalRowUid('global', 'tasks_task_labels', ['u1', 'bug'])).not.toBe(uid);
    expect(naturalRowUid('project', 'tasks_task_dependencies', ['u1', 'bug'])).not.toBe(uid);
  });

  it('declares only single-key tables as reference targets', () => {
    for (const spec of ROW_IDENTITY.project) {
      for (const ref of [...(spec.owners ?? []), ...(spec.keyRefs ?? []), ...(spec.refs ?? [])]) {
        const target = ROW_IDENTITY.project.find((s) => s.table === ref.table);
        expect(target, `${spec.table}.${ref.column} → ${ref.table}`).toBeDefined();
        expect(target?.key).toHaveLength(1);
      }
    }
  });
});

describe('uid fill through the open path', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;

  const uidOf = (table: string, where: string, ...args: (string | number)[]) =>
    (db.prepare(`SELECT uid FROM ${table} WHERE ${where}`).get(...args) as { uid: string | null })
      ?.uid;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Root', type: 'epic', labels: ['alpha', 'beta'] },
      { id: 'T002', title: 'Child', parentId: 'T001', type: 'task', depends: ['T003'] },
      { id: 'T003', title: 'Other', type: 'task' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    db = native;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('gives every row of every declared table a uid and a unique index', () => {
    for (const spec of ROW_IDENTITY.project) {
      const cols = (
        db.prepare('SELECT name FROM pragma_table_info(?)').all(spec.table) as { name: string }[]
      ).map((c) => c.name);
      for (const column of rowIdentityColumns('project', spec.table)) {
        expect(cols, `${spec.table}.${column}`).toContain(column);
      }
      const nulls = db
        .prepare(`SELECT count(*) AS n FROM "${spec.table}" WHERE uid IS NULL`)
        .get() as {
        n: number;
      };
      expect(nulls.n, spec.table).toBe(0);
    }
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_tasks_tasks_uid'",
      )
      .get();
    expect(idx).toBeDefined();
    expect(uidOf('tasks_tasks', 'id = ?', 'T001')).toMatch(V7);
  });

  it('fills a row inserted without a uid on this connection, deterministically', () => {
    const born = '2026-09-20T08:00:00.123Z';
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, created_at) VALUES ('T900', 'raw', 'pending', 'medium', ?)",
    ).run(born);
    expect(uidOf('tasks_tasks', 'id = ?', 'T900')).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T900'], born),
    );
  });

  it('leaves an older build’s insert NULL until the next open, which fills the same value', () => {
    const born = '2026-09-20 08:00:00';
    const older = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      older
        .prepare(
          "INSERT INTO tasks_tasks (id, title, status, priority, created_at) VALUES ('T901', 'old build', 'pending', 'medium', ?)",
        )
        .run(born);
    } finally {
      older.close();
    }
    expect(uidOf('tasks_tasks', 'id = ?', 'T901')).toBeNull();
    const report = prepareRowIdentity(db, 'project');
    expect(report?.filled).toEqual({ tasks_tasks: 1 });
    expect(uidOf('tasks_tasks', 'id = ?', 'T901')).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T901'], born),
    );
    expect(fillRowUids(db, 'project')).toEqual({ filled: {}, refsFilled: {}, unfilled: {} });
  });

  it('keeps a task uid across an update and its label uids across the label rewrite', async () => {
    const taskUid = uidOf('tasks_tasks', 'id = ?', 'T001');
    const labelUid = uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'alpha');
    expect(labelUid).toBe(naturalRowUid('project', 'tasks_task_labels', [taskUid ?? '', 'alpha']));
    const [task] = (await env.accessor.queryTasks({})).tasks.filter((t) => t.id === 'T001');
    if (!task) throw new Error('T001 missing');
    await env.accessor.upsertSingleTask({
      ...task,
      title: 'Root renamed',
      labels: ['alpha', 'gamma'],
    });
    expect(uidOf('tasks_tasks', 'id = ?', 'T001')).toBe(taskUid);
    expect(uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'alpha')).toBe(labelUid);
    expect(uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'gamma')).toBe(
      naturalRowUid('project', 'tasks_task_labels', [taskUid ?? '', 'gamma']),
    );
  });

  it('gives a dependency edge a uid over both task uids', () => {
    const a = uidOf('tasks_tasks', 'id = ?', 'T002');
    const b = uidOf('tasks_tasks', 'id = ?', 'T003');
    expect(uidOf('tasks_task_dependencies', 'task_id = ? AND depends_on = ?', 'T002', 'T003')).toBe(
      naturalRowUid('project', 'tasks_task_dependencies', [a ?? '', b ?? '']),
    );
  });

  it('keeps an edited criterion’s uid, so its evidence binding still resolves', async () => {
    await env.accessor.transaction(async (tx) => {
      await applyAcPlan(tx, 'T003', planAcUpdate('T003', [], ['tests pass', 'docs updated']));
    });
    const [first] = await env.accessor.getAcRows('T003');
    if (!first?.uid) throw new Error('AC has no uid');
    await env.accessor.transaction((tx) =>
      tx.insertAcBindings([
        { id: 'b-1', acId: first.id, evidenceAtomId: 'tool:test', bindingType: 'direct' },
      ]),
    );
    expect(uidOf('tasks_evidence_ac_bindings', 'id = ?', 'b-1')).toMatch(V7);
    const bindingAcUid = db
      .prepare("SELECT ac_uid FROM tasks_evidence_ac_bindings WHERE id = 'b-1'")
      .get() as {
      ac_uid: string;
    };
    expect(bindingAcUid.ac_uid).toBe(first.uid);

    // An in-place edit of AC1 (replace-all path): the id changes, the uid does not.
    await env.accessor.transaction(async (tx) => {
      const existing = await tx.getAcRows('T003');
      await applyAcPlan(
        tx,
        'T003',
        planAcUpdate('T003', existing, ['all tests pass', 'docs updated']),
      );
    });
    const [edited, second] = await env.accessor.getAcRows('T003');
    expect(edited?.id).not.toBe(first.id);
    expect(edited?.uid).toBe(first.uid);
    expect(second?.text).toBe('docs updated');
    const bindings = await env.accessor.getAcBindings([edited?.id ?? '']);
    expect(bindings.map((b) => [b.id, b.acId])).toEqual([['b-1', edited?.id]]);
    const history = db
      .prepare(
        'SELECT ac_uid, previous_text FROM tasks_task_acceptance_criteria_history WHERE ac_id = ?',
      )
      .get(first.id) as { ac_uid: string; previous_text: string };
    expect(history).toEqual({ ac_uid: first.uid, previous_text: 'tests pass' });
  });

  it('re-creates a missing uid index (a migration stamped without its index DDL)', () => {
    db.exec('DROP INDEX uq_tasks_tasks_uid');
    const healed = ensureRowIdentitySchema(db, 'project');
    expect(healed).toHaveLength(1);
    expect(healed[0]).toContain('uq_tasks_tasks_uid');
    expect(ensureRowIdentitySchema(db, 'project')).toEqual([]);
  });
});
