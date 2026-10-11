/**
 * Open-pass rebinds that retire the old replica (journal spec §1.5
 * "Retirement", T13337): a rollback of the same file and a cross-filesystem
 * move queue a signed `retire` transaction and a pending server rebind,
 * which `cloud sync` completes (E31). A copy retires nothing. Real replicas:
 * capture, seal, segments, signatures and push.
 *
 * @task T13337
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519, verifyEd25519 } from '../../../cloud/crypto.js';
import { completeOwedRebinds } from '../../../cloud/replica-rebind.js';
import { replicaRetireMessage } from '../../../cloud/signing.js';
import { _resetDeviceIdCacheForTests } from '../../../llm/stable-device-id.js';
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
import { pushStream } from '../push.js';
import { pendingRebind, settleRetireDue } from '../rebind.js';
import {
  activeReplica,
  ensureProjectReplica,
  RECONCILE_DUE_KEY,
  RETIRE_DUE_KEY,
  rebindRetires,
  retireDue,
  syncOpenPass,
} from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { retiredReplicas } from '../retire.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const PROJECT = '0192ffff-7f00-7000-8000-00000000000f';
const STREAM = `project:${PROJECT}`;
const DEV = 'dev-a';
const NEXUS_DEVICE = '0192dddd-7f00-7000-8000-00000000000d';
const KEY = generateEd25519();
const KEYS = { encryption: generateEd25519(), signing: generateEd25519() };
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-open-retire-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  _resetDeviceIdCacheForTests();
});

afterEach(() => {
  _resetDualScopeDbCache();
  _resetDeviceIdCacheForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const storePath = (name: string): string => join(dir, name, '.cleo', 'cleo.db');
/** The test device's replica registry (the open pass never uses the real one here). */
const reg = (): ReplicaRegistry => new ReplicaRegistry(join(dir, 'registry.json'), DEV);

/** Reopen a store file with the chokepoint's sync pass off; the test binds it. */
async function reopen(path: string): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  return getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', path, undefined, { syncMode: 'off' }),
  );
}

/** A store past its genesis on STREAM, bound in test mode to device DEV. */
async function author(name: string): Promise<DatabaseSync> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const path = storePath(name);
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', path));
  db.prepare(
    `INSERT INTO ${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    setSyncFlag(db, flag, true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  ensureProjectReplica(db, { dbPath: path, mode: 'test', registry: reg() });
  expect(
    cutGenesis(db, {
      scope: 'project',
      stream: STREAM,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  completeGenesis(db, {
    stream: STREAM,
    replica: replicaOf(db),
    replicaSeqFloor: null,
    nowIso: new Date(++clock).toISOString(),
  });
  return db;
}

const replicaOf = (db: DatabaseSync): string => activeReplica(db, 'project')?.replicaId ?? '';

function write(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`,
  );
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

/** What a fake server stored, in order. */
type Uploaded = Array<{ replicaId: string; replicaSeq: number; plaintext: Uint8Array }>;

async function push(db: DatabaseSync, uploaded: Uploaded) {
  const replica = replicaOf(db);
  return pushStream(db, {
    scope: 'project',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEY, s, txn),
    upload: async (seg) => {
      uploaded.push({ replicaId: replica, replicaSeq: seg.replicaSeq, plaintext: seg.sealed });
      return { seq: uploaded.length, duplicate: false };
    },
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    registry: reg(),
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
}

const decode = (plaintext: Uint8Array): LedgerTxn[] =>
  JSON.parse(inflateRawSync(plaintext).toString('utf8')) as LedgerTxn[];

/** Checkpoint the WAL into the main file so a byte copy is the whole store. */
function flush(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

function dropSidecars(path: string): void {
  for (const s of ['-wal', '-shm']) if (existsSync(`${path}${s}`)) rmSync(`${path}${s}`);
}

/** Bind the reopened store the way the open pass does, as device DEV. */
function bind(db: DatabaseSync, path: string) {
  return syncOpenPass(db, { dbPath: path, scope: 'project', mode: 'test', registry: reg() });
}

/** A connection that answers like cleo-nexus and records each call. */
function fakeConn() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    conn: {
      apiUrl: 'https://nexus.test',
      deviceId: NEXUS_DEVICE,
      keys: KEYS,
      raw: async <T>(
        _method: string,
        path: string,
        _schema: unknown,
        body?: unknown,
      ): Promise<T> => {
        const b = body as Record<string, unknown>;
        calls.push({ path, body: b });
        if (!path.endsWith('/retirements')) return { replicaId: b['replicaId'] } as T;
        const replicaId = decodeURIComponent(path.split('/replicas/')[1]?.split('/')[0] ?? '');
        return {
          retirement: {
            streamId: STREAM,
            replicaId,
            successor: b['successor'],
            lastReplicaSeq: b['lastReplicaSeq'],
            signerDeviceId: NEXUS_DEVICE,
            txnId: b['txnId'],
            signature: b['signature'],
            retiredAt: new Date(++clock).toISOString(),
          },
        } as T;
      },
    },
  };
}

const target = (name: string) => ({
  streamId: STREAM,
  projectId: null,
  storeRoot: join(dir, name),
});

describe('rebindRetires (§1.5)', () => {
  const entry = {
    nonce: 'n',
    scope: 'project' as const,
    dbRealpath: '/old/.cleo/cleo.db',
    hwm: {},
  };
  it('retires on a rollback or a move, never on a copy or another device', () => {
    expect(rebindRetires(['rollback'], entry, '/old/.cleo/cleo.db')).toBe(true);
    expect(rebindRetires(['file-identity'], entry, '/new/.cleo/cleo.db', () => false)).toBe(true);
    expect(rebindRetires(['file-identity'], entry, '/new/.cleo/cleo.db', () => true)).toBe(false);
    expect(rebindRetires(['file-identity'], undefined, '/new/.cleo/cleo.db', () => false)).toBe(
      false,
    );
    expect(rebindRetires(['file-identity'], entry, '/old/.cleo/cleo.db', () => false)).toBe(false);
    expect(rebindRetires(['rollback', 'nonce-mismatch'], entry, '/old/.cleo/cleo.db')).toBe(false);
    expect(rebindRetires(['file-identity', 'foreign-device'], entry, '/n', () => false)).toBe(
      false,
    );
  });
});

describe('open-pass rebinds and retirement (T13337)', () => {
  it('a rollback of the same file queues a signed retire up to the registry hwm, above the rolled-back store hwm; cloud sync completes it', async () => {
    let db = await author('a');
    const path = storePath('a');
    const uploaded: Uploaded = [];
    write(db, 'T1');
    expect((await push(db, uploaded)).pushed).toBe(1);
    flush(db);
    const backup = readFileSync(path);
    write(db, 'T2');
    expect((await push(db, uploaded)).pushed).toBe(1);
    const old = replicaOf(db);
    // replicaSeq counts from 0: two segments, the registry's hwm is 1.
    expect(reg().get(old)?.hwm[STREAM]).toBe(1);
    // Roll the same file back (same inode): the registry outlives it.
    _resetDualScopeDbCache();
    dropSidecars(path);
    writeFileSync(path, backup);
    db = await reopen(path);
    const bound = bind(db, path);
    expect(bound).toMatchObject({ status: 'rebound', reasons: ['rollback'], retires: true });
    const successor = replicaOf(db);
    expect(retireDue(db)).toMatchObject({ from: old, to: successor, hwm: { [STREAM]: 1 } });
    expect(reg().get(old)).toMatchObject({ successor, retireReason: 'rollback' });

    const pending = settleRetireDue(db, { now: () => new Date(++clock) });
    expect(pending).toMatchObject({ stream: STREAM, from: old, to: successor, lastReplicaSeq: 1 });
    expect(retireDue(db)).toBeNull();
    expect(pendingRebind(db)).toEqual(pending);
    expect(retiredReplicas(db, STREAM, { includeUnconfirmed: true }).get(old)).toMatchObject({
      successor,
      lastReplicaSeq: 1,
    });

    // Push waits for the copy reconcile (T13335; reconcile-copy.test.ts covers
    // it). Here the record is cleared as the reconcile would clear it.
    expect((await push(db, uploaded)).refusedKind).toBe('reconcile-pending');
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(RECONCILE_DUE_KEY);
    // The retire travels signed under the successor, first.
    expect((await push(db, uploaded)).pushed).toBeGreaterThan(0);
    const mine = uploaded.filter((u) => u.replicaId === successor);
    const txns = mine.flatMap((u) => decode(u.plaintext));
    expect(txns[0]).toMatchObject({
      txn: pending?.retireTxn,
      kind: 'retire',
      retire: { replica: old, successor, lastReplicaSeq: 1 },
    });
    expect(firstBadTxnSignature(KEY.publicKey, STREAM, txns)).toBeNull();

    // cloud sync completes the server half: attach, then a signed E31.
    const { calls, conn } = fakeConn();
    expect(await completeOwedRebinds(conn, target('a'), db)).toMatchObject({ to: successor });
    const e31 = calls.find((c) => c.path.endsWith('/retirements'));
    expect(e31?.path).toContain(encodeURIComponent(old));
    expect(e31?.body).toMatchObject({
      successor,
      lastReplicaSeq: 1,
      txnId: pending?.retireTxn,
    });
    const message = replicaRetireMessage({
      streamId: STREAM,
      replicaId: old,
      successor,
      lastReplicaSeq: 1,
      signerDeviceId: NEXUS_DEVICE,
      txnId: pending?.retireTxn ?? null,
    });
    expect(
      verifyEd25519(
        KEYS.signing.publicKey,
        message,
        Buffer.from(String(e31?.body.signature), 'base64'),
      ),
    ).toBe(true);
    expect(pendingRebind(db)).toBeNull();
    expect(retiredReplicas(db, STREAM).get(old)?.confirmedAt).not.toBeNull();
  });

  it('a cross-filesystem move (the old path gone) queues a retire; cloud sync completes it', async () => {
    const db = await author('a');
    const uploaded: Uploaded = [];
    write(db, 'T1');
    expect((await push(db, uploaded)).pushed).toBe(1);
    const old = replicaOf(db);
    flush(db);
    mkdirSync(join(dir, 'b', '.cleo'), { recursive: true });
    copyFileSync(storePath('a'), storePath('b'));
    _resetDualScopeDbCache();
    rmSync(join(dir, 'a'), { recursive: true, force: true });
    const moved = await reopen(storePath('b'));
    expect(bind(moved, storePath('b'))).toMatchObject({
      status: 'rebound',
      reasons: ['file-identity'],
      retires: true,
    });
    const successor = replicaOf(moved);
    expect(reg().get(old)).toMatchObject({ successor, retireReason: 'file-identity' });
    // cloud sync settles what the open owed, then completes it (E31).
    const { calls, conn } = fakeConn();
    expect(await completeOwedRebinds(conn, target('b'), moved)).toMatchObject({
      from: old,
      to: successor,
      lastReplicaSeq: 0,
    });
    expect(calls.map((c) => c.path.endsWith('/retirements'))).toEqual([false, true]);
    const retire = moved
      .prepare("SELECT txn, retire_json FROM _sync_txn WHERE kind = 'retire'")
      .get() as { txn: string; retire_json: string };
    expect(JSON.parse(retire.retire_json)).toEqual({
      replica: old,
      successor,
      lastReplicaSeq: 0,
    });
    expect(calls[1]?.body).toMatchObject({ successor, lastReplicaSeq: 0, txnId: retire.txn });
    expect(retireDue(moved)).toBeNull();
    expect(pendingRebind(moved)).toBeNull();
  });

  it('a copy rebinds but retires nothing: no retire transaction, nothing pending', async () => {
    const db = await author('a');
    const uploaded: Uploaded = [];
    write(db, 'T1');
    expect((await push(db, uploaded)).pushed).toBe(1);
    const old = replicaOf(db);
    flush(db);
    mkdirSync(join(dir, 'c', '.cleo'), { recursive: true });
    copyFileSync(storePath('a'), storePath('c'));
    const copy = await reopen(storePath('c'));
    const bound = bind(copy, storePath('c'));
    expect(bound).toMatchObject({ status: 'rebound', reasons: ['file-identity'] });
    expect(bound.status === 'rebound' && bound.retires).toBeFalsy();
    expect(retireDue(copy)).toBeNull();
    expect(settleRetireDue(copy)).toBeNull();
    expect(pendingRebind(copy)).toBeNull();
    expect(copy.prepare("SELECT count(*) AS n FROM _sync_txn WHERE kind = 'retire'").get()).toEqual(
      { n: 0 },
    );
    // The original keeps its live registration.
    expect(reg().get(old)?.retiredAt ?? null).toBeNull();
    const { calls, conn } = fakeConn();
    expect(await completeOwedRebinds(conn, target('c'), copy)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a canonical live open settles the retire of a moved store at once', async () => {
    mkdirSync(join(dir, 'a', '.cleo'), { recursive: true });
    const first = getDualScopeNativeDb(await openDualScopeDbAtPath('project', storePath('a')));
    setSyncFlag(first, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
    // The live open binds as the stable device, into its own registry.
    _resetDualScopeDbCache();
    const a = getDualScopeNativeDb(await openDualScopeDbAtPath('project', storePath('a')));
    const old = replicaOf(a);
    expect(old).not.toBe('');
    a.prepare('INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
      `genesis_cut:${STREAM}`,
      '0',
      new Date().toISOString(),
    );
    flush(a);
    mkdirSync(join(dir, 'b', '.cleo'), { recursive: true });
    copyFileSync(storePath('a'), storePath('b'));
    _resetDualScopeDbCache();
    rmSync(join(dir, 'a'), { recursive: true, force: true });
    const b = getDualScopeNativeDb(await openDualScopeDbAtPath('project', storePath('b')));
    expect(realpathSync(storePath('b'))).toContain(join('b', '.cleo'));
    expect(replicaOf(b)).not.toBe(old);
    expect(b.prepare('SELECT 1 FROM _sync_meta WHERE key = ?').get(RETIRE_DUE_KEY)).toBeUndefined();
    // It never landed a segment: retired with no journal transaction.
    expect(pendingRebind(b)).toMatchObject({
      stream: STREAM,
      from: old,
      to: replicaOf(b),
      lastReplicaSeq: null,
      retireTxn: null,
    });
  });
});
