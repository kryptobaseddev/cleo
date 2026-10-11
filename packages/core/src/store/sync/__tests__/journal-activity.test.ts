/**
 * Journal activity (T13369): what each device changed and when, read from
 * the journal inbox of a real replica after real pushes and pulls.
 *
 * A (which cut the stream's genesis) writes T1; B (which joined) writes T2
 * and T3 for a named project; both push and pull. A's journal must then
 * list B's transactions as B's device, its own echo as this machine, with
 * write times from the HLC, apply times, commands and per-table op counts,
 * and page, filter and summarise them correctly.
 *
 * @task T13369
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import { mergeDeviceOverview } from '../../../cloud/nexus-cloud-device-overview.js';
import {
  JournalActivitySinceError,
  nexusJournalActivity,
} from '../../../cloud/nexus-cloud-journal-activity.js';
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
import { JournalActivityCursorError, journalActivity } from '../activity.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { completeGenesis, cutGenesis, joinStream } from '../genesis.js';
import { parseHlc } from '../hlc.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { activeReplica, ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { confirmRetirements, recordRetirement } from '../retire.js';
import { sealPending } from '../sealer.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-0000000013a9';
const KEYS = { 'dev-a': generateEd25519(), 'dev-b': generateEd25519() } as const;
type Device = keyof typeof KEYS;
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-journal-activity-'));
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

/** A store with capture, seal, push and pull on, bound to its own replica. */
async function open(name: string, device: Device): Promise<Replica> {
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
  return { db, device };
}

const replicaOf = (r: Replica): string => activeReplica(r.db, 'project')?.replicaId ?? '';

/** A cuts the stream's genesis; B, an empty store, joins it at the start. */
async function twoDevices(): Promise<{ a: Replica; b: Replica }> {
  const a = await open('a', 'dev-a');
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
  const b = await open('b', 'dev-b');
  expect(
    joinStream(b.db, {
      scope: 'project',
      stream: STREAM,
      cursor: START,
      now: () => ++clock,
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  return { a, b };
}

/** One local write, in its own capture frame, as a command would make it. */
function write(db: DatabaseSync, sql: string, actor: string | null = null): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', actor);
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

async function push(r: Replica, stream: Stream, project: string | null = null) {
  const replica = replicaOf(r);
  const out = await pushStream(r.db, {
    scope: 'project',
    stream: STREAM,
    replica,
    project,
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
    scope: 'project',
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
        scope: 'project',
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

const PROJECT = 'proj-0192ffff';

async function scenario() {
  const { a, b } = await twoDevices();
  const stream = fakeStream();
  write(
    a.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('T1', 'from A', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1')`,
    '{"op":"tasks.add","agent":"agent-a"}',
  );
  await push(a, stream);
  await pull(b, stream);
  // The sealer stamps HLCs from the wall clock: let it move past A's write.
  const after = Date.now() + 5;
  while (Date.now() < after) {
    // spin
  }
  write(
    b.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('T2', 'from B', 'task', 'pending', 'medium', 'uid-T2', 'fp-T2')`,
    '{"op":"tasks.add","session":"ses-b"}',
  );
  write(
    b.db,
    "UPDATE tasks_tasks SET title = 'renamed on B' WHERE id = 'T1'",
    '{"op":"tasks.update"}',
  );
  await push(b, stream, PROJECT);
  await pull(a, stream);
  return { a, b };
}

const local = (r: Replica) => ({ localDeviceId: r.device });

/**
 * A late segment from a retired replica (§1.5, T13366): A has received B's
 * retire at stream seq 1 (confirmed by the server, or not), then B, which
 * never saw its own retirement, writes T2 and pushes it as segment 2.
 */
async function lateAfterRetire(confirmed: boolean) {
  const { a, b } = await twoDevices();
  const stream = fakeStream();
  write(
    a.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('T1', 'from A', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1')`,
  );
  await push(a, stream);
  await pull(b, stream);
  const retired = replicaOf(b);
  const successor = '0192ffff-7f00-7000-8000-00000000b0b2';
  recordRetirement(a.db, STREAM, {
    replica: retired,
    successor,
    lastReplicaSeq: 99,
    txn: `${successor}:1`,
    hlc: '0000000000001-0000-test',
    seq: 1,
  });
  if (confirmed) {
    expect(
      confirmRetirements(a.db, STREAM, [
        { replicaId: retired, successor, retiredAt: new Date(++clock).toISOString() },
      ]),
    ).toBe(1);
  }
  write(
    b.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('T2', 'late from B', 'task', 'pending', 'medium', 'uid-T2', 'fp-T2')`,
  );
  await push(b, stream);
  await pull(a, stream);
  return { a };
}

describe('journal activity lists what each device changed and when (T13369)', () => {
  it("lists other devices' transactions and this machine's echo, newest first", async () => {
    const { a } = await scenario();
    const page = journalActivity(a.db, local(a));
    expect(page.items.map((i) => [i.deviceId, i.thisDevice, i.actor?.op])).toEqual([
      ['dev-b', false, 'tasks.update'],
      ['dev-b', false, 'tasks.add'],
      ['dev-a', true, 'tasks.add'],
    ]);
    const [rename, insert, echo] = page.items;
    expect(insert?.tables).toEqual({ tasks_tasks: { I: 1, U: 0, D: 0, K: 0 } });
    expect(rename?.tables).toEqual({ tasks_tasks: { I: 0, U: 1, D: 0, K: 0 } });
    expect(insert?.ops).toBe(1);
    expect(insert?.actor).toEqual({ op: 'tasks.add', session: 'ses-b' });
    expect(echo?.actor).toEqual({ op: 'tasks.add', agent: 'agent-a' });
    expect(insert?.project).toBe(PROJECT);
    expect(echo?.project).toBeNull();
    for (const i of page.items) {
      expect(i.status).toBe('applied');
      expect(i.appliedAt).not.toBeNull();
      expect(i.at).toBe(new Date(parseHlc(i.hlc).phys).toISOString());
      expect(i.txn.startsWith(`${i.replicaId}:`)).toBe(true);
      expect(i.stream).toBe(STREAM);
    }
    expect(page.nextBefore).toBeNull();
  });

  it('summarises per device over every match, and names devices it was given', async () => {
    const { a } = await scenario();
    const page = journalActivity(a.db, {
      ...local(a),
      limit: 1,
      deviceNames: new Map([['dev-b', 'laptop B']]),
      deviceLastSeen: new Map([['dev-b', '2026-10-10T12:00:00.000Z']]),
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.deviceName).toBe('laptop B');
    expect(page.devices.map((d) => [d.deviceId, d.deviceName, d.thisDevice, d.txns])).toEqual([
      ['dev-b', 'laptop B', false, 2],
      ['dev-a', null, true, 1],
    ]);
    expect(page.devices[0]?.lastAt).toBe(page.items[0]?.at);
    expect(page.devices.map((d) => d.lastSeenAt)).toEqual(['2026-10-10T12:00:00.000Z', null]);
  });

  it('pages with nextBefore, never repeating or skipping a transaction', async () => {
    const { a } = await scenario();
    const all = journalActivity(a.db, local(a)).items.map((i) => i.txn);
    const seen: string[] = [];
    let before: string | undefined;
    for (let n = 0; n < 5; n++) {
      const page = journalActivity(a.db, {
        ...local(a),
        limit: 1,
        ...(before !== undefined ? { before } : {}),
      });
      seen.push(...page.items.map((i) => i.txn));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(all);
    expect(() => journalActivity(a.db, { ...local(a), before: 'not-a-cursor' })).toThrow(
      JournalActivityCursorError,
    );
  });

  it('filters by device, by write time and by project', async () => {
    const { a } = await scenario();
    const [, oldestB, echo] = journalActivity(a.db, local(a)).items;
    const midMs = parseHlc(oldestB?.hlc ?? '').phys;
    expect(parseHlc(echo?.hlc ?? '').phys).toBeLessThan(midMs);
    const byDevice = journalActivity(a.db, { ...local(a), deviceId: 'dev-a' });
    expect(byDevice.items.map((i) => i.deviceId)).toEqual(['dev-a']);
    expect(byDevice.devices.map((d) => d.deviceId)).toEqual(['dev-a']);
    const since = journalActivity(a.db, { ...local(a), sinceMs: midMs });
    expect(since.items.map((i) => i.actor?.op)).toEqual(['tasks.update', 'tasks.add']);
    expect(since.items.every((i) => i.deviceId === 'dev-b')).toBe(true);
    const byProject = journalActivity(a.db, { ...local(a), project: PROJECT });
    expect(byProject.items).toHaveLength(2);
    expect(journalActivity(a.db, { ...local(a), project: 'other' }).items).toEqual([]);
  });

  it("B's journal marks B's echoes as this machine and A's write as A's device", async () => {
    const { b } = await scenario();
    const page = journalActivity(b.db, local(b));
    // B pulled A's T1 before writing; its own echoes are not pulled yet.
    expect(page.items.map((i) => [i.deviceId, i.thisDevice])).toEqual([['dev-a', false]]);
  });

  it('marks a late transaction of a confirmed-retired replica as history once applied', async () => {
    const { a } = await lateAfterRetire(true);
    const page = journalActivity(a.db, local(a));
    expect(page.items.map((i) => [i.deviceId, i.status, i.history])).toEqual([
      ['dev-b', 'applied', true],
      ['dev-a', 'applied', false],
    ]);
  });

  it('marks nothing as history while the retire is unconfirmed', async () => {
    const { a } = await lateAfterRetire(false);
    const page = journalActivity(a.db, local(a));
    expect(page.items.map((i) => [i.deviceId, i.status, i.history])).toEqual([
      ['dev-b', 'applied', false],
      ['dev-a', 'applied', false],
    ]);
  });

  it('marks nothing as history without a retire', async () => {
    const { a } = await scenario();
    expect(journalActivity(a.db, local(a)).items.every((i) => i.history === false)).toBe(true);
  });

  it('refuses a --since that is not a date before opening anything', async () => {
    await expect(nexusJournalActivity({ since: 'yesterday-ish', offline: true })).rejects.toThrow(
      JournalActivitySinceError,
    );
  });
});

describe('cloud activity --devices merges presence, journal and server events per device (T13482)', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z');
  const device = (
    deviceId: string,
    name: string,
    state: 'active' | 'signed-out' | 'revoked',
    lastPresenceAt: string | null,
    current = false,
  ) => ({ deviceId, name, state, lastPresenceAt, current });

  async function sources() {
    const { a } = await scenario();
    const page = journalActivity(a.db, local(a));
    return {
      scope: 'project' as const,
      journal: { scope: 'project' as const, ...page, warnings: [] },
    };
  }

  it('gives one row per device, newest activity first, with presence, journal and server columns', async () => {
    const src = await sources();
    const r = mergeDeviceOverview({
      ...src,
      nowMs: NOW,
      warnings: [],
      devices: [
        device('dev-a', 'desk A', 'active', '2026-10-11T11:00:00.000Z', true),
        device('dev-b', 'laptop B', 'active', '2026-10-01T00:00:00.000Z'),
        device('dev-c', 'old C', 'revoked', null),
      ],
      server: [
        {
          at: '2099-01-01T00:00:00.000Z',
          action: 'snapshot.push',
          target: 'project:x',
          deviceId: 'dev-c',
          deviceName: null,
          thisDevice: false,
        },
        {
          at: '2026-10-09T00:00:00.000Z',
          action: 'lease.take',
          target: null,
          deviceId: 'dev-b',
          deviceName: null,
          thisDevice: false,
        },
      ],
    });
    expect(r.warnings).toEqual([]);
    const order = r.devices.map((d) => d.lastActivityAt ?? '');
    expect(order).toEqual([...order].sort().reverse());
    expect(r.devices[0]?.deviceId).toBe('dev-c');
    const byId = new Map(r.devices.map((d) => [d.deviceId, d]));
    const b = byId.get('dev-b');
    expect(b?.deviceName).toBe('laptop B');
    expect(b?.online).toBe(false);
    expect(b?.journal?.txns).toBe(2);
    expect(b?.journal?.last).toEqual({
      op: 'tasks.update',
      status: 'applied',
      tables: ['tasks_tasks'],
    });
    expect(b?.server).toEqual({
      at: '2026-10-09T00:00:00.000Z',
      action: 'lease.take',
      target: null,
    });
    const a = byId.get('dev-a');
    expect([a?.thisDevice, a?.online, a?.journal?.txns, a?.server]).toEqual([true, true, 1, null]);
    const c = byId.get('dev-c');
    expect([c?.state, c?.online, c?.journal, c?.server?.action]).toEqual([
      'revoked',
      null,
      null,
      'snapshot.push',
    ]);
  });

  it('offline shows the local journal only, with a warning', async () => {
    const src = await sources();
    const r = mergeDeviceOverview({
      ...src,
      nowMs: NOW,
      warnings: [],
      devices: null,
      server: null,
    });
    expect(r.devices.map((d) => [d.deviceId, d.online, d.server, d.journal?.txns])).toEqual([
      ['dev-b', null, null, 2],
      ['dev-a', null, null, 1],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['W_DEVICE_OVERVIEW_LOCAL_ONLY']);
  });
});
