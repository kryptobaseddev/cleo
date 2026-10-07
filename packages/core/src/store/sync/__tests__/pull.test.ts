/**
 * Pulling a stream's journal (T12343 S5-1; journal spec §3.1, §2.8).
 *
 * Two real stores: A authors and persists segments with the real sealer,
 * segment builder and transaction signatures; a fake stream serves them;
 * B pulls, stages and applies.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  SegmentRefusedError,
  type StreamCursor,
} from '../pull.js';
import { sealPending } from '../sealer.js';
import { buildSegment } from '../segments.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
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

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
  seal(db, RA)();
}

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

/** A's next segment, signed by A's device, as the stream serves it (the sealer is identity here). */
function authorSegment(a: DatabaseSync): Uint8Array {
  const seg = buildSegment(a, {
    stream: STREAM,
    replica: RA,
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

  it('a transaction its device did not sign refuses the segment: nothing of its page is staged', async () => {
    const a = await store('a');
    const b = await store('b');
    const stream = fakeStream();
    write(a, addTask('T1'));
    stream.append(authorSegment(a), 0, RA, 'dev-mallory'); // served under another device's pin
    await expect(pullStream(b, pullOpts(b, stream))).rejects.toBeInstanceOf(SegmentRefusedError);
    expect(n(b, 'SELECT count(*) AS n FROM _sync_inbox')).toBe(0);
    expect(readStreamCursor(b, STREAM)).toBeNull();
  });

  it('a body that is neither a ledger segment nor a vault delta is refused', async () => {
    const b = await store('b');
    const stream = fakeStream();
    stream.append(Buffer.from('not a segment'), 0);
    await expect(pullStream(b, pullOpts(b, stream))).rejects.toThrow(/not a ledger segment/);
    expect(readStreamCursor(b, STREAM)).toBeNull();
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
