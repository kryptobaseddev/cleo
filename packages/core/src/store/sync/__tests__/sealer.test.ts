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
import { syncSealerDoctorCheck } from '../../../doctor/sync-sealer.js';
import { rekeyRowUid } from '../../display-id-alias.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { naturalRowUid } from '../../row-identity.js';
import {
  captureRemints,
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { parseHlc } from '../hlc.js';
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
  // Written against row uids off; on by default since T13305 (C2). The
  // capture + fill-on interplay is tracked separately (see the C2 PR).
  vi.stubEnv('CLEO_ROW_UID_FILL', '0');
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
  sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    budget,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

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
    partial: number;
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

  it("a K in the same transaction as the row's insert is dropped: the I takes the final uid", async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    });
    const r = seal(db);
    expect(r.pending).toEqual([]);
    const now = (db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T1'").get() as { uid: string })
      .uid;
    expect(now).not.toBe('uid-T1');
    const taskOps = ops(db).filter((o) => o.t === 'tasks_tasks');
    expect(taskOps.map((o) => [o.o, o.u])).toEqual([['I', now]]);
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toBeUndefined();
    expect(meta(db, 'tasks_tasks', now)).toMatchObject({ version: 1, deleted: 0 });
    expect(liveCaptures(db)).toBe(0);
  });

  it('a K on an unsent uid that an earlier transaction sealed is kept, linking its ops (T13035, P1)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    const was = meta(db, 'tasks_tasks', 'uid-T1');
    db.exec('BEGIN IMMEDIATE');
    rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    db.exec('COMMIT');
    seal(db);
    framed(db, () => db.prepare("UPDATE tasks_tasks SET title = 'after' WHERE id = 'T1'").run());
    seal(db);
    const now = (db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T1'").get() as { uid: string })
      .uid;
    const taskOps = ops(db).filter((o) => o.t === 'tasks_tasks');
    expect(taskOps.map((o) => [o.o, o.u, o.o === 'K' ? o.nu : undefined])).toEqual([
      ['I', 'uid-T1', undefined],
      ['K', 'uid-T1', now],
      ['U', now, undefined],
    ]);
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toBeUndefined();
    expect(meta(db, 'tasks_tasks', now)).toMatchObject({ hlc: expect.any(String) });
    expect(meta(db, 'tasks_tasks', now)?.version).toBeGreaterThan(was?.version ?? 0);
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

  it('an unreadable capture is quarantined, never stalls the outbox (T13029, T13036)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    db.prepare(
      "INSERT INTO _sync_capture (seq, tbl, op, rk, uid, img, at_ms, state) VALUES ((SELECT max(seq) + 1 FROM _sync_capture), 'not_a_sync_table', 'I', '[\"\\u0027x\\u0027\"]', 'u-x', '{}', 1, 'live')",
    ).run();
    framed(db, () => addTask(db, 'T2'));
    let r: ReturnType<typeof seal> | undefined;
    expect(() => {
      r = seal(db);
    }).not.toThrow();
    expect(r?.txns).toBe(2); // T1 and T2 both seal; the poison capture is set aside
    expect(r?.pending).toEqual([]);
    expect(r?.quarantined).toEqual([
      {
        seq: expect.any(Number),
        tbl: 'not_a_sync_table',
        reason: expect.stringMatching(/not in the sync set/),
      },
    ]);
    expect(liveCaptures(db)).toBe(0);
    expect(db.prepare('SELECT tbl, op, uid FROM _sync_quarantine').all()).toEqual([
      { tbl: 'not_a_sync_table', op: 'I', uid: 'u-x' },
    ]);
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
    expect(sealPending(db, { scope: 'project', env: {}, allowUnreleased: true }).refused).toBe(
      'no bound replica',
    );
    expect(liveCaptures(db)).toBeGreaterThan(0);
    const { replicaId } = ensureProjectReplica(db, {
      dbPath,
      mode: 'test',
      registry: new ReplicaRegistry(join(dir, 'registry.json'), 'host-1'),
    });
    const r = sealPending(db, { scope: 'project', env: {}, allowUnreleased: true });
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

describe('#1779 round 2 (T13035–T13037)', () => {
  const A = 'tasks_task_acceptance_criteria';
  const addAc = (db: DatabaseSync, id: string, text: string, uid = 'uid-X') =>
    db
      .prepare(
        `INSERT INTO ${A} (id, task_id, ordinal, text, created_at, uid, birth_fp)
         VALUES (?, 'T1', 1, ?, '2026-09-01 00:00:00', ?, 'fp-X')`,
      )
      .run(id, text, uid);

  it('an AC relinked in one frame (delete A1 uid X, insert A2 uid X) seals one U of the text (T13035, P3)', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      addAc(db, 'A1', 'old');
    });
    seal(db);
    framed(db, () => {
      db.prepare(`DELETE FROM ${A} WHERE id = 'A1'`).run();
      addAc(db, 'A2', 'new');
    });
    expect(seal(db).pending).toEqual([]);
    const last = txns(db).at(-1)?.txn;
    const acOps = ops(db, last).filter((o) => o.t === A);
    expect(acOps.map((o) => [o.o, o.u, o.a])).toEqual([['U', 'uid-X', { text: 'new' }]]);
    expect(meta(db, A, 'uid-X')).toMatchObject({ deleted: 0, version: 2 });
  });

  it('a dead incarnation (a no-uid insert and its delete, unframed) never stalls the outbox (T13036, P2)', async () => {
    const db = await store();
    addTask(db, 'T1', null); // a pre-S2 binary: unframed, no uid
    db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'");
    framed(db, () => addTask(db, 'T2'));
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(r.dropped).toBe(2);
    expect(liveCaptures(db)).toBe(0);
    expect(ops(db).map((o) => [o.o, o.u])).toEqual([['I', 'uid-T2']]);
  });

  it('a no-uid row that is still live keeps waiting for the fill', async () => {
    const db = await store();
    addTask(db, 'T1', null);
    const r = seal(db);
    expect(r.dropped).toBe(0);
    expect(r.pending[0]?.reason).toMatch(/no uid/);
  });

  it('an op takes its HLC time from its last capture (T13037, P4)', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      db.exec("UPDATE tasks_tasks SET title = 'b' WHERE id = 'T1'");
    });
    const seqs = (
      db
        .prepare("SELECT seq FROM _sync_capture WHERE tbl = 'tasks_tasks' ORDER BY seq")
        .all() as Array<{
        seq: number;
      }>
    ).map((r) => r.seq);
    const late = Date.now() + 10 * 86_400_000;
    db.prepare('UPDATE _sync_capture SET at_ms = ? WHERE seq = ?').run(late, seqs[0] ?? 0);
    db.prepare('UPDATE _sync_capture SET at_ms = ? WHERE seq = ?').run(late + 5000, seqs[1] ?? 0);
    seal(db);
    const [i] = ops(db).filter((o) => o.t === 'tasks_tasks');
    expect(i?.o).toBe('I');
    expect(parseHlc(i?.h ?? '').phys).toBe(late + 5000);
  });

  it("the ledger's first sight counts a waiting foreign REPLACE as no new row (T13037)", async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    // A foreign connection without recursive triggers: REPLACE captures an I only.
    db.exec('PRAGMA recursive_triggers = OFF');
    db.prepare(
      `INSERT OR REPLACE INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES ('T1', 'replaced', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1')`,
    ).run();
    db.exec('PRAGMA recursive_triggers = ON');
    seal(db, 1); // the frame seals; the REPLACE waits; the ledger sees tasks_tasks first
    seal(db);
    const live = (
      db.prepare("SELECT live FROM _sync_ledger WHERE tbl = 'tasks_tasks'").get() as {
        live: number;
      }
    ).live;
    const count = (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n;
    expect(live).toBe(count);
  });

  it('a K that changes only birth_fp keeps the row meta and carries the new bfp (T13037)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.exec("UPDATE tasks_tasks SET birth_fp = 'fp-T9' WHERE id = 'T1'"));
    seal(db);
    expect(ops(db).find((o) => o.o === 'K')).toMatchObject({
      u: 'uid-T1',
      nu: 'uid-T1',
      bfp: 'fp-T9',
    });
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toMatchObject({ deleted: 0 });
    framed(db, () => db.exec("UPDATE tasks_tasks SET title = 'later' WHERE id = 'T1'"));
    seal(db);
    expect(
      ops(db)
        .filter((o) => o.o === 'U')
        .at(-1),
    ).toMatchObject({ bfp: 'fp-T9' });
  });

  it('a rebase frame waits for the S5 scoped rebase; apply frames seal their residual (T13037, T12757)', async () => {
    const db = await store();
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'rebase', 'test');
    addTask(db, 'T1');
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    const r = seal(db);
    expect(r.txns).toBe(0);
    expect(r.pending[0]?.reason).toMatch(/rebase frames wait/);
  });

  it('a persisted sync.seal is refused while the flag is unreleased (T13037)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    const r = sealPending(db, { scope: 'project', replica: REPLICA, env: {} });
    expect(r.refused).toMatch(/unreleased/);
    expect(liveCaptures(db)).toBeGreaterThan(0);
  });

  it('the local column a stored ref uid comes from (ac_id) neither travels nor hashes (T13037)', async () => {
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
    const [i] = ops(db).filter((o) => o.t === hist);
    expect(i?.a).not.toHaveProperty('ac_id');
    expect(i?.a).toMatchObject({ ac_uid: 'uid-AC1' });
    const def = captureTableDef(db, 'project', hist);
    if (!def) throw new Error('no def');
    const before = rowChash(db, 'project', def, 'uid-H1');
    db.prepare(`UPDATE ${hist} SET ac_id = 'AC9' WHERE uid = 'uid-H1'`).run();
    expect(rowChash(db, 'project', def, 'uid-H1')).toBe(before);
  });

  it('doctor reports the backlog head, quarantined tables and a persisted unreleased flag (T13036)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1', null)); // waits for the fill
    db.prepare(
      "INSERT INTO _sync_capture (seq, tbl, op, rk, uid, img, at_ms, state) VALUES ((SELECT max(seq) + 1 FROM _sync_capture), 'not_a_sync_table', 'I', '[\"\\u0027x\\u0027\"]', 'u-x', '{}', 1, 'live')",
    ).run();
    // The no-uid head stops the batch before the poison capture: quarantine
    // it through a second store state instead.
    db.prepare(
      "INSERT INTO _sync_quarantine (seq, tbl, op, rk, uid, img, at_ms, reason, quarantined_at_ms) VALUES (999, 'not_a_sync_table', 'I', 'x', NULL, '{}', 1, 'test', 1)",
    ).run();
    const row = syncSealerDoctorCheck(join(dir, 'project'));
    expect(row.status).toBe('warning');
    expect(row.message).toMatch(/not_a_sync_table \(1\)/);
    expect(row.message).toMatch(/sync\.seal/);
    expect(row.message).toMatch(/2 capture\(s\) waiting, head seq/);
  });
});

describe('#1779 round 3 (T13041)', () => {
  const taskOps = (db: DatabaseSync) => ops(db).filter((o) => o.t === 'tasks_tasks');

  it('a sealed row cleared and deleted in one frame seals D of its uid (MED-A, probe a)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => {
      db.exec("UPDATE tasks_tasks SET uid = NULL WHERE id = 'T1'");
      db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'");
    });
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(r.dropped).toBe(0);
    expect(taskOps(db).map((o) => [o.o, o.u])).toEqual([
      ['I', 'uid-T1'],
      ['D', 'uid-T1'],
    ]);
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toMatchObject({ deleted: 1 });
    expect(liveCaptures(db)).toBe(0);
  });

  it('a clear and a delete in separate frames seal D of the uid and never stall (MED-A, probe a2)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.exec("UPDATE tasks_tasks SET uid = NULL WHERE id = 'T1'"));
    framed(db, () => db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'"));
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(taskOps(db).map((o) => [o.o, o.u])).toEqual([
      ['I', 'uid-T1'],
      ['D', 'uid-T1'],
    ]);
    expect(liveCaptures(db)).toBe(0);
  });

  it('a clear waits for its refill, then seals as one K across transactions (N8)', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.exec("UPDATE tasks_tasks SET uid = NULL WHERE id = 'T1'"));
    expect(seal(db).pending[0]?.reason).toMatch(/NULL uid/);
    // The open-time fill re-mints the uid outside capture, then journals the
    // new identity as K(NULL → y) (captureRemints, T12806 × S2).
    db.exec('BEGIN IMMEDIATE');
    db.exec(
      "DELETE FROM cleo_trigger_suspend; INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')",
    );
    db.exec("UPDATE tasks_tasks SET uid = 'uid-T9' WHERE id = 'T1'");
    db.exec('DELETE FROM cleo_trigger_suspend');
    captureRemints(db, 'project');
    db.exec('COMMIT');
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(taskOps(db).map((o) => [o.o, o.u, o.o === 'K' ? o.nu : undefined])).toEqual([
      ['I', 'uid-T1', undefined],
      ['K', 'uid-T1', 'uid-T9'],
    ]);
    expect(meta(db, 'tasks_tasks', 'uid-T9')).toMatchObject({ deleted: 0 });
  });

  it('a dead row never takes the identity of a later row under the same key (MED-B, probe c)', async () => {
    const db = await store();
    addTask(db, 'R1', null); // no uid, unframed
    db.exec("DELETE FROM tasks_tasks WHERE id = 'R1'");
    framed(db, () => addTask(db, 'R1')); // a new row, uid-R1
    db.exec("UPDATE tasks_tasks SET title = 'new image' WHERE id = 'R1'");
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(r.dropped).toBe(2);
    expect(taskOps(db).map((o) => [o.o, o.u])).toEqual([
      ['I', 'uid-R1'],
      ['U', 'uid-R1'],
    ]);
  });

  it('a reference follows its key: a surviving row points at the row the key names now', async () => {
    // FK semantics: the label still references T1 by key, so on this store it
    // belongs to the new T1. Resolving the live row keeps receivers converged.
    const db = await store();
    addTask(db, 'T1', null);
    framed(db, () =>
      db.exec("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'bug')"),
    );
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'");
    db.exec('PRAGMA foreign_keys = ON');
    framed(db, () => addTask(db, 'T1'));
    const r = seal(db);
    expect(r.pending).toEqual([]);
    expect(ops(db).find((o) => o.t === 'tasks_task_labels')?.k).toEqual({
      task_id: 'uid-T1',
      label: 'bug',
    });
  });

  it('FK actions of a parent delete name the parent by uid (T13226)', async () => {
    // P is a child of epic E; E's criterion targets P (ON DELETE SET NULL) and
    // X depends on P (ON DELETE CASCADE). The actions fire with P already
    // gone, so only P's own D capture still knows uid-P.
    const db = await store();
    framed(db, () => {
      addTask(db, 'E');
      addTask(db, 'P');
      addTask(db, 'X');
      db.exec("UPDATE tasks_tasks SET type = 'epic' WHERE id = 'E'");
      db.exec("UPDATE tasks_tasks SET parent_id = 'E' WHERE id = 'P'");
      db.exec(
        `INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, target_task_id, text, uid, birth_fp)
         VALUES ('ac-e', 'E', 1, 'child_task', 'P', 'targets P', 'uid-ac-e', 'fp-ac-e')`,
      );
      db.exec("INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('X', 'P')");
    });
    seal(db);
    const before = ops(db).length;
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    framed(db, () => db.exec("DELETE FROM tasks_tasks WHERE id = 'P'"));
    const r = seal(db);
    expect(r.pending).toEqual([]);
    const after = ops(db).slice(before);
    // The SET NULL is journaled: before names uid-P, after is null.
    const setNull = after.find((o) => o.t === 'tasks_task_acceptance_criteria');
    expect(setNull).toEqual(
      expect.objectContaining({
        o: 'U',
        u: 'uid-ac-e',
        a: { target_task_id: null },
        b: { target_task_id: 'uid-P' },
      }),
    );
    // The cascaded dependency D carries the parent's uid in its key.
    const dep = after.find((o) => o.t === 'tasks_task_dependencies');
    expect(dep).toEqual(
      expect.objectContaining({ o: 'D', k: { task_id: 'uid-X', depends_on: 'uid-P' } }),
    );
  });

  it('a quarantined capture marks its table suspect and flags the partial transaction (LOW)', async () => {
    const db = await store();
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', 'test');
    addTask(db, 'T1');
    db.prepare(
      "INSERT INTO _sync_capture (seq, tbl, op, rk, uid, img, at_ms, state, frame) VALUES ((SELECT max(seq) + 1 FROM _sync_capture), 'tasks_tasks', 'U', '[\"\\u0027T1\\u0027\"]', 'uid-T1', '{\"title\":[\"not enc\",\"also not\"]}', 1, 'live', ?)",
    ).run(frame);
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    const r = seal(db);
    expect(r.quarantined).toHaveLength(1);
    expect(txns(db).at(-1)).toMatchObject({ partial: 1 });
    expect(
      db.prepare("SELECT 1 AS ok FROM _sync_meta WHERE key = 'suspect:tasks_tasks'").get(),
    ).toEqual({ ok: 1 });
  });
});

describe('S3c: canonical wire timestamps and append-only tombstones (T12986)', () => {
  it('timestamps are canonical on the wire; the sealer never rewrites the local row', async () => {
    const db = await store();
    framed(db, () =>
      db
        .prepare(
          `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, created_at, updated_at)
           VALUES ('T1', 't', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1', '2026-09-14 19:56:01', '2026-09-14 21:56:01')`,
        )
        .run(),
    );
    seal(db);
    const [op] = ops(db);
    expect(op?.a).toMatchObject({
      created_at: '2026-09-14T19:56:01.000Z',
      updated_at: '2026-09-14T21:56:01.000Z',
    });
    expect(
      db.prepare("SELECT created_at, updated_at FROM tasks_tasks WHERE id = 'T1'").get(),
    ).toEqual({ created_at: '2026-09-14 19:56:01', updated_at: '2026-09-14 21:56:01' });
  });

  it('a format-only rewrite of the same instant seals nothing', async () => {
    const db = await store();
    framed(db, () =>
      db
        .prepare(
          `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, created_at)
           VALUES ('T1', 't', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1', '2026-09-14 19:56:01')`,
        )
        .run(),
    );
    seal(db);
    const before = txns(db).length;
    framed(db, () =>
      db
        .prepare("UPDATE tasks_tasks SET created_at = '2026-09-14T19:56:01.000Z' WHERE id = 'T1'")
        .run(),
    );
    const r = seal(db);
    expect(r.captures).toBe(1);
    expect(txns(db)).toHaveLength(before);
  });

  it('chash hashes the canonical form: legacy and canonical text hash alike', async () => {
    const db = await store();
    addTask(db, 'T1');
    const def = captureTableDef(db, 'project', 'tasks_tasks');
    if (!def) throw new Error('no def');
    db.prepare("UPDATE tasks_tasks SET created_at = '2026-09-14 19:56:01' WHERE id = 'T1'").run();
    const legacy = rowChash(db, 'project', def, 'uid-T1');
    db.prepare(
      "UPDATE tasks_tasks SET created_at = '2026-09-14T19:56:01.000Z' WHERE id = 'T1'",
    ).run();
    expect(rowChash(db, 'project', def, 'uid-T1')).toBe(legacy);
    // Another instant still hashes differently.
    db.prepare(
      "UPDATE tasks_tasks SET created_at = '2026-09-14T19:56:02.000Z' WHERE id = 'T1'",
    ).run();
    expect(rowChash(db, 'project', def, 'uid-T1')).not.toBe(legacy);
  });

  it('a delete in an append-only table leaves no per-row tombstone; the D op still travels', async () => {
    const db = await store();
    const hist = 'tasks_task_acceptance_criteria_history';
    expect(captureTableDef(db, 'project', hist)?.appendOnly).toBe(true);
    framed(db, () =>
      db
        .prepare(
          `INSERT INTO ${hist} (ac_id, previous_text, reason, uid, birth_fp) VALUES ('AC1', 'old', 'edit', 'uid-H1', 'fp-H1')`,
        )
        .run(),
    );
    seal(db);
    expect(meta(db, hist, 'uid-H1')).toMatchObject({ deleted: 0 });
    framed(db, () => db.prepare(`DELETE FROM ${hist} WHERE uid = 'uid-H1'`).run());
    seal(db);
    expect(meta(db, hist, 'uid-H1')).toBeUndefined();
    expect(
      ops(db)
        .filter((o) => o.t === hist)
        .map((o) => o.o),
    ).toEqual(['I', 'D']);
    const ledger = db.prepare('SELECT live FROM _sync_ledger WHERE tbl = ?').get(hist) as {
      live: number;
    };
    expect(ledger.live).toBe(0);
  });

  it('a delete in an ordinary table keeps its full tombstone', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    framed(db, () => db.prepare("DELETE FROM tasks_tasks WHERE id = 'T1'").run());
    seal(db);
    expect(meta(db, 'tasks_tasks', 'uid-T1')).toMatchObject({ deleted: 1 });
  });
});
