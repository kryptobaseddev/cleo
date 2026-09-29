/**
 * Two stores created offline merge without uid collisions; display-id
 * collisions are re-minted deterministically and keep resolving through an
 * alias (T12341 AC2, AC3).
 *
 * The merge engine itself is T12344. The harness below does what the spec
 * (§7, §9) says it must: match rows by uid, resolve a display-id collision
 * with {@link collisionLoser}, re-mint or re-place the loser, and translate
 * edge endpoints through uids.
 *
 * @task T12341
 * @epic T12323
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateTaskDisplayId,
  collisionLoser,
  recordDisplayIdAlias,
  remintTaskDisplayId,
  resolveDisplayId,
} from '../display-id-alias.js';
import { naturalRowUid, prepareRowIdentity } from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

interface TaskRow {
  id: string;
  uid: string;
  title: string;
  type: string | null;
  parent_id: string | null;
  created_at: string;
}

const tasksOf = (db: DatabaseSync): TaskRow[] =>
  db
    .prepare('SELECT id, uid, title, type, parent_id, created_at FROM tasks_tasks ORDER BY id')
    .all() as unknown as TaskRow[];

const depsOf = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT d.uid AS uid, a.uid AS fromUid, b.uid AS toUid
         FROM tasks_task_dependencies d
         JOIN tasks_tasks a ON a.id = d.task_id
         JOIN tasks_tasks b ON b.id = d.depends_on`,
    )
    .all() as unknown as { uid: string; fromUid: string; toUid: string }[];

function addTask(db: DatabaseSync, id: string, title: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES (?, ?, 'pending', 'medium', 'task', ?)",
  ).run(id, title, createdAt);
}

function addDep(db: DatabaseSync, taskId: string, dependsOn: string): void {
  db.prepare('INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES (?, ?)').run(
    taskId,
    dependsOn,
  );
}

/** Merge every task and dependency of `remote` into `local`, keyed by uid. */
function mergeByUid(local: DatabaseSync, remote: DatabaseSync, origin: string): void {
  local.exec('BEGIN IMMEDIATE');
  try {
    const known = new Set(tasksOf(local).map((t) => t.uid));
    for (const incoming of tasksOf(remote)) {
      if (known.has(incoming.uid)) continue;
      const holder = local.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(incoming.id) as
        | { uid: string }
        | undefined;
      let id = incoming.id;
      if (holder) {
        if (collisionLoser(holder.uid, incoming.uid) === holder.uid) {
          remintTaskDisplayId(local, incoming.id, { reason: 'collision-remint', origin });
        } else {
          id = allocateTaskDisplayId(local);
          recordDisplayIdAlias(local, {
            table: 'tasks_tasks',
            displayId: incoming.id,
            entityUid: incoming.uid,
            reason: 'collision-remint',
            origin,
          });
        }
      }
      local
        .prepare(
          "INSERT INTO tasks_tasks (id, uid, title, status, priority, type, created_at) VALUES (?, ?, ?, 'pending', 'medium', ?, ?)",
        )
        .run(id, incoming.uid, incoming.title, incoming.type, incoming.created_at);
    }
    const knownEdges = new Set(depsOf(local).map((d) => d.uid));
    const idOf = local.prepare('SELECT id FROM tasks_tasks WHERE uid = ?');
    for (const edge of depsOf(remote)) {
      if (knownEdges.has(edge.uid)) continue;
      const from = idOf.get(edge.fromUid) as { id: string };
      const to = idOf.get(edge.toUid) as { id: string };
      addDep(local, from.id, to.id);
    }
    local.exec('COMMIT');
  } catch (error) {
    local.exec('ROLLBACK');
    throw error;
  }
}

describe('collisionLoser', () => {
  it('picks the greater uid, whichever side asks', () => {
    const older = '0192d0c0-0000-7000-8000-000000000000';
    const newer = '0192d0c0-0001-7000-8000-000000000000';
    expect(collisionLoser(older, newer)).toBe(newer);
    expect(collisionLoser(newer, older)).toBe(newer);
  });
});

describe('two stores created offline (AC2, AC3)', () => {
  let env: TestDbEnv;
  let a: DatabaseSync;
  let b: DatabaseSync;
  let bPath: string;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Shared epic', type: 'epic', createdAt: '2026-09-20T09:00:00.000Z' },
      {
        id: 'T002',
        title: 'Shared task',
        type: 'task',
        depends: ['T003'],
        createdAt: '2026-09-20T09:01:00.000Z',
      },
      { id: 'T003', title: 'Shared dep', type: 'task', createdAt: '2026-09-20T09:02:00.000Z' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    a = native;
    // Device B starts from a copy of the same history, then both go offline.
    bPath = join(env.tempDir, 'device-b.db');
    a.exec(`VACUUM INTO '${bPath}'`);
    b = new DatabaseSync(bPath);
    prepareRowIdentity(b, 'project');

    addTask(a, 'T004', 'alpha (A)', '2026-09-25T10:00:00.000Z');
    addDep(a, 'T004', 'T001');
    addTask(a, 'T005', 'delta (A)', '2026-09-25T12:00:00.000Z');
    addTask(b, 'T004', 'beta (B)', '2026-09-25T09:00:00.000Z');
    addTask(b, 'T005', 'gamma (B)', '2026-09-25T13:00:00.000Z');
    addDep(b, 'T005', 'T004');
  });

  afterEach(async () => {
    b.close();
    rmSync(bPath, { force: true });
    await env.cleanup();
  });

  it('gives shared history the same uids and new work distinct ones', () => {
    const byId = (rows: TaskRow[]) => new Map(rows.map((r) => [r.id, r.uid]));
    const ua = byId(tasksOf(a));
    const ub = byId(tasksOf(b));
    for (const id of ['T001', 'T002', 'T003']) expect(ua.get(id)).toBe(ub.get(id));
    for (const id of ['T004', 'T005']) expect(ua.get(id)).not.toBe(ub.get(id));
    const all = [...ua.values(), ...ub.values()];
    expect(new Set(all).size).toBe(3 + 2 + 2);
    const sharedEdge = depsOf(a).find((d) => d.fromUid === ua.get('T002'));
    expect(depsOf(b).map((d) => d.uid)).toContain(sharedEdge?.uid);
  });

  it('merges by uid, re-mints the later row of each collision, and aliases the old id', () => {
    const before = new Map(tasksOf(a).map((r) => [r.title, r.uid]));
    const remote = new Map(tasksOf(b).map((r) => [r.title, r.uid]));
    mergeByUid(a, b, 'device-b');

    const after = tasksOf(a);
    expect(after).toHaveLength(7);
    const byTitle = new Map(after.map((r) => [r.title, r]));
    // Every uid survived, none duplicated.
    for (const [title, uid] of [...before, ...remote]) expect(byTitle.get(title)?.uid).toBe(uid);

    // T004: B's row is older, so A's local row was re-minted and its edge followed it.
    expect(byTitle.get('beta (B)')?.id).toBe('T004');
    const alpha = byTitle.get('alpha (A)');
    expect(alpha?.id).not.toBe('T004');
    const alphaDep = a
      .prepare('SELECT depends_on, uid FROM tasks_task_dependencies WHERE task_id = ?')
      .get(alpha?.id ?? '') as { depends_on: string; uid: string };
    expect(alphaDep.depends_on).toBe('T001');
    expect(alphaDep.uid).toBe(
      naturalRowUid('project', 'tasks_task_dependencies', [
        alpha?.uid ?? '',
        before.get('Shared epic') ?? '',
      ]),
    );

    // T005: B's row is newer, so it came in under a new id; A's keeps T005.
    expect(byTitle.get('delta (A)')?.id).toBe('T005');
    const gamma = byTitle.get('gamma (B)');
    expect(gamma?.id).not.toBe('T005');
    // B's edge gamma → beta arrived translated through uids.
    expect(
      a
        .prepare('SELECT depends_on FROM tasks_task_dependencies WHERE task_id = ?')
        .get(gamma?.id ?? ''),
    ).toEqual({ depends_on: 'T004' });

    expect(a.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Both displaced ids still resolve: to their live holder AND the aliased row, so ambiguous.
    const t004 = resolveDisplayId(a, 'tasks_tasks', 'T004');
    expect(t004.status).toBe('ambiguous');
    expect(t004.status === 'ambiguous' && t004.claimants.map((c) => [c.via, c.currentId])).toEqual([
      ['live', 'T004'],
      ['alias', alpha?.id],
    ]);
    expect(resolveDisplayId(a, 'tasks_tasks', 'T001')).toEqual({
      status: 'resolved',
      claimant: { uid: before.get('Shared epic'), currentId: 'T001', via: 'live' },
    });
    expect(resolveDisplayId(a, 'tasks_tasks', 'T999')).toEqual({ status: 'none' });
  });

  it('resolves a re-minted id that nobody else holds to its row', () => {
    const uid = (
      a.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T003'").get() as { uid: string }
    ).uid;
    const receipt = remintTaskDisplayId(a, 'T003', { reason: 'manual' });
    expect(receipt.rewritten['tasks_task_dependencies.depends_on']).toBe(1);
    expect(resolveDisplayId(a, 'tasks_tasks', 'T003')).toEqual({
      status: 'resolved',
      claimant: { uid, currentId: receipt.newId, via: 'alias' },
    });
    expect(a.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
