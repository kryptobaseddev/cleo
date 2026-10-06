/**
 * Persist before push: the segment outbox (T12343 O-1; journal spec §2.8).
 *
 * Real stores: local writes go through capture frames and the real sealer;
 * the segment sealer is a deterministic stand-in for the journal client's
 * `sealSegment` (the bytes persisted are whatever it returns).
 *
 * @task T12343
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { AppendSegmentRequest } from '@cleocode/contracts/cloud';
import { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { ROW_IDENTITY_META_TABLE, ROW_IDENTITY_SYNCED_KEY } from '../../row-identity.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { sealPending } from '../sealer.js';
import {
  buildSegment,
  markSegmentPushed,
  type SegmentSealer,
  unpushedSegments,
} from '../segments.js';
import { unsequencedLocalTxns } from '../sequencing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '0192aaaa-7f00-7000-8000-00000000000a';
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
const NOW = '2026-10-06T00:00:00.000Z';
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-segments-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'p', '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
  const r = sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null).toBeNull();
}

const addTask = (id: string, uid: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', '${uid}', 'fp-${uid}')`;

/** A stand-in for the journal client's sealSegment: deterministic, and records what it saw. */
function recordingSealer(): { sealer: SegmentSealer; seen: Array<{ seq: number; plain: Buffer }> } {
  const seen: Array<{ seq: number; plain: Buffer }> = [];
  return {
    seen,
    sealer: (replicaSeq, plaintext) => {
      seen.push({ seq: replicaSeq, plain: Buffer.from(plaintext) });
      return Buffer.concat([Buffer.from(`sealed:${replicaSeq}:`), Buffer.from(plaintext)]);
    },
  };
}

const n = (db: DatabaseSync, sql: string, ...args: Array<string | number>): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

const build = (db: DatabaseSync, sealer: SegmentSealer, maxPlaintextBytes?: number) =>
  buildSegment(db, {
    stream: STREAM,
    replica: REPLICA,
    project: '0192ffff-7f00-7000-8000-00000000000f',
    sealer,
    nowIso: NOW,
    ...(maxPlaintextBytes !== undefined ? { maxPlaintextBytes } : {}),
  });

describe('segment outbox: persist before push (§2.8)', () => {
  it('packs sealed transactions in order and persists the exact sealed bytes in one transaction', async () => {
    const db = await store();
    write(db, `${addTask('A', 'a')}; ${addTask('B', 'b')}`);
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'a'");
    write(db, "DELETE FROM tasks_tasks WHERE uid = 'b'");
    const txns = (
      db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq').all() as Array<{ txn: string }>
    ).map((t) => t.txn);
    const { sealer, seen } = recordingSealer();
    const seg = build(db, sealer);
    expect(seg).not.toBeNull();
    if (!seg) return;
    expect(seg.replicaSeq).toBe(0);
    expect(seg.txns).toEqual(txns);
    // The persisted bytes are exactly what the sealer returned, hashed.
    const row = db
      .prepare('SELECT sealed, segment_hash, state FROM _sync_segment WHERE replica_seq = 0')
      .get() as { sealed: Uint8Array; segment_hash: string; state: string };
    expect(Buffer.from(row.sealed)).toEqual(sealer(0, seen[0]?.plain ?? Buffer.alloc(0), seg.meta));
    expect(row.segment_hash).toBe(createHash('sha256').update(row.sealed).digest('hex'));
    expect(row.state).toBe('sealed');
    // The plaintext is deflate-raw canonical JSON of the wire transactions.
    const wire = JSON.parse(inflateRawSync(seen[0]?.plain ?? Buffer.alloc(0)).toString('utf8'));
    expect(wire.map((t: unknown) => LedgerTxn.parse(t).txn)).toEqual(txns);
    // Every packed txn is segmented, mapped in order, and its rows are marked sent.
    expect(n(db, "SELECT count(*) AS n FROM _sync_txn WHERE state = 'segmented'")).toBe(3);
    expect(
      (
        db.prepare('SELECT txn FROM _sync_segment_txn ORDER BY idx').all() as Array<{ txn: string }>
      ).map((t) => t.txn),
    ).toEqual(txns);
    expect(
      n(db, "SELECT count(*) AS n FROM _sync_row_meta WHERE sent = 1 AND uid IN ('a', 'b')"),
    ).toBe(2);
    // uids are about to leave the device: the marker is written, once (§3.4).
    const marker = db
      .prepare(`SELECT value FROM ${ROW_IDENTITY_META_TABLE} WHERE key = ?`)
      .get(ROW_IDENTITY_SYNCED_KEY) as { value: string };
    expect(JSON.parse(marker.value)).toMatchObject({
      replicaId: REPLICA,
      stream: STREAM,
      reason: 'send',
    });
    // Nothing left to pack.
    expect(build(db, sealer)).toBeNull();
  });

  it('declares segment/v3 metadata the server accepts: counts, HLC range, deltas summing per txn', async () => {
    const db = await store();
    write(db, `${addTask('A', 'a')}; ${addTask('B', 'b')}`);
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'a'");
    write(db, "DELETE FROM tasks_tasks WHERE uid = 'b'");
    const seg = build(db, recordingSealer().sealer);
    if (!seg) throw new Error('no segment');
    expect(seg.meta).toMatchObject({
      schemaVersion: SYNC_SCHEMA_VERSION,
      opCount: 4,
      deltas: { tasks_tasks: { created: 2, deleted: 1 } },
      txnDeltas: [
        { txn: 0, deltas: { tasks_tasks: { created: 2, deleted: 0 } } },
        { txn: 1, deltas: {} },
        { txn: 2, deltas: { tasks_tasks: { created: 0, deleted: 1 } } },
      ],
    });
    expect(seg.meta.hlcMin <= seg.meta.hlcMax).toBe(true);
    // The server's own schema (txnDeltas index and sum, opCount) accepts it.
    expect(
      AppendSegmentRequest.safeParse({
        replicaId: REPLICA,
        deviceId: '0192dddd-7f00-4000-8000-00000000000d',
        segmentHash: seg.segmentHash,
        replicaSeq: seg.replicaSeq,
        signature: Buffer.from('sig').toString('base64'),
        ciphertext: seg.sealed.toString('base64'),
        ...seg.meta,
        txnDeltas: [...(seg.meta.txnDeltas ?? [])],
      }).success,
    ).toBe(true);
  });

  it('respects the plaintext budget, keeps a larger transaction whole, and counts replicaSeq gap-free', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    write(db, addTask('B', 'b'));
    write(db, `${addTask('C', 'c')}; ${addTask('D', 'd')}; ${addTask('E', 'e')}`);
    const { sealer } = recordingSealer();
    const sizes: number[] = [];
    for (let seg = build(db, sealer, 1); seg !== null; seg = build(db, sealer, 1)) {
      expect(seg.replicaSeq).toBe(sizes.length);
      sizes.push(seg.txns.length);
    }
    expect(sizes, 'one transaction per segment under a 1-byte budget').toEqual([1, 1, 1]);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_segment_txn')).toBe(3);
  });

  it('a sealer that fails leaves nothing behind: no segment, txns still sealed, nothing sent', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    expect(() =>
      build(db, () => {
        throw new Error('no stream key');
      }),
    ).toThrow('no stream key');
    expect(db.isTransaction).toBe(false);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_segment')).toBe(0);
    expect(n(db, "SELECT count(*) AS n FROM _sync_txn WHERE state = 'sealed'")).toBe(1);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_row_meta WHERE sent = 1')).toBe(0);
    expect(
      n(
        db,
        `SELECT count(*) AS n FROM ${ROW_IDENTITY_META_TABLE} WHERE key = ?`,
        ROW_IDENTITY_SYNCED_KEY,
      ),
    ).toBe(0);
  });

  it('a resend reads back the same bytes; a stored segment leaves the unpushed list', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    write(db, addTask('B', 'b'));
    const { sealer } = recordingSealer();
    const first = build(db, sealer, 1);
    const second = build(db, sealer, 1);
    if (!first || !second) throw new Error('no segments');
    // A crash before the push: the outbox still holds the exact bytes, lowest first.
    const waiting = unpushedSegments(db, STREAM, REPLICA);
    expect(waiting.map((s) => s.replicaSeq)).toEqual([0, 1]);
    expect(waiting[0]?.sealed).toEqual(first.sealed);
    expect(waiting[0]?.segmentHash).toBe(first.segmentHash);
    expect(waiting[0]?.meta).toEqual(first.meta);
    markSegmentPushed(db, {
      stream: STREAM,
      replica: REPLICA,
      replicaSeq: 0,
      serverSeq: 41,
      nowIso: NOW,
    });
    expect(unpushedSegments(db, STREAM, REPLICA).map((s) => s.replicaSeq)).toEqual([1]);
    expect(
      db.prepare('SELECT state, server_seq FROM _sync_segment WHERE replica_seq = 0').get(),
    ).toEqual({ state: 'pushed', server_seq: 41 });
  });

  it('a segmented transaction stays unsequenced until its echo (§3.5)', async () => {
    const db = await store();
    db.prepare(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('undo_enabled', '1', ?) ON CONFLICT (key) DO NOTHING",
    ).run(NOW);
    write(db, addTask('A', 'a'));
    build(db, recordingSealer().sealer);
    expect(unsequencedLocalTxns(db).map((t) => t.txn)).toEqual([
      (db.prepare('SELECT txn FROM _sync_txn').get() as { txn: string }).txn,
    ]);
  });
});
