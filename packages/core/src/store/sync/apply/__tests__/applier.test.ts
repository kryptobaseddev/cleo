/**
 * The inbox and the applier loop (T12344 PR-3; journal spec §3.1, §3.2,
 * §2.9, §1.3).
 *
 * Real project `cleo.db` stores with capture and seal on, under a `mkdtemp`
 * directory. Remote transactions are staged as a receiver would stage them
 * and applied by {@link applyStagedTxns}; the sealer then proves nothing is
 * echoed back.
 *
 * @task T12344
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../../capture.js';
import { listConflicts } from '../../conflicts.js';
import {
  actorOpOf,
  localLeaves,
  readFieldFrontiers,
  readFieldLeaves,
  recordFieldLeaves,
} from '../../field-leave.js';
import { setSyncFlag } from '../../flags.js';
import { type InboxSegment, inboxCounts, stagedTxns, stageTxns } from '../../inbox.js';
import { readRowMeta } from '../../row-meta.js';
import { sealPending } from '../../sealer.js';
import { applyStagedTxns } from '../applier.js';
import { syncSetChildKeys } from '../fk.js';
import { ON_REMOTE_PARENT_DELETE } from '../parent-delete.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const LOCAL = '01929a3e-7f00-7000-8000-000000000001';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';
const STREAM = 'project:test';
const T0 = 1_790_000_000_000;
let clock = T0;

/** An HLC `ms` after T0 issued by `replica`. */
const h = (ms: number, replica = R1): string =>
  `${String(T0 + ms).padStart(13, '0')}-000000-${replica}`;

let dir: string;

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(join(tmpdir(), 'cleo-applier-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(name = 'project'): Promise<DatabaseSync> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, name, '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

/** Seal for real; a refused seal would make "seals nothing" vacuous. */
function seal(db: DatabaseSync) {
  const r = sealPending(db, {
    scope: 'project',
    replica: LOCAL,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null, 'sealing was refused').toBeNull();
  return r;
}

function txn(id: string, ops: LedgerOp[], extra: Partial<LedgerTxn> = {}): LedgerTxn {
  const hlc = ops.reduce((m, o) => (o.h > m ? o.h : m), ops[0]?.h ?? h(0));
  return {
    v: 1,
    txn: id,
    hlc,
    project: null,
    scope: 'project',
    via: 'accessor',
    kind: 'write',
    actor: null,
    ops,
    sig: '',
    ...extra,
  };
}

let seq = 0;
function segment(replicaId: string, txns: LedgerTxn[], schemaVersion = SYNC_SCHEMA_VERSION) {
  seq += 1;
  const s: InboxSegment = {
    seq,
    replicaId,
    replicaSeq: seq,
    deviceId: `dev-${replicaId.slice(0, 4)}`,
    schemaVersion,
    txns,
  };
  return s;
}

const insert = (uid: string, at: string, a: Record<string, string> = {}): LedgerOp => ({
  t: 'tasks_tasks',
  u: uid,
  o: 'I',
  h: at,
  a: {
    id: uid.toUpperCase(),
    title: `title ${uid}`,
    type: 'task',
    status: 'pending',
    priority: 'medium',
    birth_fp: `fp-${uid}`,
    ...a,
  },
});
/** A status change as the sealer emits it: the whole status group (T13222). */
const grp = (status: string): Record<string, string | null> => ({
  status,
  completed_at: null,
  cancelled_at: null,
  cancellation_reason: null,
});
const update = (uid: string, at: string, a: Record<string, string | null>): LedgerOp => ({
  t: 'tasks_tasks',
  u: uid,
  o: 'U',
  h: at,
  a,
});
const del = (uid: string, at: string): LedgerOp => ({ t: 'tasks_tasks', u: uid, o: 'D', h: at });

function stage(db: DatabaseSync, s: InboxSegment): number {
  return stageTxns(db, STREAM, s, new Date(clock).toISOString());
}

function apply(db: DatabaseSync, nowMs = T0 + 60_000) {
  return applyStagedTxns(db, {
    scope: 'project',
    stream: STREAM,
    replica: LOCAL,
    now: () => nowMs,
    seal: () => seal(db),
  });
}

const task = (db: DatabaseSync, uid: string) =>
  db.prepare('SELECT id, title, status, pipeline_stage FROM tasks_tasks WHERE uid = ?').get(uid) as
    | { id: string; title: string; status: string; pipeline_stage: string | null }
    | undefined;

const statuses = (db: DatabaseSync) =>
  (
    db
      .prepare('SELECT seq, txn_idx, status FROM _sync_inbox ORDER BY seq, txn_idx')
      .all() as Array<{ seq: number; txn_idx: number; status: string }>
  ).map((r) => `${r.seq}.${r.txn_idx}:${r.status}`);

describe('applyStagedTxns: insert, update, delete (§3.2)', () => {
  it('applies each, sets row meta from the stream, and the sealer echoes nothing', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('r1', h(1))])]));
    const r = apply(db);
    expect(r).toMatchObject({ applied: 1, pending: 0, conflicts: 0 });
    expect(task(db, 'r1')).toMatchObject({ title: 'title r1', status: 'pending' });
    expect(readRowMeta(db, 'tasks_tasks', 'r1')).toMatchObject({
      hlc: h(1),
      fhlc: null,
      deleted: 0,
      version: 1,
    });
    expect(seal(db).txns, 'the applied insert was echoed').toBe(0);

    stage(db, segment(R2, [txn('R2:1', [update('r1', h(5, R2), { title: 'renamed' })])]));
    expect(apply(db).applied).toBe(1);
    expect(task(db, 'r1')?.title).toBe('renamed');
    const meta = readRowMeta(db, 'tasks_tasks', 'r1');
    expect(meta?.hlc).toBe(h(5, R2));
    expect(JSON.parse(meta?.fhlc ?? '{}')).toMatchObject({ status: h(1) });
    expect(seal(db).txns, 'the applied update was echoed').toBe(0);

    stage(db, segment(R1, [txn('R1:2', [del('r1', h(9))])]));
    expect(apply(db).applied).toBe(1);
    expect(task(db, 'r1')).toBeUndefined();
    expect(readRowMeta(db, 'tasks_tasks', 'r1')).toMatchObject({ hlc: h(9), deleted: 1 });
    expect(seal(db).txns, 'the applied delete was echoed').toBe(0);
    expect(statuses(db)).toEqual(['1.0:applied', '2.0:applied', '3.0:applied']);
  });

  it('an older write loses field by field, and a late op never resurrects a deleted row', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [insert('r1', h(1))]),
        txn('R1:2', [update('r1', h(10), { title: 'newer' })]),
      ]),
    );
    stage(db, segment(R2, [txn('R2:1', [update('r1', h(5, R2), { title: 'older' })])]));
    apply(db);
    expect(task(db, 'r1')?.title).toBe('newer');
    expect(readRowMeta(db, 'tasks_tasks', 'r1')?.hlc).toBe(h(10));

    stage(db, segment(R1, [txn('R1:3', [del('r1', h(20))])]));
    stage(db, segment(R2, [txn('R2:2', [insert('r1', h(15, R2))])]));
    apply(db);
    expect(task(db, 'r1')).toBeUndefined();
    expect(readRowMeta(db, 'tasks_tasks', 'r1')).toMatchObject({ hlc: h(20), deleted: 1 });
  });

  it('a delete over a newer edit keeps the delete HLC as the tombstone', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('r1', h(1))])]));
    stage(db, segment(R2, [txn('R2:1', [update('r1', h(30, R2), { title: 'late edit' })])]));
    stage(db, segment(R1, [txn('R1:2', [del('r1', h(20))])]));
    const r = apply(db);
    expect(r.conflict).toBe(1);
    expect(task(db, 'r1')).toBeUndefined();
    expect(readRowMeta(db, 'tasks_tasks', 'r1')).toMatchObject({ hlc: h(20), deleted: 1 });
    expect(listConflicts(db).map((c) => c.kind)).toEqual(['delete-vs-edit']);
    // An insert between the delete and the edit revives the row on every replica.
    stage(db, segment(R3, [txn('R3:1', [insert('r1', h(25, R3), { title: 'revived' })])]));
    apply(db);
    expect(task(db, 'r1')?.title).toBe('revived');
  });
});

describe('convergence and exactly-once (§2.9)', () => {
  const stream = (): InboxSegment[] => {
    seq = 0;
    return [
      segment(R1, [txn('R1:1', [insert('a', h(1)), insert('b', h(2))])]),
      segment(R2, [txn('R2:1', [update('a', h(8, R2), { title: 'r2 title' })])]),
      segment(R1, [txn('R1:2', [update('a', h(6), { title: 'r1 title', priority: 'high' })])]),
      segment(R3, [txn('R3:1', [del('b', h(9, R3))])]),
      segment(R2, [txn('R2:2', [update('b', h(4, R2), { title: 'too late' })])]),
    ];
  };
  const snapshot = (db: DatabaseSync) => ({
    rows: db
      .prepare("SELECT uid, title, priority, status FROM tasks_tasks WHERE uid IN ('a','b')")
      .all(),
    meta: db
      .prepare(
        "SELECT uid, hlc, fhlc, deleted FROM _sync_row_meta WHERE uid IN ('a','b') ORDER BY uid",
      )
      .all(),
  });

  it('two stores applying the same stream, in different batches, converge', async () => {
    const a = await store('a');
    const b = await store('b');
    for (const s of stream()) stage(a, s);
    apply(a);
    const segs = stream();
    for (const s of segs.slice(0, 2)) stage(b, s);
    apply(b);
    for (const s of segs.slice(2)) stage(b, s);
    apply(b);
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(snapshot(a).rows).toEqual([
      { uid: 'a', title: 'r2 title', priority: 'high', status: 'pending' },
    ]);
  });

  it('a re-pull stages nothing twice and a second apply changes nothing', async () => {
    const db = await store();
    const segs = stream();
    for (const s of segs) stage(db, s);
    expect(segs.map((s) => stage(db, s))).toEqual([0, 0, 0, 0, 0]);
    apply(db);
    const before = snapshot(db);
    const versions = db.prepare('SELECT uid, version FROM _sync_row_meta ORDER BY uid').all();
    const again = apply(db);
    expect(again).toMatchObject({ applied: 0, pending: 0, conflicts: 0 });
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('SELECT uid, version FROM _sync_row_meta ORDER BY uid').all()).toEqual(
      versions,
    );
  });
});

describe('typed rules and conflict records (§3.6)', () => {
  it('a non-leave write onto a done task is void with a typed-rule conflict; a reopen applies', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [insert('t1', h(1), { status: 'done', pipeline_stage: 'contribution' })]),
      ]),
    );
    stage(db, segment(R2, [txn('R2:1', [update('t1', h(5, R2), grp('active'))])]));
    const r = apply(db);
    expect(r).toMatchObject({ applied: 1, void: 1, conflicts: 1 });
    expect(task(db, 't1')?.status).toBe('done');
    const [c] = listConflicts(db, { open: true });
    expect(c).toMatchObject({
      kind: 'typed-rule',
      rule: 'task.status.absorbing',
      table: 'tasks_tasks',
      uid: 't1',
      resolution: 'incoming-dropped',
      origin: R2,
      seq: 2,
      txnIdx: 0,
      opIdx: 0,
    });
    expect(statuses(db)).toEqual(['1.0:applied', '2.0:void']);

    stage(
      db,
      segment(R3, [
        txn('R3:1', [update('t1', h(10, R3), grp('active'))], {
          actor: { op: 'tasks.reopen' },
        }),
      ]),
    );
    expect(apply(db).applied).toBe(1);
    expect(task(db, 't1')?.status).toBe('active');
    expect(readFieldLeaves(db, 'tasks_tasks', 't1')).toEqual({ status: h(10, R3) });
  });

  it('the stored leave stops an older absorbing write from overriding a reopen', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [insert('t1', h(1), { status: 'done', pipeline_stage: 'contribution' })]),
      ]),
    );
    stage(
      db,
      segment(R3, [
        txn('R3:1', [update('t1', h(10, R3), grp('active'))], {
          actor: { op: 'tasks.reopen' },
        }),
      ]),
    );
    apply(db);
    // A concurrent completion older than the reopen arrives in a later pass.
    stage(db, segment(R2, [txn('R2:1', [update('t1', h(8, R2), grp('done'))])]));
    apply(db);
    expect(task(db, 't1')?.status).toBe('active');
  });
});

describe('review fixes carried into apply (T13222, T13223)', () => {
  it('a sealer-shaped insert carries birth_fp as bfp, and the applied row gets it', async () => {
    const db = await store();
    const op = insert('b1', h(1));
    const { birth_fp: _fp, ...a } = op.a ?? {};
    stage(db, segment(R1, [txn('R1:1', [{ ...op, a, bfp: 'fp-sealed' }])]));
    expect(apply(db).applied).toBe(1);
    expect(db.prepare("SELECT birth_fp FROM tasks_tasks WHERE uid = 'b1'").get()).toEqual({
      birth_fp: 'fp-sealed',
    });
    expect(seal(db).txns, 'the applied insert was echoed').toBe(0);
  });

  it('a partial status group is refused-schema with the missing members named', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('t1', h(1))])]));
    stage(db, segment(R2, [txn('R2:1', [update('t1', h(5, R2), { status: 'active' })])]));
    expect(apply(db)).toMatchObject({ applied: 1, refusedSchema: 1 });
    expect(db.prepare('SELECT reason FROM _sync_inbox WHERE seq = 2').get()).toEqual({
      reason: 'tasks_tasks/t1: malformed column(s) cancellation_reason, cancelled_at, completed_at',
    });
  });

  it('the rank-max frontier persists across apply calls, so a late restore finds the next best', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('s1', h(1), { pipeline_stage: 'research' })])]));
    stage(db, segment(R1, [txn('R1:2', [update('s1', h(5), { pipeline_stage: 'release' })])]));
    stage(
      db,
      segment(R2, [txn('R2:1', [update('s1', h(20, R2), { pipeline_stage: 'implementation' })])]),
    );
    apply(db);
    expect(task(db, 's1')?.pipeline_stage).toBe('release');
    // A restore at h10 kills release@h5; implementation@h20 is still alive.
    stage(
      db,
      segment(R3, [
        txn('R3:1', [update('s1', h(10, R3), { pipeline_stage: 'research' })], {
          actor: { op: 'tasks.restore' },
        }),
      ]),
    );
    apply(db);
    expect(task(db, 's1')?.pipeline_stage).toBe('implementation');
    // The winner keeps its own HLC, the row's newest.
    expect(readRowMeta(db, 'tasks_tasks', 's1')?.hlc).toBe(h(20, R2));
  });

  it('a local stage advance joins the stored frontier, and the next remote op keeps it (T13232)', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('s2', h(1), { pipeline_stage: 'research' })])]));
    stage(
      db,
      segment(R1, [txn('R1:2', [update('s2', h(5), { pipeline_stage: 'implementation' })])]),
    );
    stage(db, segment(R2, [txn('R2:1', [update('s2', h(9, R2), { pipeline_stage: 'research' })])]));
    apply(db);
    expect(Object.keys(readFieldFrontiers(db, 'tasks_tasks', 's2'))).toEqual(['pipeline_stage']);
    // The user advances the stage locally.
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', null);
    db.prepare("UPDATE tasks_tasks SET pipeline_stage = 'testing' WHERE uid = 's2'").run();
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    seal(db);
    // testing dominates both stored candidates: the frontier collapses.
    expect(readFieldFrontiers(db, 'tasks_tasks', 's2')).toEqual({});
    stage(
      db,
      segment(R2, [txn('R2:2', [update('s2', h(15, R2), { pipeline_stage: 'validation' })])]),
    );
    apply(db);
    expect(task(db, 's2')?.pipeline_stage).toBe('testing');
  });

  it("this replica's own echo is applied without re-applying its counter deltas", async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('e9', h(1))])]));
    // A $inc on a plain column is malformed; an own echo drops it before the merge.
    stage(
      db,
      segment(LOCAL, [
        txn('L:1', [
          {
            ...update('e9', h(3, LOCAL), { title: 'mine' }),
            a: { title: 'mine', priority: { $inc: 1 } },
          },
        ]),
      ]),
    );
    expect(apply(db)).toMatchObject({ applied: 2, refusedSchema: 0 });
    expect(task(db, 'e9')?.title).toBe('mine');
  });

  it("a child D whose row the parent's local cascade already removed applies as a tombstone", async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('c1', h(1))])]));
    apply(db);
    // The row vanishes locally without a delete op reaching meta (an FK cascade).
    db.exec('BEGIN IMMEDIATE');
    db.prepare("DELETE FROM tasks_tasks WHERE uid = 'c1'").run();
    db.exec('COMMIT');
    db.prepare("DELETE FROM _sync_capture WHERE tbl = 'tasks_tasks'").run();
    stage(db, segment(R1, [txn('R1:2', [del('c1', h(3))])]));
    expect(apply(db)).toMatchObject({ applied: 1, pending: 0 });
    expect(readRowMeta(db, 'tasks_tasks', 'c1')).toMatchObject({ deleted: 1, hlc: h(3) });
  });
});

describe('terminal stages merge with their status (T877)', () => {
  it('a remote cancel and a remote completion apply over an advanced stage, never a guard void', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [
          insert('x1', h(1), { pipeline_stage: 'testing' }),
          insert('x2', h(1), { pipeline_stage: 'release' }),
        ]),
      ]),
    );
    apply(db);
    stage(
      db,
      segment(R2, [
        txn('R2:1', [
          update('x1', h(5, R2), {
            ...grp('cancelled'),
            cancelled_at: '2026-10-05T00:00:00.000Z',
            pipeline_stage: 'cancelled',
          }),
          update('x2', h(5, R2), {
            ...grp('done'),
            completed_at: '2026-10-05T00:00:00.000Z',
            pipeline_stage: 'contribution',
          }),
        ]),
      ]),
    );
    expect(apply(db)).toMatchObject({ applied: 1, conflict: 0, void: 0 });
    expect(task(db, 'x1')).toMatchObject({ status: 'cancelled', pipeline_stage: 'cancelled' });
    expect(task(db, 'x2')).toMatchObject({ status: 'done', pipeline_stage: 'contribution' });
    expect(listConflicts(db)).toEqual([]);
  });
});

describe('pending, holds and retries (§3.2)', () => {
  it('an update of a never-seen row waits, and applies once its insert arrives', async () => {
    const db = await store();
    stage(db, segment(R2, [txn('R2:1', [update('p1', h(5, R2), { title: 'edited' })])]));
    expect(apply(db)).toMatchObject({ pending: 1, applied: 0 });
    expect(task(db, 'p1')).toBeUndefined();
    expect(statuses(db)).toEqual(['1.0:pending']);

    stage(db, segment(R1, [txn('R1:1', [insert('p1', h(1))])]));
    const r = apply(db);
    expect(r).toMatchObject({ applied: 2, pending: 0 });
    expect(r.passes).toBeGreaterThan(1);
    expect(task(db, 'p1')?.title).toBe('edited');
  });

  it('a pending transaction holds later writes of its rows, not independent ones', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('e1', h(1))])]));
    // R2:2 edits e1 and updates never-seen p1: the whole transaction waits.
    stage(
      db,
      segment(R2, [
        txn('R2:2', [
          update('e1', h(3, R2), { title: 'pending' }),
          update('p1', h(4, R2), { title: 'x' }),
        ]),
      ]),
    );
    // R3:1 alone could apply; it writes e1, which the pending R2:2 writes too.
    stage(db, segment(R3, [txn('R3:1', [update('e1', h(6, R3), { priority: 'high' })])]));
    stage(db, segment(R3, [txn('R3:2', [insert('z1', h(7, R3))])]));
    const r = apply(db);
    expect(statuses(db)).toEqual(['1.0:applied', '2.0:pending', '3.0:pending', '4.0:applied']);
    expect(r).toMatchObject({ pending: 2, applied: 2 });
    expect(task(db, 'e1'), 'a pending transaction wrote part of itself').toMatchObject({
      title: 'title e1',
    });
    expect(db.prepare("SELECT priority FROM tasks_tasks WHERE uid = 'e1'").get()).toEqual({
      priority: 'medium',
    });
    expect(db.prepare('SELECT reason FROM _sync_inbox WHERE seq = 3').get()).toEqual({
      reason: 'waits on a pending transaction writing tasks_tasks/e1',
    });
  });

  it('a split transaction applies only once every part is staged, in one frame', async () => {
    const db = await store();
    const p1 = txn('R1:9', [insert('s1', h(1))], { part: [1, 2] });
    const p2 = txn('R1:9', [update('s1', h(2), { title: 'part two' })], { part: [2, 2] });
    stage(db, segment(R1, [p1]));
    expect(stagedTxns(db, STREAM)).toEqual([]);
    expect(apply(db).applied).toBe(0);
    stage(db, segment(R1, [p2]));
    const [joined] = stagedTxns(db, STREAM);
    expect(joined?.parts).toHaveLength(2);
    expect(joined?.txn.ops).toHaveLength(2);
    apply(db);
    expect(task(db, 's1')?.title).toBe('part two');
    const frames = db.prepare('SELECT DISTINCT applied_frame AS f FROM _sync_inbox').all();
    expect(frames).toHaveLength(1);
  });
});

describe('schema and skew refusals (§2.9, §1.3)', () => {
  it('a newer segment schema, a newer txn format and an unknown column are refused-schema', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('x1', h(1))])], SYNC_SCHEMA_VERSION + 1));
    stage(db, segment(R1, [txn('R1:2', [insert('x2', h(2))], { v: 2 })]));
    stage(db, segment(R1, [txn('R1:3', [insert('x3', h(3), { no_such_column: 'v' })])]));
    const r = apply(db);
    expect(r).toMatchObject({ refusedSchema: 3, applied: 0 });
    expect(inboxCounts(db, STREAM)).toEqual({ 'refused-schema': 3 });
    expect(db.prepare("SELECT count(*) AS n FROM tasks_tasks WHERE uid LIKE 'x%'").get()).toEqual({
      n: 0,
    });
    const reasons = db.prepare('SELECT reason FROM _sync_inbox ORDER BY seq').all() as Array<{
      reason: string;
    }>;
    expect(reasons[0]?.reason).toMatch(/^E_SCHEMA_AHEAD/);
    expect(reasons[2]?.reason).toMatch(/no_such_column/);
  });

  it('a txn from a newer writer with an unknown field is refused-schema, and the stream flows (T13234)', async () => {
    const db = await store();
    const future = {
      ...txn('R1:1', [insert('f1', h(1))]),
      v: 2,
      ops: [{ ...insert('f1', h(1)), zz_future: 1 }],
    };
    db.prepare(
      `INSERT INTO _sync_inbox (stream, seq, txn_idx, replica_id, replica_seq, device_id,
         schema_version, txn_json, hlc, status, staged_at)
       VALUES (?, 1, 0, ?, 1, 'dev', ?, ?, ?, 'staged', 'now')`,
    ).run(STREAM, R1, SYNC_SCHEMA_VERSION, JSON.stringify(future), h(1));
    seq = 1;
    stage(db, segment(R2, [txn('R2:1', [insert('n1', h(2, R2))])]));
    expect(apply(db)).toMatchObject({ applied: 1 });
    expect(task(db, 'n1')).toBeDefined();
    expect(statuses(db)).toEqual(['1.0:refused-schema', '2.0:applied']);
    expect(db.prepare('SELECT reason FROM _sync_inbox WHERE seq = 1').get()).toEqual({
      reason: expect.stringMatching(/^E_SCHEMA_AHEAD/),
    });
  });

  it('holds a skewed replica FIFO while others flow, and releases it in order', async () => {
    const db = await store();
    const ahead = 10 * 60 * 1000;
    stage(db, segment(R2, [txn('R2:1', [insert('k1', h(ahead, R2))])]));
    // In bounds itself, but behind R2's held head: FIFO keeps R2's order.
    stage(db, segment(R2, [txn('R2:2', [insert('k2', h(10, R2))])]));
    stage(db, segment(R3, [txn('R3:1', [insert('k3', h(5, R3))])]));
    const r = apply(db, T0 + 1000);
    expect(r).toMatchObject({ heldSkew: 2, applied: 1 });
    expect(statuses(db)).toEqual(['1.0:held-skew', '2.0:held-skew', '3.0:applied']);
    const later = apply(db, T0 + ahead);
    expect(later.applied).toBe(2);
    expect(task(db, 'k1')).toBeDefined();
    expect(task(db, 'k2')).toBeDefined();
  });
});

describe('local leaves (field-leave)', () => {
  it('a reopen-like op moving status off an absorbing state is a leave; others are not', () => {
    const op = { a: { status: 'active' }, b: { status: 'done' }, h: h(4) };
    expect(localLeaves('tasks_tasks', op, 'tasks.reopen')).toEqual({ status: h(4) });
    expect(localLeaves('tasks_tasks', op, 'tasks.update')).toEqual({});
    expect(localLeaves('tasks_tasks', { ...op, b: { status: 'pending' } }, 'tasks.reopen')).toEqual(
      {},
    );
    expect(
      localLeaves('tasks_tasks', { ...op, a: { status: 'cancelled' } }, 'tasks.reopen'),
    ).toEqual({});
    expect(localLeaves('brain_observations', op, 'tasks.reopen')).toEqual({});
    // A repair U carries no before-image (#1879 unknownBefore): no leave inferred.
    expect(
      localLeaves('tasks_tasks', { a: { status: 'active' }, h: h(4) }, 'tasks.reopen'),
    ).toEqual({});
    // A rank-max restore raises the stage's floor.
    expect(
      localLeaves('tasks_tasks', { a: { pipeline_stage: 'research' }, h: h(6) }, 'tasks.restore'),
    ).toEqual({ pipeline_stage: h(6) });
  });

  it('the sealer records the leave of a local reopen, and a local delete clears it', async () => {
    const db = await store();
    const write = (actor: string | null, sql: string): void => {
      db.exec('BEGIN IMMEDIATE');
      const frame = openCaptureFrame(db, 'write', actor);
      db.exec(sql);
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
    };
    write(
      null,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, pipeline_stage, uid, birth_fp)
       VALUES ('L1', 'local', 'task', 'done', 'medium', 'contribution', 'l1', 'fp-l1')`,
    );
    seal(db);
    write('{"op":"tasks.update"}', "UPDATE tasks_tasks SET title = 'edited' WHERE uid = 'l1'");
    seal(db);
    expect(readFieldLeaves(db, 'tasks_tasks', 'l1')).toEqual({});
    write('{"op":"tasks.reopen"}', "UPDATE tasks_tasks SET status = 'active' WHERE uid = 'l1'");
    seal(db);
    const meta = readRowMeta(db, 'tasks_tasks', 'l1');
    expect(readFieldLeaves(db, 'tasks_tasks', 'l1')).toEqual({ status: meta?.hlc });
    write(null, "DELETE FROM tasks_tasks WHERE uid = 'l1'");
    seal(db);
    expect(readFieldLeaves(db, 'tasks_tasks', 'l1')).toEqual({});
  });

  it('reads the op of a JSON actor only', () => {
    expect(actorOpOf('{"agent":"a","op":"tasks.reopen"}')).toBe('tasks.reopen');
    expect(actorOpOf('fk_orphans')).toBeNull();
    expect(actorOpOf('{not json')).toBeNull();
    expect(actorOpOf(null)).toBeNull();
  });
});

describe('PR-4: references, guards, parent deletes and re-keys (§3.2)', () => {
  const fkOn = (db: DatabaseSync): void => {
    db.exec('PRAGMA foreign_keys = ON');
  };
  const parentOf = (db: DatabaseSync, uid: string) =>
    (
      db.prepare('SELECT parent_id AS p FROM tasks_tasks WHERE uid = ?').get(uid) as {
        p: string | null;
      }
    ).p;

  it('a reference travels as a uid and is stored as the local key, with no echo', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('p1', h(1), { type: 'epic' })])]));
    stage(db, segment(R1, [txn('R1:2', [insert('c1', h(2), { parent_id: 'p1' })])]));
    expect(apply(db)).toMatchObject({ applied: 2, pending: 0 });
    expect(parentOf(db, 'c1')).toBe('P1');
    expect(seal(db).txns, 'the applied reference was echoed').toBe(0);
    // The merge reads the reference as a uid: a sequential re-parent is no conflict.
    stage(db, segment(R1, [txn('R1:3', [insert('p2', h(3), { type: 'epic' })])]));
    stage(
      db,
      segment(R2, [
        txn('R2:1', [{ ...update('c1', h(5, R2), { parent_id: 'p2' }), b: { parent_id: 'p1' } }]),
      ]),
    );
    apply(db);
    expect(parentOf(db, 'c1')).toBe('P2');
    expect(listConflicts(db)).toEqual([]);
  });

  it('a parent and child in one transaction apply together', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [
          insert('p1', h(1), { type: 'epic' }),
          insert('c1', h(1), { parent_id: 'p1' }),
        ]),
      ]),
    );
    expect(apply(db).applied).toBe(1);
    expect(parentOf(db, 'c1')).toBe('P1');
  });

  it('a reference to a row never seen waits, and applies when the row arrives', async () => {
    const db = await store();
    stage(db, segment(R2, [txn('R2:1', [insert('c1', h(5, R2), { parent_id: 'p1' })])]));
    expect(apply(db)).toMatchObject({ pending: 1 });
    expect(db.prepare('SELECT reason FROM _sync_inbox WHERE seq = 1').get()).toEqual({
      reason: 'tasks_tasks/c1: reference parent_id to p1 not seen yet',
    });
    stage(db, segment(R1, [txn('R1:1', [insert('p1', h(1), { type: 'epic' })])]));
    expect(apply(db)).toMatchObject({ applied: 2, pending: 0 });
    expect(parentOf(db, 'c1')).toBe('P1');
  });

  it('a reference to a deleted row is a dangling-ref conflict and a void, never pending', async () => {
    const db = await store();
    stage(
      db,
      segment(R1, [
        txn('R1:1', [insert('p1', h(1), { type: 'epic' })]),
        txn('R1:2', [del('p1', h(2))]),
      ]),
    );
    apply(db);
    stage(db, segment(R2, [txn('R2:1', [insert('c1', h(5, R2), { parent_id: 'p1' })])]));
    expect(apply(db)).toMatchObject({ void: 1, pending: 0 });
    expect(task(db, 'c1')).toBeUndefined();
    expect(listConflicts(db)).toEqual([
      expect.objectContaining({ kind: 'dangling-ref', uid: 'c1', columns: ['parent_id'] }),
    ]);
  });

  it('a reference to a re-keyed row follows tasks_uid_aliases', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('p2', h(1), { type: 'epic' })])]));
    apply(db);
    db.prepare(
      `INSERT INTO tasks_uid_aliases (uid, entity_table, old_uid, old_birth_fp, new_uid, created_at)
       VALUES ('alias-1', 'tasks_tasks', 'p1', 'fp-p1', 'p2', '2026-10-05T00:00:00.000Z')`,
    ).run();
    seal(db);
    stage(db, segment(R2, [txn('R2:1', [insert('c1', h(5, R2), { parent_id: 'p1' })])]));
    expect(apply(db)).toMatchObject({ applied: 1, pending: 0 });
    expect(parentOf(db, 'c1')).toBe('P2');
  });

  it('a guard refusal voids only that op, with a guard conflict', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('g1', h(1)), insert('g2', h(1))])]));
    apply(db);
    // done without a terminal pipeline stage: the T877 trigger aborts the write.
    stage(
      db,
      segment(R2, [
        txn('R2:1', [update('g1', h(5, R2), grp('done')), update('g2', h(5, R2), { title: 'ok' })]),
      ]),
    );
    expect(apply(db)).toMatchObject({ conflict: 1 });
    expect(task(db, 'g1')?.status).toBe('pending');
    expect(task(db, 'g2')?.title).toBe('ok');
    const [c] = listConflicts(db);
    expect(c).toMatchObject({ kind: 'guard', uid: 'g1', resolution: 'op-voided', opIdx: 0 });
    expect(c?.rule).toMatch(/T877_INVARIANT_VIOLATION/);
    expect(seal(db).txns, 'the voided op left a residual').toBe(0);
  });

  it('a parent delete with a remaining CASCADE child is voided with a conflict', async () => {
    const db = await store();
    fkOn(db);
    stage(
      db,
      segment(R1, [txn('R1:1', [insert('p1', h(1), { type: 'epic' }), insert('d1', h(1))])]),
    );
    apply(db);
    // A concurrent dependency on p1, already here.
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', null);
    db.prepare(
      "INSERT INTO tasks_task_dependencies (task_id, depends_on, uid) VALUES ('D1', 'P1', 'dep-1')",
    ).run();
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    seal(db);
    stage(db, segment(R2, [txn('R2:1', [del('p1', h(5, R2))])]));
    expect(apply(db)).toMatchObject({ void: 1 });
    expect(task(db, 'p1')).toBeDefined();
    expect(listConflicts(db)).toEqual([
      expect.objectContaining({
        kind: 'delete-with-live-children',
        uid: 'p1',
        columns: ['tasks_task_dependencies:dep-1'],
      }),
    ]);
  });

  it('a parent delete clears SET NULL children through FK actions, and they are not echoed', async () => {
    const db = await store();
    fkOn(db);
    // With recursive triggers on, the FK action's child UPDATE is captured
    // (today it is not, T13226): the delete's SET NULL intent must explain it.
    db.exec('PRAGMA recursive_triggers = ON');
    stage(
      db,
      segment(R1, [
        txn('R1:1', [
          insert('p1', h(1), { type: 'epic' }),
          insert('c1', h(1), { parent_id: 'p1' }),
        ]),
      ]),
    );
    apply(db);
    stage(db, segment(R1, [txn('R1:2', [del('p1', h(5))])]));
    expect(apply(db)).toMatchObject({ applied: 1 });
    expect(task(db, 'p1')).toBeUndefined();
    expect(parentOf(db, 'c1')).toBeNull();
    // The FK action was captured, and the delete recorded the intent that explains it.
    expect(
      db.prepare("SELECT count(*) AS n FROM _sync_capture WHERE op = 'U' AND uid = 'c1'").get(),
    ).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT enc FROM _sync_apply_intent WHERE uid = 'c1' AND col = 'parent_id'").get(),
    ).toEqual({ enc: 'NULL' });
    expect(seal(db).txns, 'the SET NULL action was echoed').toBe(0);
  });

  it('a K op re-keys the row, moves its meta and state, and is not echoed', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('k1', h(1))])]));
    apply(db);
    recordFieldLeaves(db, 'tasks_tasks', 'k1', { status: h(1) });
    stage(
      db,
      segment(R1, [
        txn('R1:2', [{ t: 'tasks_tasks', u: 'k1', o: 'K', h: h(2), nu: 'k2', bfp: 'fp-k2' }]),
      ]),
    );
    expect(apply(db)).toMatchObject({ applied: 1 });
    expect(task(db, 'k1')).toBeUndefined();
    expect(task(db, 'k2')?.id).toBe('K1');
    expect(readRowMeta(db, 'tasks_tasks', 'k1')).toBeUndefined();
    expect(readRowMeta(db, 'tasks_tasks', 'k2')).toMatchObject({ hlc: h(1), bfp: 'fp-k2' });
    // The typed-rule state follows the row (review LOW-2).
    expect(readFieldLeaves(db, 'tasks_tasks', 'k1')).toEqual({});
    expect(readFieldLeaves(db, 'tasks_tasks', 'k2')).toEqual({ status: h(1) });
    expect(seal(db).txns, 'the applied re-key was echoed').toBe(0);
    stage(db, segment(R2, [txn('R2:1', [update('k2', h(5, R2), { title: 'after rekey' })])]));
    apply(db);
    expect(task(db, 'k2')?.title).toBe('after rekey');
  });

  it('a K op onto a uid another live row holds is a uid-collision void', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('k1', h(1)), insert('k2', h(1))])]));
    apply(db);
    stage(
      db,
      segment(R2, [txn('R2:1', [{ t: 'tasks_tasks', u: 'k1', o: 'K', h: h(3, R2), nu: 'k2' }])]),
    );
    expect(apply(db)).toMatchObject({ void: 1 });
    expect(listConflicts(db)).toEqual([
      expect.objectContaining({ kind: 'uid-collision', uid: 'k1' }),
    ]);
    expect(task(db, 'k1')).toBeDefined();
  });

  it('every sync-set FK parent declares its remote-delete policy', async () => {
    const db = await store();
    const parents = [...syncSetChildKeys(db, 'project').keys()].sort();
    expect(parents.length).toBeGreaterThan(0);
    for (const t of parents) {
      expect(ON_REMOTE_PARENT_DELETE, `${t} has no onRemoteParentDelete policy`).toHaveProperty(t);
    }
  });

  it('a K op of a row never seen waits', async () => {
    const db = await store();
    stage(
      db,
      segment(R2, [txn('R2:1', [{ t: 'tasks_tasks', u: 'k9', o: 'K', h: h(3, R2), nu: 'k10' }])]),
    );
    expect(apply(db)).toMatchObject({ pending: 1 });
  });
});

describe('review #1896: intra-transaction references and guard scope (T13238, T13239)', () => {
  const parentOf = (db: DatabaseSync, uid: string) =>
    (
      db.prepare('SELECT parent_id AS p FROM tasks_tasks WHERE uid = ?').get(uid) as {
        p: string | null;
      }
    ).p;
  /** The store's sealed transactions, as a receiver stages them. */
  const sealedTxns = (db: DatabaseSync): LedgerTxn[] =>
    (
      db.prepare('SELECT txn, hlc, via, kind FROM _sync_txn ORDER BY local_seq').all() as Array<{
        txn: string;
        hlc: string;
        via: LedgerTxn['via'];
        kind: LedgerTxn['kind'];
      }>
    ).map((t) => ({
      v: 1,
      txn: t.txn,
      hlc: t.hlc,
      project: null,
      scope: 'project',
      via: t.via,
      kind: t.kind,
      actor: null,
      ops: (
        db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
          body: string;
        }>
      ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
      sig: '',
    }));

  it('a real frame inserting A, inserting B, then A.parent = B applies whole on a receiver', async () => {
    const origin = await store('origin');
    origin.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(origin, 'write', null);
    origin
      .prepare(
        "INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('A', 'a', 'task', 'pending', 'medium', 'uid-a', 'fp-a')",
      )
      .run();
    origin
      .prepare(
        "INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('B', 'b', 'epic', 'pending', 'medium', 'uid-b', 'fp-b')",
      )
      .run();
    origin.prepare("UPDATE tasks_tasks SET parent_id = 'B' WHERE id = 'A'").run();
    finishCaptureFrame(origin, frame);
    origin.exec('COMMIT');
    seal(origin);
    const txns = sealedTxns(origin);
    // Netting keeps A's op first, carrying the reference to B.
    expect(txns[0]?.ops.map((o) => `${o.o}:${o.u}`)).toEqual(['I:uid-a', 'I:uid-b']);

    const receiver = await store('receiver');
    receiver.exec('PRAGMA foreign_keys = ON');
    stage(receiver, segment(R1, txns));
    // The origin's sealer stamps HLCs from its real clock.
    expect(apply(receiver, Date.now())).toMatchObject({ applied: 1, pending: 0, conflict: 0 });
    expect(parentOf(receiver, 'uid-a')).toBe('B');
  });

  it('a guard refusal of a re-key voids only that op; the stream keeps flowing', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('k1', h(1))])]));
    apply(db);
    db.exec(
      "CREATE TEMP TRIGGER no_rekey BEFORE UPDATE OF uid ON main.tasks_tasks BEGIN SELECT RAISE(ABORT, 'no rekey here'); END",
    );
    stage(
      db,
      segment(R1, [txn('R1:2', [{ t: 'tasks_tasks', u: 'k1', o: 'K', h: h(2), nu: 'k2' }])]),
    );
    stage(db, segment(R2, [txn('R2:1', [insert('z9', h(3, R2))])]));
    expect(apply(db)).toMatchObject({ void: 1, applied: 1 });
    expect(listConflicts(db)).toEqual([
      expect.objectContaining({ kind: 'guard', uid: 'k1', rule: 'no rekey here' }),
    ]);
    expect(task(db, 'k1')).toBeDefined();
  });

  it('a non-constraint store error fails the pass and keeps the txn staged, never a void', async () => {
    const db = await store();
    stage(db, segment(R1, [txn('R1:1', [insert('e1', h(1))])]));
    apply(db);
    db.exec(
      'CREATE TEMP TRIGGER broken AFTER UPDATE ON main.tasks_tasks BEGIN INSERT INTO main.no_such_table VALUES (1); END',
    );
    stage(db, segment(R2, [txn('R2:1', [update('e1', h(5, R2), { title: 'x' })])]));
    expect(() => apply(db)).toThrow(/no such table/);
    expect(statuses(db)).toEqual(['1.0:applied', '2.0:staged']);
    expect(listConflicts(db)).toEqual([]);
  });
});
