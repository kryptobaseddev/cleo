/**
 * The own-echo fast path and the foreign-touch index (T13193; journal spec
 * §3.5 Rules 2-3).
 *
 * Local writes are made through capture frames and sealed by the real
 * sealer; their own echo is the sealed transaction staged back as a stream
 * segment of this replica. Undo is switched on by a test-only helper (S4 owns
 * the real toggle).
 *
 * @task T13193
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
} from '../../../dual-scope-db.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../../capture.js';
import { setSyncFlag } from '../../flags.js';
import { stageTxns } from '../../inbox.js';
import { readRowMeta } from '../../row-meta.js';
import { sealPending } from '../../sealer.js';
import {
  DROP_NETTED_UNDO_SQL,
  FOREIGN_TOUCH_INCOMPLETE_KEY,
  OLDEST_UNSEQUENCED_SQL,
} from '../../sequencing.js';
import { applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const LOCAL = '0192eeee-7f00-7000-8000-00000000000e';
const R2 = '22222222-2222-4222-8222-222222222222';
const STREAM = 'project:t13193';
let clock = Date.now();
let seq = 0;
let dir: string;

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(join(tmpdir(), 'cleo-sequencing-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Test-only: switch undo on, as S4's genesis cut will (never exported from core). */
function enableUndo(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('undo_enabled', '1', '2026-10-05T00:00:00.000Z') ON CONFLICT (key) DO NOTHING",
  ).run();
}

async function store(): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'project', '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  enableUndo(db);
  return db;
}

function seal(db: DatabaseSync): void {
  const r = sealPending(db, {
    scope: 'project',
    replica: LOCAL,
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

/** This store's sealed transactions with these ids, as the stream would carry them. */
function own(db: DatabaseSync, ids: readonly string[]): LedgerTxn[] {
  return ids.map((id) => {
    const t = db.prepare('SELECT txn, hlc, via, kind FROM _sync_txn WHERE txn = ?').get(id) as {
      txn: string;
      hlc: string;
      via: LedgerTxn['via'];
      kind: LedgerTxn['kind'];
    };
    return {
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
    };
  });
}

const lastTxn = (db: DatabaseSync): string =>
  (db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq DESC LIMIT 1').get() as { txn: string })
    .txn;

function stage(db: DatabaseSync, replicaId: string, txns: LedgerTxn[]): void {
  seq += 1;
  stageTxns(
    db,
    STREAM,
    {
      seq,
      replicaId,
      replicaSeq: seq,
      deviceId: `dev-${replicaId.slice(0, 4)}`,
      schemaVersion: SYNC_SCHEMA_VERSION,
      txns,
    },
    new Date().toISOString(),
  );
}

const apply = (db: DatabaseSync) =>
  applyStagedTxns(db, {
    scope: 'project',
    stream: STREAM,
    replica: LOCAL,
    now: () => Date.now(),
    seal: () => seal(db),
  });

/** A foreign transaction editing a task's title, with an HLC newer than anything local. */
function foreignTitle(uid: string, title: string): LedgerTxn {
  const h = `${Date.now() + 1000 + seq}-000000-${R2}`;
  return {
    v: 1,
    txn: `R2:${seq + 1}`,
    hlc: h,
    project: null,
    scope: 'project',
    via: 'accessor',
    kind: 'write',
    actor: null,
    ops: [{ t: 'tasks_tasks', u: uid, o: 'U', h, a: { title } }],
    sig: '',
  };
}

const n = (db: DatabaseSync, sql: string, ...args: string[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;
const sequenced = (db: DatabaseSync, txn: string): boolean =>
  n(db, 'SELECT count(*) AS n FROM _sync_sequenced WHERE txn = ?', txn) === 1;
const undoOf = (db: DatabaseSync, txn: string): number =>
  n(
    db,
    'SELECT count(*) AS n FROM _sync_undo WHERE txn_local = (SELECT frame FROM _sync_txn WHERE txn = ?)',
    txn,
  );

const addTask = (id: string, uid: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', '${uid}', 'fp-${uid}')`;

describe('own-echo fast path (§3.5 Rule 3)', () => {
  it('an echo with no foreign touch since its commit is sequenced and its undo dropped', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    seal(db);
    const l1 = lastTxn(db);
    expect(undoOf(db, l1)).toBeGreaterThan(0);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_row_undo WHERE txn = ?', l1)).toBe(1);
    stage(db, LOCAL, own(db, [l1]));
    expect(apply(db)).toMatchObject({ applied: 1, conflict: 0, rebased: 0 });
    expect(sequenced(db, l1)).toBe(true);
    expect(undoOf(db, l1)).toBe(0);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_row_undo WHERE txn = ?', l1)).toBe(0);
  });

  it('a foreign touch of its row after its commit sends its echo through a rebase', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    seal(db);
    stage(db, LOCAL, own(db, [lastTxn(db)]));
    apply(db);
    // Local L2 edits A; then a foreign txn edits A; then L2's echo arrives.
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'a'");
    seal(db);
    const l2 = lastTxn(db);
    stage(db, R2, [foreignTitle('a', 'from R2')]);
    apply(db);
    expect(n(db, "SELECT count(*) AS n FROM _sync_foreign_touch WHERE uid = 'a'")).toBe(1);
    stage(db, LOCAL, own(db, [l2]));
    expect(apply(db), 'stream order disagrees: a rebase decides').toMatchObject({ rebased: 1 });
    expect(sequenced(db, l2)).toBe(true);
    expect(undoOf(db, l2)).toBe(0);
    expect(
      db.prepare("SELECT title, priority FROM tasks_tasks WHERE uid = 'a'").get(),
    ).toMatchObject({ title: 'from R2', priority: 'high' });
  });

  it('a foreign touch of another row, or one applied before the commit, does not block it', async () => {
    const db = await store();
    write(db, `${addTask('A', 'a')}; ${addTask('B', 'b')}`);
    seal(db);
    stage(db, LOCAL, own(db, [lastTxn(db)]));
    apply(db);
    // Foreign touch of A before the local commit.
    write(db, "UPDATE tasks_tasks SET priority = 'low' WHERE uid = 'b'");
    seal(db);
    const pending = lastTxn(db); // keeps the touch index recording
    stage(db, R2, [foreignTitle('a', 'early')]);
    apply(db);
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'a'");
    seal(db);
    const l3 = lastTxn(db);
    // Foreign touch of B after L3's commit: another row.
    stage(db, R2, [foreignTitle('b', 'later')]);
    apply(db);
    stage(db, LOCAL, own(db, [l3]));
    expect(apply(db), 'the fast path sequenced it').toMatchObject({ rebased: 0 });
    expect(sequenced(db, l3)).toBe(true);
    expect(sequenced(db, pending)).toBe(false);
  });

  it('declines while the foreign-touch index is incomplete', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    seal(db);
    db.prepare(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, '1', '2026-10-05T00:00:00.000Z')",
    ).run(FOREIGN_TOUCH_INCOMPLETE_KEY);
    const l1 = lastTxn(db);
    stage(db, LOCAL, own(db, [l1]));
    expect(apply(db), 'the fast path declined; a rebase decided').toMatchObject({ rebased: 1 });
    expect(sequenced(db, l1)).toBe(true);
  });

  it('sequencing the last unsequenced txn empties the touch index and clears its incomplete mark', async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    seal(db);
    stage(db, LOCAL, own(db, [lastTxn(db)]));
    apply(db);
    // L1 edits A; a foreign txn then edits A too (a stream that knows A).
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'a'");
    seal(db);
    stage(db, R2, [foreignTitle('a', 'x')]);
    apply(db);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_foreign_touch')).toBe(1);
    // The foreign touch came after L1's commit, so L1 waits for a rebase; L2 on
    // another row is sequenced, and the index stays (L1 is still unsequenced).
    write(db, addTask('B', 'b'));
    seal(db);
    const l2 = lastTxn(db);
    stage(db, LOCAL, own(db, [l2]));
    apply(db);
    expect(sequenced(db, l2)).toBe(true);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_foreign_touch')).toBe(1);
  });
});

describe('sequencing queries under the write lock (T13260)', () => {
  it('reach _sync_txn through its frame index, never a scan of the sealed history', async () => {
    const db = await store();
    for (const sql of [OLDEST_UNSEQUENCED_SQL, DROP_NETTED_UNDO_SQL]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');
      expect(plan, sql).toMatch(/\b_sync_txn_frame\b/);
      expect(plan, sql).not.toMatch(/SCAN t\b(?! USING)/);
    }
  });
});

describe('undo of a frame that netted to nothing', () => {
  it('is dropped at the next sequencing', async () => {
    const db = await store();
    // Insert and delete in one frame: it nets to nothing, so no txn is sealed.
    write(db, `${addTask('N', 'n')}; DELETE FROM tasks_tasks WHERE uid = 'n'`);
    seal(db);
    const orphan = () =>
      n(
        db,
        'SELECT count(*) AS n FROM _sync_undo WHERE txn_local IS NOT NULL AND txn_local NOT IN (SELECT frame FROM _sync_txn WHERE frame IS NOT NULL)',
      );
    expect(orphan()).toBeGreaterThan(0);
    write(db, addTask('A', 'a'));
    seal(db);
    const l1 = lastTxn(db);
    stage(db, LOCAL, own(db, [l1]));
    apply(db);
    expect(sequenced(db, l1)).toBe(true);
    expect(orphan()).toBe(0);
  });
});

describe('row undo: the merge state a local op moved (§3.5 Rule 2)', () => {
  it("snapshots the row's prior meta for each sealed local op while undo is on", async () => {
    const db = await store();
    write(db, addTask('A', 'a'));
    seal(db);
    const before = readRowMeta(db, 'tasks_tasks', 'a');
    write(db, "UPDATE tasks_tasks SET title = 'renamed' WHERE uid = 'a'");
    seal(db);
    const l2 = lastTxn(db);
    const snap = db
      .prepare('SELECT tbl, uid, meta_json FROM _sync_row_undo WHERE txn = ?')
      .get(l2) as { tbl: string; uid: string; meta_json: string };
    expect(snap).toMatchObject({ tbl: 'tasks_tasks', uid: 'a' });
    expect(JSON.parse(snap.meta_json)).toMatchObject({
      hlc: before?.hlc,
      version: before?.version,
    });
  });

  it('writes nothing while undo is off', async () => {
    const db = await store();
    db.prepare("DELETE FROM _sync_meta WHERE key = 'undo_enabled'").run();
    write(db, addTask('A', 'a'));
    seal(db);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_row_undo')).toBe(0);
  });
});
