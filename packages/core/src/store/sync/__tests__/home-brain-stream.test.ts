/**
 * The main brain stream end to end (T13370): two devices' GLOBAL stores on
 * the account's `home:<user>` stream. A cuts the stream's genesis, B joins
 * it; brain rows written on A reach B with the same uid and the same content
 * hash, and a concurrent edit to one observation resolves by the merge rules
 * to the same row on both.
 *
 * Every step runs the real code (capture triggers, sealer, segment builder,
 * txn signatures, push, pull, inbox, merge engine, applier) against global
 * stores; only the server is a fake stream that orders segments as they
 * arrive.
 *
 * @task T13370
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import { readStoreSyncStream } from '../../../cloud/nexus-cloud-status.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { listConflicts } from '../conflicts.js';
import { setSyncFlag, syncSetTables } from '../flags.js';
import { completeGenesis, cutGenesis, joinStream } from '../genesis.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { activeReplica, ensureGlobalReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { rowChash, sealPending } from '../sealer.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'home:0192ffff-7f00-7000-8000-0000000013a2';
const KEYS = { 'dev-a': generateEd25519(), 'dev-b': generateEd25519() } as const;
type Device = keyof typeof KEYS;
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-home-brain-'));
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

interface Replica {
  readonly db: DatabaseSync;
  readonly device: Device;
}

const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };

/** A global store with capture, seal, push and pull on, bound to its own replica. */
async function open(name: string, device: Device): Promise<Replica> {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, 'cleo.db');
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('global', path));
  setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    setSyncFlag(db, flag, true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  const registry = new ReplicaRegistry(join(dir, `registry-${name}.json`), device);
  ensureGlobalReplica(db, { dbPath: path, mode: 'test', registry });
  return { db, device };
}

const replicaOf = (r: Replica): string => activeReplica(r.db, 'global')?.replicaId ?? '';

/** A cuts the home stream's genesis; B, an empty global store, joins it at the start. */
async function twoDevices(): Promise<{ a: Replica; b: Replica }> {
  const a = await open('a', 'dev-a');
  expect(
    cutGenesis(a.db, {
      scope: 'global',
      stream: STREAM,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  completeGenesis(a.db, {
    stream: STREAM,
    replica: replicaOf(a),
    replicaSeqFloor: null,
    nowIso: new Date(++clock).toISOString(),
  });
  const b = await open('b', 'dev-b');
  expect(
    joinStream(b.db, {
      scope: 'global',
      stream: STREAM,
      cursor: START,
      now: () => ++clock,
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  return { a, b };
}

/** One local write, in its own capture frame, as a command would make it. */
function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

/** The fake server: segments in arrival order; pulls page after the cursor. */
function fakeStream() {
  const segments: PulledStreamSegment[] = [];
  return {
    segments,
    append(plaintext: Uint8Array, replicaSeq: number, replicaId: string, deviceId: string): number {
      segments.push({
        seq: segments.length + 1,
        replicaId,
        replicaSeq,
        deviceId,
        plaintext,
        schemaVersion: SYNC_SCHEMA_VERSION,
      });
      return segments.length;
    },
    pull: async (cursor: StreamCursor) => {
      const page = segments.filter((s) => s.seq > cursor.after).slice(0, 2);
      const replicas = { ...cursor.replicas };
      for (const s of page) {
        replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
      }
      return {
        segments: page,
        cursor: { after: page.at(-1)?.seq ?? cursor.after, knowsAllReplicas: true, replicas },
        head: segments.length,
      };
    },
  };
}
type Stream = ReturnType<typeof fakeStream>;

async function push(r: Replica, stream: Stream) {
  const replica = replicaOf(r);
  const out = await pushStream(r.db, {
    scope: 'global',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEYS[r.device], s, txn),
    upload: async (seg) => ({
      seq: stream.append(seg.sealed, seg.replicaSeq, replica, r.device),
      duplicate: false,
    }),
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused).toBeNull();
  return out;
}

async function pull(r: Replica, stream: Stream) {
  const replica = replicaOf(r);
  const opts: PullStreamOptions = {
    scope: 'global',
    stream: STREAM,
    replica,
    pull: stream.pull,
    verify: (deviceId: string, txns: readonly LedgerTxn[]) =>
      deviceId in KEYS ? firstBadTxnSignature(KEYS[deviceId as Device].publicKey, STREAM, txns) : 0,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {
      sealPending(r.db, {
        scope: 'global',
        replica,
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
      });
    },
  };
  const out = await pullStream(r.db, opts);
  expect(out.refused).toBeNull();
  return out;
}

/** The brain tables the main brain stream must carry (T13370 AC1). */
const BRAIN_TABLES = [
  'brain_observations',
  'brain_decisions',
  'brain_patterns',
  'brain_learnings',
  'brain_page_nodes',
  'brain_page_edges',
  'brain_sticky_notes',
] as const;

/** `uid -> wire-image hash` for every live row of a table, in uid order. */
function rowHashes(db: DatabaseSync, table: string): Array<[string, string | null]> {
  const def = captureTableDef(db, 'global', table);
  if (!def) throw new Error(`${table} is not captured in the global sync set`);
  return (
    db.prepare(`SELECT uid FROM "${table}" WHERE uid IS NOT NULL ORDER BY uid`).all() as Array<{
      uid: string;
    }>
  ).map((r) => [r.uid, rowChash(db, 'global', def, r.uid) ?? null]);
}

/** Per-table content checksum over the global sync set (tables with rows only). */
function contentChecksums(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of syncSetTables('global')) {
    if (!captureTableDef(db, 'global', table)) continue;
    const rows = rowHashes(db, table);
    if (rows.length === 0) continue;
    const h = createHash('sha256');
    for (const [uid, chash] of rows) h.update(`${uid}\0${chash ?? ''}\n`);
    out[table] = h.digest('hex');
  }
  return out;
}

/** One row in each main brain table, written on a device as a memory command would. */
function writeBrain(db: DatabaseSync): void {
  write(
    db,
    `INSERT INTO brain_observations (id, type, title, narrative, created_at, valid_at) VALUES
       ('O-home0001', 'discovery', 'home stream works', 'first', '2026-10-10T09:00:00.000Z', '2026-10-10 09:00:00');
     INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at, valid_at) VALUES
       ('D9001', 'architecture', 'Sync the main brain', 'two devices', 'high', '2026-10-10 09:01:00', '2026-10-10 09:01:00');
     INSERT INTO brain_patterns (id, type, pattern, context, extracted_at, valid_at) VALUES
       ('P-home0001', 'workflow', 'pull then push', 'sync', '2026-10-10 09:02:00', '2026-10-10 09:02:00');
     INSERT INTO brain_learnings (id, insight, source, confidence, created_at, valid_at) VALUES
       ('L-home0001', 'home streams carry the brain', 'session', 0.8, '2026-10-10 09:03:00', '2026-10-10 09:03:00');
     INSERT INTO brain_page_nodes (id, node_type, label, created_at, last_activity_at) VALUES
       ('observation:O-home0001', 'observation', 'home stream works', '2026-10-10 09:04:00', '2026-10-10 09:04:00');
     INSERT INTO brain_page_edges (from_id, to_id, edge_type, created_at) VALUES
       ('observation:O-home0001', 'decision:D9001', 'co_retrieved', '2026-10-10 09:05:00');
     INSERT INTO brain_sticky_notes (id, content, created_at) VALUES
       ('SN-901', 'carry this across', '2026-10-10 09:06:00');`,
  );
}

const observation = (db: DatabaseSync): Record<string, unknown> | undefined =>
  db
    .prepare('SELECT uid, title, narrative, type FROM brain_observations WHERE id = ?')
    .get('O-home0001') as Record<string, unknown> | undefined;

describe('the main brain stream (home:<user>) end to end (T13370)', () => {
  it('brain rows written on A reach B with the same uid and the same content hash', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    writeBrain(a.db);
    const pushed = await push(a, stream);
    expect(stream.segments.length).toBeGreaterThan(0);
    expect(pushed.refused).toBeNull();
    await pull(b, stream);
    for (const table of BRAIN_TABLES) {
      const atA = rowHashes(a.db, table);
      expect(atA.length, table).toBe(1);
      expect(atA[0]?.[1], `${table} content hash`).not.toBeNull();
      expect(rowHashes(b.db, table), table).toEqual(atA);
    }
    expect(contentChecksums(b.db)).toEqual(contentChecksums(a.db));
  });

  it("cloud status names the home stream from the store's own journal: cut, unsent ops, pushed and pulled positions", async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const status = (r: Replica, name: string) =>
      readStoreSyncStream(r.db, 'global', null, join(dir, name, 'cleo.db'));
    writeBrain(a.db);
    sealPending(a.db, {
      scope: 'global',
      replica: replicaOf(a),
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    });
    const before = await status(a, 'a');
    expect(before.stream).toBe(STREAM);
    expect(before.genesisCut).not.toBeNull();
    expect(before.genesisPending).toBe(false);
    // Seven inserts sealed, none sent yet.
    expect(before.unsentOps).toEqual({ known: true, value: BRAIN_TABLES.length });
    expect(before.lastPushedSeq.known).toBe(false);

    // A packed segment the server never stored is still unsent.
    await expect(
      pushStream(a.db, {
        scope: 'global',
        stream: STREAM,
        replica: replicaOf(a),
        project: null,
        sealer: (_seq, plaintext) => Buffer.from(plaintext),
        signTxn: (s, txn) => signTxn(KEYS[a.device], s, txn),
        upload: async () => {
          throw new Error('offline');
        },
        serverOffsetMs: 0,
        serverLastReplicaSeq: null,
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
      }),
    ).rejects.toThrow('offline');
    expect((await status(a, 'a')).unsentOps).toEqual({ known: true, value: BRAIN_TABLES.length });

    await push(a, stream);
    const after = await status(a, 'a');
    expect(after.unsentOps).toEqual({ known: true, value: 0 });
    expect(after.lastPushedSeq).toEqual({ known: true, value: stream.segments.length });

    const joined = await status(b, 'b');
    expect(joined.stream).toBe(STREAM);
    expect(joined.genesisCut).not.toBeNull();
    expect(joined.lastPulledSeq).toEqual({ known: true, value: 0 });
    await pull(b, stream);
    expect((await status(b, 'b')).lastPulledSeq).toEqual({
      known: true,
      value: stream.segments.length,
    });
  });

  it('a concurrent edit to one observation resolves to the same row on both, with the same conflicts', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    writeBrain(a.db);
    await push(a, stream);
    await pull(b, stream);
    await pull(a, stream); // own echo
    expect(observation(b.db)).toEqual(observation(a.db));

    // Offline, concurrently: A retitles it; B retitles it and rewrites the
    // narrative later (B's edit carries the later HLC).
    write(a.db, "UPDATE brain_observations SET title = 'title from A' WHERE id = 'O-home0001'");
    await push(a, stream);
    write(
      b.db,
      "UPDATE brain_observations SET title = 'title from B', narrative = 'from B' WHERE id = 'O-home0001'",
    );
    await push(b, stream); // B pushes without having pulled A's edit

    await pull(a, stream);
    await pull(b, stream);
    const atA = observation(a.db);
    expect(atA).toEqual(observation(b.db));
    // Per-field LWW by HLC: B wins both fields it touched.
    expect(atA).toMatchObject({ title: 'title from B', narrative: 'from B' });
    const keys = (db: DatabaseSync) =>
      listConflicts(db, { stream: STREAM })
        .map((c) => `${c.table}|${c.uid}|${[...c.columns].sort().join(',')}`)
        .sort();
    expect(keys(a.db).length).toBeGreaterThan(0);
    expect(keys(a.db)).toEqual(keys(b.db));
    expect(contentChecksums(b.db)).toEqual(contentChecksums(a.db));
  });
});
