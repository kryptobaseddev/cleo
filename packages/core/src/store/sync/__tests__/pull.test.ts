/**
 * Pulling a stream's journal (T12343 S5-1; journal spec §3.1, §2.8).
 *
 * Two real stores: A authors and persists segments with the real sealer,
 * segment builder and transaction signatures; a fake stream serves them;
 * B pulls, stages and applies.
 *
 * @task T12343
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import {
  type PulledStreamSegment,
  pullStream,
  readStreamCursor,
  type StreamCursor,
  seenTxnReport,
} from '../pull.js';
import { ensureSyncSchema } from '../schema.js';
import { sealPending } from '../sealer.js';
import { buildSegment } from '../segments.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
const RC = '0192cccc-7f00-7000-8000-00000000000c';
/** A's successor after a rebind: a new replica id, the store's local_seq counter continues. */
const RA2 = '0192aaaa-7f00-7000-8000-0000000000a2';
const DEV_A = 'dev-a';
const KEY_A = generateEd25519();
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-pull-'));
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

async function store(name: string): Promise<DatabaseSync> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, name, '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  setSyncFlag(db, 'sync.pull', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

const seal = (db: DatabaseSync, replica: string) => () => {
  sealPending(db, {
    scope: 'project',
    replica,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
};

function write(db: DatabaseSync, sql: string, replica = RA): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
  seal(db, replica)();
}

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

/** A's next segment, signed by A's device, as the stream serves it (the sealer is identity here). */
function authorSegment(a: DatabaseSync, replica = RA): Uint8Array {
  const seg = buildSegment(a, {
    stream: STREAM,
    replica,
    scope: 'project',
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (stream, txn) => signTxn(KEY_A, stream, txn),
    nowIso: new Date(++clock).toISOString(),
  });
  if (!seg) throw new Error('nothing to pack');
  return seg.sealed;
}

/** A fake stream: segments in seq order, served after the cursor, one page at a time. */
function fakeStream() {
  const segments: PulledStreamSegment[] = [];
  let pages = 0;
  return {
    segments,
    get pages() {
      return pages;
    },
    append(plaintext: Uint8Array, replicaSeq: number, replicaId = RA, deviceId = DEV_A): void {
      segments.push({
        seq: segments.length + 1,
        replicaId,
        replicaSeq,
        deviceId,
        plaintext,
        schemaVersion: SYNC_SCHEMA_VERSION,
      });
    },
    pull: async (cursor: StreamCursor) => {
      pages += 1;
      const page = segments.filter((s) => s.seq > cursor.after).slice(0, 2);
      const replicas = { ...cursor.replicas };
      for (const s of page)
        replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
      return {
        segments: page,
        cursor: { after: page.at(-1)?.seq ?? cursor.after, knowsAllReplicas: true, replicas },
        head: segments.length,
      };
    },
  };
}

const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };

const pullOpts = (b: DatabaseSync, stream: ReturnType<typeof fakeStream>) => ({
  scope: 'project' as const,
  stream: STREAM,
  replica: RB,
  pull: stream.pull,
  verify: (deviceId: string, txns: Parameters<typeof firstBadTxnSignature>[2]) =>
    deviceId === DEV_A ? firstBadTxnSignature(KEY_A.publicKey, STREAM, txns) : 0,
  initialCursor: START,
  now: () => ++clock,
  env: {},
  seal: seal(b, RB),
});

const n = (db: DatabaseSync, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n);

describe('pullStream (S5-1)', () => {
  it("stages and applies another replica's segments in stream order, persisting the cursor; a rerun pulls nothing", async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0);
    write(a, addTask('T2'));
    stream.append(authorSegment(a), 1);
    write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE id = 'T1'");
    stream.append(authorSegment(a), 2);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ segments: 3, staged: 3, redelivered: 0, after: 3, head: 3 });
    expect(r.apply?.applied).toBe(3);
    expect(b.prepare("SELECT priority FROM tasks_tasks WHERE id = 'T1'").get()).toEqual({
      priority: 'high',
    });
    expect(readStreamCursor(b, STREAM)).toMatchObject({ after: 3 });
    const again = await pullStream(b, pullOpts(b, stream));
    expect(again).toMatchObject({ segments: 0, staged: 0, after: 3 });
  });

  it('a re-delivered transaction is never staged or applied twice', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    const first = authorSegment(a);
    stream.append(first, 0);
    await pullStream(b, pullOpts(b, stream));
    // The same transaction arrives again in a later segment (a replayed or re-sealed segment).
    stream.append(first, 1);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ segments: 1, staged: 0, redelivered: 1 });
    expect(n(b, 'SELECT count(*) AS n FROM _sync_inbox')).toBe(1);
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T1'")).toBe(1);
    expect(n(b, 'SELECT count(*) AS n FROM _sync_conflict')).toBe(0);
  });

  it('a vault delta segment carries no ops and is passed over', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    stream.append(
      Buffer.from(
        JSON.stringify({ kind: 'cleo-vault-delta/v1', base: 'cp-1', tables: { tasks_tasks: 2 } }),
      ),
      0,
    );
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 1);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ segments: 2, vaultDeltas: 1, staged: 1, after: 2 });
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T1'")).toBe(1);
  });

  it('a refused segment stops the pull there: what precedes it is applied, the cursor stops before it, a retry re-stages nothing (T13307)', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0);
    write(a, addTask('T2'));
    stream.append(authorSegment(a), 1);
    write(a, addTask('T3'));
    stream.append(authorSegment(a), 2, RA, 'dev-mallory'); // page 2: served under another device's pin
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r.refused).toMatch(/segment 3 of replica .*not signed by device dev-mallory/);
    expect(r).toMatchObject({ segments: 2, staged: 2, after: 2 });
    expect(r.apply?.applied).toBe(2);
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id IN ('T1', 'T2')")).toBe(2);
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T3'")).toBe(0);
    expect(readStreamCursor(b, STREAM)).toMatchObject({ after: 2 });
    const retry = await pullStream(b, pullOpts(b, stream));
    expect(retry).toMatchObject({ segments: 0, staged: 0, after: 2 });
    expect(retry.refused).toMatch(/segment 3/);
  });

  it('a refused segment mid-page: the segments before it in that page are staged and applied', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0);
    stream.append(Buffer.from('not a segment'), 1); // same page as seq 1
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r.refused).toMatch(/segment 2 of replica .*not a ledger segment/);
    expect(r).toMatchObject({ segments: 1, staged: 1, after: 1 });
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T1'")).toBe(1);
  });

  it('refuses with sync.pull off: nothing pulled, nothing staged', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0);
    setSyncFlag(b, 'sync.pull', false, { schemaRoot: SYNC_SCHEMA });
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ refused: 'sync.pull is off', segments: 0, apply: null });
    expect(stream.pages).toBe(0);
    expect(n(b, 'SELECT count(*) AS n FROM _sync_inbox')).toBe(0);
  });
});

describe('per-origin seen floor (T13318)', () => {
  const floorOf = (db: DatabaseSync, origin: string) =>
    db
      .prepare(
        'SELECT staged_upto AS stagedUpto, pruned_upto AS prunedUpto, seen_rows AS rows FROM _sync_seen_floor WHERE stream = ? AND origin = ?',
      )
      .get(STREAM, origin);

  it('a re-delivered txn below the floor is skipped while its seen row exists, and refused loudly once pruned', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    const first = authorSegment(a); // RA:1
    stream.append(first, 0);
    write(a, addTask('T2'));
    stream.append(authorSegment(a), 1); // RA:2
    write(a, addTask('T3'));
    const third = authorSegment(a); // RA:3
    stream.append(third, 2);
    await pullStream(b, pullOpts(b, stream));
    expect(floorOf(b, RA)).toEqual({ stagedUpto: 3, prunedUpto: 0, rows: 3 });

    // Below the floor, row present: skipped as seen.
    stream.append(first, 3);
    const seen = await pullStream(b, { ...pullOpts(b, stream), pruneSeen: true });
    expect(seen).toMatchObject({ refused: null, staged: 0, redelivered: 1, after: 4 });
    // The prune drops every row below the floor and keeps the floor's own.
    expect(floorOf(b, RA)).toEqual({ stagedUpto: 3, prunedUpto: 2, rows: 1 });
    expect(b.prepare('SELECT txn FROM _sync_seen_txn').all()).toEqual([{ txn: `${RA}:3` }]);

    // The latest txn is still skipped quietly; a pruned one is refused, never staged.
    stream.append(third, 4);
    stream.append(first, 5);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r.refusedKind).toBe('below-floor');
    expect(r.refused).toMatch(
      new RegExp(`segment 6 of replica ${RA}: transaction ${RA}:1 .*pruned \\(pruned_upto 2\\)`),
    );
    expect(r).toMatchObject({ segments: 1, staged: 0, redelivered: 1, after: 5 });
    expect(readStreamCursor(b, STREAM)).toMatchObject({ after: 5 });
    expect(n(b, 'SELECT count(*) AS n FROM _sync_inbox')).toBe(3);
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T1'")).toBe(1);
    // The refusal holds on retry: the stream stops there until someone looks.
    const retry = await pullStream(b, pullOpts(b, stream));
    expect(retry).toMatchObject({ refusedKind: 'below-floor', segments: 0, after: 5 });
  });

  it('a txn below the floor that was never staged is refused as out of order, never skipped', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    const early = authorSegment(a); // RA:1, held back
    write(a, addTask('T2'));
    stream.append(authorSegment(a), 0); // RA:2 first
    stream.append(early, 1);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r.refusedKind).toBe('below-floor');
    expect(r.refused).toMatch(/transaction .*:1 is at or below .*floor 2.*out of local_seq order/);
    expect(r).toMatchObject({ segments: 1, staged: 1, after: 1 });
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'T1'")).toBe(0);
    expect(n(b, 'SELECT count(*) AS n FROM _sync_seen_txn')).toBe(1);
  });

  it("the migration seeds each origin's floor and counts from rows staged before it existed", async () => {
    // A journal at the folder before the floor, with seen rows already staged.
    const older = join(dir, 'older-schema');
    for (const f of readdirSync(SYNC_SCHEMA).filter((f) => f < '20261009120000')) {
      cpSync(join(SYNC_SCHEMA, f), join(older, f), { recursive: true });
    }
    mkdirSync(join(dir, 'old', '.cleo'), { recursive: true });
    const db = getDualScopeNativeDb(
      await openDualScopeDbAtPath('project', join(dir, 'old', '.cleo', 'cleo.db')),
    );
    ensureSyncSchema(db, { root: older });
    const ins = db.prepare('INSERT INTO _sync_seen_txn (stream, txn, seq) VALUES (?, ?, ?)');
    ins.run(STREAM, `${RA}:1`, 1);
    ins.run(STREAM, `${RA}:9`, 2);
    ins.run(STREAM, `${RC}:4`, 3);
    ensureSyncSchema(db, { root: SYNC_SCHEMA });
    const row = (txn: string) => STREAM.length + txn.length + 8;
    expect(floorOf(db, RA)).toEqual({ stagedUpto: 9, prunedUpto: 0, rows: 2 });
    expect(floorOf(db, RC)).toEqual({ stagedUpto: 4, prunedUpto: 0, rows: 1 });
    expect(db.prepare('SELECT sum(seen_bytes) AS b FROM _sync_seen_floor').get()).toEqual({
      b: row(`${RA}:1`) + row(`${RA}:9`) + row(`${RC}:4`),
    });
  });

  it('a store whose journal records the floor folder but lost the table gets it back on pull, counts re-seeded', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0); // RA:1
    write(a, addTask('T2'));
    stream.append(authorSegment(a), 1); // RA:2
    await pullStream(b, pullOpts(b, stream));
    b.exec('DROP TABLE _sync_seen_floor');
    // Until the next pull, status still reports the ledger, never zero.
    expect(seenTxnReport(b)).toMatchObject({ rows: 2, byStream: { [STREAM]: 2 } });
    write(a, addTask('T3'));
    stream.append(authorSegment(a), 2); // RA:3
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ refused: null, staged: 1, after: 3 });
    expect(floorOf(b, RA)).toEqual({ stagedUpto: 3, prunedUpto: 0, rows: 3 });
    expect(seenTxnReport(b)).toMatchObject({ rows: 3, byStream: { [STREAM]: 3 } });
  });

  it("a transaction that is not the segment replica's is refused", async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0, RC); // RA's txn served as replica RC's
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r.refusedKind).toBe('segment');
    expect(r.refused).toMatch(new RegExp(`transaction ${RA}:1 is not one of its transactions`));
    expect(r).toMatchObject({ staged: 0, after: 0 });
  });

  it("rebind proof case: a retired replica's late segment and its successor keep separate floors; nothing is refused", async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    const old0 = authorSegment(a); // RA:1
    write(a, addTask('T2'));
    const late = authorSegment(a); // RA:2: pushed before the rebind, sequenced after
    // The rebind: a new replica id; the store's local_seq counter continues.
    write(a, addTask('T3'), RA2);
    const succ = authorSegment(a, RA2);
    stream.append(old0, 0, RA);
    stream.append(succ, 0, RA2);
    stream.append(late, 1, RA);
    const r = await pullStream(b, pullOpts(b, stream));
    expect(r).toMatchObject({ refused: null, staged: 3, after: 3 });
    expect(floorOf(b, RA)).toMatchObject({ stagedUpto: 2 });
    expect(floorOf(b, RA2)).toMatchObject({ stagedUpto: 3 });
    expect(n(b, "SELECT count(*) AS n FROM tasks_tasks WHERE id IN ('T1', 'T2', 'T3')")).toBe(3);
  });

  it("revive proof case: a voided txn stays seen; the author's later txn is staged above the floor; re-delivery of the void is skipped", async () => {
    const a = await store('a');
    const b = await store('b');
    const c = await store('c');
    const stream = fakeStream();
    write(a, addTask('T1')); // RA:1
    stream.append(authorSegment(a), 0);
    await pullStream(c, { ...pullOpts(c, stream), replica: RC, seal: seal(c, RC) });
    write(a, "DELETE FROM tasks_tasks WHERE id = 'T1'"); // RA:2
    stream.append(authorSegment(a), 1);
    await new Promise((r) => setTimeout(r, 5)); // C's edit is newer than A's delete
    write(c, "UPDATE tasks_tasks SET priority = 'high' WHERE id = 'T1'", RC); // RC:1
    const voided = authorSegment(c, RC);
    stream.append(voided, 0, RC);
    await pullStream(b, pullOpts(b, stream));
    expect(b.prepare('SELECT status FROM _sync_inbox WHERE replica_id = ?').all(RC)).toEqual([
      { status: 'void' },
    ]);
    expect(floorOf(b, RC)).toMatchObject({ stagedUpto: 1 });
    // The author writes again (a re-emit is a new txn, `reemitOf`, spec §2.11 §6).
    write(c, addTask('T4'), RC); // RC:2
    stream.append(authorSegment(c, RC), 1, RC);
    stream.append(voided, 2, RC);
    const r = await pullStream(b, { ...pullOpts(b, stream), pruneSeen: true });
    expect(r).toMatchObject({ refused: null, staged: 1, redelivered: 1 });
    expect(floorOf(b, RC)).toMatchObject({ stagedUpto: 2, prunedUpto: 1 });
    expect(b.prepare('SELECT count(*) AS n FROM _sync_inbox WHERE replica_id = ?').get(RC)).toEqual(
      { n: 2 },
    );
  });
});
