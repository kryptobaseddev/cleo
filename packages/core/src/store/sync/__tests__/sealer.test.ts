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
import { ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import {
  canonicalJson,
  decodeEnc,
  rowChash,
  type SealedOp,
  sealBacklog,
  sealPending,
} from '../sealer.js';

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
  if (opts.seal !== false) {
    setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
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
    expect(m?.chash).toBe(def ? rowChash(db, 'project', def, 'uid-T1') : 'missing-def');
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

  it('a K on a uid that never left the device is dropped; the row meta follows the row', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    const was = meta(db, 'tasks_tasks', 'uid-T1');
    db.exec('BEGIN IMMEDIATE');
    rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    db.exec('COMMIT');
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(ops(db).filter((o) => o.o === 'K')).toEqual([]);
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toBeUndefined();
    const now = (db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T1'").get() as { uid: string })
      .uid;
    expect(meta(db, 'tasks_tasks', now)).toMatchObject({
      version: was?.version,
      chash: was?.chash,
    });
    expect(liveCaptures(db)).toBe(0);
  });

  it('a K on a sent uid is kept and moves row meta to the new uid, keeping hlc, version and chash (§2.5, T13031)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    db.exec("UPDATE _sync_row_meta SET sent = 1 WHERE uid = 'uid-T1'");
    const was = meta(db, 'tasks_tasks', 'uid-T1');
    db.exec('BEGIN IMMEDIATE');
    rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    db.exec('COMMIT');
    seal(db);
    const k = ops(db).find((o) => o.o === 'K');
    expect(k).toMatchObject({ t: 'tasks_tasks', u: 'uid-T1' });
    const newUid = k?.nu as string;
    expect(newUid).toBeTruthy();
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toBeUndefined();
    const moved = meta(db, 'tasks_tasks', newUid);
    expect(moved?.version).toBe(was?.version);
    expect(moved?.hlc).toBe(was?.hlc);
    expect(moved?.chash).toBe(was?.chash);
  });

  it('netting in a frame: I then U seals one I; an insert then delete seals nothing', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      db.exec("UPDATE tasks_tasks SET title = 'final' WHERE id = 'T1'");
      addTask(db, 'T2');
      db.exec("DELETE FROM tasks_tasks WHERE id = 'T2'");
    });
    const r = seal(db);
    expect(r).toMatchObject({ txns: 1, ops: 1, pending: [] });
    const [only] = ops(db);
    expect(only).toMatchObject({ o: 'I', u: 'uid-T1', a: { title: 'final' } });
    expect(meta(db, 'tasks_tasks', 'uid-T2')).toBeUndefined();
    expect(db.prepare("SELECT live FROM _sync_ledger WHERE tbl = 'tasks_tasks'").get()).toEqual({
      live: (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n,
    });
  });

  it('a frame whose writes cancel out consumes its captures and writes no transaction', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T9');
      db.exec("DELETE FROM tasks_tasks WHERE id = 'T9'");
    });
    expect(seal(db)).toMatchObject({ txns: 0, ops: 0, captures: 2 });
    expect(txns(db)).toEqual([]);
    expect(liveCaptures(db)).toBe(0);
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

describe('#1779 review fixes (T13029–T13033)', () => {
  const opsOf = (db: DatabaseSync, t: string) => ops(db).filter((o) => o.t === t);
  const capture = (db: DatabaseSync) =>
    db.exec(
      "DELETE FROM cleo_trigger_suspend; INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')",
    );
  const uncapture = (db: DatabaseSync) => db.exec('DELETE FROM cleo_trigger_suspend');

  it('an I whose uid comes from the live row takes birth_fp from there too, and seals before a later U (T13029)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1', null)); // captured before the identity fill
    db.exec('BEGIN IMMEDIATE');
    capture(db);
    db.exec("UPDATE tasks_tasks SET uid = 'uid-T1', birth_fp = 'fp-T1' WHERE id = 'T1'");
    uncapture(db);
    db.exec('COMMIT');
    framed(db, () => db.prepare("UPDATE tasks_tasks SET title = 'second' WHERE id = 'T1'").run());
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(txns(db).map((t) => t.local_seq)).toEqual([1, 2]);
    const [i, u] = opsOf(db, 'tasks_tasks');
    expect(i).toMatchObject({ o: 'I', u: 'uid-T1', bfp: 'fp-T1' });
    expect(u).toMatchObject({ o: 'U', u: 'uid-T1', bfp: 'fp-T1' });
  });

  it('a group that cannot seal stops the batch: nothing after it gets an HLC first (§2.9)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1', null)); // no uid anywhere yet
    framed(db, () => addTask(db, 'T2'));
    const r = seal(db);
    expect(r.txns).toBe(0);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]?.reason).toMatch(/no uid/);
    expect(liveCaptures(db)).toBe(2);
  });

  it('an unreadable capture is reported, never aborts the batch (T13029)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    db.prepare(
      "INSERT INTO _sync_capture (seq, tbl, op, rk, uid, img, at_ms, state) VALUES ((SELECT max(seq) + 1 FROM _sync_capture), 'not_a_sync_table', 'I', '[\"\\u0027x\\u0027\"]', 'u-x', '{}', 1, 'live')",
    ).run();
    let r: ReturnType<typeof seal> | undefined;
    expect(() => {
      r = seal(db);
    }).not.toThrow();
    expect(r?.txns).toBe(1); // T1 seals; the poison capture holds the head after it
    expect(r?.pending[0]?.reason).toMatch(/not in the sync set/);
  });

  it('stored ref uids stay in the image; only uid and birth_fp move to u/bfp (T13030)', async () => {
    const db = await store();
    const hist = 'tasks_task_acceptance_criteria_history';
    framed(db, () =>
      db
        .prepare(
          `INSERT INTO ${hist} (ac_id, previous_text, reason, uid, birth_fp, ac_uid) VALUES ('AC1', 'old', 'edit', 'uid-H1', 'fp-H1', 'uid-AC1')`,
        )
        .run(),
    );
    seal(db);
    const [i] = opsOf(db, hist);
    expect(i?.a).toMatchObject({ ac_uid: 'uid-AC1' });
    expect(i?.a).not.toHaveProperty('uid');
    expect(i?.a).not.toHaveProperty('birth_fp');
  });

  it('a U sealed after its row was deleted still carries bfp (T13030)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.prepare("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'").run());
    framed(db, () => db.prepare("DELETE FROM tasks_tasks WHERE id = 'T1'").run());
    seal(db);
    const u = opsOf(db, 'tasks_tasks').find((o) => o.o === 'U');
    expect(u).toMatchObject({ u: 'uid-T1', bfp: 'fp-T1' });
  });

  it('a U sealed alone after its row was deleted takes bfp from row meta (T13030)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.prepare("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'").run());
    framed(db, () => db.prepare("DELETE FROM tasks_tasks WHERE id = 'T1'").run());
    // The batch holds only the U: the row is gone and the D is not read yet.
    expect(seal(db, 1)).toMatchObject({ txns: 1, captures: 1 });
    const u = opsOf(db, 'tasks_tasks').find((o) => o.o === 'U');
    expect(u).toMatchObject({ u: 'uid-T1', bfp: 'fp-T1' });
  });

  it('chash hashes the wire image: the same row under another display id hashes alike (T13031)', async () => {
    const db = await store();
    addTask(db, 'T1');
    const def = captureTableDef(db, 'project', 'tasks_tasks');
    if (!def) throw new Error('no def');
    const before = rowChash(db, 'project', def, 'uid-T1');
    db.prepare("UPDATE tasks_tasks SET id = 'T777' WHERE id = 'T1'").run();
    expect(rowChash(db, 'project', def, 'uid-T1')).toBe(before);
  });

  it('the transaction counter only rises: no txn id is reused after old rows are collected (T13033)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    db.exec('DELETE FROM _sync_op; DELETE FROM _sync_txn');
    framed(db, () => addTask(db, 'T2'));
    seal(db);
    expect(txns(db).map((t) => t.local_seq)).toEqual([2]);
  });

  it('the replica defaults to the bound one, and nothing seals without one', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    expect(sealPending(db, { scope: 'project', env: {} }).refused).toBe('no bound replica');
    expect(liveCaptures(db)).toBeGreaterThan(0);
    const { replicaId } = ensureProjectReplica(db, {
      dbPath,
      mode: 'test',
      registry: new ReplicaRegistry(join(dir, 'registry.json'), 'host-1'),
    });
    const r = sealPending(db, { scope: 'project', env: {} });
    expect(r.refused).toBeNull();
    expect(txns(db)[0]?.txn).toBe(`${replicaId}:1`);
  });

  it('sealBacklog reports the live head for the doctor', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1', null));
    const b = sealBacklog(db);
    expect(b.live).toBeGreaterThan(0);
    expect(b.oldestSeq).toBeTypeOf('number');
  });
});
