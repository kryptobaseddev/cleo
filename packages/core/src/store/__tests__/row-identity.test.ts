/**
 * Row uids (T12341): the uid recipes, the birth fingerprint, and the fill
 * through the real open path.
 *
 * Spec: `cleo docs fetch t12341-uid-scheme` (§5 recipes, §6 filling and
 * collisions, §8 acceptance criteria and stale evidence).
 *
 * @task T12341
 * @epic T12323
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rowIdentityDoctorCheck } from '../../doctor/row-identity.js';
import { computeAcCoverage } from '../../tasks/ac-coverage-gate.js';
import { applyAcPlan, planAcUpdate } from '../../tasks/ac-table.js';
import { rekeyRowUid } from '../display-id-alias.js';
import {
  birthFingerprint,
  classifyUidMatch,
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
  it('encodes inputs without ambiguity, numbers canonically', () => {
    const enc = (v: Parameters<typeof encodeUidInputs>[0]) => encodeUidInputs(v).toString('hex');
    expect(enc(['ab', 'c'])).not.toBe(enc(['a', 'bc']));
    expect(enc([null])).not.toBe(enc(['']));
    expect(enc([1])).not.toBe(enc(['1']));
    expect(enc([1])).toBe(enc([1n]));
    expect(enc([3])).toBe(enc([3.0]));
    expect(enc([0.1 + 0.2])).toBe(enc([0.30000000000000004]));
    expect(enc([1.5])).not.toBe(enc(['1.5']));
  });

  it('mints a random UUIDv7 for a new row, and one carrying an imported row’s birth', () => {
    const a = mintRowUid();
    expect(a).toMatch(V7);
    expect(mintRowUid()).not.toBe(a);
    const born = Date.parse('2026-01-02T03:04:05.678Z');
    expect(Number.parseInt(mintRowUid(born).replaceAll('-', '').slice(0, 12), 16)).toBe(born);
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

  it('puts the owning row into the identity', () => {
    const birth = '2026-09-24 17:59:09';
    expect(
      mintedRowUid('project', 'tasks_task_acceptance_criteria', ['ac-1'], birth, [mintRowUid()]),
    ).not.toBe(
      mintedRowUid('project', 'tasks_task_acceptance_criteria', ['ac-1'], birth, [mintRowUid()]),
    );
  });

  it('makes UUIDv8 natural uids; the mirror recipe differs', () => {
    const uid = naturalRowUid('project', 'tasks_task_labels', ['u1', 'bug']);
    expect(uid).toMatch(V8);
    expect(naturalRowUid('project', 'tasks_task_labels', ['u1', 'bug'])).toBe(uid);
    expect(naturalRowUid('global', 'tasks_task_labels', ['u1', 'bug'])).not.toBe(uid);
    expect(naturalRowUid('project', 'tasks_task_labels', ['u1', 'bug'], 'natural-mirror')).not.toBe(
      uid,
    );
  });

  it('fingerprints the birth at full precision and flags an unknown one', () => {
    const fp = birthFingerprint('tasks_tasks', '2026-09-24 17:59:09', ['Title', 'task']);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(birthFingerprint('tasks_tasks', '2026-09-24T17:59:09.000Z', ['Title', 'task'])).not.toBe(
      fp,
    );
    expect(birthFingerprint('tasks_tasks', '2026-09-24 17:59:09', ['Other', 'task'])).not.toBe(fp);
    expect(birthFingerprint('tasks_tasks', null, [])).toBe(
      birthFingerprint('tasks_tasks', null, []),
    );
    expect(birthFingerprint('tasks_tasks', null, [])).not.toBe(
      birthFingerprint('tasks_tasks', 'garbage', []),
    );
  });

  it('classifies two rows with one uid by their birth fingerprints', () => {
    expect(classifyUidMatch('a', 'a')).toBe('same-row');
    expect(classifyUidMatch('a', 'b')).toBe('collision');
    expect(classifyUidMatch(null, 'b')).toBe('unknown');
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

  const one = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).get(...args) as Record<string, string | number | null> | undefined;
  const uidOf = (table: string, where: string, ...args: (string | number)[]) =>
    one(`SELECT uid FROM ${table} WHERE ${where}`, ...args)?.uid ?? null;

  /** A connection like an older build's: no uid functions, no TEMP triggers. */
  function olderBuild<T>(fn: (older: DatabaseSync) => T): T {
    const older = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      older.exec('PRAGMA foreign_keys = OFF');
      return fn(older);
    } finally {
      older.close();
    }
  }

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

  it('gives every row of every declared table its identity columns and a unique uid index', () => {
    for (const spec of ROW_IDENTITY.project) {
      const cols = (
        db.prepare('SELECT name FROM pragma_table_info(?)').all(spec.table) as { name: string }[]
      ).map((c) => c.name);
      for (const column of rowIdentityColumns('project', spec.table)) {
        expect(cols, `${spec.table}.${column}`).toContain(column);
      }
      const nulls = one(
        `SELECT count(*) AS n FROM "${spec.table}" WHERE uid IS NULL${spec.kind === 'minted' ? ' OR birth_fp IS NULL' : ''}`,
      );
      expect(nulls?.n, spec.table).toBe(0);
    }
    expect(
      one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_tasks_tasks_uid'"),
    ).toBeDefined();
    expect(uidOf('tasks_tasks', 'id = ?', 'T001')).toMatch(V7);
  });

  it('fills a row inserted without a uid on this connection, deterministically', () => {
    const born = '2026-09-20T08:00:00.123Z';
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T900', 'raw', 'pending', 'medium', 'task', ?)",
    ).run(born);
    expect(uidOf('tasks_tasks', 'id = ?', 'T900')).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T900'], born),
    );
    expect(one("SELECT birth_fp FROM tasks_tasks WHERE id = 'T900'")?.birth_fp).toBe(
      birthFingerprint('tasks_tasks', born, ['raw', 'task']),
    );
  });

  it('leaves an older build’s insert NULL until the next open, which fills the same values', () => {
    const born = '2026-09-20 08:00:00';
    olderBuild((older) =>
      older
        .prepare(
          "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T901', 'old build', 'pending', 'medium', 'task', ?)",
        )
        .run(born),
    );
    expect(uidOf('tasks_tasks', 'id = ?', 'T901')).toBeNull();
    const report = prepareRowIdentity(db, 'project');
    expect(report?.filled).toEqual({ tasks_tasks: 1 });
    expect(report?.fingerprinted).toEqual({ tasks_tasks: 1 });
    expect(uidOf('tasks_tasks', 'id = ?', 'T901')).toBe(
      mintedRowUid('project', 'tasks_tasks', ['T901'], born),
    );
    expect(fillRowUids(db, 'project')).toEqual({
      filled: {},
      refsFilled: {},
      fingerprinted: {},
      relinked: 0,
      unfilled: {},
    });
  });

  it('flags a row with an unknown birth instead of hiding it', () => {
    olderBuild((older) =>
      older.exec(
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T902', 'no birth', 'pending', 'medium', 'task', '2026-13-45 99:99:99')",
      ),
    );
    const report = prepareRowIdentity(db, 'project');
    expect(uidOf('tasks_tasks', 'id = ?', 'T902')?.startsWith('00000000-0000-7')).toBe(true);
    expect(report?.findings.unknownBirth).toEqual({ tasks_tasks: 1 });
  });

  it('keeps a task uid across an update and never rewrites kept labels or dependencies', async () => {
    const taskUid = uidOf('tasks_tasks', 'id = ?', 'T001');
    const rowidOf = (table: string, where: string) =>
      one(`SELECT rowid AS r FROM ${table} WHERE ${where}`)?.r;
    const alphaRowid = rowidOf('tasks_task_labels', "task_id = 'T001' AND label = 'alpha'");
    const depRowid = rowidOf('tasks_task_dependencies', "task_id = 'T002' AND depends_on = 'T003'");
    const labelUid = uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'alpha');
    expect(labelUid).toBe(naturalRowUid('project', 'tasks_task_labels', [taskUid ?? '', 'alpha']));
    const tasks = (await env.accessor.queryTasks({})).tasks;
    const root = tasks.find((t) => t.id === 'T001');
    const child = tasks.find((t) => t.id === 'T002');
    if (!root || !child) throw new Error('seed missing');
    await env.accessor.upsertSingleTask({
      ...root,
      title: 'Root renamed',
      labels: ['alpha', 'gamma'],
    });
    await env.accessor.upsertSingleTask({ ...child, title: 'Child renamed' });
    expect(uidOf('tasks_tasks', 'id = ?', 'T001')).toBe(taskUid);
    // A kept edge keeps its physical row: no delete + re-insert (spec §6.3).
    expect(rowidOf('tasks_task_labels', "task_id = 'T001' AND label = 'alpha'")).toBe(alphaRowid);
    expect(rowidOf('tasks_task_dependencies', "task_id = 'T002' AND depends_on = 'T003'")).toBe(
      depRowid,
    );
    expect(uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'beta')).toBeNull();
    expect(uidOf('tasks_task_labels', 'task_id = ? AND label = ?', 'T001', 'gamma')).toBe(
      naturalRowUid('project', 'tasks_task_labels', [taskUid ?? '', 'gamma']),
    );
  });

  it('gives a dependency edge a uid over both task uids, and a dangling one a flagged uid', () => {
    const a = uidOf('tasks_tasks', 'id = ?', 'T002');
    const b = uidOf('tasks_tasks', 'id = ?', 'T003');
    expect(uidOf('tasks_task_dependencies', 'task_id = ? AND depends_on = ?', 'T002', 'T003')).toBe(
      naturalRowUid('project', 'tasks_task_dependencies', [a ?? '', b ?? '']),
    );
    olderBuild((older) =>
      older.exec(
        "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T003', 'T999')",
      ),
    );
    const report = prepareRowIdentity(db, 'project');
    expect(uidOf('tasks_task_dependencies', 'task_id = ? AND depends_on = ?', 'T003', 'T999')).toBe(
      naturalRowUid('project', 'tasks_task_dependencies', [b ?? '', 'dangling:T999']),
    );
    expect(report?.findings.danglingRefs).toEqual({ tasks_task_dependencies: 1 });
  });

  it('canonicalises a symmetric relation stored both ways: one canonical uid, one mirror', () => {
    const u2 = uidOf('tasks_tasks', 'id = ?', 'T002') ?? '';
    const u3 = uidOf('tasks_tasks', 'id = ?', 'T003') ?? '';
    olderBuild((older) =>
      older.exec(`INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES
        ('T002', 'T003', 'related'), ('T003', 'T002', 'related'), ('T002', 'T003', 'blocks')`),
    );
    const report = prepareRowIdentity(db, 'project');
    const [lo, hi] = u2 < u3 ? [u2, u3] : [u3, u2];
    const loId = lo === u2 ? 'T002' : 'T003';
    const hiId = lo === u2 ? 'T003' : 'T002';
    const rel = (from: string, to: string, type: string) =>
      uidOf(
        'tasks_task_relations',
        'task_id = ? AND related_to = ? AND relation_type = ?',
        from,
        to,
        type,
      );
    expect(rel(loId, hiId, 'related')).toBe(
      naturalRowUid('project', 'tasks_task_relations', [lo, hi, 'related']),
    );
    expect(rel(hiId, loId, 'related')).toBe(
      naturalRowUid('project', 'tasks_task_relations', [lo, hi, 'related'], 'natural-mirror'),
    );
    // Directional types keep direction.
    expect(rel('T002', 'T003', 'blocks')).toBe(
      naturalRowUid('project', 'tasks_task_relations', [u2, u3, 'blocks']),
    );
    expect(report?.findings.mirrorEdges).toEqual({ tasks_task_relations: 1 });
  });

  it('never fails an insert whose uid would clash: the later row falls back to the mirror', () => {
    const u2 = uidOf('tasks_tasks', 'id = ?', 'T002') ?? '';
    const u3 = uidOf('tasks_tasks', 'id = ?', 'T003') ?? '';
    const [loId, hiId] = u2 < u3 ? ['T002', 'T003'] : ['T003', 'T002'];
    // The reversed row alone takes the canonical uid; the canonical-order row
    // inserted later must not fail on the unique index.
    db.prepare(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES (?, ?, 'related')",
    ).run(hiId, loId);
    db.prepare(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES (?, ?, 'related')",
    ).run(loId, hiId);
    const uids = (
      db.prepare("SELECT uid FROM tasks_task_relations WHERE relation_type = 'related'").all() as {
        uid: string;
      }[]
    ).map((r) => r.uid);
    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
    expect(uids.every((u) => V8.test(u))).toBe(true);
  });

  it('keeps an edited criterion’s uid and marks its evidence stale until re-verified', async () => {
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
    const binding = one(
      "SELECT uid, ac_uid, ac_text_hash, birth_fp FROM tasks_evidence_ac_bindings WHERE id = 'b-1'",
    );
    expect(binding?.uid).toMatch(V7);
    expect(binding?.ac_uid).toBe(first.uid);
    expect(binding?.ac_text_hash).toBe(first.contentHash);
    expect(binding?.birth_fp).toMatch(/^[0-9a-f]{32}$/);
    const fresh = await env.accessor.getAcBindings([first.id]);
    expect(fresh.map((b) => [b.id, b.stale ?? false])).toEqual([['b-1', false]]);

    // In-place edit of AC1 (replace-all path): the id changes, the uid does not,
    // and the evidence recorded for the old text is stale.
    await env.accessor.transaction(async (tx) => {
      const existing = await tx.getAcRows('T003');
      await applyAcPlan(
        tx,
        'T003',
        planAcUpdate('T003', existing, ['all tests pass', 'docs updated']),
      );
    });
    const [edited] = await env.accessor.getAcRows('T003');
    expect(edited?.id).not.toBe(first.id);
    expect(edited?.uid).toBe(first.uid);
    const bindings = await env.accessor.getAcBindings([edited?.id ?? '']);
    expect(bindings.map((b) => [b.id, b.acId, b.stale])).toEqual([['b-1', edited?.id, true]]);
    const coverage = await computeAcCoverage('T003', env.accessor);
    expect(coverage.ok).toBe(false);
    if (!coverage.ok) expect(coverage.unsatisfied.map((u) => u.acId)).toContain(edited?.id);
    const history = one(
      'SELECT ac_uid, previous_text FROM tasks_task_acceptance_criteria_history WHERE ac_id = ?',
      first.id,
    );
    expect(history).toEqual({ ac_uid: first.uid, previous_text: 'tests pass' });
  });

  it('a criterion deleted and re-created at the same ordinal inherits the uid, not the evidence', async () => {
    await env.accessor.transaction(async (tx) => {
      await applyAcPlan(tx, 'T003', planAcUpdate('T003', [], ['tests pass']));
    });
    const [first] = await env.accessor.getAcRows('T003');
    await env.accessor.transaction((tx) =>
      tx.insertAcBindings([
        { id: 'b-2', acId: first?.id ?? '', evidenceAtomId: 'tool:test', bindingType: 'direct' },
      ]),
    );
    await env.accessor.transaction(async (tx) => {
      await applyAcPlan(tx, 'T003', planAcUpdate('T003', await tx.getAcRows('T003'), []));
    });
    await env.accessor.transaction(async (tx) => {
      await applyAcPlan(tx, 'T003', planAcUpdate('T003', [], ['a different criterion']));
    });
    const [replacement] = await env.accessor.getAcRows('T003');
    const bindings = await env.accessor.getAcBindings([replacement?.id ?? '']);
    for (const b of bindings) expect(b.stale).toBe(true);
    const coverage = await computeAcCoverage('T003', env.accessor);
    expect(coverage.ok).toBe(false);
  });

  it('re-links a criterion an older build deleted and recreated without its uid', async () => {
    await env.accessor.transaction(async (tx) => {
      await applyAcPlan(tx, 'T003', planAcUpdate('T003', [], ['tests pass', 'docs updated']));
    });
    const before = await env.accessor.getAcRows('T003');
    olderBuild((older) => {
      // An older build's replace-all: delete, then insert without a uid.
      older.exec("DELETE FROM tasks_task_acceptance_criteria WHERE task_id = 'T003'");
      older.exec(`INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key)
        VALUES ('old-a', 'T003', 1, 'all tests pass', 'text', 'text:1:a'),
               ('old-b', 'T003', 2, 'docs updated', 'text', 'text:2:b')`);
    });
    expect(
      one("SELECT count(*) AS n FROM tasks_ac_uid_graveyard WHERE task_id = 'T003'")?.n,
    ).toBeGreaterThanOrEqual(2);
    const report = prepareRowIdentity(db, 'project');
    expect(report?.relinked).toBe(2);
    const after = await env.accessor.getAcRows('T003');
    expect(after.map((r) => r.uid)).toEqual(before.map((r) => r.uid));
    expect(one('SELECT count(*) AS n FROM tasks_ac_uid_graveyard')?.n).toBe(0);
  });

  it('cleo doctor reports unfilled rows and flagged rows, read-only', () => {
    expect(rowIdentityDoctorCheck(env.tempDir).status).toBe('ok');
    olderBuild((older) => {
      older.exec(
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T903', 'old', 'pending', 'medium', 'task', '2026-09-20 08:00:00')",
      );
      older.exec(
        "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T003', 'T998')",
      );
    });
    const before = rowIdentityDoctorCheck(env.tempDir);
    expect(before.status).toBe('warning');
    expect(before.message).toContain('tasks_tasks (1)');
    expect(before.message).toContain('rows referencing a missing row');
    prepareRowIdentity(db, 'project');
    const after = rowIdentityDoctorCheck(env.tempDir);
    expect(after.message).not.toContain('filled at the next open');
    expect(after.message).toContain('tasks_task_dependencies (1)');
  });

  it('re-creates a missing uid index (a migration stamped without its index DDL)', () => {
    db.exec('DROP INDEX uq_tasks_tasks_uid');
    const healed = ensureRowIdentitySchema(db, 'project');
    expect(healed).toHaveLength(1);
    expect(healed[0]).toContain('uq_tasks_tasks_uid');
    expect(ensureRowIdentitySchema(db, 'project')).toEqual([]);
  });
});

describe('identity versus collision across stores (spec §3)', () => {
  let env: TestDbEnv;
  const extra: string[] = [];

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [{ id: 'T001', title: 'Seed', type: 'task' }]);
  });

  afterEach(async () => {
    for (const f of extra.splice(0)) rmSync(f, { force: true });
    await env.cleanup();
  });

  /** Another device's store: a copy of this one's file, opened by this build. */
  function copyStore(name: string): DatabaseSync {
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    const path = join(env.tempDir, `${name}.db`);
    native.exec(`VACUUM INTO '${path}'`);
    extra.push(path);
    return new DatabaseSync(path);
  }

  /** An older build on that device writes T100 (no uid, second-precision birth); this build opens. */
  function olderBuildWritesT100(db: DatabaseSync, title: string): void {
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T100', ?, 'pending', 'medium', 'task', '2026-09-28 12:00:00')",
    ).run(title);
    prepareRowIdentity(db, 'project');
  }

  const identity = (db: DatabaseSync, id: string) =>
    db.prepare('SELECT uid, birth_fp AS fp FROM tasks_tasks WHERE id = ?').get(id) as {
      uid: string;
      fp: string;
    };

  it('a copied store keeps identical uids and fingerprints', () => {
    const a = copyStore('a');
    const b = copyStore('b');
    try {
      olderBuildWritesT100(a, 'The same row');
      // The copy is taken after T100 exists on "a": one history, two devices.
      a.exec(`VACUUM INTO '${join(env.tempDir, 'a2.db')}'`);
      extra.push(join(env.tempDir, 'a2.db'));
      const a2 = new DatabaseSync(join(env.tempDir, 'a2.db'));
      try {
        prepareRowIdentity(a2, 'project');
        expect(identity(a2, 'T100')).toEqual(identity(a, 'T100'));
        expect(identity(a2, 'T001')).toEqual(identity(b, 'T001'));
        expect(classifyUidMatch(identity(a, 'T100').fp, identity(a2, 'T100').fp)).toBe('same-row');
      } finally {
        a2.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });

  it('two stores minting T100 in the same second get one uid, flagged as a collision and re-keyed', () => {
    const a = copyStore('a');
    const b = copyStore('b');
    try {
      olderBuildWritesT100(a, 'Work done on device A');
      olderBuildWritesT100(b, 'Different work on device B');
      const ia = identity(a, 'T100');
      const ib = identity(b, 'T100');
      expect(ia.uid).toBe(ib.uid);
      expect(classifyUidMatch(ia.fp, ib.fp)).toBe('collision');

      // The authority re-keys the loser (greater fingerprint); the old uid
      // stays resolvable through its fingerprint.
      const [loserDb, loser] = ia.fp > ib.fp ? [a, ia] : [b, ib];
      const receipt = rekeyRowUid(loserDb, 'tasks_tasks', loser.uid, { origin: 'device' });
      expect(receipt.newUid).toMatch(V7);
      expect(identity(loserDb, 'T100')).toEqual({ uid: receipt.newUid, fp: loser.fp });
      expect(
        loserDb
          .prepare(
            'SELECT new_uid FROM tasks_uid_aliases WHERE entity_table = ? AND old_uid = ? AND old_birth_fp = ?',
          )
          .get('tasks_tasks', loser.uid, loser.fp),
      ).toEqual({ new_uid: receipt.newUid });
    } finally {
      a.close();
      b.close();
    }
  });
});
