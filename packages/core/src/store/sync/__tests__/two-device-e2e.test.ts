/**
 * Two-device end to end (T13371): two real replicas, A (which cut the
 * stream's genesis) and B (which joined it), edit the same task while
 * neither has seen the other's change. Both push, both pull, and both must
 * end with the same row, the same conflict records and the same content
 * checksums. A row changed behind the journal's back must then show up in
 * the checksums and in the repair diff.
 *
 * Every step runs the real code: capture triggers, sealer, segment builder,
 * txn signatures, push, pull, inbox, merge engine and applier. Only the
 * server is a fake stream that orders segments as they arrive.
 *
 * Merge rules this exercises (journal spec §3.2, merge/rules.ts):
 * - per-field LWW by HLC for title, priority and acceptance_json;
 * - the status group {status, completed_at, cancelled_at, cancellation_reason}
 *   moves as one unit from the winning op;
 * - `task.status.absorbing` (T12937): done and cancelled are both terminal,
 *   so between them it is plain LWW, never a refusal;
 * - pipeline_stage is coupled to the terminal status (T13243);
 * - a concurrent divergent edit records a conflict whichever side wins.
 *
 * @task T13371
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
import {
  captureTableDef,
  dropCaptureTriggers,
  finishCaptureFrame,
  installCaptureTriggers,
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
import { planRepair } from '../repair.js';
import { activeReplica, ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { rowChash, sealPending } from '../sealer.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-0000000013a1';
const KEYS = { 'dev-a': generateEd25519(), 'dev-b': generateEd25519() } as const;
type Device = keyof typeof KEYS;
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-two-device-'));
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
    scope: 'project',
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

const TASK_COLUMNS =
  'title, status, priority, acceptance_json, pipeline_stage, completed_at, cancelled_at, cancellation_reason';

function task(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

/**
 * Per-table content checksum over the sync set: sha256 of every live row's
 * uid and wire-image hash ({@link rowChash}, the hash every replica computes
 * over identical bytes), in uid order. Tables with no rows are left out.
 */
function contentChecksums(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of syncSetTables('project')) {
    const def = captureTableDef(db, 'project', table);
    if (!def) continue;
    const uids = (
      db.prepare(`SELECT uid FROM "${table}" WHERE uid IS NOT NULL ORDER BY uid`).all() as Array<{
        uid: string;
      }>
    ).map((r) => r.uid);
    if (uids.length === 0) continue;
    const h = createHash('sha256');
    for (const uid of uids) h.update(`${uid}\0${rowChash(db, 'project', def, uid) ?? ''}\n`);
    out[table] = h.digest('hex');
  }
  return out;
}

/** Seal whatever the apply left captured, so the repair diff can run. */
function settle(r: Replica): void {
  const out = sealPending(r.db, {
    scope: 'project',
    replica: replicaOf(r),
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused).toBeNull();
}

/** The conflicts a replica recorded, as (table, uid, columns) keys, sorted. */
function conflictKeys(db: DatabaseSync): string[] {
  return listConflicts(db, { stream: STREAM })
    .map((c) => `${c.table}|${c.uid}|${[...c.columns].sort().join(',')}`)
    .sort();
}

/**
 * A pushes T1, B pulls it; then both go offline and edit T1 concurrently.
 * A completes it and retitles it; B cancels it, retitles it, raises its
 * priority and rewrites its acceptance. B's edits are sealed later, so they
 * carry the later HLCs.
 */
async function concurrentEdits() {
  const { a, b } = await twoDevices();
  const stream = fakeStream();
  write(
    a.db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, acceptance_json, uid, birth_fp)
     VALUES ('T1', 'shared task', 'task', 'pending', 'medium', '["ship it"]', 'uid-T1', 'fp-T1')`,
  );
  await push(a, stream);
  await pull(b, stream);
  await pull(a, stream); // own echo
  expect(task(b.db, 'T1')).toEqual(task(a.db, 'T1'));
  const base = task(a.db, 'T1');

  // Offline, concurrently: neither replica has seen the other's edit.
  const doneAt = new Date(++clock).toISOString();
  write(
    a.db,
    `UPDATE tasks_tasks SET status = 'done', completed_at = '${doneAt}', pipeline_stage = 'contribution',
       title = 'title from A', acceptance_json = '["ship it","A: tests green"]' WHERE id = 'T1'`,
  );
  await push(a, stream);
  const cancelAt = new Date(++clock).toISOString();
  write(
    b.db,
    `UPDATE tasks_tasks SET status = 'cancelled', cancelled_at = '${cancelAt}',
       cancellation_reason = 'superseded on B', pipeline_stage = 'cancelled',
       title = 'title from B', priority = 'high', acceptance_json = '["B: rescoped"]' WHERE id = 'T1'`,
  );
  await push(b, stream); // B pushes without having pulled A's edit

  await pull(a, stream);
  await pull(b, stream);
  return { a, b, stream, base, cancelAt };
}

describe('two devices editing one task converge (T13371)', () => {
  it('both replicas end with the same row, chosen by the merge rules', async () => {
    const { a, b, cancelAt } = await concurrentEdits();
    const atA = task(a.db, 'T1');
    const atB = task(b.db, 'T1');
    expect(atA).toEqual(atB);
    // B's edits carry the later HLCs: LWW gives B every field both touched;
    // the status group moves whole from B's op, and the stage follows it.
    expect(atA).toMatchObject({
      title: 'title from B',
      status: 'cancelled',
      cancelled_at: cancelAt,
      cancellation_reason: 'superseded on B',
      completed_at: null,
      pipeline_stage: 'cancelled',
      priority: 'high',
      acceptance_json: '["B: rescoped"]',
    });
  });

  it('both replicas record the same conflicts for the divergent fields, and none for priority', async () => {
    const { a, b } = await concurrentEdits();
    const keysA = conflictKeys(a.db);
    const keysB = conflictKeys(b.db);
    expect(keysA.length).toBeGreaterThan(0);
    expect(keysA).toEqual(keysB);
    const columns = new Set(
      [...listConflicts(a.db, { stream: STREAM }), ...listConflicts(b.db, { stream: STREAM })]
        .filter((c) => c.uid === 'uid-T1')
        .flatMap((c) => c.columns),
    );
    expect(columns.has('title')).toBe(true);
    expect(columns.has('status')).toBe(true);
    expect(columns.has('acceptance_json')).toBe(true);
    // Only B changed priority: no divergence, no conflict.
    expect(columns.has('priority')).toBe(false);
  });

  it("both replicas' per-table content checksums match after convergence", async () => {
    const { a, b, stream } = await concurrentEdits();
    // Converged replicas have nothing left to send: no echo ping-pong.
    const sent = stream.segments.length;
    await push(a, stream);
    await push(b, stream);
    expect(stream.segments.length).toBe(sent);
    const sumA = contentChecksums(a.db);
    expect(sumA.tasks_tasks).toBeDefined();
    expect(contentChecksums(b.db)).toEqual(sumA);
    // Each replica's row meta agrees with its own rows: nothing for repair.
    for (const r of [a, b]) {
      settle(r);
      const plan = planRepair(r.db, 'project', 'tasks_tasks');
      expect(plan.skipped).toBeNull();
      expect(plan.inserts.length + plan.updates.length + plan.deletes.length).toBe(0);
    }
  });

  it('a row changed behind the journal is caught by the checksums and the repair diff', async () => {
    const { a, b } = await concurrentEdits();
    settle(a);
    settle(b);
    // Corrupt B's copy with capture off, as a raw edit outside the chokepoint would.
    dropCaptureTriggers(b.db);
    b.db.prepare("UPDATE tasks_tasks SET title = 'silently corrupted' WHERE id = 'T1'").run();
    installCaptureTriggers(b.db, 'project');
    const sumA = contentChecksums(a.db);
    const sumB = contentChecksums(b.db);
    expect(sumB.tasks_tasks).not.toBe(sumA.tasks_tasks);
    const plan = planRepair(b.db, 'project', 'tasks_tasks');
    expect(plan.skipped).toBeNull();
    expect(plan.updates.map((u) => u.uid)).toContain('uid-T1');
    // A is untouched.
    const atA = planRepair(a.db, 'project', 'tasks_tasks');
    expect(atA.updates.length).toBe(0);
  });
});
