/**
 * Two stores created offline merge without uid collisions; display-id
 * collisions are re-minted by a single authority, ordered by HLC, and
 * converge; uid collisions re-key the loser and every replica applies the
 * receipt (T12341 AC2, AC3; spec §6.4, §9; T12744, T12745, T12748, T12750).
 *
 * The merge engine itself is T12344. The harness below drives the receive
 * contract it will call: rows travel as wire rows (uid, birth fingerprint,
 * references as (uid, birth fingerprint)); a row that cannot be placed is
 * held in the identity quarantine, never inserted under a stand-in id.
 *
 * @task T12341
 * @epic T12323
 */

// Row uids are opt-in (T12341); these tests exercise them.
process.env.CLEO_ROW_UID_FILL = '1';

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pivotTask } from '../../orchestrate/pivot.js';
import { buildAcRowId } from '../../tasks/ac-table.js';
import {
  applyRekey,
  applyRemintOp,
  collisionHlcFromBirths,
  collisionLoser,
  compareHlc,
  listHeldRows,
  REMINT_TAKEOVER_MS,
  type RemintOp,
  receiveRow,
  rekeyRowUid,
  remintAuthority,
  remintTaskDisplayId,
  resolveDisplayId,
  type WireRow,
  wireRowOf,
} from '../display-id-alias.js';
import {
  naturalRowUid,
  prepareRowIdentity,
  ROW_IDENTITY,
  rekeyedChildUid,
} from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { RENAMED_RECENT_MS } from '../sqlite-data-accessor.js';
import { encodeHlc } from '../sync/hlc.js';
import {
  BOUND_TEST_SESSION_ID,
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from './test-db-helper.js';

interface TaskRow {
  id: string;
  uid: string;
  birth_fp: string;
  title: string;
}

/** One device: its store, its replica name, and the rows it originated. */
interface Replica {
  readonly name: string;
  readonly db: DatabaseSync;
  readonly originated: Set<string>;
}

const BASE_MS = 1_790_000_000_000;
let tick = 0;
/** A stable replica uuid per test device name (HLCs name their replica by uuid). */
const replica = (name: string) => {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** A fresh HLC value (the journal's wire form, T12342), increasing across the file. */
const clock = (node = 'n'): string =>
  encodeHlc({ phys: BASE_MS + ++tick * 1000, ctr: 0, replica: replica(node) });
const hlcAt = (ms: number, node = 'n') =>
  encodeHlc({ phys: BASE_MS + ms, ctr: 0, replica: replica(node) });

const tasksOf = (db: DatabaseSync): TaskRow[] =>
  db
    .prepare('SELECT id, uid, birth_fp, title FROM tasks_tasks ORDER BY id')
    .all() as unknown as TaskRow[];

const idByTitle = (db: DatabaseSync) => new Map(tasksOf(db).map((r) => [r.title, r.id]));

/** Held rows never enter the task table: every id there is a `T####`. */
function expectOnlyDisplayIds(db: DatabaseSync): void {
  for (const t of tasksOf(db)) expect(t.id).toMatch(/^T\d+$/);
}

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

const sequence = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT json_extract(value, '$.counter') AS counter FROM tasks_schema_meta WHERE key = 'task_id_sequence'",
    )
    .get();

/**
 * Re-mint, as the authority, every local loser of a display-id collision this
 * replica originated (the held winner is placed by the re-mint).
 */
function settle(r: Replica): RemintOp[] {
  const ops: RemintOp[] = [];
  for (const h of listHeldRows(r.db)) {
    if (h.reason !== 'display-id-collision' || !h.contestedId) continue;
    const holder = r.db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(h.contestedId) as
      | { uid: string }
      | undefined;
    if (!holder) continue;
    if (collisionLoser(holder.uid, h.uid) === holder.uid && r.originated.has(holder.uid)) {
      ops.push(
        remintTaskDisplayId(r.db, h.contestedId, {
          reason: 'collision-remint',
          origin: r.name,
          hlc: clock(r.name),
        }),
      );
    }
  }
  return ops;
}

/** Receive every task of `remote` into `local`; return the re-mints `local` authored. */
function pull(local: Replica, remote: Replica): RemintOp[] {
  for (const t of tasksOf(remote.db)) {
    receiveRow(local.db, wireRowOf(remote.db, 'tasks_tasks', t.uid));
    expectOnlyDisplayIds(local.db);
  }
  return settle(local);
}

/**
 * Apply published ops. A conflict (the new number is taken here) is a new
 * collision: when this replica originated its loser, it re-mints again.
 */
function apply(r: Replica, ops: readonly RemintOp[]): RemintOp[] {
  const next: RemintOp[] = [];
  for (const op of ops) {
    const result = applyRemintOp(r.db, op);
    expectOnlyDisplayIds(r.db);
    if (result.status !== 'conflict') continue;
    const loser = collisionLoser(result.holderUid ?? '', op.uid);
    if (loser === result.holderUid && r.originated.has(loser)) {
      next.push(
        remintTaskDisplayId(r.db, op.newId, {
          reason: 'collision-remint',
          origin: r.name,
          hlc: clock(r.name),
        }),
      );
      expect(applyRemintOp(r.db, op).status).toBe('applied');
    }
  }
  return [...next, ...settle(r)];
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
    vi.unstubAllEnvs();
  });

  it('gives shared history the same uids and new work distinct ones', () => {
    const byId = (rows: TaskRow[]) => new Map(rows.map((r) => [r.id, r.uid]));
    const ua = byId(tasksOf(a.db));
    const ub = byId(tasksOf(b.db));
    for (const id of ['T001', 'T002', 'T003']) expect(ua.get(id)).toBe(ub.get(id));
    for (const id of ['T004', 'T005']) expect(ua.get(id)).not.toBe(ub.get(id));
    expect(new Set([...ua.values(), ...ub.values()]).size).toBe(3 + 2 + 2);
  });

  it('re-mints only at the origin of each loser, holds the rest, and converges', () => {
    const originOf = new Map<string, string>();
    for (const r of [a, b]) for (const uid of r.originated) originOf.set(uid, r.name);
    const opsA = pull(a, b);
    const opsB = pull(b, a);
    expect(opsA.map((op) => op.oldId)).toEqual(['T004']);
    expect(opsB.map((op) => op.oldId)).toContain('T005');
    let pending = [...opsA, ...opsB];
    const authored = [...pending];
    for (let round = 0; pending.length > 0; round++) {
      expect(round, 'converges in a few rounds').toBeLessThan(5);
      const next = [...apply(a, pending), ...apply(b, pending)];
      next.push(...pull(a, b), ...pull(b, a));
      authored.push(...next);
      pending = next;
    }
    for (const op of authored) expect(op.origin).toBe(originOf.get(op.uid));
    expect(listHeldRows(a.db)).toEqual([]);
    expect(listHeldRows(b.db)).toEqual([]);

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

    const t004 = resolveDisplayId(a.db, 'tasks_tasks', 'T004');
    expect(t004.status).toBe('resolved');
    if (t004.status === 'resolved') {
      expect(t004.claimant.currentId).toBe('T004');
      expect(t004.alsoKnownAs.map((c) => [c.currentId, c.origin])).toEqual([
        [alpha?.id, 'device-a'],
      ]);
    }
  });

  it('a held loser is read-only; once released, show, update and reparent work (T12750)', async () => {
    pull(a, b);
    // gamma (B) loses T005 to delta (A); B originated it, so A holds it.
    const gamma = tasksOf(b.db).find((t) => t.title === 'gamma (B)') as TaskRow;
    const held = listHeldRows(a.db).find((h) => h.uid === gamma.uid);
    expect(held).toMatchObject({ reason: 'display-id-collision', contestedId: 'T005' });
    expect(
      a.db.prepare('SELECT count(*) AS n FROM tasks_tasks WHERE uid = ?').get(gamma.uid),
    ).toEqual({ n: 0 });
    expect((await env.accessor.loadSingleTask('T005'))?.title).toBe('delta (A)');

    // B's re-mint arrives: A places gamma under the published number.
    const op: RemintOp = {
      uid: gamma.uid,
      birthFp: gamma.birth_fp,
      oldId: 'T005',
      newId: 'T950',
      origin: 'device-b',
      hlc: clock('device-b'),
    };
    const result = applyRemintOp(a.db, op);
    expect(result.status).toBe('recorded');
    expect(idByTitle(a.db).get('gamma (B)')).toBe('T950');
    expect(listHeldRows(a.db).map((h) => h.uid)).not.toContain(gamma.uid);

    expect((await env.accessor.loadSingleTask('T950'))?.title).toBe('gamma (B)');
    await env.accessor.updateTaskFields('T950', { title: 'gamma (B), edited' });
    await env.accessor.updateTaskFields('T950', { parentId: 'T001' });
    expect(
      a.db.prepare("SELECT title, parent_id FROM tasks_tasks WHERE id = 'T950'").get(),
    ).toEqual({ title: 'gamma (B), edited', parent_id: 'T001' });
    expect(a.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('applyRemintOp keeps the greatest HLC whatever the arrival order (T12750)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    // The fallback re-minted alpha; the origin re-minted it again, later.
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-a', hlc: hlcAt(10_000) };
    const cPath = join(env.tempDir, 'device-c.db');
    b.db.exec(`VACUUM INTO '${cPath}'`);
    const c = new DatabaseSync(cPath);
    try {
      prepareRowIdentity(c, 'project');
      expect(applyRemintOp(b.db, early).status).toBe('recorded');
      expect(applyRemintOp(b.db, late).status).toBe('applied');
      expect(applyRemintOp(c, late).status).toBe('recorded');
      expect(applyRemintOp(c, early).status).toBe('superseded');
      for (const db of [b.db, c]) {
        expect(idByTitle(db).get('alpha (A)')).toBe('T800');
        // Both displaced numbers resolve to alpha through its aliases.
        for (const old of ['T004', 'T700']) {
          const r = resolveDisplayId(db, 'tasks_tasks', old);
          const uids =
            r.status === 'resolved' ? [r.claimant, ...r.alsoKnownAs].map((x) => x.uid) : [];
          expect(uids, old).toContain(alpha.uid);
        }
      }
      expect(applyRemintOp(c, late).status).toBe('already-applied');
    } finally {
      c.close();
      rmSync(cPath, { force: true });
    }
  });

  it('the re-mint record is portable: losing local state changes no outcome (T12800)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-a', hlc: hlcAt(10_000) };
    expect(applyRemintOp(b.db, late).status).toBe('recorded');
    // The replica's local-only state is lost (or was never there).
    b.db.exec('DELETE FROM tasks_row_identity_meta');
    expect(applyRemintOp(b.db, early).status).toBe('superseded');
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T800');
    // An op recorded before its row arrives still decides where the row lands.
    const beta = tasksOf(b.db).find((t) => t.title === 'beta (B)') as TaskRow;
    const moveBeta: RemintOp = {
      uid: beta.uid,
      birthFp: beta.birth_fp,
      oldId: 'T004',
      newId: 'T901',
      origin: 'device-b',
      hlc: hlcAt(20_000, 'device-b'),
    };
    expect(applyRemintOp(a.db, moveBeta).status).toBe('recorded');
    a.db.exec('DELETE FROM tasks_row_identity_meta');
    expect(receiveRow(a.db, wireRowOf(b.db, 'tasks_tasks', beta.uid))).toMatchObject({
      status: 'inserted',
      key: 'T901',
    });
  });

  it('a guarded write to a re-numbered id fails with E_TASK_RENAMED, never lands on the new holder (T12800)', async () => {
    a.db
      .prepare(
        `UPDATE tasks_tasks SET claimed_by_session = 'ses-1', claimed_by_agent = 'agent-1',
           claimed_at = '2026-09-29T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z'
         WHERE id = 'T004'`,
      )
      .run();
    const read = await env.accessor.loadSingleTask('T004');
    const readVersion = read?.updatedAt ?? read?.createdAt ?? '';
    pull(a, b); // alpha (A) loses T004 to beta (B) and is re-minted here
    const alphaId = idByTitle(a.db).get('alpha (A)') as string;
    expect(alphaId).not.toBe('T004');
    const now = '2026-09-30T00:00:00.000Z';
    const renamed = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        code: 26,
        details: { actual: 'T004', expected: alphaId },
      });
    await renamed(
      env.accessor.updateTaskFields(
        'T004',
        { title: 'claim holder edit' },
        { claim: { sessionId: 'ses-1', mode: 'renew', now } },
      ),
    );
    await renamed(
      env.accessor.updateTaskFields(
        'T004',
        { title: 'if-match edit' },
        { expectedUpdatedAt: readVersion },
      ),
    );
    expect(idByTitle(a.db).get('beta (B)')).toBe('T004');
    // Addressing the new holder deliberately still works.
    const betaTask = await env.accessor.loadSingleTask('T004');
    const betaVersion = betaTask?.updatedAt ?? betaTask?.createdAt ?? '';
    await env.accessor.updateTaskFields(
      'T004',
      { title: 'beta, edited' },
      { expectedUpdatedAt: betaVersion },
    );
    expect(idByTitle(a.db).get('beta, edited')).toBe('T004');
  });

  it('a stale --if-match on the task that now holds the id is E_CONFLICT, not E_TASK_RENAMED (T12800)', async () => {
    pull(a, b);
    const beta = await env.accessor.loadSingleTask('T004');
    expect(beta?.title).toBe('beta (B)');
    const staleBeta = beta?.updatedAt ?? beta?.createdAt ?? '';
    await env.accessor.updateTaskFields('T004', { title: 'beta, first edit' });
    await expect(
      env.accessor.updateTaskFields(
        'T004',
        { title: 'beta, stale edit' },
        { expectedUpdatedAt: staleBeta },
      ),
    ).rejects.toMatchObject({ code: ExitCode.VERSION_CONFLICT });
    // A version that was never alpha's under T004 is a plain conflict too.
    await expect(
      env.accessor.updateTaskFields(
        'T004',
        { title: 'beta, made-up version' },
        { expectedUpdatedAt: '2001-01-01T00:00:00.000Z' },
      ),
    ).rejects.toMatchObject({ code: ExitCode.VERSION_CONFLICT });
    expect(idByTitle(a.db).get('beta, first edit')).toBe('T004');
  });

  it('acquiring the new holder is never E_TASK_RENAMED: claim, renew, and a pivot from the renamed task (T12800)', async () => {
    // The session's focus is resolved from the test project, not the runner's.
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    await bindTestSession(env);
    const claimant = { sessionId: BOUND_TEST_SESSION_ID, agentId: 'agent-1' };
    await env.accessor.claimTask('T004', { ...claimant, mode: 'acquire' });
    await env.accessor.updateTaskFields('T004', { pipelineStage: 'implementation' });
    pull(a, b);
    const alphaId = idByTitle(a.db).get('alpha (A)') as string;
    expect(alphaId).not.toBe('T004');
    expect((await env.accessor.loadSingleTask(alphaId))?.claim?.sessionId).toBe(
      BOUND_TEST_SESSION_ID,
    );

    // Pivot claims its target BEFORE it releases its source: at that moment
    // the session holds the renamed task and acquires the new holder.
    const result = await pivotTask(alphaId, 'T004', {
      reason: 'the id moved; work on beta',
      projectRoot: env.tempDir,
      accessor: env.accessor,
    });
    expect(result.toTaskId).toBe('T004');
    const beta = await env.accessor.loadSingleTask('T004');
    expect(beta?.title).toBe('beta (B)');
    expect(beta?.claim?.sessionId).toBe(BOUND_TEST_SESSION_ID);
    // Renewing the lease the session now holds on T004 is its own claim.
    await env.accessor.claimTask('T004', { ...claimant, mode: 'renew' });
  });

  it('only a recent rename is E_TASK_RENAMED; an old one falls through to E_CONFLICT (T12800)', async () => {
    const read = await env.accessor.loadSingleTask('T004');
    const readVersion = read?.updatedAt ?? read?.createdAt ?? '';
    pull(a, b);
    const edit = () =>
      env.accessor.updateTaskFields(
        'T004',
        { title: 'late edit' },
        { expectedUpdatedAt: readVersion },
      );
    await expect(edit()).rejects.toMatchObject({ code: ExitCode.TASK_RENAMED });
    const old = new Date(Date.now() - RENAMED_RECENT_MS - 60_000).toISOString();
    a.db
      .prepare(
        "UPDATE tasks_row_identity_meta SET value = json_set(value, '$.at', ?) WHERE key = 'renamed_from:tasks_tasks:T004'",
      )
      .run(old);
    await expect(edit()).rejects.toMatchObject({ code: ExitCode.VERSION_CONFLICT });
    expect(idByTitle(a.db).get('beta (B)')).toBe('T004');
  });

  it('alias rows converge whatever order the re-mint ops arrive in (T12800)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-a', hlc: hlcAt(10_000) };
    const cPath = join(env.tempDir, 'device-c-order.db');
    b.db.exec(`VACUUM INTO '${cPath}'`);
    const c = new DatabaseSync(cPath);
    try {
      prepareRowIdentity(c, 'project');
      for (const op of [early, late]) applyRemintOp(b.db, op);
      for (const op of [late, early]) applyRemintOp(c, op);
      const aliases = (db: DatabaseSync) =>
        db
          .prepare(
            `SELECT uid, entity_table, display_id, entity_uid, entity_birth_fp, reason, origin,
                    displaced_hlc, created_at
               FROM tasks_display_id_aliases ORDER BY uid`,
          )
          .all();
      expect(aliases(b.db).length).toBeGreaterThan(0);
      expect(aliases(c)).toEqual(aliases(b.db));
      // Replaying either op changes nothing.
      for (const op of [early, late]) applyRemintOp(c, op);
      expect(aliases(c)).toEqual(aliases(b.db));
    } finally {
      c.close();
      rmSync(cPath, { force: true });
    }
  });

  it('an alias row under the pre-review uid (no reason in the key) still resolves once and keeps the winner (T12800)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    // What a build before the review wrote: the uid hashed without the reason.
    // (Counted on VACUUM copies of the field stores on 2026-09-30: 0 alias rows.)
    const staleUid = naturalRowUid('project', 'tasks_display_id_aliases', [
      'tasks_tasks',
      'T700',
      alpha.uid,
    ]);
    b.db
      .prepare(
        `INSERT INTO tasks_display_id_aliases
           (uid, entity_table, display_id, entity_uid, entity_birth_fp, reason, origin,
            displaced_hlc, created_at)
         VALUES (?, 'tasks_tasks', 'T700', ?, ?, 'remint-assigned', 'device-c', ?, ?)`,
      )
      .run(
        staleUid,
        alpha.uid,
        alpha.birth_fp,
        hlcAt(5_000, 'device-c'),
        '2026-09-29T00:00:00.000Z',
      );
    const late: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T800',
      origin: 'device-a',
      hlc: hlcAt(10_000),
    };
    const early: RemintOp = {
      ...late,
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    expect(applyRemintOp(b.db, late).status).toBe('recorded');
    expect(applyRemintOp(b.db, early).status).toBe('superseded');
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T800');
    const r = resolveDisplayId(b.db, 'tasks_tasks', 'T700');
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect([r.claimant, ...r.alsoKnownAs].map((x) => x.uid)).toEqual([alpha.uid]);
    }
  });

  it('alias created_at is derived from the displacement HLC, never the wall clock (T12800 + T12802)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const op: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    applyRemintOp(b.db, op);
    const rows = b.db
      .prepare(
        'SELECT displaced_hlc AS hlc, created_at AS at FROM tasks_display_id_aliases WHERE entity_uid = ?',
      )
      .all(alpha.uid) as { hlc: string; at: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.hlc).toBe(op.hlc);
      expect(r.at).toBe(new Date(BASE_MS + 5_000).toISOString());
    }
  });

  it('alias rows converge across HLC formats: a 9.25 value and a journal value order by HLC, not text (T12800 + T12802)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    // Same alias (T004 displaced from alpha as a collision re-mint), two
    // displacements: the 9.25-format one is LATER, but sorts first as text.
    const legacyLater =
      `${String(BASE_MS + 20_000).padStart(15, '0')}.000000.device-c` as RemintOp['hlc'];
    const journalEarlier = hlcAt(10_000, 'device-a');
    expect(legacyLater < journalEarlier).toBe(true);
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-a',
      hlc: journalEarlier,
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-c', hlc: legacyLater };
    const cPath = join(env.tempDir, 'device-c-mixed.db');
    b.db.exec(`VACUUM INTO '${cPath}'`);
    const c = new DatabaseSync(cPath);
    try {
      prepareRowIdentity(c, 'project');
      for (const op of [early, late]) applyRemintOp(b.db, op);
      for (const op of [late, early]) applyRemintOp(c, op);
      const aliases = (db: DatabaseSync) =>
        db
          .prepare(
            `SELECT uid, display_id, reason, origin, displaced_hlc, created_at
               FROM tasks_display_id_aliases WHERE entity_uid = ? ORDER BY uid`,
          )
          .all(alpha.uid);
      expect(aliases(c)).toEqual(aliases(b.db));
      // The T004 collision alias keeps the EARLIER displacement (the journal value).
      const t004 = aliases(b.db).find(
        (r) => (r as { display_id: string; reason: string }).display_id === 'T004',
      ) as { displaced_hlc: string };
      expect(t004.displaced_hlc).toBe(journalEarlier);
      expect(idByTitle(b.db).get('alpha (A)')).toBe('T800');
      expect(idByTitle(c).get('alpha (A)')).toBe('T800');
    } finally {
      c.close();
      rmSync(cPath, { force: true });
    }
  });

  it('a replica that receives the alias rows only through sync derives the same winner (T12800)', () => {
    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: hlcAt(5_000, 'device-c'),
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-a', hlc: hlcAt(10_000) };
    applyRemintOp(b.db, late);
    applyRemintOp(b.db, early);
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T800');

    // Replica D never saw either op: it has beta, not alpha, and no aliases.
    const dPath = join(env.tempDir, 'device-d.db');
    b.db.exec(`VACUUM INTO '${dPath}'`);
    const d = new DatabaseSync(dPath);
    try {
      prepareRowIdentity(d, 'project');
      d.exec('DELETE FROM tasks_display_id_aliases');
      d.exec('DELETE FROM tasks_row_identity_meta');
      d.prepare('DELETE FROM tasks_tasks WHERE uid = ?').run(alpha.uid);
      // The alias rows arrive as ordinary synced rows, in reverse order.
      const aliasUids = (
        b.db.prepare('SELECT uid FROM tasks_display_id_aliases ORDER BY uid DESC').all() as {
          uid: string;
        }[]
      ).map((r) => r.uid);
      expect(aliasUids.length).toBeGreaterThan(0);
      for (const uid of aliasUids) {
        expect(receiveRow(d, wireRowOf(b.db, 'tasks_display_id_aliases', uid)).status).toBe(
          'inserted',
        );
      }
      // Then alpha arrives under the id it had where it was authored.
      const wire = wireRowOf(a.db, 'tasks_tasks', alpha.uid);
      expect(receiveRow(d, wire)).toMatchObject({ status: 'inserted', key: 'T800' });
      expect(idByTitle(d).get('alpha (A)')).toBe('T800');
      expect(idByTitle(d).get('beta (B)')).toBe('T004');
    } finally {
      d.close();
      rmSync(dPath, { force: true });
    }
  });

  it('a stored HLC in the 9.25 format is still ordered, never thrown on (T12802)', () => {
    // `<ms 15>.<counter 6>.<node>`: what a 9.25 build wrote with the flag on.
    const legacy = (ms: number, node: string) =>
      `${String(BASE_MS + ms).padStart(15, '0')}.000000.${node}` as RemintOp['hlc'];
    expect(compareHlc(legacy(5_000, 'device-c'), hlcAt(10_000))).toBeLessThan(0);
    expect(compareHlc(hlcAt(10_000), legacy(5_000, 'device-c'))).toBeGreaterThan(0);
    expect(compareHlc(legacy(20_000, 'device-c'), hlcAt(10_000))).toBeGreaterThan(0);
    expect(() => compareHlc('not-an-hlc' as RemintOp['hlc'], hlcAt(1))).toThrow();

    pull(b, a);
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const early: RemintOp = {
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId: 'T700',
      origin: 'device-c',
      hlc: legacy(5_000, 'device-c'),
    };
    const late: RemintOp = { ...early, newId: 'T800', origin: 'device-a', hlc: hlcAt(10_000) };
    expect(applyRemintOp(b.db, early).status).toBe('recorded');
    expect(applyRemintOp(b.db, late).status).toBe('applied');
    expect(applyRemintOp(b.db, early).status).toBe('superseded');
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T800');
  });

  it('a non-authority never allocates: it records, applies, or reports a conflict', () => {
    const alpha = tasksOf(a.db).find((t) => t.title === 'alpha (A)') as TaskRow;
    const op = (newId: string): RemintOp => ({
      uid: alpha.uid,
      birthFp: alpha.birth_fp,
      oldId: 'T004',
      newId,
      origin: 'device-a',
      hlc: clock('device-a'),
    });
    expect(applyRemintOp(a.db, op('T001')).status).toBe('conflict');
    const before = sequence(b.db);
    // Before alpha reaches B: the op is recorded and alpha is placed under it on arrival.
    expect(applyRemintOp(b.db, op('T900')).status).toBe('recorded');
    expect(receiveRow(b.db, wireRowOf(a.db, 'tasks_tasks', alpha.uid))).toMatchObject({
      status: 'inserted',
      key: 'T900',
    });
    expect(idByTitle(b.db).get('alpha (A)')).toBe('T900');
    expect(sequence(b.db)).toEqual(before);
  });

  it('a re-mint re-derives the task AC ids with their bindings and history, so same-text ACs never collide (T12799)', () => {
    const addAc = (db: DatabaseSync, taskId: string, text: string) => {
      const id = buildAcRowId(taskId, text);
      db.prepare(
        "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES (?, ?, 1, ?, 'text', 'text:1:x')",
      ).run(id, taskId, text);
      return id;
    };
    const alphaAc = addAc(a.db, 'T004', 'tests pass');
    const betaAc = addAc(b.db, 'T004', 'tests pass');
    expect(alphaAc).toBe(betaAc);
    a.db
      .prepare(
        "INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type) VALUES ('bind-a', 'tool:test', ?, 'direct')",
      )
      .run(alphaAc);
    a.db
      .prepare(
        "INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES (?, 'old', 'edit')",
      )
      .run(alphaAc);
    const uidOfAc = (db: DatabaseSync, id: string) =>
      (
        db.prepare('SELECT uid FROM tasks_task_acceptance_criteria WHERE id = ?').get(id) as {
          uid: string;
        }
      ).uid;
    const alphaAcUid = uidOfAc(a.db, alphaAc);
    const betaAcUid = uidOfAc(b.db, betaAc);

    const [receipt] = pull(a, b) as Array<RemintOp & { rewritten: Record<string, number> }>;
    const newAc = buildAcRowId(receipt?.newId ?? '', 'tests pass');
    expect(
      a.db
        .prepare('SELECT id, task_id FROM tasks_task_acceptance_criteria WHERE uid = ?')
        .get(alphaAcUid),
    ).toEqual({ id: newAc, task_id: receipt?.newId });
    expect(receipt?.rewritten['tasks_task_acceptance_criteria.id']).toBe(1);
    for (const table of ['tasks_evidence_ac_bindings', 'tasks_task_acceptance_criteria_history']) {
      expect(a.db.prepare(`SELECT ac_id FROM ${table}`).all(), table).toEqual([{ ac_id: newAc }]);
    }
    // beta's same-text criterion now lands next to it instead of colliding.
    expect(
      receiveRow(a.db, wireRowOf(b.db, 'tasks_task_acceptance_criteria', betaAcUid)),
    ).toMatchObject({ status: 'inserted', key: betaAc });
    expect(a.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a received binding never attaches to the wrong criterion after a collision (T12798)', () => {
    const acId = buildAcRowId('T004', 'tests pass');
    for (const db of [a.db, b.db]) {
      db.prepare(
        "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES (?, 'T004', 1, 'tests pass', 'text', 'text:1:x')",
      ).run(acId);
    }
    b.db
      .prepare(
        "INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type) VALUES ('bind-beta', 'tool:test', ?, 'direct')",
      )
      .run(acId);
    const acUid = (db: DatabaseSync) =>
      (
        db.prepare('SELECT uid FROM tasks_task_acceptance_criteria WHERE id = ?').get(acId) as {
          uid: string;
        }
      ).uid;
    const alphaAc = acUid(a.db);
    const betaAc = acUid(b.db);
    const bindingUid = (
      b.db.prepare("SELECT uid FROM tasks_evidence_ac_bindings WHERE id = 'bind-beta'").get() as {
        uid: string;
      }
    ).uid;
    // The binding reaches A before beta's criterion: A's row with that local
    // id is alpha's criterion, so the binding waits instead of attaching.
    const wire = wireRowOf(b.db, 'tasks_evidence_ac_bindings', bindingUid);
    expect(wire.values).not.toHaveProperty('ac_id');
    expect(wire.refs?.ac_uid).toEqual({ uid: betaAc, birthFp: expect.any(String) });
    expect(receiveRow(a.db, wire)).toMatchObject({ status: 'held', reason: 'ref-pending' });
    expect(a.db.prepare('SELECT count(*) AS n FROM tasks_evidence_ac_bindings').get()).toEqual({
      n: 0,
    });
    // A re-mints alpha (its criterion id is re-derived), beta and its criterion
    // arrive, and the binding lands on beta's criterion.
    pull(a, b);
    receiveRow(a.db, wireRowOf(b.db, 'tasks_task_acceptance_criteria', betaAc));
    // Only gamma (B's T005, waiting for B's re-mint) is still held.
    expect(listHeldRows(a.db).map((h) => [h.entityTable, h.contestedId])).toEqual([
      ['tasks_tasks', 'T005'],
    ]);
    expect(
      a.db
        .prepare(
          `SELECT b.ac_id AS acId, b.ac_uid AS acUid, c.uid AS criterionUid
             FROM tasks_evidence_ac_bindings b
             JOIN tasks_task_acceptance_criteria c ON c.id = b.ac_id
            WHERE b.id = 'bind-beta'`,
        )
        .get(),
    ).toEqual({ acId, acUid: betaAc, criterionUid: betaAc });
    expect(alphaAc).not.toBe(betaAc);
  });

  it('a received JSON id array is translated to local ids, and waits for its tasks (T12798)', () => {
    b.db
      .prepare(
        `INSERT INTO tasks_sessions (id, name, tasks_created_json, tasks_completed_json)
         VALUES ('ses-b', 'B session', '["T005"]', '["T001"]')`,
      )
      .run();
    const sessionUid = (
      b.db.prepare("SELECT uid FROM tasks_sessions WHERE id = 'ses-b'").get() as { uid: string }
    ).uid;
    pull(a, b); // gamma (B's T005) loses to delta and is held on A
    const gamma = tasksOf(b.db).find((t) => t.title === 'gamma (B)') as TaskRow;
    const wire = wireRowOf(b.db, 'tasks_sessions', sessionUid);
    expect(wire.values).not.toHaveProperty('tasks_created_json');
    expect(receiveRow(a.db, wire)).toMatchObject({ status: 'held', reason: 'ref-pending' });
    applyRemintOp(a.db, {
      uid: gamma.uid,
      birthFp: gamma.birth_fp,
      oldId: 'T005',
      newId: 'T950',
      origin: 'device-b',
      hlc: clock('device-b'),
    });
    expect(
      a.db
        .prepare(
          "SELECT tasks_created_json AS created, tasks_completed_json AS completed FROM tasks_sessions WHERE id = 'ses-b'",
        )
        .get(),
    ).toEqual({ created: '["T950"]', completed: '["T001"]' });
  });

  it('a received AUTOINCREMENT row drops the sender id and gets a local one (T12799)', () => {
    // The criterion the history rows point at: B's, received by A first.
    b.db
      .prepare(
        "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES ('ac-x', 'T001', 1, 'x', 'text', 'text:1:x')",
      )
      .run();
    const acX = (
      b.db.prepare("SELECT uid FROM tasks_task_acceptance_criteria WHERE id = 'ac-x'").get() as {
        uid: string;
      }
    ).uid;
    expect(receiveRow(a.db, wireRowOf(b.db, 'tasks_task_acceptance_criteria', acX)).status).toBe(
      'inserted',
    );
    const history = (db: DatabaseSync, text: string) => {
      db.prepare(
        "INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES ('ac-x', ?, 'edit')",
      ).run(text);
      return db
        .prepare(
          'SELECT id, uid FROM tasks_task_acceptance_criteria_history WHERE previous_text = ?',
        )
        .get(text) as { id: number; uid: string };
    };
    const onA = history(a.db, 'written on A');
    const onB = history(b.db, 'written on B');
    expect(onA.id).toBe(onB.id);
    const result = receiveRow(
      a.db,
      wireRowOf(b.db, 'tasks_task_acceptance_criteria_history', onB.uid),
    );
    expect(result.status).toBe('inserted');
    expect(result.status === 'inserted' && result.key).not.toBe(String(onA.id));
    expect(
      a.db
        .prepare(
          'SELECT previous_text AS t FROM tasks_task_acceptance_criteria_history WHERE uid IN (?, ?) ORDER BY id',
        )
        .all(onA.uid, onB.uid),
    ).toEqual([{ t: 'written on A' }, { t: 'written on B' }]);
    expect(listHeldRows(a.db)).toEqual([]);
  });

  it('a re-mint moves the version and keeps the claim; a guarded rename honours both (T12748)', () => {
    a.db
      .prepare(
        `UPDATE tasks_tasks SET claimed_by_session = 'ses-1', claimed_by_agent = 'agent-1',
           claimed_at = '2026-09-29T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z',
           updated_at = '2026-09-29T00:00:00.000Z' WHERE id = 'T003'`,
      )
      .run();
    const uid = (
      a.db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T003'").get() as { uid: string }
    ).uid;
    const claim = () =>
      a.db
        .prepare(
          'SELECT claimed_by_session, claimed_by_agent, claimed_at, lease_expires_at, updated_at FROM tasks_tasks WHERE uid = ?',
        )
        .get(uid) as Record<string, string>;
    const before = claim();
    const remint = (guard?: Parameters<typeof remintTaskDisplayId>[2]['guard']) =>
      remintTaskDisplayId(a.db, 'T003', {
        reason: 'manual',
        origin: 'device-a',
        hlc: clock(),
        guard,
      });
    expect(() => remint({ expectedUpdatedAt: '2026-09-01T00:00:00.000Z' })).toThrow();
    expect(() =>
      remint({ claim: { sessionId: 'ses-2', mode: 'acquire', now: '2026-09-29T01:00:00.000Z' } }),
    ).toThrow(/claim/i);
    expect(claim()).toEqual(before);
    const receipt = remint();
    const after = claim();
    expect(after.updated_at > (before.updated_at as string)).toBe(true);
    expect({ ...after, updated_at: null }).toEqual({ ...before, updated_at: null });
    expect(receipt.rewritten['tasks_task_dependencies.depends_on']).toBe(1);
  });
});

describe('uid collision: re-key the loser, every replica applies it (T12744, T12745, T12750)', () => {
  let env: TestDbEnv;
  const files: string[] = [];
  const open: DatabaseSync[] = [];

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Shared epic', type: 'epic', createdAt: '2026-09-20T09:00:00.000Z' },
    ]);
  });

  afterEach(async () => {
    for (const db of open.splice(0)) db.close();
    for (const f of files.splice(0)) rmSync(f, { force: true });
    await env.cleanup();
  });

  function copyOf(source: DatabaseSync, name: string): DatabaseSync {
    const path = join(env.tempDir, `${name}.db`);
    source.exec(`VACUUM INTO '${path}'`);
    files.push(path);
    const db = new DatabaseSync(path);
    open.push(db);
    prepareRowIdentity(db, 'project');
    return db;
  }

  /** An older build writes T100 and its family (no uids, same second); this build opens. */
  function family(db: DatabaseSync, tag: string): void {
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T100', ?, 'pending', 'medium', 'task', '2026-09-28 12:00:00')",
    ).run(`Work on device ${tag}`);
    db.prepare(
      "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key, created_at) VALUES (?, 'T100', 1, ?, 'text', 'text:1:x', '2026-09-28 12:00:00')",
    ).run(`ac-${tag}-1`, `criterion ${tag}`);
    db.prepare("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T100', ?)").run(
      `from-${tag}`,
    );
    addDep(db, 'T100', 'T001');
    prepareRowIdentity(db, 'project');
  }

  const identity = (db: DatabaseSync, where: string, ...args: string[]) =>
    db.prepare(`SELECT id, uid, birth_fp AS fp FROM tasks_tasks WHERE ${where}`).get(...args) as {
      id: string;
      uid: string;
      fp: string;
    };

  /** Identity values of every declared row (natural and minted), as comparable strings. */
  function dump(db: DatabaseSync, skip: readonly string[] = []): Set<string> {
    const out = new Set<string>();
    for (const spec of ROW_IDENTITY.project) {
      if (spec.table.endsWith('_aliases') || skip.includes(spec.table)) continue;
      const cols = [
        'uid',
        ...(spec.kind === 'minted' ? ['birth_fp'] : []),
        ...(spec.storedRefUids ?? []).map((r) => r.column),
      ];
      for (const row of db.prepare(`SELECT ${cols.join(', ')} FROM ${spec.table}`).all() as Record<
        string,
        unknown
      >[]) {
        out.add(`${spec.table}|${cols.map((c) => String(row[c])).join('|')}`);
      }
    }
    return out;
  }

  /** The wire rows of a task and everything keyed by it. */
  function wiresOf(db: DatabaseSync, taskUid: string): WireRow[] {
    const key = (
      db.prepare('SELECT id FROM tasks_tasks WHERE uid = ?').get(taskUid) as { id: string }
    ).id;
    const rows = (table: string) =>
      (db.prepare(`SELECT uid FROM ${table} WHERE task_id = ?`).all(key) as { uid: string }[]).map(
        (r) => wireRowOf(db, table, r.uid),
      );
    return [
      wireRowOf(db, 'tasks_tasks', taskUid),
      ...rows('tasks_task_acceptance_criteria'),
      ...rows('tasks_task_labels'),
      ...rows('tasks_task_dependencies'),
      ...rows('tasks_task_relations'),
    ];
  }

  it('winner-side and loser-side replicas converge on the authority receipt', () => {
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    const x = copyOf(native, 'x');
    const y = copyOf(native, 'y');
    family(x, 'X');
    family(y, 'Y');
    const ix = identity(x, "id = 'T100'");
    const iy = identity(y, "id = 'T100'");
    expect(ix.uid).toBe(iy.uid);
    expect(ix.fp).not.toBe(iy.fp);
    const [L, W, tagL] = ix.fp > iy.fp ? [x, y, 'X'] : [y, x, 'Y'];
    const U = ix.uid;
    const fpL = identity(L, "id = 'T100'").fp;
    const fpW = identity(W, "id = 'T100'").fp;

    // The loser's device grows a deep tree before anyone syncs: a random-uid
    // criterion, AC history and an evidence binding (stored ac_uid copies), a
    // relation, and a manual re-number (the key changes; an alias records it).
    L.prepare(
      "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES ('ac-L-new', 'T100', 2, 'added later', 'text', 'text:2:y')",
    ).run();
    const acL = `ac-${tagL}-1`;
    L.prepare(
      "INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES (?, 'old text', 'edit')",
    ).run(acL);
    L.prepare(
      "INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type) VALUES ('bind-1', 'atom-1', ?, 'direct')",
    ).run(acL);
    L.prepare(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T100', 'T001', 'related')",
    ).run();
    prepareRowIdentity(L, 'project');
    const renumber = remintTaskDisplayId(L, 'T100', {
      reason: 'manual',
      origin: 'dev-L',
      hlc: clock('dev-L'),
    });
    expect(renumber.newId).toBe('T101');

    const lWires = wiresOf(L, U);
    const wWires = wiresOf(W, U);
    const Z = copyOf(L, 'z'); // the authority: another replica holding the loser
    const oldAcs = Z.prepare(
      "SELECT uid FROM tasks_task_acceptance_criteria WHERE task_id = 'T101' ORDER BY uid",
    ).all() as { uid: string }[];
    expect(oldAcs).toHaveLength(2);

    // ---- Winner-side replica: the loser arrives and is held, refs included.
    expect(receiveRow(W, lWires[0] as WireRow)).toMatchObject({
      status: 'held',
      reason: 'uid-collision',
      collision: {
        kind: 'uid',
        uid: U,
        loserBirthFp: fpL,
        winnerBirthFp: fpW,
        localIsLoser: false,
      },
    });
    for (const w of lWires.slice(1)) expect(receiveRow(W, w).status).toBe('held');
    // A reference to the loser never lands on the winner (T12745).
    expect(W.prepare("SELECT label FROM tasks_task_labels WHERE task_id = 'T100'").all()).toEqual([
      { label: `from-${tagL === 'X' ? 'Y' : 'X'}` },
    ]);
    expect(W.prepare('SELECT count(*) AS n FROM tasks_task_relations').get()).toEqual({ n: 0 });
    // The winner is never re-keyed (T12744).
    expect(() => rekeyRowUid(W, 'tasks_tasks', U, fpW)).toThrow(/not the loser/);
    expect(() => rekeyRowUid(Z, 'tasks_tasks', U, fpW)).toThrow(/not the loser/);
    expect(() => rekeyRowUid(Z, 'tasks_tasks', U, 'f'.repeat(32))).toThrow(/No tasks_tasks row/);

    // ---- The authority re-keys the loser and publishes the receipt.
    const R = rekeyRowUid(Z, 'tasks_tasks', U, fpL, { origin: 'dev-Z', displacedHlc: clock('z') });
    expect(identity(Z, "id = 'T101'")).toEqual({ id: 'T101', uid: R.newUid, fp: fpL });
    // Children re-keyed from stored identity, although the owner's key changed.
    expect(R.cascaded.map((c) => [c.table, c.oldUid, c.newUid]).sort()).toEqual(
      oldAcs
        .map((ac) => [
          'tasks_task_acceptance_criteria',
          ac.uid,
          rekeyedChildUid('project', 'tasks_task_acceptance_criteria', ac.uid, R.newUid),
        ])
        .sort(),
    );
    const acLUid = (
      Z.prepare('SELECT uid FROM tasks_task_acceptance_criteria WHERE id = ?').get(acL) as {
        uid: string;
      }
    ).uid;
    for (const table of ['tasks_task_acceptance_criteria_history', 'tasks_evidence_ac_bindings']) {
      expect(Z.prepare(`SELECT ac_uid FROM ${table}`).all()).toEqual([{ ac_uid: acLUid }]);
    }
    // Natural rows re-derived and published, the display alias included.
    // Two display aliases move: the renumbered T100, and T101, the id the
    // manual re-mint assigned (its portable re-mint record, T12800).
    expect(R.natural.map((n) => n.table).sort()).toEqual([
      'tasks_display_id_aliases',
      'tasks_display_id_aliases',
      'tasks_task_dependencies',
      'tasks_task_labels',
      'tasks_task_relations',
    ]);
    expect(
      Z.prepare("SELECT entity_uid FROM tasks_display_id_aliases WHERE display_id = 'T100'").all(),
    ).toEqual([{ entity_uid: R.newUid }]);
    expect(Z.prepare("SELECT uid FROM tasks_task_labels WHERE task_id = 'T101'").get()).toEqual({
      uid: naturalRowUid('project', 'tasks_task_labels', [R.newUid, `from-${tagL}`]),
    });
    expect(Z.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // ---- Winner side applies the receipt: the held loser and its tree are placed.
    const onW = applyRekey(W, R);
    expect(onW.rows.map((r) => r.status)).toEqual(['applied-held', 'applied-held', 'applied-held']);
    expect(listHeldRows(W)).toEqual([]);
    expect(identity(W, "id = 'T100'")).toEqual({ id: 'T100', uid: U, fp: fpW });
    expect(identity(W, 'uid = ?', R.newUid)).toEqual({ id: 'T101', uid: R.newUid, fp: fpL });
    const history = [
      'tasks_task_acceptance_criteria_history',
      'tasks_evidence_ac_bindings',
    ] as const;
    const wRows = dump(W);
    for (const r of dump(Z, history)) expect(wRows, r).toContain(r);
    expect(W.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // ---- Loser side (not the authority): the winner arrives first and waits.
    expect(receiveRow(L, wWires[0] as WireRow)).toMatchObject({
      status: 'held',
      collision: { kind: 'uid', localIsLoser: true, loserBirthFp: fpL },
    });
    for (const w of wWires.slice(1)) expect(receiveRow(L, w).status).toBe('held');
    const onL = applyRekey(L, R);
    expect(onL.rows.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(listHeldRows(L)).toEqual([]);
    const lRows = dump(L);
    for (const r of dump(Z)) expect(lRows, r).toContain(r);
    expect(identity(L, 'uid = ?', U)).toEqual({ id: 'T100', uid: U, fp: fpW });
    // T100 is the winner's live id here; the loser's old number comes back as history.
    const t100 = resolveDisplayId(L, 'tasks_tasks', 'T100');
    expect(t100.status === 'resolved' && t100.alsoKnownAs.map((c) => [c.uid, c.currentId])).toEqual(
      [[R.newUid, 'T101']],
    );
    expect(L.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Idempotent.
    expect(applyRekey(L, R).rows.map((r) => r.status)).toEqual([
      'already-applied',
      'already-applied',
      'already-applied',
    ]);
  });
});

describe('remintAuthority (spec §9.2, T12750)', () => {
  const WINDOW = REMINT_TAKEOVER_MS;
  const replicas = [
    { id: 'dev-c', joinedHlc: hlcAt(0) },
    { id: 'dev-a', joinedHlc: hlcAt(0), retiredHlc: hlcAt(WINDOW / 2) },
    { id: 'dev-b', joinedHlc: hlcAt(0) },
    { id: 'dev-d', joinedHlc: hlcAt(10 * WINDOW) },
  ];
  const at = (ms: number, origin: string | null = 'dev-c', list = replicas) =>
    remintAuthority({
      cloudSynced: false,
      origin,
      replicas: list,
      collisionHlc: hlcAt(1),
      atHlc: hlcAt(1 + ms),
    });

  it('the server when the project syncs', () => {
    expect(
      remintAuthority({
        cloudSynced: true,
        origin: 'dev-c',
        replicas,
        collisionHlc: hlcAt(1),
        atHlc: hlcAt(2),
      }).authority,
    ).toBe('server');
  });

  it('the origin inside its window, then each other active replica in turn, cycling', () => {
    expect(at(0)).toEqual({ authority: 'dev-c', reason: 'origin', slot: 0 });
    expect(at(WINDOW - 1).authority).toBe('dev-c');
    // dev-a retired at WINDOW/2 and dev-d joins at 10 windows: the chain is [dev-b].
    expect(at(WINDOW)).toEqual({ authority: 'dev-b', reason: 'fallback', slot: 1 });
    expect(at(2 * WINDOW).authority).toBe('dev-b');
    // Once dev-d is a member, a silent fallback loses its turn when its window ends.
    expect(at(11 * WINDOW)).toEqual({ authority: 'dev-b', reason: 'fallback', slot: 11 });
    expect(at(12 * WINDOW)).toEqual({ authority: 'dev-d', reason: 'fallback', slot: 12 });
    expect(at(13 * WINDOW).authority).toBe('dev-b');
  });

  it('no origin, or a retired one, goes to the chain at once', () => {
    expect(at(0, null)).toEqual({ authority: 'dev-a', reason: 'fallback', slot: 1 });
    expect(at(0, 'dev-a')).toEqual({ authority: 'dev-a', reason: 'origin', slot: 0 });
    expect(at(WINDOW - 1, 'dev-a')).toEqual({ authority: 'dev-b', reason: 'fallback', slot: 1 });
  });

  it('pre-HLC rows anchor the schedule at the later birth (T12802)', () => {
    const t0 = BASE_MS + 1000;
    const anchor = collisionHlcFromBirths(t0, t0 + 500);
    expect(anchor).toMatch(/^\d{13}-000000-00000000-0000-0000-0000-000000000000$/);
    expect(anchor).toBe(collisionHlcFromBirths(t0 + 500, t0));
    expect(
      remintAuthority({
        cloudSynced: false,
        origin: 'dev-c',
        replicas,
        collisionHlc: anchor,
        atHlc: hlcAt(1500 + WINDOW),
      }),
    ).toMatchObject({ reason: 'fallback', slot: 1 });
  });

  it('is the same on every replica for the same inputs', () => {
    const shuffled = [...replicas].reverse();
    for (const ms of [0, WINDOW, 3 * WINDOW, 11 * WINDOW]) {
      expect(at(ms, 'dev-c', shuffled)).toEqual(at(ms));
    }
  });
});

describe('references the sender no longer resolves (T12798 review, probe 1753)', () => {
  let env: TestDbEnv;
  let a: DatabaseSync;
  let b: DatabaseSync;
  let bPath: string;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Shared', type: 'task', createdAt: '2026-09-20T09:00:00.000Z' },
    ]);
    a = getNativeTasksDb(env.tempDir) as DatabaseSync;
    bPath = join(env.tempDir, 'b.db');
    a.exec(`VACUUM INTO '${bPath}'`);
    b = new DatabaseSync(bPath);
    prepareRowIdentity(b, 'project');
  });

  afterEach(async () => {
    b.close();
    rmSync(bPath, { force: true });
    await env.cleanup();
  });

  it('Q1: history of a criterion deleted on the sender is placed, with its uid carried and no live ac_id', () => {
    b.prepare(
      "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES ('ac-z','T001',1,'z','text','text:1:z')",
    ).run();
    b.prepare(
      "INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES ('ac-z','z','delete')",
    ).run();
    b.prepare("DELETE FROM tasks_task_acceptance_criteria WHERE id='ac-z'").run();
    const h = b.prepare('SELECT uid, ac_uid FROM tasks_task_acceptance_criteria_history').get() as {
      uid: string;
      ac_uid: string;
    };
    const wire = wireRowOf(b, 'tasks_task_acceptance_criteria_history', h.uid);
    expect(wire.values).not.toHaveProperty('ac_id');
    expect(wire.refs?.ac_uid).toMatchObject({ uid: h.ac_uid, gone: true });
    expect(receiveRow(a, wire).status).toBe('inserted');
    expect(listHeldRows(a)).toEqual([]);
    expect(
      a
        .prepare('SELECT ac_id, ac_uid FROM tasks_task_acceptance_criteria_history WHERE uid = ?')
        .get(h.uid),
    ).toEqual({ ac_id: `gone:${h.ac_uid}`, ac_uid: h.ac_uid });
  });

  it('Q2: a session whose id array names a task the sender no longer has syncs without it', () => {
    b.prepare(
      `INSERT INTO tasks_sessions (id, name, tasks_created_json, tasks_completed_json)
       VALUES ('ses-b', 's', '["T001"]', '["T999"]')`,
    ).run();
    const s = b.prepare("SELECT uid FROM tasks_sessions WHERE id='ses-b'").get() as { uid: string };
    const wire = wireRowOf(b, 'tasks_sessions', s.uid);
    expect(wire.jsonRefs?.tasks_completed_json).toEqual([]);
    expect(receiveRow(a, wire).status).toBe('inserted');
    expect(
      a
        .prepare(
          "SELECT tasks_created_json AS created, tasks_completed_json AS completed FROM tasks_sessions WHERE id='ses-b'",
        )
        .get(),
    ).toEqual({ created: '["T001"]', completed: '[]' });
  });

  it('Q3: an orphan recorded ac_uid never attaches to another criterion holding that uid', () => {
    b.prepare(
      "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key) VALUES ('ac-b','T001',1,'b-text','text','text:1:b')",
    ).run();
    b.prepare(
      "INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type) VALUES ('bind-b','tool:test','ac-b','direct')",
    ).run();
    const acU = (
      b.prepare("SELECT uid FROM tasks_task_acceptance_criteria WHERE id='ac-b'").get() as {
        uid: string;
      }
    ).uid;
    b.prepare("DELETE FROM tasks_task_acceptance_criteria WHERE id='ac-b'").run();
    const bind = b
      .prepare("SELECT uid FROM tasks_evidence_ac_bindings WHERE id='bind-b'")
      .get() as {
      uid: string;
    };
    // A holds a DIFFERENT criterion under the same uid (the other side of a collision).
    a.prepare(
      "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key, uid, birth_fp) VALUES ('ac-a','T001',1,'a-text','text','text:1:a',?, 'other-fp')",
    ).run(acU);
    const wire = wireRowOf(b, 'tasks_evidence_ac_bindings', bind.uid);
    expect(wire.refs?.ac_uid).toMatchObject({ uid: acU, gone: true });
    expect(wire.refs?.ac_uid?.birthFp).not.toBe('other-fp');
    expect(receiveRow(a, wire)).toMatchObject({ status: 'held', reason: 'ref-pending' });
    expect(
      a.prepare("SELECT count(*) AS n FROM tasks_evidence_ac_bindings WHERE id='bind-b'").get(),
    ).toEqual({
      n: 0,
    });
    // A reference that names a uid but no fingerprint never matches a minted row.
    expect(
      receiveRow(a, {
        ...wire,
        uid: 'no-fp',
        refs: { ...wire.refs, ac_uid: { uid: acU, birthFp: null } },
      }),
    ).toMatchObject({ status: 'held', reason: 'ref-pending' });
  });

  it('a row from a v1 sender (raw local keys in its values) is recognised and held', () => {
    const t = b.prepare("SELECT uid FROM tasks_tasks WHERE id='T001'").get() as { uid: string };
    const { version: _v, ...v1 } = wireRowOf(b, 'tasks_tasks', t.uid);
    expect(
      receiveRow(a, { ...v1, uid: 'from-v1', values: { ...v1.values, id: 'T777' } }),
    ).toMatchObject({
      status: 'held',
      reason: 'unsupported-wire',
    });
    expect(listHeldRows(a).map((h) => [h.reason, h.contestedId])).toEqual([
      ['unsupported-wire', 'wire v1'],
    ]);
  });
});
