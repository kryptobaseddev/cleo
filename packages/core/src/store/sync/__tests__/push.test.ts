/**
 * Pushing a stream's journal (T12343 S4-2; journal spec §2.8, §2.9, §1.3).
 *
 * Real stores (capture, seal, the real sealer and segment builder) and a
 * fake uploader standing in for the journal client.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import {
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_RECIPE,
  ROW_IDENTITY_RECIPE_KEY,
} from '../../row-identity.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { completeGenesis, cutGenesis } from '../genesis.js';
import { CLOCK_AHEAD_KEY, pushStream, type SegmentUploader } from '../push.js';
import { ensureProjectReplica, storeHwm } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import type { PersistedSegment } from '../segments.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
let clock = Date.now();
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-push-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  dbPath = join(dir, 'p', '.cleo', 'cleo.db');
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

const n = (db: DatabaseSync, sql: string, ...args: Array<string | number>): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

/** A store past its genesis (cut, checkpoint stored): push may send. */
async function pushing(
  floor: number | null = null,
): Promise<{ db: DatabaseSync; replica: string; registry: ReplicaRegistry }> {
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', dbPath));
  db.prepare(
    `INSERT INTO ${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  const registry = new ReplicaRegistry(join(dir, 'registry.json'), 'host-1');
  const { replicaId } = ensureProjectReplica(db, { dbPath, mode: 'test', registry });
  const cut = cutGenesis(db, {
    scope: 'project',
    stream: STREAM,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(cut.refused).toBeNull();
  completeGenesis(db, {
    stream: STREAM,
    replica: replicaId,
    replicaSeqFloor: floor,
    nowIso: new Date(++clock).toISOString(),
  });
  return { db, replica: replicaId, registry };
}

/** A fake server: stores segments by (replicaSeq, hash), assigns seqs, answers duplicates. */
function fakeServer() {
  const stored = new Map<number, { hash: string; seq: number }>();
  const sent: PersistedSegment[] = [];
  let head = 0;
  let failNext = false;
  const upload: SegmentUploader = async (seg) => {
    sent.push(seg);
    if (failNext) {
      failNext = false;
      throw new Error('network down');
    }
    const prior = stored.get(seg.replicaSeq);
    if (prior) {
      expect(prior.hash, 'a resend carried different bytes').toBe(seg.segmentHash);
      return { seq: prior.seq, duplicate: true };
    }
    head += 1;
    stored.set(seg.replicaSeq, { hash: seg.segmentHash, seq: head });
    return { seq: head, duplicate: false };
  };
  return {
    upload,
    sent,
    stored,
    failOnce: () => {
      failNext = true;
    },
    /** The server stored the next upload but the response was lost. */
    storeThenLose: (seg: PersistedSegment) => {
      head += 1;
      stored.set(seg.replicaSeq, { hash: seg.segmentHash, seq: head });
    },
  };
}

const opts = (replica: string, server: ReturnType<typeof fakeServer>, extra = {}) => ({
  scope: 'project' as const,
  stream: STREAM,
  replica,
  project: null,
  sealer: (_seq: number, plaintext: Uint8Array) => Buffer.from(plaintext),
  signTxn: (_stream: string, txn: Parameters<Parameters<typeof pushStream>[1]['signTxn']>[1]) =>
    txn,
  upload: server.upload,
  serverDate: new Date(clock),
  serverLastReplicaSeq: null,
  now: () => ++clock,
  env: {},
  allowUnreleased: true,
  ...extra,
});

describe('pushStream (S4-2)', () => {
  it('seals, persists and uploads the pending journal once; a second run sends nothing', async () => {
    const { db, replica, registry } = await pushing();
    write(db, addTask('T1'));
    write(db, addTask('T2'));
    const server = fakeServer();
    const r = await pushStream(db, opts(replica, server, { registry }));
    expect(r).toMatchObject({ refused: null, clockAhead: false, sealed: 2, built: 1, pushed: 1 });
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]?.replicaSeq).toBe(0);
    expect(r.lastServerSeq).toBe(1);
    expect(
      db.prepare('SELECT state, server_seq FROM _sync_segment WHERE replica_seq = 0').get(),
    ).toEqual({ state: 'pushed', server_seq: 1 });
    // The device registry follows the store's persisted mark.
    expect(registry.get(replica)?.hwm[STREAM]).toBe(0);
    expect(storeHwm(db, replica)[STREAM]).toBe(0);
    const again = await pushStream(db, opts(replica, server));
    expect(again).toMatchObject({ sealed: 0, built: 0, pushed: 0 });
    expect(server.sent).toHaveLength(1);
  });

  it('an upload that fails is resent next run with the same bytes; a stored-but-lost one counts as a duplicate', async () => {
    const { db, replica } = await pushing();
    write(db, addTask('T1'));
    const server = fakeServer();
    server.failOnce();
    await expect(pushStream(db, opts(replica, server))).rejects.toThrow('network down');
    expect(n(db, "SELECT count(*) AS n FROM _sync_segment WHERE state = 'sealed'")).toBe(1);
    // The server stores it this time, but the answer is lost: the next run resends, a duplicate.
    const [first] = server.sent;
    if (!first) throw new Error('fixture');
    server.storeThenLose(first);
    const r = await pushStream(db, opts(replica, server));
    expect(r).toMatchObject({ pushed: 1, duplicates: 1, built: 0 });
    expect(server.sent.map((s) => s.segmentHash)).toEqual([first.segmentHash, first.segmentHash]);
    expect(n(db, "SELECT count(*) AS n FROM _sync_segment WHERE state = 'pushed'")).toBe(1);
  });

  it('the first journal segment follows the replica seq the genesis push recorded', async () => {
    const { db, replica } = await pushing(4); // the vault's deltas spent replicaSeq 0..4
    write(db, addTask('T1'));
    const server = fakeServer();
    await pushStream(db, opts(replica, server, { serverLastReplicaSeq: 4 }));
    expect(server.sent[0]?.replicaSeq).toBe(5);
  });

  it('a clock ahead of the server pauses push (no seal, no segment) and is reported until it recovers', async () => {
    const { db, replica } = await pushing();
    write(db, addTask('T1'));
    const server = fakeServer();
    const paused = await pushStream(
      db,
      opts(replica, server, { serverDate: new Date(clock - 10 * 60 * 1000) }),
    );
    expect(paused).toMatchObject({ clockAhead: true, sealed: 0, built: 0, pushed: 0 });
    expect(n(db, 'SELECT count(*) AS n FROM _sync_meta WHERE key = ?', CLOCK_AHEAD_KEY)).toBe(1);
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBeGreaterThan(
      0,
    );
    const ok = await pushStream(db, opts(replica, server));
    expect(ok).toMatchObject({ clockAhead: false, pushed: 1 });
    expect(n(db, 'SELECT count(*) AS n FROM _sync_meta WHERE key = ?', CLOCK_AHEAD_KEY)).toBe(0);
  });

  it('a server ahead of the store (restored or copied) is refused before anything is sealed or sent', async () => {
    const { db, replica } = await pushing();
    write(db, addTask('T1'));
    const server = fakeServer();
    const r = await pushStream(db, opts(replica, server, { serverLastReplicaSeq: 2 }));
    expect(r.refused).toMatch(/behind .*rebind/);
    expect(r).toMatchObject({ sealed: 0, built: 0, pushed: 0 });
    expect(server.sent).toHaveLength(0);
  });

  it('refuses with push off, with no cut, and while the genesis checkpoint is not stored', async () => {
    const { db, replica } = await pushing();
    const server = fakeServer();
    db.prepare("DELETE FROM _sync_meta WHERE key = 'genesis_pending:' || ?").run(STREAM);
    db.prepare(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('genesis_pending:' || ?, '0', 'x')",
    ).run(STREAM);
    expect((await pushStream(db, opts(replica, server))).refused).toMatch(/not stored yet/);
    db.prepare("DELETE FROM _sync_meta WHERE key LIKE 'genesis_%'").run();
    expect((await pushStream(db, opts(replica, server))).refused).toMatch(/no genesis cut/);
    setSyncFlag(db, 'sync.push', false, { schemaRoot: SYNC_SCHEMA });
    expect((await pushStream(db, opts(replica, server))).refused).toBe('sync.push is off');
    expect(server.sent).toHaveLength(0);
  });
});
