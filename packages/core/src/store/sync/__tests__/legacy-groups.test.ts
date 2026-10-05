/**
 * Pre-T13222 partial merge groups are completed, not lost (T13233).
 *
 * The old capture trigger recorded only the changed columns of the status
 * group, and a pre-fix sealer sealed them as such. The engine now refuses a
 * partial-group U, which would void whole transactions on every receiver.
 * The new build completes them, both for captures still in `_sync_capture`
 * and for sealed-but-unsent ops, from the value each missing member held at
 * the write: the next write's before-image, else the live row.
 *
 * The "old trigger" capture is produced the way it looked: a status-only
 * change whose image holds only `status`.
 *
 * @task T13233
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { applyStagedTxns } from '../apply/applier.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { stageTxns } from '../inbox.js';
import { LEGACY_GROUPS_KEY, sealPending } from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const AUTHOR = '0192cccc-7f00-7000-8000-00000000000c';
const RECEIVER = '0192dddd-7f00-7000-8000-00000000000d';
const GROUP = ['cancellation_reason', 'cancelled_at', 'completed_at', 'status'];
const DONE_AT = '2026-10-05T00:00:00.000Z';
let clock = Date.now();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-legacy-groups-'));
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
  return db;
}

function seal(db: DatabaseSync, replica = AUTHOR): void {
  const r = sealPending(db, {
    scope: 'project',
    replica,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null, 'sealing was refused').toBeNull();
}

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

/** Rewrite the newest live U capture of the row to its pre-T13222 shape: changed columns only. */
function asOldTriggerCapture(db: DatabaseSync): void {
  const c = db
    .prepare(
      "SELECT seq, img FROM _sync_capture WHERE op = 'U' AND state = 'live' ORDER BY seq DESC",
    )
    .get() as { seq: number; img: string };
  const img = JSON.parse(c.img) as Record<string, [string, string]>;
  const changed = Object.fromEntries(Object.entries(img).filter(([, [b, a]]) => b !== a));
  db.prepare('UPDATE _sync_capture SET img = ? WHERE seq = ?').run(JSON.stringify(changed), c.seq);
}

const sealedUs = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT o.body FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn WHERE o.o = 'U' ORDER BY t.local_seq, o.idx",
      )
      .all() as Array<{ body: string }>
  ).map((r) => LedgerOp.parse(JSON.parse(r.body)));

function sealedTxns(db: DatabaseSync): LedgerTxn[] {
  const txns = db
    .prepare('SELECT txn, hlc, via, kind FROM _sync_txn ORDER BY local_seq')
    .all() as Array<{ txn: string; hlc: string; via: LedgerTxn['via']; kind: LedgerTxn['kind'] }>;
  return txns.map((t) => ({
    v: 1,
    txn: t.txn,
    hlc: t.hlc,
    project: null,
    scope: 'project',
    via: t.via,
    kind: t.kind,
    actor: null,
    ops: (
      db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
        body: string;
      }>
    ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
    sig: '',
  }));
}

async function applyOnReceiver(txns: LedgerTxn[]) {
  const receiver = await store('receiver');
  stageTxns(
    receiver,
    'project:t13233',
    {
      seq: 1,
      replicaId: AUTHOR,
      replicaSeq: 1,
      deviceId: 'dev-author',
      schemaVersion: SYNC_SCHEMA_VERSION,
      txns,
    },
    new Date().toISOString(),
  );
  const report = applyStagedTxns(receiver, {
    scope: 'project',
    stream: 'project:t13233',
    replica: RECEIVER,
    seal: () => seal(receiver, RECEIVER),
  });
  return { receiver, report };
}

const addTask = (db: DatabaseSync) =>
  write(
    db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('T1', 'legacy', 'task', 'pending', 'medium', 'uid-T1', 'fp-T1')`,
  );

describe('T13233: pre-T13222 partial groups are completed', () => {
  it('an old-trigger capture still in _sync_capture seals whole, from the next write, and applies', async () => {
    const db = await store('author');
    addTask(db);
    seal(db);
    write(db, "UPDATE tasks_tasks SET status = 'blocked' WHERE uid = 'uid-T1'");
    asOldTriggerCapture(db);
    write(
      db,
      `UPDATE tasks_tasks SET status = 'done', pipeline_stage = 'contribution', completed_at = '${DONE_AT}' WHERE uid = 'uid-T1'`,
    );
    seal(db);
    const [blocked, done] = sealedUs(db);
    expect(Object.keys(blocked?.a ?? {}).sort()).toEqual(GROUP);
    // completed_at at the blocked write was NULL (the done's before-image), not the live value.
    expect(blocked?.a).toMatchObject({ status: 'blocked', completed_at: null });
    expect(done?.a).toMatchObject({ status: 'done' });

    const { receiver, report } = await applyOnReceiver(sealedTxns(db));
    expect(report).toMatchObject({ refusedSchema: 0, void: 0, pending: 0 });
    expect(receiver.prepare("SELECT status FROM tasks_tasks WHERE uid = 'uid-T1'").get()).toEqual({
      status: 'done',
    });
  });

  it('a sealed-but-unsent partial op is completed once, from the live row', async () => {
    const db = await store('author');
    addTask(db);
    seal(db);
    write(db, "UPDATE tasks_tasks SET status = 'blocked' WHERE uid = 'uid-T1'");
    seal(db);
    // Make it look sealed by a pre-fix build: status only, and the upgrade not yet run.
    const row = db.prepare("SELECT txn, idx, body FROM _sync_op WHERE o = 'U'").get() as {
      txn: string;
      idx: number;
      body: string;
    };
    const op = JSON.parse(row.body) as { a: Record<string, unknown>; b: Record<string, unknown> };
    const partial = { ...op, a: { status: op.a.status }, b: { status: op.b.status } };
    db.prepare('UPDATE _sync_op SET body = ? WHERE txn = ? AND idx = ?').run(
      JSON.stringify(partial),
      row.txn,
      row.idx,
    );
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(LEGACY_GROUPS_KEY);
    seal(db);
    const [blocked] = sealedUs(db);
    expect(Object.keys(blocked?.a ?? {}).sort()).toEqual(GROUP);
    expect(blocked?.a).toMatchObject({ status: 'blocked', completed_at: null, cancelled_at: null });
    expect(db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(LEGACY_GROUPS_KEY)).toEqual(
      { value: '1' },
    );

    const { report } = await applyOnReceiver(sealedTxns(db));
    expect(report).toMatchObject({ refusedSchema: 0, void: 0, pending: 0, applied: 2 });
  });
});
