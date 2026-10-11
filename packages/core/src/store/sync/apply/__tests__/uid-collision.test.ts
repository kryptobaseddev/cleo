/**
 * Uid collisions on apply (T12341 §6.4 step 3, T13394): an incoming row op
 * whose uid is held here by a live row with ANOTHER birth fingerprint is two
 * different rows that minted one uid. It is never merged: the transaction is
 * held (pending) and a `uid-collision` conflict naming the loser (the greater
 * fingerprint) is recorded once. A same-fingerprint delivery (the same row)
 * still applies, and a re-key naming the other row never touches the winner.
 *
 * @task T13394
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../../capture.js';
import { listConflicts } from '../../conflicts.js';
import { setSyncFlag } from '../../flags.js';
import { stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import { type ApplyReport, applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const STREAM = 'project:t13394-uid-collision';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
let clock = Date.now();
let dir: string;
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  cursor: number;
}

beforeEach(() => {
  published = [];
  dir = mkdtempSync(join(tmpdir(), 'cleo-uid-collision-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function replica(id: string): Promise<Replica> {
  const name = id.slice(4, 8);
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, name, '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return { db, id, cursor: 0 };
}

function seal(r: Replica): void {
  const out = sealPending(r.db, {
    scope: 'project',
    replica: r.id,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused ?? null, 'sealing was refused').toBeNull();
}

/** One local write through a capture frame, sealed; returns its txn id. */
function write(r: Replica, sql: string): string {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', null);
  r.db.exec(sql);
  finishCaptureFrame(r.db, frame);
  r.db.exec('COMMIT');
  seal(r);
  return (
    r.db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq DESC LIMIT 1').get() as {
      txn: string;
    }
  ).txn;
}

/** A sealed transaction as the stream carries it. */
function txnOf(r: Replica, id: string): LedgerTxn {
  const t = r.db
    .prepare('SELECT txn, hlc, via, kind, actor FROM _sync_txn WHERE txn = ?')
    .get(id) as {
    txn: string;
    hlc: string;
    via: LedgerTxn['via'];
    kind: LedgerTxn['kind'];
    actor: string | null;
  };
  return {
    v: 1,
    txn: t.txn,
    hlc: t.hlc,
    project: null,
    scope: 'project',
    via: t.via,
    kind: t.kind,
    actor: t.actor?.startsWith('{') ? LedgerActor.parse(JSON.parse(t.actor)) : null,
    ops: (
      r.db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
        body: string;
      }>
    ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
    sig: '',
  };
}

function publish(replicaId: string, ...txns: LedgerTxn[]): void {
  published.push({ replicaId, txns });
}

function sync(r: Replica): ApplyReport {
  for (; r.cursor < published.length; r.cursor++) {
    const s = published[r.cursor] as { replicaId: string; txns: LedgerTxn[] };
    stageTxns(
      r.db,
      STREAM,
      {
        seq: r.cursor + 1,
        replicaId: s.replicaId,
        replicaSeq: r.cursor + 1,
        deviceId: `dev-${s.replicaId.slice(4, 8)}`,
        schemaVersion: SYNC_SCHEMA_VERSION,
        txns: s.txns,
      },
      new Date().toISOString(),
    );
  }
  return applyStagedTxns(r.db, {
    scope: 'project',
    stream: STREAM,
    replica: r.id,
    now: () => Date.now(),
    seal: () => seal(r),
  });
}

const rows = (db: DatabaseSync, table: string, cols: string): Array<Record<string, unknown>> =>
  db.prepare(`SELECT ${cols} FROM main."${table}" ORDER BY uid`).all() as Array<
    Record<string, unknown>
  >;

const inboxStatus = (db: DatabaseSync, replicaId: string): string[] =>
  (
    db
      .prepare('SELECT status FROM _sync_inbox WHERE replica_id = ? ORDER BY seq')
      .all(replicaId) as Array<{ status: string }>
  ).map((r) => r.status);

/** Same id, same birth second, different query: one uid, two fingerprints. */
const retrieval = (query: string) =>
  `INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source, session_id, created_at)
     VALUES ('${query}', '["O-1"]', 1, 'find', 'ses-1', '2026-09-01 09:00:00')`;

/** Same id and created_at, different title: one uid, two fingerprints. */
const task = (title: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
     VALUES ('T1', '${title}', 'task', 'pending', 'medium', '2026-09-01T09:00:00.000Z')`;

/**
 * Two replicas each write a row of `table` that mints the same uid with a
 * different fingerprint, publish, and apply both. Each must keep its own row
 * untouched, hold the other's transaction, and record one collision.
 */
async function collide(
  table: string,
  sqlA: string,
  sqlB: string,
  cols: string,
): Promise<{ a: Replica; b: Replica }> {
  const a = await replica(RA);
  const b = await replica(RB);
  const ta = write(a, sqlA);
  const tb = write(b, sqlB);
  const [ra] = rows(a.db, table, 'uid, birth_fp');
  const [rb] = rows(b.db, table, 'uid, birth_fp');
  expect(ra?.uid, 'the recipe gives both rows one uid').toBe(rb?.uid);
  expect(ra?.birth_fp).not.toBe(rb?.birth_fp);
  const before = { a: rows(a.db, table, cols), b: rows(b.db, table, cols) };
  publish(a.id, txnOf(a, ta));
  publish(b.id, txnOf(b, tb));
  for (const [r, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const rep = sync(r);
    expect(rep.pending, `${r.id.slice(4, 8)} holds the other row`).toBe(1);
    expect(rep.void).toBe(0);
    // Its own row is untouched: never a mix of the two.
    expect(rows(r.db, table, cols)).toEqual(r === a ? before.a : before.b);
    // Its own echo applied; the other replica's transaction waits, pending.
    expect(inboxStatus(r.db, r.id)).toEqual(['applied']);
    expect(inboxStatus(r.db, other.id)).toEqual(['pending']);
    const cs = listConflicts(r.db);
    expect(cs).toHaveLength(1);
    const localFp = (r === a ? ra : rb)?.birth_fp as string;
    const incomingFp = (r === a ? rb : ra)?.birth_fp as string;
    expect(cs[0]).toMatchObject({
      kind: 'uid-collision',
      table,
      uid: ra?.uid,
      resolution: 'op-held',
      rule: `loser:${incomingFp > localFp ? 'incoming' : 'local'}`,
    });
    // Re-planned on the next apply, the hold is still listed once.
    expect(sync(r).pending).toBe(1);
    expect(listConflicts(r.db)).toHaveLength(1);
  }
  return { a, b };
}

describe('an incoming row with a known uid and another birth fingerprint is never merged', () => {
  it('brain_retrieval_log: two devices write id 1 in the same second; both rows survive', async () => {
    const { a, b } = await collide(
      'brain_retrieval_log',
      retrieval('query a'),
      retrieval('query b'),
      'uid, birth_fp, query',
    );
    // The held row is not lost: it waits in the inbox with its own values.
    for (const [r, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const held = r.db
        .prepare(`SELECT txn_json FROM _sync_inbox WHERE replica_id = ? AND status = 'pending'`)
        .get(other.id) as { txn_json: string };
      expect(held.txn_json).toContain(r === a ? 'query b' : 'query a');
    }
  });

  it('tasks_tasks: two devices create T1 at the same instant with different titles', async () => {
    await collide('tasks_tasks', task('alpha'), task('beta'), 'uid, birth_fp, id, title');
  });
});

describe('the same row still merges', () => {
  it('a same-fingerprint delivery applies: the other replica gets the row, then its update', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    publish(a.id, txnOf(a, write(a, task('alpha'))));
    expect(sync(b)).toMatchObject({ pending: 0, void: 0 });
    publish(a.id, txnOf(a, write(a, "UPDATE tasks_tasks SET title = 'alpha 2' WHERE id = 'T1'")));
    expect(sync(b)).toMatchObject({ pending: 0, void: 0 });
    expect(rows(b.db, 'tasks_tasks', 'uid, birth_fp, title')).toEqual(
      rows(a.db, 'tasks_tasks', 'uid, birth_fp, title'),
    );
    expect(listConflicts(b.db)).toEqual([]);
    // Each replica's own echo is the same row too.
    expect(sync(a)).toMatchObject({ pending: 0, void: 0 });
    expect(listConflicts(a.db)).toEqual([]);
  });
});

describe('a re-key names its row by (uid, old fingerprint)', () => {
  it('a K for the other row of a collision never moves the winner', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const ta = write(a, task('alpha'));
    write(b, task('beta'));
    const [rb] = rows(b.db, 'tasks_tasks', 'uid, birth_fp, title');
    const txn = txnOf(a, ta);
    const ins = txn.ops[0] as LedgerOp;
    // A's row re-keyed to a fresh uid, as its authority would publish it.
    const k: LedgerTxn = {
      ...txn,
      txn: `${a.id}:999`,
      hlc: txn.hlc.replace(/^\d{13}/, (ms) => String(Number(ms) + 1).padStart(13, '0')),
      kind: 'rekey',
      ops: [
        {
          t: 'tasks_tasks',
          o: 'K',
          u: ins.u,
          nu: '0192cccc-7f00-7000-8000-00000000000c',
          h: txn.hlc,
          bfp: ins.bfp,
          obfp: ins.bfp,
        } as LedgerOp,
      ],
    };
    publish(a.id, k);
    sync(b);
    expect(rows(b.db, 'tasks_tasks', 'uid, birth_fp, title')).toEqual([rb]);
  });
});
