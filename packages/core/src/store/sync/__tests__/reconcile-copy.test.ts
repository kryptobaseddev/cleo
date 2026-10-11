/**
 * The copy reconcile (journal spec §1.5 N7, T13335): a store the open pass
 * rebound reconciles against the merged state, a checkpoint restored into a
 * scratch store and pulled to head there, field by field. Real replicas:
 * capture, seal, segments, push, a fake stream and the merge engine's pull.
 *
 * The original replica A pushes rows, loses two uploads (an update and a
 * delete the server never stored), leaves one change unsealed, and is copied
 * to C. A goes on: an update, an insert and a delete reach the stream. C
 * rebinds and reconciles:
 * - rule 1: the unsealed change is re-emitted at the time of its capture;
 * - rule 2: A's later update, insert and delete are adopted, nothing emitted;
 * - rule 3: the lost update and the lost delete are emitted with A's HLCs pinned.
 *
 * @task T13335
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
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
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
  syncCaptureOpenPass,
} from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { completeGenesis, cutGenesis } from '../genesis.js';
import {
  type PulledStreamSegment,
  pullStream,
  readStreamCursor,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { reconcileCopy } from '../reconcile-copy.js';
import { activeReplica, ensureProjectReplica, reconcileDue, syncOpenPass } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { fieldHlcsOf, readRowMeta } from '../row-meta.js';
import { sealPending } from '../sealer.js';
import { signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
const DEV = 'dev-a';
const KEY = generateEd25519();
const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-reconcile-copy-'));
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

const storePath = (name: string): string => join(dir, name, '.cleo', 'cleo.db');
const reg = (): ReplicaRegistry => new ReplicaRegistry(join(dir, 'registry.json'), DEV);
const replicaOf = (db: DatabaseSync): string => activeReplica(db, 'project')?.replicaId ?? '';

async function author(): Promise<DatabaseSync> {
  mkdirSync(join(dir, 'a', '.cleo'), { recursive: true });
  const path = storePath('a');
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

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

/** The fake stream: what the server stored, in order. */
const stream: PulledStreamSegment[] = [];

async function push(db: DatabaseSync, lost = false) {
  const replica = replicaOf(db);
  return pushStream(db, {
    scope: 'project',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEY, s, txn),
    upload: async (seg) => {
      // A lost upload: the answer says stored, the server kept nothing.
      if (!lost) {
        stream.push({
          seq: stream.length + 1,
          replicaId: replica,
          replicaSeq: seg.replicaSeq,
          deviceId: DEV,
          plaintext: seg.sealed,
          schemaVersion: SYNC_SCHEMA_VERSION,
        });
      }
      return { seq: stream.length, duplicate: false };
    },
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
}

const pullPage = async (cursor: StreamCursor) => {
  const page = stream.filter((s) => s.seq > cursor.after);
  const replicas = { ...cursor.replicas };
  for (const s of page) replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
  return {
    segments: page,
    cursor: { after: page.at(-1)?.seq ?? cursor.after, knowsAllReplicas: true, replicas },
    head: stream.length,
  };
};

const title = (db: DatabaseSync, id: string): string | undefined =>
  (
    db.prepare('SELECT title FROM tasks_tasks WHERE id = ?').get(id) as
      | { title: string }
      | undefined
  )?.title;

const titleHlc = (db: DatabaseSync, id: string): string => {
  const meta = readRowMeta(db, 'tasks_tasks', `uid-${id}`);
  if (!meta) throw new Error(`no meta for ${id}`);
  return fieldHlcsOf({ columns: ['title'], identity: [] }, meta).title as string;
};

/**
 * A pushed, lost and left a change unsealed, then was copied to C, then
 * went on; returns C rebound (sync open pass off, bound as the test device)
 * and the merged scratch at head.
 */
async function scenario(opts: { lostInsert?: boolean } = {}) {
  stream.length = 0;
  const a = await author();
  // The checkpoint: A right after its genesis cut.
  const cp = join(dir, 'cp.db');
  a.exec(`VACUUM INTO '${cp}'`);
  for (const id of ['T1', 'T2', 'T5', 'T6', 'T7']) write(a, addTask(id));
  expect((await push(a)).pushed).toBe(1);
  // A pulls its own echo: it holds a pull position the copy inherits.
  const echo = await pullStream(a, {
    scope: 'project',
    stream: STREAM,
    replica: replicaOf(a),
    pull: pullPage,
    verify: () => null,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {},
  });
  expect(echo.refused).toBeNull();
  // Two uploads the server lost: an update and a delete.
  write(a, "UPDATE tasks_tasks SET title = 'lost title' WHERE id = 'T1'");
  write(a, "DELETE FROM tasks_tasks WHERE id = 'T6'");
  // A row the stream never saw: its insert is in the lost upload too.
  if (opts.lostInsert) write(a, addTask('T9'));
  expect((await push(a, true)).pushed).toBe(1);
  const lostTitleHlc = titleHlc(a, 'T1');
  const lostDeleteHlc = readRowMeta(a, 'tasks_tasks', 'uid-T6')?.hlc as string;
  // A change never sealed: inherited by the copy.
  write(a, "UPDATE tasks_tasks SET title = 'unsealed title' WHERE id = 'T7'");
  a.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  mkdirSync(join(dir, 'c', '.cleo'), { recursive: true });
  copyFileSync(storePath('a'), storePath('c'));
  // A goes on: an update, an insert and a delete reach the stream.
  write(a, "UPDATE tasks_tasks SET title = 'later title' WHERE id = 'T2'");
  write(a, addTask('T4'));
  write(a, "DELETE FROM tasks_tasks WHERE id = 'T5'");
  expect((await push(a)).pushed).toBeGreaterThan(0);

  // The merged state: the checkpoint in a scratch store, pulled to head.
  mkdirSync(join(dir, 'scratch'), { recursive: true });
  copyFileSync(cp, join(dir, 'scratch', 'cleo.db'));
  const merged = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'scratch', 'cleo.db'), undefined, {
      dedicated: true,
      syncMode: 'off',
    }),
  );
  setSyncFlag(merged, 'sync.pull', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  const pulled = await pullStream(merged, {
    scope: 'project',
    stream: STREAM,
    // No own echoes: the scratch is no replica.
    replica: randomUUID(),
    pull: pullPage,
    verify: () => null,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {},
  });
  expect(pulled.refused).toBeNull();

  // C opens with the open pass off and binds as the open pass does.
  const c = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', storePath('c'), undefined, { syncMode: 'off' }),
  );
  const old = replicaOf(c);
  expect(
    syncOpenPass(c, { dbPath: storePath('c'), scope: 'project', mode: 'test', registry: reg() }),
  ).toMatchObject({ status: 'rebound', reasons: ['file-identity'] });
  // ...and runs the capture open pass, as a canonical open does.
  syncCaptureOpenPass(c, 'project', { schemaRoot: SYNC_SCHEMA });
  return { a, c, merged, old, lostTitleHlc, lostDeleteHlc };
}

const decode = (plaintext: Uint8Array): LedgerTxn[] =>
  JSON.parse(inflateRawSync(plaintext).toString('utf8')) as LedgerTxn[];

describe('the copy reconcile (T13335, §1.5 N7)', () => {
  it('a copy rebind discards the inherited cursor and pauses push until it reconciles', async () => {
    const { a, c, old } = await scenario();
    expect(reconcileDue(c)).toMatchObject({ from: old, to: replicaOf(c) });
    expect(readStreamCursor(a, STREAM)).not.toBeNull();
    expect(readStreamCursor(c, STREAM)).toBeNull();
    const refused = await push(c);
    expect(refused.refusedKind).toBe('reconcile-pending');
    expect(stream.filter((s) => s.replicaId === replicaOf(c))).toEqual([]);
  });

  it('adopts newer merged state (rule 2), re-emits inherited changes (rule 1) and pins what the stream lost (rule 3)', async () => {
    const { c, merged, lostTitleHlc, lostDeleteHlc } = await scenario();
    const report = reconcileCopy(c, merged, {
      scope: 'project',
      stream: STREAM,
      mergedCursor: readStreamCursor(merged, STREAM) ?? START,
      now: () => ++clock,
    });
    expect(report).toMatchObject({
      adoptedFields: 1,
      adoptedInserts: 1,
      adoptedDeletes: 1,
      pinned: 2,
      unresolved: 0,
    });
    // The store now holds the merged values where the stream is newer.
    expect(title(c, 'T2')).toBe('later title');
    expect(title(c, 'T4')).toBe('title T4');
    expect(title(c, 'T5')).toBeUndefined();
    // And keeps its own where it is newer, or where only it changed.
    expect(title(c, 'T1')).toBe('lost title');
    expect(title(c, 'T6')).toBeUndefined();
    expect(title(c, 'T7')).toBe('unsealed title');
    // An adopted field takes the merged field HLC.
    expect(titleHlc(c, 'T2')).toBe(titleHlc(merged, 'T2'));
    // Push resumes from the merged position.
    expect(reconcileDue(c)).toBeNull();
    expect(readStreamCursor(c, STREAM)).toEqual(readStreamCursor(merged, STREAM));

    // What C sends: the rule-1 and rule-3 changes only, with rule 3 pinned.
    expect(
      sealPending(c, { scope: 'project', now: () => ++clock, env: {}, allowUnreleased: true })
        .refused,
    ).toBeNull();
    const before = stream.length;
    expect((await push(c)).refusedKind).toBeNull();
    const ops = stream
      .slice(before)
      .flatMap((s) => decode(s.plaintext))
      .flatMap((t) => t.ops.map((op) => ({ ...op, via: t.via })));
    const byUid = new Map(ops.map((op) => [op.u, op] as const));
    expect([...byUid.keys()].sort()).toEqual(['uid-T1', 'uid-T6', 'uid-T7']);
    expect(ops.every((op) => op.via === 'rebind')).toBe(true);
    expect(byUid.get('uid-T1')).toMatchObject({
      o: 'U',
      a: { title: 'lost title' },
      fh: { title: lostTitleHlc },
    });
    expect(byUid.get('uid-T6')).toMatchObject({ o: 'D', h: lostDeleteHlc });
    const t7 = byUid.get('uid-T7');
    expect(t7).toMatchObject({ o: 'U', a: { title: 'unsealed title' } });
    expect(t7?.fh).toBeUndefined();
    // The pinned field's meta keeps the HLC the original replica issued.
    expect(titleHlc(c, 'T1')).toBe(lostTitleHlc);
  });

  it('re-inserts a row the stream deleted but the copy changed later, above the tombstone (T13392)', async () => {
    const { a, c, merged } = await scenario();
    const tombstone = readRowMeta(merged, 'tasks_tasks', 'uid-T5')?.hlc as string;
    expect(readRowMeta(merged, 'tasks_tasks', 'uid-T5')?.deleted).toBeTruthy();
    // C edits T5 after the rebind, sealed before the reconcile runs: its
    // field HLC is newer than the stream's delete.
    write(c, "UPDATE tasks_tasks SET title = 'copy title' WHERE id = 'T5'");
    expect(
      sealPending(c, { scope: 'project', now: () => ++clock, env: {}, allowUnreleased: true })
        .refused,
    ).toBeNull();
    const copyTitleHlc = titleHlc(c, 'T5');
    expect(copyTitleHlc > tombstone).toBe(true);
    const report = reconcileCopy(c, merged, {
      scope: 'project',
      stream: STREAM,
      mergedCursor: readStreamCursor(merged, STREAM) ?? START,
      now: () => ++clock,
    });
    // T5 is the merged state's only delete: kept here, never adopted.
    expect(report).toMatchObject({ adoptedDeletes: 0, unresolved: 0 });
    // The copy keeps its newer row.
    expect(title(c, 'T5')).toBe('copy title');
    // A clock behind the tombstone (skew, or a fresh replica sealing an
    // inherited value) must still re-insert above it: the op HLC is pinned
    // at reconcile time, so the seal's own clock does not matter.
    c.prepare('UPDATE _sync_clock SET phys = 0, ctr = 0').run();
    expect(
      sealPending(c, { scope: 'project', now: () => 1, env: {}, allowUnreleased: true }).refused,
    ).toBeNull();
    const before = stream.length;
    expect((await push(c)).refusedKind).toBeNull();
    const t5 = stream
      .slice(before)
      .flatMap((s) => decode(s.plaintext))
      .flatMap((t) => t.ops.map((op) => ({ ...op, via: t.via })))
      .filter((op) => op.u === 'uid-T5' && op.via === 'rebind');
    // The whole live row as an I whose op HLC is above the tombstone, its
    // field HLCs pinned: an update would be voided everywhere.
    expect(t5).toHaveLength(1);
    expect(t5[0]).toMatchObject({
      o: 'I',
      a: { title: 'copy title' },
      fh: { title: copyTitleHlc },
    });
    expect((t5[0]?.h ?? '') > tombstone).toBe(true);
    // Every replica ends with the same row: A, which deleted it, re-creates it.
    const pulled = await pullStream(a, {
      scope: 'project',
      stream: STREAM,
      replica: replicaOf(a),
      pull: pullPage,
      verify: () => null,
      initialCursor: readStreamCursor(a, STREAM) ?? START,
      now: () => ++clock,
      env: {},
      seal: () => {},
    });
    expect(pulled.refused).toBeNull();
    expect(title(a, 'T5')).toBe('copy title');
    expect(titleHlc(a, 'T5')).toBe(titleHlc(c, 'T5'));
  });

  it('emits a row the stream never saw as an insert with its HLCs pinned (rule 3)', async () => {
    const { c, merged } = await scenario({ lostInsert: true });
    expect(title(c, 'T9')).toBe('title T9');
    expect(readRowMeta(merged, 'tasks_tasks', 'uid-T9')).toBeUndefined();
    const t9Hlc = titleHlc(c, 'T9');
    const report = reconcileCopy(c, merged, {
      scope: 'project',
      stream: STREAM,
      mergedCursor: readStreamCursor(merged, STREAM) ?? START,
      now: () => ++clock,
    });
    expect(report).toMatchObject({ pinned: 3, unresolved: 0 });
    expect(title(c, 'T9')).toBe('title T9');
    expect(
      sealPending(c, { scope: 'project', now: () => ++clock, env: {}, allowUnreleased: true })
        .refused,
    ).toBeNull();
    const before = stream.length;
    expect((await push(c)).refusedKind).toBeNull();
    const t9 = stream
      .slice(before)
      .flatMap((s) => decode(s.plaintext))
      .flatMap((t) => t.ops.map((op) => ({ ...op, via: t.via })))
      .filter((op) => op.u === 'uid-T9');
    expect(t9).toHaveLength(1);
    expect(t9[0]).toMatchObject({
      o: 'I',
      via: 'rebind',
      a: { title: 'title T9' },
      fh: { title: t9Hlc },
    });
  });

  it('does nothing when no reconcile is due', async () => {
    const { c, merged } = await scenario();
    const opts = {
      scope: 'project' as const,
      stream: STREAM,
      mergedCursor: readStreamCursor(merged, STREAM) ?? START,
    };
    expect(reconcileCopy(c, merged, opts)).not.toBeNull();
    expect(reconcileCopy(c, merged, opts)).toBeNull();
  });
});
