/**
 * The sealer, S3a (T12984; journal spec §2.5, §1.6, §2.6, §4.3).
 *
 * Coverage:
 *   - decodeEnc / canonicalJson
 *   - refused while sync.seal is off
 *   - a validated frame seals as one transaction; unframed captures as
 *     singletons flagged `unframed`, provenance foreign (ruling (c))
 *   - I / U / D / K ops: typed values, references as uids, bfp on minted rows
 *   - row meta: version, origin, per-field fhlc, tombstone, K move keeping
 *     version and chash; chash = canonical live image without secrets
 *   - chash deferred while a live capture of the row remains
 *   - ledger: count(*) on first sight, then +I −D
 *   - a minted row without a uid keeps its group pending
 *   - captures and empty frames consumed; budget ends on a group boundary
 *
 * @task T12984
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rekeyRowUid } from '../../display-id-alias.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { naturalRowUid } from '../../row-identity.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { canonicalJson, decodeEnc, rowChash, type SealedOp, sealPending } from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sealer-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(opts: { seal?: boolean } = {}): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  if (opts.seal !== false) setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

let clock = T0;
const seal = (db: DatabaseSync, budget?: number) =>
  sealPending(db, { scope: 'project', replica: REPLICA, budget, now: () => ++clock, env: {} });

/** A framed write, the way accessor.transaction() labels it. */
function framed(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  fn();
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (db: DatabaseSync, id: string, uid: string | null = `uid-${id}`) =>
  db
    .prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
    )
    .run(id, `title ${id}`, uid, uid === null ? null : `fp-${id}`);

const txns = (db: DatabaseSync) =>
  db.prepare('SELECT * FROM _sync_txn ORDER BY local_seq').all() as Array<{
    txn: string;
    local_seq: number;
    hlc: string;
    via: string;
    kind: string;
    unframed: number;
    op_count: number;
    frame: string | null;
  }>;

const ops = (db: DatabaseSync, txn?: string): SealedOp[] =>
  (
    (txn
      ? db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(txn)
      : db.prepare('SELECT body FROM _sync_op ORDER BY txn, idx').all()) as Array<{ body: string }>
  ).map((r) => JSON.parse(r.body) as SealedOp);

const meta = (db: DatabaseSync, tbl: string, uid: string) =>
  db.prepare('SELECT * FROM _sync_row_meta WHERE tbl = ? AND uid = ?').get(tbl, uid) as
    | {
        hlc: string;
        fhlc: string | null;
        origin: string;
        version: number;
        deleted: number;
        chash: string | null;
        key_json: string | null;
      }
    | undefined;

const liveCaptures = (db: DatabaseSync) =>
  (
    db.prepare("SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'").get() as {
      n: number;
    }
  ).n;

describe('wire values', () => {
  it('decodes every enc() form', () => {
    expect(decodeEnc("'it''s'")).toBe("it's");
    expect(decodeEnc('NULL')).toBeNull();
    expect(decodeEnc('42')).toBe(42);
    expect(decodeEnc('-7')).toBe(-7);
    expect(decodeEnc('9007199254740993')).toEqual({ $i: '9007199254740993' });
    expect(decodeEnc('r0.10000000000000001')).toEqual({ $r: '0.10000000000000001' });
    expect(decodeEnc('r-Inf')).toEqual({ $r: '-Inf' });
    expect(decodeEnc("X'00FF'")).toEqual({ $b: 'AP8=' });
    expect(() => decodeEnc('garbage')).toThrow(/not an enc/);
  });

  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('sealPending', () => {
  it('refuses while sync.seal is off, touching nothing', async () => {
    const db = await store({ seal: false });
    framed(db, () => addTask(db, 'T1'));
    expect(seal(db).refused).toBe('sync.seal is off');
    expect(liveCaptures(db)).toBeGreaterThan(0);
  });

  it('a validated frame seals as one transaction with typed ops, meta, chash and ledger', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      addTask(db, 'T2');
    });
    const r = seal(db);
    expect(r).toMatchObject({ txns: 1, unframed: 0, refused: null, pending: [] });
    const [t] = txns(db);
    expect(t).toMatchObject({
      local_seq: 1,
      txn: `${REPLICA}:1`,
      via: 'accessor',
      kind: 'write',
      unframed: 0,
      op_count: 2,
    });
    const [i1] = ops(db);
    expect(i1).toMatchObject({ t: 'tasks_tasks', u: 'uid-T1', o: 'I', bfp: 'fp-T1' });
    expect(i1?.a).toMatchObject({ id: 'T1', title: 'title T1', status: 'pending' });
    expect(i1?.a).not.toHaveProperty('uid');
    expect(t?.hlc).toBe(
      ops(db)
        .map((o) => o.h)
        .sort()
        .at(-1),
    );
    const m = meta(db, 'tasks_tasks', 'uid-T1');
    expect(m).toMatchObject({ origin: REPLICA, version: 1, deleted: 0, fhlc: null });
    const def = captureTableDef(db, 'project', 'tasks_tasks');
    expect(m?.chash).toBe(def ? rowChash(db, def, 'uid-T1') : 'missing-def');
    expect(m?.chash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare("SELECT live FROM _sync_ledger WHERE tbl = 'tasks_tasks'").get()).toEqual({
      live: (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n,
    });
    expect(liveCaptures(db)).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM _sync_frame').get()).toEqual({ n: 0 });
  });

  it('unframed captures seal as singleton transactions, provenance foreign', async () => {
    const db = await store();
    addTask(db, 'T1');
    addTask(db, 'T2');
    const r = seal(db);
    expect(r).toMatchObject({ txns: 2, unframed: 2 });
    expect(txns(db).map((t) => [t.via, t.unframed, t.op_count])).toEqual([
      ['foreign', 1, 1],
      ['foreign', 1, 1],
    ]);
  });

  it('U carries changed columns before/after and bfp; fhlc keeps older columns; D tombstones', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    const iHlc = meta(db, 'tasks_tasks', 'uid-T1')?.hlc;
    framed(db, () => db.exec("UPDATE tasks_tasks SET title = 'renamed' WHERE id = 'T1'"));
    seal(db);
    const u = ops(db).find((o) => o.o === 'U');
    expect(u).toMatchObject({
      u: 'uid-T1',
      bfp: 'fp-T1',
      a: { title: 'renamed' },
      b: { title: 'title T1' },
    });
    const m = meta(db, 'tasks_tasks', 'uid-T1');
    expect(m?.version).toBe(2);
    const fhlc = JSON.parse(m?.fhlc ?? '{}') as Record<string, string>;
    expect(fhlc.status).toBe(iHlc);
    expect(fhlc).not.toHaveProperty('title');

    const before = (
      db.prepare("SELECT live FROM _sync_ledger WHERE tbl = 'tasks_tasks'").get() as {
        live: number;
      }
    ).live;
    framed(db, () => db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'"));
    seal(db);
    const d = ops(db).find((o) => o.o === 'D');
    expect(d).toMatchObject({ u: 'uid-T1', bfp: 'fp-T1' });
    expect(d?.b).toMatchObject({ title: 'renamed' });
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toMatchObject({ deleted: 1, version: 3 });
    expect(db.prepare("SELECT live FROM _sync_ledger WHERE tbl = 'tasks_tasks'").get()).toEqual({
      live: before - 1,
    });
  });

  it('K moves row meta to the new uid, keeping version and chash', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    const was = meta(db, 'tasks_tasks', 'uid-T1');
    db.exec('BEGIN IMMEDIATE');
    rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    db.exec('COMMIT');
    seal(db);
    const k = ops(db).find((o) => o.o === 'K');
    expect(k).toMatchObject({ t: 'tasks_tasks', u: 'uid-T1' });
    const newUid = k?.nu as string;
    expect(newUid).toBeTruthy();
    expect(newUid).not.toBe('uid-T1');
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toBeUndefined();
    const moved = meta(db, 'tasks_tasks', newUid);
    expect(moved?.version).toBeGreaterThan(was?.version ?? 0);
    expect(moved?.chash).toBeTruthy();
  });

  it('natural rows carry their key with references as uids', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      db.exec("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'bug')");
    });
    expect(seal(db).pending).toEqual([]);
    const label = ops(db).find((o) => o.t === 'tasks_task_labels');
    expect(label?.o).toBe('I');
    expect(label?.k).toEqual({ task_id: 'uid-T1', label: 'bug' });
    // The uid the T12341 fill would give the row: a function of the key.
    expect(label?.u).toBe(naturalRowUid('project', 'tasks_task_labels', ['uid-T1', 'bug']));
    expect(label?.a).toMatchObject({ task_id: 'uid-T1' });
  });

  it('a minted row with no uid keeps its whole group pending', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      addTask(db, 'T2', null);
    });
    const r = seal(db);
    expect(r.txns).toBe(0);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]?.reason).toMatch(/no uid/);
    expect(liveCaptures(db)).toBe(2);
  });

  it('chash waits while a live capture of the row remains; the budget ends on a group boundary', async () => {
    const db = await store();
    addTask(db, 'T1'); // unframed: seq 1
    db.exec("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'"); // unframed: seq 2
    expect(seal(db, 1)).toMatchObject({ txns: 1, captures: 1 });
    expect(meta(db, 'tasks_tasks', 'uid-T1')?.chash).toBeNull();
    seal(db);
    expect(meta(db, 'tasks_tasks', 'uid-T1')?.chash).toMatch(/^[0-9a-f]{64}$/);

    framed(db, () => {
      addTask(db, 'T2');
      addTask(db, 'T3');
      addTask(db, 'T4');
    });
    const r = seal(db, 1);
    expect(r).toMatchObject({ txns: 1, captures: 3 }); // the whole frame, not 1 capture
  });
});
