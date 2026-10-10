/**
 * The undo-budget rebind at the next pull to head (T13278; journal spec
 * §3.5 Rule 2 D5, §1.5 "Retirement" and N7).
 *
 * Real replicas: A authors through the real capture triggers, sealer,
 * segment builder, signatures and push; it goes offline, its undo passes the
 * budget, and the next pull that reaches the head rebinds it, reconciles what
 * it never sent, and retires the old id. B, another replica, pulls the same
 * fake stream. A late segment of the retired replica lands after the retire
 * and applies as history.
 *
 * @task T13278
 * @task T12763
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import { remintAuthority } from '../../display-id-alias.js';
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
import { encodeHlc } from '../hlc.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  readStreamCursor,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { pendingRebind, REBIND_PENDING_KEY, undoBudgetRebindDue } from '../rebind.js';
import { decideReconcileField } from '../reconcile.js';
import { activeReplica, ensureProjectReplica, listReplicas } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import {
  confirmRetirements,
  liveReplicaHorizon,
  retiredReplicas,
  withRetirements,
} from '../retire.js';
import { sealPending } from '../sealer.js';
import { recordUndoBudget, UNDO_BUDGET_EXCEEDED_KEY, undoBudget } from '../sequencing.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
const DEV_A = 'dev-a';
const DEV_B = 'dev-b';
const RETIRED_AT = '2026-10-09T12:00:00.000Z';
const KEY_A = generateEd25519();
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-rebind-head-'));
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
  readonly path: string;
  readonly device: string;
  readonly registry: ReplicaRegistry;
}

async function open(name: string, device: string): Promise<Replica> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const path = join(dir, name, '.cleo', 'cleo.db');
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', path));
  db.prepare(
    `INSERT INTO ${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    setSyncFlag(db, flag, true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  const registry = new ReplicaRegistry(join(dir, `registry-${name}.json`), device);
  ensureProjectReplica(db, { dbPath: path, mode: 'test', registry });
  return { db, path, device, registry };
}

/** A, past its genesis on the stream: it pushes, and keeps undo. */
async function author(): Promise<Replica> {
  const a = await open('a', DEV_A);
  expect(
    cutGenesis(a.db, {
      scope: 'project',
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
  return a;
}

const replicaOf = (r: Replica): string => activeReplica(r.db, 'project')?.replicaId ?? '';

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

const n = (db: DatabaseSync, sql: string, ...args: string[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

/** The fake stream: segments in seq order; uploads append, pulls page after the cursor. */
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

const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };

async function push(a: Replica, stream: Stream, fail = false) {
  const replica = replicaOf(a);
  return pushStream(a.db, {
    scope: 'project',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEY_A, s, txn),
    upload: async (seg) => {
      if (fail) throw new Error('offline');
      return {
        seq: stream.append(seg.sealed, seg.replicaSeq, replica, a.device),
        duplicate: false,
      };
    },
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
}

function pullOpts(r: Replica, stream: Stream, extra: Partial<PullStreamOptions> = {}) {
  const replica = replicaOf(r);
  return {
    scope: 'project' as const,
    stream: STREAM,
    replica,
    pull: stream.pull,
    verify: (deviceId: string, txns: readonly LedgerTxn[]) =>
      deviceId === DEV_A ? firstBadTxnSignature(KEY_A.publicKey, STREAM, txns) : 0,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {
      sealPending(r.db, {
        scope: 'project',
        replica,
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
      });
    },
    rebind: { dbPath: r.path, mode: 'test' as const, deviceId: r.device, registry: r.registry },
    ...extra,
  };
}

const decode = (plaintext: Uint8Array): LedgerTxn[] =>
  JSON.parse(inflateRawSync(plaintext).toString('utf8')) as LedgerTxn[];

const title = (db: DatabaseSync, id: string) =>
  (
    db.prepare('SELECT title FROM tasks_tasks WHERE id = ?').get(id) as
      | { title: string }
      | undefined
  )?.title;

/**
 * A replica that pushed T1, went offline, wrote more, failed to push twice
 * (two unsent segments), and passed its undo budget. B has T1.
 */
async function offlineOverBudget() {
  const a = await author();
  const b = await open('b', DEV_B);
  const stream = fakeStream();
  write(a.db, addTask('T1'));
  expect((await push(a, stream)).pushed).toBe(1);
  await pullStream(b.db, pullOpts(b, stream));
  await pullStream(a.db, pullOpts(a, stream)); // own echo: sequenced
  const old = replicaOf(a);
  // Offline: two segments built, neither reaches the server.
  write(a.db, "UPDATE tasks_tasks SET title = 'offline title', priority = 'high' WHERE id = 'T1'");
  write(a.db, addTask('T2'));
  await expect(push(a, stream, true)).rejects.toThrow('offline');
  write(a.db, "UPDATE tasks_tasks SET title = 'late title' WHERE id = 'T1'");
  await expect(push(a, stream, true)).rejects.toThrow('offline');
  // The first unsent segment lands on the stream late, after the retire: its
  // title is older than the one the reconcile re-emits, a divergent edit.
  const late = a.db
    .prepare(
      "SELECT sealed, replica_seq AS rs FROM _sync_segment WHERE replica_id = ? AND state = 'sealed' ORDER BY replica_seq LIMIT 1",
    )
    .get(old) as { sealed: Uint8Array; rs: number };
  // A capture never sealed, too.
  a.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(a.db, 'write', null);
  a.db.exec("UPDATE tasks_tasks SET status = 'active' WHERE id = 'T2'");
  finishCaptureFrame(a.db, frame);
  a.db.exec('COMMIT');
  expect(n(a.db, 'SELECT count(*) AS n FROM _sync_undo')).toBeGreaterThan(0);
  expect(recordUndoBudget(a.db, new Date(++clock).toISOString(), 1).state).toBe('exceeded');
  return { a, b, stream, old, late };
}

describe('the undo-budget rebind at the next pull to head (T13278, D5)', () => {
  it('rebinds, reconciles, retires the old id at head; never re-sends the old outbox; B applies it and a late old segment as history', async () => {
    const { a, b, stream, old, late } = await offlineOverBudget();

    const r = await pullStream(a.db, pullOpts(a, stream));
    expect(r.refused).toBeNull();
    const rebind = r.rebind;
    expect(rebind).not.toBeNull();
    const successor = replicaOf(a);
    expect(successor).not.toBe(old);
    expect(rebind).toMatchObject({ previousReplicaId: old, replicaId: successor });
    // The old replica is retired, its successor named; the device registry agrees.
    expect(listReplicas(a.db).find((x) => x.replicaId === old)).toMatchObject({
      successor,
    });
    expect(a.registry.get(old)?.retireReason).toBe('undo-budget');
    // The key is cleared by the rebind, and only the server half is pending.
    expect(undoBudgetRebindDue(a.db)).toBe(false);
    expect(pendingRebind(a.db)).toMatchObject({
      stream: STREAM,
      from: old,
      to: successor,
      lastReplicaSeq: 0,
    });
    // The old outbox is inherited, its undo gone: only the reconcile's own undo remains.
    expect(
      n(
        a.db,
        "SELECT count(*) AS n FROM _sync_segment WHERE replica_id = ? AND state = 'inherited'",
        old,
      ),
    ).toBe(2);
    expect(n(a.db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'inherited'")).toBe(0);
    expect(n(a.db, "SELECT count(*) AS n FROM _sync_undo WHERE kind <> 'repair'")).toBe(0);
    expect(rebind?.reconcile).toMatchObject({ inserts: 1, updates: 1, deletes: 0 });

    // Push under the successor: the retire, then the rebind repair. Nothing of the old outbox.
    const before = stream.segments.length;
    const pushed = await push(a, stream);
    expect(pushed.refused).toBeNull();
    const sent = stream.segments.slice(before);
    expect(sent.every((s) => s.replicaId === successor)).toBe(true);
    const txns = sent.flatMap((s) => decode(s.plaintext));
    expect(txns[0]).toMatchObject({
      kind: 'retire',
      via: 'rebind',
      ops: [],
      retire: { replica: old, successor, lastReplicaSeq: 0 },
    });
    expect(txns[0]?.txn.startsWith(`${successor}:`)).toBe(true);
    const repair = txns.find((t) => t.kind === 'repair');
    expect(repair).toMatchObject({ via: 'rebind' });
    const byUid = Object.fromEntries((repair?.ops ?? []).map((o) => [o.u, o]));
    expect(byUid['uid-T2']).toMatchObject({ o: 'I' });
    expect(byUid['uid-T2']?.a).toMatchObject({ status: 'active' });
    expect(byUid['uid-T1']).toMatchObject({ o: 'U' });
    expect(byUid['uid-T1']?.a).toEqual({ title: 'late title', priority: 'high' });
    // A late segment of the retired replica lands after the retire.
    stream.append(late.sealed, late.rs, old, DEV_A);

    // The server confirmed the retirement (T13366): the home listing or E31's record.
    const atB = await pullStream(
      b.db,
      pullOpts(b, stream, {
        rebind: undefined,
        serverRetirements: [{ replicaId: old, successor, retiredAt: RETIRED_AT }],
      }),
    );
    expect(atB.refused).toBeNull();
    expect(retiredReplicas(b.db, STREAM).get(old)).toMatchObject({
      successor,
      lastReplicaSeq: 0,
      seq: before + 1,
      confirmedAt: RETIRED_AT,
    });
    expect(title(b.db, 'T1')).toBe('late title');
    expect(title(b.db, 'T2')).toBe('title T2');
    // The late segment applied as history: no conflict against the reconcile.
    expect(n(b.db, 'SELECT count(*) AS n FROM _sync_conflict')).toBe(0);

    // A's own retire is confirmed by the E31 answer (completeServerRebind, T13366).
    expect(
      confirmRetirements(a.db, STREAM, [{ replicaId: old, successor, retiredAt: RETIRED_AT }]),
    ).toBe(1);
    // A pulls its echo: the retire's seq is filled, the repair is sequenced, its undo drained.
    const echo = await pullStream(a.db, pullOpts(a, stream));
    expect(echo.rebind).toBeNull();
    expect(retiredReplicas(a.db, STREAM).get(old)?.seq).toBe(before + 1);
    expect(n(a.db, 'SELECT count(*) AS n FROM _sync_undo')).toBe(0);
    expect(n(a.db, 'SELECT count(*) AS n FROM _sync_conflict')).toBe(0);
    expect(title(a.db, 'T1')).toBe('late title');
    // The ledger counts each live row once (the reconcile's I recounts T2),
    // once the apply frame's captures are sealed.
    sealPending(a.db, {
      scope: 'project',
      replica: successor,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    });
    expect(n(a.db, "SELECT live AS n FROM _sync_ledger WHERE tbl = 'tasks_tasks'")).toBe(
      n(a.db, 'SELECT count(*) AS n FROM tasks_tasks'),
    );

    // The fold horizon and the remint authority leave the old id out.
    const retired = retiredReplicas(b.db, STREAM);
    const hOld = '0000000000001-0000-a';
    expect(liveReplicaHorizon({ [old]: hOld, [successor]: 'z', x: 'y' }, retired)).toBe('y');
    const retireHlc = retired.get(old)?.hlc ?? '';
    const members = withRetirements(
      [
        { id: old, joinedHlc: encodeHlc({ phys: 0, ctr: 0, replica: old }) },
        { id: successor, joinedHlc: encodeHlc({ phys: 0, ctr: 0, replica: successor }) },
      ],
      retired,
    );
    expect(members[0]?.retiredHlc).toBe(retireHlc);
    expect(
      remintAuthority({
        cloudSynced: false,
        origin: old,
        replicas: members,
        collisionHlc: retireHlc,
        atHlc: retireHlc,
      }).authority,
    ).toBe(successor);
  });

  it('an unconfirmed retire changes nothing: the late segment records its conflicts and the old id still counts (T13366)', async () => {
    const { a, b, stream, old, late } = await offlineOverBudget();
    await pullStream(a.db, pullOpts(a, stream));
    const successor = replicaOf(a);
    await push(a, stream);
    stream.append(late.sealed, late.rs, old, DEV_A);

    // A signed retire, but no server record of it.
    const atB = await pullStream(b.db, pullOpts(b, stream, { rebind: undefined }));
    expect(atB.refused).toBeNull();
    expect(retiredReplicas(b.db, STREAM).has(old)).toBe(false);
    expect(retiredReplicas(b.db, STREAM, { includeUnconfirmed: true }).get(old)).toMatchObject({
      successor,
      confirmedAt: null,
    });
    // The values are the same either way; only the conflict records differ.
    expect(title(b.db, 'T1')).toBe('late title');
    expect(n(b.db, 'SELECT count(*) AS n FROM _sync_conflict')).toBeGreaterThan(0);
    // The fold horizon still waits for the old replica.
    const hOld = '0000000000001-0000-a';
    expect(
      liveReplicaHorizon({ [old]: hOld, [successor]: 'z' }, retiredReplicas(b.db, STREAM)),
    ).toBe(hOld);

    // A server record naming another successor confirms nothing; the right one does.
    expect(
      confirmRetirements(b.db, STREAM, [
        {
          replicaId: old,
          successor: '0192ffff-0000-7000-8000-0000000000ee',
          retiredAt: RETIRED_AT,
        },
        { replicaId: old, successor: null, retiredAt: RETIRED_AT },
      ]),
    ).toBe(0);
    expect(retiredReplicas(b.db, STREAM).has(old)).toBe(false);
    expect(
      confirmRetirements(b.db, STREAM, [{ replicaId: old, successor, retiredAt: RETIRED_AT }]),
    ).toBe(1);
    expect(retiredReplicas(b.db, STREAM).get(old)?.confirmedAt).toBe(RETIRED_AT);
    expect(
      liveReplicaHorizon({ [old]: hOld, [successor]: 'z' }, retiredReplicas(b.db, STREAM)),
    ).toBe('z');
  });

  it('only a pull that reaches the head rebinds: the key survives a refused pull and one that stops short', async () => {
    const { a, stream, old } = await offlineOverBudget();
    // sync.pull off: refused, nothing pulled, no rebind.
    const off = await pullStream(a.db, pullOpts(a, stream, { env: { CLEO_SYNC_PULL: '0' } }));
    expect(off.refusedKind).toBe('pull-off');
    expect(off.rebind).toBeNull();
    expect(undoBudgetRebindDue(a.db)).toBe(true);
    // A page that ends short of the server's head.
    const short = await pullStream(
      a.db,
      pullOpts(a, stream, {
        pull: async (cursor) => ({ segments: [], cursor, head: cursor.after + 5 }),
      }),
    );
    expect(short.rebind).toBeNull();
    expect(undoBudgetRebindDue(a.db)).toBe(true);
    expect(replicaOf(a)).toBe(old);
    // Undo below the budget does not clear it either: only the rebind does.
    expect(recordUndoBudget(a.db, new Date(++clock).toISOString()).exceededAt).not.toBeNull();
    expect(undoBudget(a.db).state).toBe('exceeded');
    expect(
      a.db.prepare('SELECT 1 AS x FROM _sync_meta WHERE key = ?').get(UNDO_BUDGET_EXCEEDED_KEY),
    ).toBeDefined();
    // Without the store's open options a pull at head leaves it for the cloud to run.
    const plain = await pullStream(a.db, pullOpts(a, stream, { rebind: undefined }));
    expect(plain.rebind).toBeNull();
    expect(undoBudgetRebindDue(a.db)).toBe(true);
    // The next pull to head with them rebinds.
    const done = await pullStream(a.db, pullOpts(a, stream));
    expect(done.rebind?.previousReplicaId).toBe(old);
    expect(undoBudgetRebindDue(a.db)).toBe(false);
    expect(readStreamCursor(a.db, STREAM)?.after).toBe(stream.segments.length);
    expect(
      a.db.prepare('SELECT 1 AS x FROM _sync_meta WHERE key = ?').get(REBIND_PENDING_KEY),
    ).toBeDefined();
  });

  it('a replica that never landed a segment retires with no journal transaction', async () => {
    const a = await author();
    const stream = fakeStream();
    write(a.db, addTask('T1'));
    await expect(push(a, stream, true)).rejects.toThrow('offline');
    recordUndoBudget(a.db, new Date(++clock).toISOString(), 1);
    const r = await pullStream(a.db, pullOpts(a, stream));
    expect(r.rebind?.pending).toMatchObject({ lastReplicaSeq: null, retireTxn: null });
    expect(n(a.db, "SELECT count(*) AS n FROM _sync_txn WHERE kind = 'retire'")).toBe(0);
    // Its insert is re-emitted under the successor.
    expect(r.rebind?.reconcile).toMatchObject({ inserts: 1 });
  });
});

describe('the three-way reconcile rule (T12763, §1.5 N7)', () => {
  it('rule 1: a field an inherited change touched is emitted at tick(at_ms), whatever the HLCs', () => {
    expect(decideReconcileField({ touchedByInherited: true, localHlc: 'b', mergedHlc: 'a' })).toBe(
      'emit-tick',
    );
    expect(decideReconcileField({ touchedByInherited: true, localHlc: 'a', mergedHlc: 'b' })).toBe(
      'emit-tick',
    );
  });

  it('rule 2: an untouched field with a local HLC below the merged one (or none) adopts the merged value', () => {
    expect(decideReconcileField({ touchedByInherited: false, localHlc: 'a', mergedHlc: 'b' })).toBe(
      'adopt-merged',
    );
    expect(
      decideReconcileField({ touchedByInherited: false, localHlc: null, mergedHlc: 'b' }),
    ).toBe('adopt-merged');
  });

  it('rule 3: otherwise the local value is emitted with its HLC unchanged', () => {
    expect(decideReconcileField({ touchedByInherited: false, localHlc: 'b', mergedHlc: 'b' })).toBe(
      'emit-pinned',
    );
    expect(decideReconcileField({ touchedByInherited: false, localHlc: 'c', mergedHlc: 'b' })).toBe(
      'emit-pinned',
    );
  });
});
