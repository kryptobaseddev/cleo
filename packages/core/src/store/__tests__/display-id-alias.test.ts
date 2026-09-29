/**
 * Two stores created offline merge without uid collisions; display-id
 * collisions are re-minted by a single authority and converge (T12341 AC2,
 * AC3; spec §9).
 *
 * The merge engine itself is T12344. The harness below follows the contract
 * the spec gives it: rows match by uid; on a display-id collision every
 * replica agrees on the loser (the greater uid), only the replica that
 * ORIGINATED the loser re-mints it and publishes the op, and every other
 * replica keeps the loser under a provisional id until the op arrives.
 *
 * @task T12341
 * @epic T12323
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRemintOp,
  collisionLoser,
  PROVISIONAL_ID_PREFIX,
  provisionalDisplayId,
  REMINT_TAKEOVER_MS,
  type RemintOp,
  recordDisplayIdAlias,
  remintAuthority,
  remintTaskDisplayId,
  resolveDisplayId,
} from '../display-id-alias.js';
import { naturalRowUid, prepareRowIdentity } from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

interface TaskRow {
  id: string;
  uid: string;
  birth_fp: string;
  title: string;
  type: string | null;
  created_at: string;
}

/** One device: its store, its replica name, and the rows it originated. */
interface Replica {
  readonly name: string;
  readonly db: DatabaseSync;
  readonly originated: Set<string>;
}

const tasksOf = (db: DatabaseSync): TaskRow[] =>
  db
    .prepare('SELECT id, uid, birth_fp, title, type, created_at FROM tasks_tasks ORDER BY id')
    .all() as unknown as TaskRow[];

const idByTitle = (db: DatabaseSync) => new Map(tasksOf(db).map((r) => [r.title, r.id]));

function addTask(r: Replica, id: string, title: string, createdAt: string): void {
  r.db
    .prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES (?, ?, 'pending', 'medium', 'task', ?)",
    )
    .run(id, title, createdAt);
  const row = r.db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(id) as { uid: string };
  r.originated.add(row.uid);
}

function addDep(db: DatabaseSync, taskId: string, dependsOn: string): void {
  db.prepare('INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES (?, ?)').run(
    taskId,
    dependsOn,
  );
}

/**
 * Pull `remote`'s tasks into `local`, keyed by uid. Returns the re-mint ops
 * `local` authored (it originated the loser), to publish to everyone.
 */
function pull(local: Replica, remote: Replica): RemintOp[] {
  const ops: RemintOp[] = [];
  local.db.exec('BEGIN IMMEDIATE');
  try {
    const known = new Set(tasksOf(local.db).map((t) => t.uid));
    for (const incoming of tasksOf(remote.db)) {
      if (known.has(incoming.uid)) continue;
      const holder = local.db
        .prepare('SELECT uid FROM tasks_tasks WHERE id = ?')
        .get(incoming.id) as { uid: string } | undefined;
      let id = incoming.id;
      if (holder) {
        const loser = collisionLoser(holder.uid, incoming.uid);
        if (loser === holder.uid && local.originated.has(loser)) {
          // The local row loses and this replica originated it: the authority.
          ops.push(
            remintTaskDisplayId(local.db, incoming.id, {
              reason: 'collision-remint',
              origin: local.name,
            }),
          );
        } else if (loser === incoming.uid) {
          // The remote row loses; its origin re-mints. Keep it provisional here.
          id = provisionalDisplayId(incoming.uid);
        } else {
          throw new Error('harness: the local loser was originated elsewhere');
        }
      }
      local.db
        .prepare(
          "INSERT INTO tasks_tasks (id, uid, birth_fp, title, status, priority, type, created_at) VALUES (?, ?, ?, ?, 'pending', 'medium', ?, ?)",
        )
        .run(
          id,
          incoming.uid,
          incoming.birth_fp,
          incoming.title,
          incoming.type,
          incoming.created_at,
        );
    }
    local.db.exec('COMMIT');
  } catch (error) {
    local.db.exec('ROLLBACK');
    throw error;
  }
  return ops;
}

/**
 * Apply published ops. A conflict (the new number is taken here) is a new
 * collision: when this replica originated its loser, it re-mints again and
 * returns the new op; otherwise the op's row waits for its own origin.
 */
function apply(r: Replica, ops: readonly RemintOp[]): RemintOp[] {
  const next: RemintOp[] = [];
  for (const op of ops) {
    const result = applyRemintOp(r.db, op);
    if (result.status !== 'conflict') continue;
    const loser = collisionLoser(result.holderUid ?? '', op.uid);
    if (loser === result.holderUid && r.originated.has(loser)) {
      next.push(
        remintTaskDisplayId(r.db, op.newId, {
          reason: 'collision-remint',
          origin: r.name,
        }),
      );
      expect(applyRemintOp(r.db, op).status).toBe('applied');
    }
  }
  return next;
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
  let a: Replica;
  let b: Replica;
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
    // Device B starts from a copy of the same history, then both go offline.
    bPath = join(env.tempDir, 'device-b.db');
    native.exec(`VACUUM INTO '${bPath}'`);
    const bDb = new DatabaseSync(bPath);
    prepareRowIdentity(bDb, 'project');
    a = { name: 'device-a', db: native, originated: new Set() };
    b = { name: 'device-b', db: bDb, originated: new Set() };

    addTask(a, 'T004', 'alpha (A)', '2026-09-25T10:00:00.000Z');
    addDep(a.db, 'T004', 'T001');
    addTask(a, 'T005', 'delta (A)', '2026-09-25T12:00:00.000Z');
    addTask(b, 'T004', 'beta (B)', '2026-09-25T09:00:00.000Z');
    addTask(b, 'T005', 'gamma (B)', '2026-09-25T13:00:00.000Z');
  });

  afterEach(async () => {
    b.db.close();
    rmSync(bPath, { force: true });
    await env.cleanup();
  });

  it('gives shared history the same uids and new work distinct ones', () => {
    const byId = (rows: TaskRow[]) => new Map(rows.map((r) => [r.id, r.uid]));
    const ua = byId(tasksOf(a.db));
    const ub = byId(tasksOf(b.db));
    for (const id of ['T001', 'T002', 'T003']) expect(ua.get(id)).toBe(ub.get(id));
    for (const id of ['T004', 'T005']) expect(ua.get(id)).not.toBe(ub.get(id));
    expect(new Set([...ua.values(), ...ub.values()]).size).toBe(3 + 2 + 2);
  });

  it('re-mints only at the origin of each loser, and converges', () => {
    // alpha (A) loses T004 to the older beta (B): only A, its origin, re-mints
    // it. gamma (B) loses T005 to the older delta (A): only B re-mints it. Each
    // side keeps the other's loser provisional until the op arrives.
    const originOf = new Map<string, string>();
    for (const r of [a, b]) for (const uid of r.originated) originOf.set(uid, r.name);
    const opsA = pull(a, b);
    const opsB = pull(b, a);
    expect(opsA.map((op) => op.oldId)).toEqual(['T004']);
    expect(opsB.map((op) => op.oldId)).toContain('T005');
    // Publish until quiet. Offline authorities allocate from their own
    // counters, so a published number can collide again; each new collision
    // is again re-minted only by its loser's origin, and it settles.
    let pending = [...opsA, ...opsB];
    const authored = [...pending];
    for (let round = 0; pending.length > 0; round++) {
      expect(round, 'converges in a few rounds').toBeLessThan(5);
      const next = [...apply(a, pending), ...apply(b, pending)];
      authored.push(...next);
      pending = next;
    }
    for (const op of authored) expect(op.origin).toBe(originOf.get(op.uid));

    // Converged: the same display id for every uid on both devices.
    const view = (db: DatabaseSync) =>
      tasksOf(db)
        .map((r) => `${r.uid}=${r.id}`)
        .sort();
    expect(view(a.db)).toEqual(view(b.db));
    const ids = idByTitle(a.db);
    expect(ids.get('beta (B)')).toBe('T004');
    expect(ids.get('delta (A)')).toBe('T005');
    expect(ids.get('alpha (A)')).not.toBe('T004');
    expect(ids.get('gamma (B)')).not.toBe('T005');
    for (const id of ids.values()) expect(id).toMatch(/^T\d+$/);

    // alpha's dependency followed its re-mint; the edge uid did not change.
    const alpha = tasksOf(a.db).find((r) => r.title === 'alpha (A)');
    const epic = tasksOf(a.db).find((r) => r.title === 'Shared epic');
    expect(
      a.db
        .prepare('SELECT depends_on, uid FROM tasks_task_dependencies WHERE task_id = ?')
        .get(alpha?.id ?? ''),
    ).toEqual({
      depends_on: 'T001',
      uid: naturalRowUid('project', 'tasks_task_dependencies', [alpha?.uid ?? '', epic?.uid ?? '']),
    });
    expect(a.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(b.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The live id wins; the displaced row comes back as history with its origin.
    const t004 = resolveDisplayId(a.db, 'tasks_tasks', 'T004');
    expect(t004.status).toBe('resolved');
    if (t004.status === 'resolved') {
      expect(t004.claimant.currentId).toBe('T004');
      expect(t004.alsoKnownAs.map((c) => [c.currentId, c.origin])).toEqual([
        [alpha?.id, 'device-a'],
      ]);
    }
  });

  it('an alias resolves only when no live row holds the id; several aliases are ambiguous', () => {
    const t003 = a.db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T003'").get() as {
      uid: string;
    };
    const receipt = remintTaskDisplayId(a.db, 'T003', { reason: 'manual', origin: 'device-a' });
    expect(receipt.rewritten['tasks_task_dependencies.depends_on']).toBe(1);
    expect(resolveDisplayId(a.db, 'tasks_tasks', 'T003')).toEqual({
      status: 'resolved',
      claimant: {
        uid: t003.uid,
        currentId: receipt.newId,
        via: 'alias',
        origin: 'device-a',
        displacedHlc: null,
      },
      alsoKnownAs: [],
    });
    const t005 = a.db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T005'").get() as {
      uid: string;
    };
    recordDisplayIdAlias(a.db, {
      table: 'tasks_tasks',
      displayId: 'T003',
      entityUid: t005.uid,
      reason: 'manual',
      origin: 'device-b',
    });
    const both = resolveDisplayId(a.db, 'tasks_tasks', 'T003');
    expect(both.status).toBe('ambiguous');
    if (both.status === 'ambiguous') {
      expect(both.candidates.map((c) => c.uid).sort()).toEqual([t003.uid, t005.uid].sort());
    }
    expect(resolveDisplayId(a.db, 'tasks_tasks', 'T999')).toEqual({ status: 'none' });
    expect(a.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a non-authority never allocates: it applies the op, or reports a conflict', () => {
    const alphaUid = [...a.originated][0] ?? '';
    // B originated gamma only, so its pull authors exactly one re-mint.
    expect(pull(b, a).map((o) => o.oldId)).toEqual(['T005']);
    expect(idByTitle(b.db).get('alpha (A)')).toBe(provisionalDisplayId(alphaUid));
    const op = (newId: string, uid = alphaUid): RemintOp => ({
      uid,
      oldId: 'T004',
      newId,
      origin: 'device-a',
      displacedHlc: null,
    });
    expect(applyRemintOp(b.db, op('T900', '00000000-0000-7000-8000-000000000000')).status).toBe(
      'unknown-row',
    );
    expect(applyRemintOp(b.db, op('T001')).status).toBe('conflict');
    expect(applyRemintOp(b.db, op('T900')).status).toBe('applied');
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T900');
    expect(applyRemintOp(b.db, op('T900')).status).toBe('already-applied');
  });
});

describe('provisional display ids (spec §9.2)', () => {
  const REPO = resolve(import.meta.dirname, '../../../../..');
  const uids = [
    '0192d0c0-0000-7000-8000-000000000000',
    '0192d0c0-1234-7abc-9def-123456789abc',
    // Same millisecond as the first: the provisional id must still differ.
    '0192d0c0-0000-7fff-bfff-ffffffffffff',
  ];

  /** Every regex literal in non-test source that looks for a `T` followed by a digit. */
  function taskIdRegexes(): RegExp[] {
    const found: RegExp[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
          const text = readFileSync(path, 'utf8');
          for (const m of text.matchAll(
            /\/((?:[^/\\\n]|\\.)*T\\d(?:[^/\\\n]|\\.)*)\/([gimsuy]*)/g,
          )) {
            try {
              found.push(new RegExp(m[1] as string, (m[2] ?? '').replace('g', '')));
            } catch {
              // Not a regex literal (a path or a comment); skip it.
            }
          }
        }
      }
    };
    for (const pkg of readdirSync(join(REPO, 'packages'))) {
      const src = join(REPO, 'packages', pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // A package without src/.
      }
    }
    return found;
  }

  it('no T#### parser in the code base reads a provisional id as a task id', () => {
    const regexes = taskIdRegexes();
    // The parsers named in the review, plus every other one the scan finds.
    expect(regexes.length).toBeGreaterThan(40);
    for (const re of [/\bT\d{1,5}\b/, /(T\d+)/, /^T\d+$/i, /\bT\d+\b/, ...regexes]) {
      for (const uid of uids) {
        const id = provisionalDisplayId(uid);
        expect(re.test(id), `${re} matched ${id}`).toBe(false);
        expect(re.test(`task/${id}`), `${re} matched task/${id}`).toBe(false);
      }
    }
  });

  it('is a valid git ref component and never reuses the uid timestamp', () => {
    for (const uid of uids) {
      const id = provisionalDisplayId(uid);
      expect(id.startsWith(PROVISIONAL_ID_PREFIX)).toBe(true);
      expect(() =>
        execFileSync('git', ['check-ref-format', `refs/heads/task/${id}`], { stdio: 'pipe' }),
      ).not.toThrow();
    }
    // Two uids minted in the same millisecond still get distinct provisional ids.
    expect(provisionalDisplayId(uids[0] ?? '')).not.toBe(provisionalDisplayId(uids[2] ?? ''));
  });
});

describe('remintAuthority (spec §9.2)', () => {
  const replicas = [{ id: 'dev-c' }, { id: 'dev-a', retired: true }, { id: 'dev-b' }];
  const base = { cloudSynced: false, replicas, provisionalSinceMs: 0, nowMs: 1000 };

  it('the server when the project syncs', () => {
    expect(remintAuthority({ ...base, cloudSynced: true, origin: 'dev-c' })).toEqual({
      authority: 'server',
      reason: 'server',
    });
  });

  it('the origin while it is active and inside the takeover window', () => {
    expect(remintAuthority({ ...base, origin: 'dev-c' })).toEqual({
      authority: 'dev-c',
      reason: 'origin',
    });
  });

  it('the lowest active replica for a row with no origin, a retired origin, or after the timeout', () => {
    expect(remintAuthority({ ...base, origin: null })).toEqual({
      authority: 'dev-b',
      reason: 'no-origin',
    });
    expect(remintAuthority({ ...base, origin: 'dev-a' })).toEqual({
      authority: 'dev-b',
      reason: 'origin-retired',
    });
    expect(remintAuthority({ ...base, origin: 'dev-c', nowMs: REMINT_TAKEOVER_MS })).toEqual({
      authority: 'dev-b',
      reason: 'takeover',
    });
  });

  it('is the same on every replica for the same inputs', () => {
    const shuffled = [...replicas].reverse();
    expect(remintAuthority({ ...base, origin: null, replicas: shuffled })).toEqual(
      remintAuthority({ ...base, origin: null }),
    );
  });
});
