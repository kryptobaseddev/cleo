/**
 * The scoped rebase frame (T13193; journal spec §3.5 Rules 2-6).
 *
 * Every replica is a real store: local writes go through capture frames and
 * are sealed by the real sealer, sealed transactions are published to one
 * shared stream, and each replica stages and applies that stream in order
 * (its own transactions arrive as echoes). Undo is switched on by a
 * test-only helper (S4 owns the real toggle).
 *
 * @task T13193
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoreSyncStream } from '../../../../cloud/nexus-cloud-status.js';
import { runSyncRepair } from '../../../../doctor/sync-repair.js';
import { showTask } from '../../../../tasks/show.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../../capture.js';
import { setSyncFlag } from '../../flags.js';
import { HELD_WARN_DAYS, listHeldOps, SyncHeldError } from '../../held.js';
import { stageTxns } from '../../inbox.js';
import { planRepair } from '../../repair.js';
import { sealPending } from '../../sealer.js';
import { buildSegment } from '../../segments.js';
import {
  FOREIGN_TOUCH_COUNT_KEY,
  FOREIGN_TOUCH_INCOMPLETE_KEY,
  FOREIGN_TOUCH_MAX,
  undoBudget,
} from '../../sequencing.js';
import { type ApplyReport, type ApplyStagedOptions, applyStagedTxns } from '../applier.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const STREAM = 'project:t13193-rebase';
const RA = '0192aaaa-7f00-7000-8000-00000000000a';
const RB = '0192bbbb-7f00-7000-8000-00000000000b';
const RC = '0192cccc-7f00-7000-8000-00000000000c';
let clock = Date.now();
let dir: string;
/** The shared stream: every published segment, in stream order. */
let published: Array<{ replicaId: string; txns: LedgerTxn[] }>;

interface Replica {
  readonly db: DatabaseSync;
  readonly id: string;
  /** How many stream segments this replica has staged. */
  cursor: number;
}

beforeEach(() => {
  published = [];
  dir = mkdtempSync(join(tmpdir(), 'cleo-rebase-'));
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

/** Test-only: switch undo on, as S4's genesis cut will (never exported from core). */
function enableUndo(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('undo_enabled', '1', '2026-10-05T00:00:00.000Z') ON CONFLICT (key) DO NOTHING",
  ).run();
}

async function replica(id: string): Promise<Replica> {
  const name = id.slice(4, 8);
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, name, '.cleo', 'cleo.db')),
  );
  db.exec('PRAGMA foreign_keys = ON');
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  enableUndo(db);
  return { db, id, cursor: 0 };
}

function seal(r: Replica): void {
  const out = sealPending(r.db, {
    scope: 'project',
    replica: r.id,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(out.refused ?? null, 'sealing was refused').toBeNull();
}

/** One local write, through a capture frame, sealed; returns its txn id. */
function write(r: Replica, sql: string, actor: string | null = null): string {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', actor);
  r.db.exec(sql);
  finishCaptureFrame(r.db, frame);
  r.db.exec('COMMIT');
  seal(r);
  return (
    r.db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq DESC LIMIT 1').get() as {
      txn: string;
    }
  ).txn;
}

/** Publish these sealed transactions of a replica as one stream segment. */
function publish(r: Replica, ...ids: string[]): void {
  const txns = ids.map((id): LedgerTxn => {
    const t = r.db
      .prepare('SELECT txn, hlc, via, kind, actor FROM _sync_txn WHERE txn = ?')
      .get(id) as {
      txn: string;
      hlc: string;
      via: LedgerTxn['via'];
      kind: LedgerTxn['kind'];
      actor: string | null;
    };
    return {
      v: 1,
      txn: t.txn,
      hlc: t.hlc,
      project: null,
      scope: 'project',
      via: t.via,
      kind: t.kind,
      actor: t.actor?.startsWith('{') ? LedgerActor.parse(JSON.parse(t.actor)) : null,
      ops: (
        r.db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
          body: string;
        }>
      ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
      sig: '',
    };
  });
  published.push({ replicaId: r.id, txns });
}

/** Stage every segment this replica has not seen (up to `upTo`), then apply. */
function sync(
  r: Replica,
  upTo = published.length,
  extra: Partial<Pick<ApplyStagedOptions, 'pageOps' | 'pageMs' | 'now' | 'undoBudgetBytes'>> = {},
): ApplyReport {
  for (; r.cursor < upTo; r.cursor++) {
    const s = published[r.cursor] as { replicaId: string; txns: LedgerTxn[] };
    stageTxns(
      r.db,
      STREAM,
      {
        seq: r.cursor + 1,
        replicaId: s.replicaId,
        replicaSeq: r.cursor + 1,
        deviceId: `dev-${s.replicaId.slice(4, 8)}`,
        schemaVersion: SYNC_SCHEMA_VERSION,
        txns: s.txns,
      },
      new Date().toISOString(),
    );
  }
  const report = applyStagedTxns(r.db, {
    scope: 'project',
    stream: STREAM,
    replica: r.id,
    now: () => Date.now(),
    seal: () => seal(r),
    ...extra,
  });
  expect(n(r.db, 'SELECT count(*) AS n FROM cleo_trigger_suspend'), 'triggers left suspended').toBe(
    0,
  );
  return report;
}

const n = (db: DatabaseSync, sql: string, ...args: string[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** What every replica must agree on: task rows and their merge clocks. */
const snapshot = (r: Replica) => ({
  rows: r.db
    .prepare(
      'SELECT uid, title, priority, status, description, parent_id FROM tasks_tasks ORDER BY uid',
    )
    .all(),
  meta: r.db
    .prepare(
      "SELECT uid, hlc, fhlc, deleted FROM _sync_row_meta WHERE tbl = 'tasks_tasks' ORDER BY uid",
    )
    .all(),
});

const row = (r: Replica, uid: string) =>
  r.db
    .prepare('SELECT title, priority, status, description FROM tasks_tasks WHERE uid = ?')
    .get(uid);

const outcome = (r: Replica, txn: string): string | undefined =>
  (
    r.db.prepare('SELECT outcome FROM _sync_sequenced WHERE txn = ?').get(txn) as
      | { outcome: string }
      | undefined
  )?.outcome;

const undoOf = (r: Replica, txn: string): number =>
  n(
    r.db,
    'SELECT count(*) AS n FROM _sync_undo WHERE txn_local = (SELECT frame FROM _sync_txn WHERE txn = ?)',
    txn,
  );

const addTask = (id: string, uid: string, extra = '') =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp${extra ? ', parent_id' : ''}) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', '${uid}', 'fp-${uid}'${extra ? `, '${extra}'` : ''})`;

/** Three replicas sharing task X (and Y), every one in sync. */
async function threeReplicas(): Promise<[Replica, Replica, Replica]> {
  const a = await replica(RA);
  const b = await replica(RB);
  const c = await replica(RC);
  publish(a, write(a, `${addTask('X', 'x')}; ${addTask('Y', 'y')}`));
  for (const r of [a, b, c]) sync(r);
  return [a, b, c];
}

const converged = (rs: readonly Replica[]) => {
  const [first, ...rest] = rs as [Replica, ...Replica[]];
  for (const r of rest) {
    expect(snapshot(r), `replica ${r.id} diverged`).toEqual(snapshot(first));
  }
};

describe('scoped rebase (§3.5 Rules 2-4)', () => {
  it('a foreign edit meeting an unsequenced local edit of the same row converges', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    const fb = write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'x'");
    publish(b, fb);
    publish(a, la);
    const ra = sync(a);
    expect(ra, 'the foreign txn and the echo were both rebased').toMatchObject({ rebased: 2 });
    sync(b);
    sync(c);
    expect(row(a, 'x')).toMatchObject({ title: 'from B', priority: 'high' });
    converged([a, b, c]);
    expect(outcome(a, la)).toBe('applied');
    expect(undoOf(a, la)).toBe(0);
  });

  it('the replay respects LWW: a newer stream write of the same column wins (R6-7)', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET title = 'from A' WHERE uid = 'x'");
    const fb = write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'x'");
    publish(b, fb);
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(row(a, 'x')).toMatchObject({ title: 'from B' });
    converged([a, b, c]);
  });

  it('an older stream write of the same column loses to the replayed local one', async () => {
    const [a, b, c] = await threeReplicas();
    const fb = write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'x'");
    const la = write(a, "UPDATE tasks_tasks SET title = 'from A' WHERE uid = 'x'");
    publish(b, fb);
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(row(a, 'x'), 'the replay put the newer local title back').toMatchObject({
      title: 'from A',
    });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    converged([a, b, c]);
  });

  it('the rewind follows the footprint to a fixed point: a txn touching another row rides along', async () => {
    const [a, b, c] = await threeReplicas();
    // One local txn edits X and Y; the foreign txn touches Y only.
    const la = write(
      a,
      "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'; UPDATE tasks_tasks SET priority = 'low' WHERE uid = 'y'",
    );
    const lz = write(a, "UPDATE tasks_tasks SET description = 'later' WHERE uid = 'x'");
    const fb = write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'y'");
    publish(b, fb);
    publish(a, la, lz);
    for (const r of [a, b, c]) sync(r);
    expect(row(a, 'x')).toMatchObject({ priority: 'high', description: 'later' });
    expect(row(a, 'y')).toMatchObject({ priority: 'low', title: 'from B' });
    converged([a, b, c]);
  });

  it("a rewound insert keeps its row's local-only columns through the replay (R7-2)", async () => {
    const [a, b, c] = await threeReplicas();
    // A claim is local-only: capture never records it, so the stream cannot restore it.
    const col = 'claimed_by_agent';
    expect(captureTableDef(a.db, 'project', 'tasks_tasks')?.columns).not.toContain(col);
    const la = write(
      a,
      `${addTask('Z', 'z')}; UPDATE tasks_tasks SET ${col} = 'kept' WHERE uid = 'z'; UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'y'`,
    );
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'y'"));
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(
      a.db.prepare(`SELECT ${col} AS v FROM tasks_tasks WHERE uid = 'z'`).get(),
      'the rewind dropped a local-only column',
    ).toEqual({ v: 'kept' });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    converged([a, b, c]);
  });
});

describe('own-echo fast path with later local txns (§3.5 Rule 3)', () => {
  it('an echo under a later local txn on its footprint is rebased, never applied over it', async () => {
    const a = await replica(RA);
    publish(a, write(a, addTask('X', 'x')));
    sync(a);
    const l1 = write(a, "UPDATE tasks_tasks SET status = 'active' WHERE uid = 'x'");
    const l2 = write(
      a,
      "UPDATE tasks_tasks SET status = 'done', pipeline_stage = 'contribution' WHERE uid = 'x'",
    );
    publish(a, l1);
    // Applied in place, L1's 'active' would land on L2's 'done' and be refused.
    expect(sync(a)).toMatchObject({ rebased: 1, void: 0 });
    expect(outcome(a, l1)).toBe('applied');
    expect(row(a, 'x')).toMatchObject({ status: 'done' });
    publish(a, l2);
    expect(sync(a)).toMatchObject({ void: 0 });
    expect(outcome(a, l2)).toBe('applied');
  });
});

describe('rows outside the sync set survive a rewound insert (R7-2, T13267)', () => {
  it("a rewound task's and session's cascade children come back with the replay and the echo", async () => {
    const [a, b, c] = await threeReplicas();
    expect(captureTableDef(a.db, 'project', 'tasks_task_work_history')).toBeUndefined();
    expect(captureTableDef(a.db, 'project', 'tasks_session_handoff_entries')).toBeUndefined();
    // No sync-set table has a SET NULL child outside the sync set today: a
    // local table stands in for one (a column the delete would clear).
    a.db.exec(
      'CREATE TABLE local_pin (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks_tasks(id) ON DELETE SET NULL)',
    );
    const la = write(
      a,
      `INSERT INTO tasks_sessions (id, name, uid, birth_fp) VALUES ('S1', 'local session', 's1', 'fp-s1');
       ${addTask('Z', 'z')};
       INSERT INTO tasks_task_work_history (session_id, task_id) VALUES ('S1', 'Z');
       INSERT INTO tasks_session_handoff_entries (session_id, handoff_json) VALUES ('S1', '{}');
       INSERT INTO tasks_external_task_links (id, task_id, provider_id, external_id, link_type) VALUES ('L1', 'Z', 'gh', '42', 'manual');
       UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'y'`,
    );
    a.db.exec("INSERT INTO local_pin (id, task_id) VALUES (1, 'Z')");
    const children = () => ({
      pin: n(a.db, "SELECT count(*) AS n FROM local_pin WHERE task_id = 'Z'"),
      history: n(a.db, "SELECT count(*) AS n FROM tasks_task_work_history WHERE task_id = 'Z'"),
      handoff: n(
        a.db,
        "SELECT count(*) AS n FROM tasks_session_handoff_entries WHERE session_id = 'S1'",
      ),
      links: n(a.db, "SELECT count(*) AS n FROM tasks_external_task_links WHERE task_id = 'Z'"),
    });
    const all = { pin: 1, history: 1, handoff: 1, links: 1 };
    expect(children()).toEqual(all);
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'y'"));
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(children(), 'the replay lost cascade children').toEqual(all);
    publish(a, la);
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(children(), 'the echo lost cascade children').toEqual(all);
    sync(b);
    sync(c);
    converged([a, b, c]);
  });
});

describe('Gate C over the replay (T13268)', () => {
  it('a replayed type change that strands a stream child stays rewound, as receivers void it', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    const la = write(a, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'");
    publish(b, write(b, addTask('K', 'k', 'X')));
    sync(a);
    expect(
      a.db.prepare("SELECT type FROM tasks_tasks WHERE uid = 'x'").get(),
      'the replay made a task contain a task',
    ).toEqual({ type: 'epic' });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    expect(undoOf(a, la)).toBeGreaterThan(0);
    converged([a, b, c]);
  });
});

describe('Gate C over the replay: the rolled-back replay re-snapshots (T13268, D2)', () => {
  it('a later rewind restores what the stream wrote, not the sealed before-image', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    // B (older HLC) makes X a saga with an epic child; A (newer) makes X a task.
    const fb = write(
      b,
      `UPDATE tasks_tasks SET type = 'saga' WHERE uid = 'x'; ${addTask('K', 'k', 'X').replace("'task'", "'epic'")}`,
    );
    const la = write(a, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'");
    publish(b, fb);
    sync(a);
    expect(a.db.prepare("SELECT type FROM tasks_tasks WHERE uid = 'x'").get()).toEqual({
      type: 'saga',
    });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    expect(a.db.prepare("SELECT type FROM tasks_tasks WHERE uid = 'x'").get()).toEqual({
      type: 'saga',
    });
    converged([a, b, c]);
  });
});

describe('a voided local txn stays rewound (§3.5 Rule 6)', () => {
  it('a foreign completion before a local non-leave edit voids the echo, keeping its undo', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET status = 'active' WHERE uid = 'x'");
    const fb = write(
      b,
      "UPDATE tasks_tasks SET status = 'done', pipeline_stage = 'contribution' WHERE uid = 'x'",
    );
    publish(b, fb);
    expect(sync(a)).toMatchObject({ rebased: 1, conflicts: 0 });
    expect(
      n(a.db, 'SELECT count(*) AS n FROM _sync_conflict'),
      'the replay recorded a conflict its echo will record',
    ).toBe(0);
    expect(row(a, 'x'), 'the replay of the refused edit stays rewound').toMatchObject({
      status: 'done',
    });
    publish(a, la);
    expect(sync(a)).toMatchObject({ void: 1 });
    expect(outcome(a, la)).toBe('void');
    expect(undoOf(a, la)).toBeGreaterThan(0);
    sync(b);
    sync(c);
    converged([a, b, c]);
  });

  it('a later page restores what the voided replay sat on, never the sealed before-image (D2)', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET status = 'active' WHERE uid = 'x'");
    publish(
      b,
      write(
        b,
        "UPDATE tasks_tasks SET status = 'done', pipeline_stage = 'contribution' WHERE uid = 'x'",
      ),
    );
    sync(a);
    // A second foreign page touching X: its rewind must restore 'done', not
    // the op's before-image 'pending' (the replay would then apply 'active').
    publish(c, write(c, "UPDATE tasks_tasks SET title = 'from C' WHERE uid = 'x'"));
    sync(a);
    expect(row(a, 'x')).toMatchObject({ status: 'done', title: 'from C' });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    converged([a, b, c]);
  });

  it('a row a replay found already deleted is not re-inserted by the next rewind', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "DELETE FROM tasks_tasks WHERE uid = 'y'");
    publish(b, write(b, "DELETE FROM tasks_tasks WHERE uid = 'y'"));
    sync(a);
    publish(c, write(c, "UPDATE tasks_tasks SET title = 'late' WHERE uid = 'y'"));
    sync(a);
    expect(row(a, 'y'), 'a later rewind resurrected the row').toBeUndefined();
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(row(a, 'y')).toBeUndefined();
    converged([a, b, c]);
  });
});

describe('a parent delete racing a child insert, three replicas (R5-1)', () => {
  for (const order of ['delete first', 'insert first'] as const) {
    it(`converges with FK on (${order})`, async () => {
      const [a, b, c] = await threeReplicas();
      expect(n(a.db, 'SELECT foreign_keys AS n FROM pragma_foreign_keys')).toBe(1);
      publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
      for (const r of [a, b, c]) sync(r);
      const dp = write(a, "DELETE FROM tasks_tasks WHERE uid = 'x'");
      const ik = write(c, addTask('K', 'k', 'X'));
      if (order === 'delete first') {
        publish(a, dp);
        publish(c, ik);
      } else {
        publish(c, ik);
        publish(a, dp);
      }
      for (const r of [a, c, b]) sync(r);
      converged([a, b, c]);
      expect(row(b, 'x')).toBeUndefined();
      if (order === 'delete first') {
        expect(row(c, 'k'), 'the dangling child stays rewound on its origin').toBeUndefined();
        expect(outcome(c, ik)).toBe('void');
        expect(
          n(c.db, "SELECT count(*) AS n FROM _sync_conflict WHERE kind = 'dangling-ref'"),
          'the replay recorded the conflict its echo records',
        ).toBe(1);
      } else {
        expect(c.db.prepare("SELECT parent_id FROM tasks_tasks WHERE uid = 'k'").get()).toEqual({
          parent_id: null,
        });
      }
    });
  }
});

describe('held rows (§3.5 Rule 5)', () => {
  const ledgerBalanced = (r: Replica) => {
    // The sealer accounts an apply's own writes when it next seals.
    seal(r);
    const l = r.db
      .prepare("SELECT live, held FROM _sync_ledger WHERE tbl = 'tasks_tasks'")
      .get() as { live: number; held: number };
    expect({ live: Number(l.live) }, 'ledger live differs from count(*) + held').toEqual({
      live: n(r.db, 'SELECT count(*) AS n FROM tasks_tasks') + Number(l.held),
    });
    return Number(l.held);
  };
  const heldMeta = (r: Replica, uid: string) =>
    (
      r.db
        .prepare("SELECT held FROM _sync_row_meta WHERE tbl = 'tasks_tasks' AND uid = ?")
        .get(uid) as { held: number } | undefined
    )?.held;

  it('an insert under a parent the stream deleted is held: visible, accounted, never repaired', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    const lk = write(a, addTask('T900', 'k', 'X'));
    publish(b, write(b, "DELETE FROM tasks_tasks WHERE uid = 'x'"));
    expect(sync(a), 'the pull lists the transaction it held').toMatchObject({
      rebased: 1,
      held: [lk],
    });
    expect(row(a, 'k'), 'the held insert stays rewound').toBeUndefined();
    expect(heldMeta(a, 'k')).toBe(1);
    expect(ledgerBalanced(a)).toBe(1);
    const plan = planRepair(a.db, 'project', 'tasks_tasks');
    expect(plan.deletes, 'a repair D for the held insert').toEqual([]);
    expect(plan.held).toBe(1);
    expect(listHeldOps(a.db)).toEqual([
      expect.objectContaining({ txn: lk, tbl: 'tasks_tasks', uid: 'k', effect: 1 }),
    ]);
    const err = await showTask('T900', join(dir, 'aaaa')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SyncHeldError);
    expect((err as SyncHeldError).toLAFSError().code).toBe('E_SYNC_HELD');
    expect((err as SyncHeldError).held).toMatchObject({
      uid: 'k',
      values: expect.objectContaining({ id: 'T900', parent_id: 'x' }),
    });
    expect((err as SyncHeldError).held.reason).toMatch(
      /dangling-ref on tasks_tasks\/k \[parent_id\]/,
    );
    // cloud status counts it; the doctor lists it once it is older than the warn age.
    const status = await readStoreSyncStream(a.db, 'project', null, 'cleo.db');
    expect(status.held).toMatchObject({ count: 1, long: [], warnDays: HELD_WARN_DAYS });
    const fresh = await runSyncRepair(join(dir, 'aaaa'));
    expect(fresh.holds).toMatchObject({ total: 1, long: [] });
    const later = await runSyncRepair(join(dir, 'aaaa'), {
      nowMs: Date.now() + (HELD_WARN_DAYS + 1) * 86_400_000,
    });
    expect(later.holds.long).toEqual([
      expect.objectContaining({ txn: lk, table: 'tasks_tasks', uid: 'k' }),
    ]);
    expect(later.holds.long[0]?.reason).toMatch(/dangling-ref/);
    publish(a, lk);
    expect(sync(a), 'a decided echo is no longer held').toMatchObject({ held: [] });
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, lk)).toBe('void');
    expect(heldMeta(a, 'k'), 'the hold outlived its decided echo').toBeUndefined();
    expect((await readStoreSyncStream(a.db, 'project', null, 'cleo.db')).held.count).toBe(0);
    expect(ledgerBalanced(a)).toBe(0);
    expect(listHeldOps(a.db)).toEqual([]);
    await expect(showTask('T900', join(dir, 'aaaa'))).rejects.not.toBeInstanceOf(SyncHeldError);
    converged([a, b, c]);
  });

  it('a held insert applied later gets back what its rewind kept, across frames (T13269)', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    const lk = write(
      a,
      `${addTask('T901', 'k', 'X')}; INSERT INTO tasks_external_task_links (id, task_id, provider_id, external_id, link_type) VALUES ('L1', 'T901', 'gh', '42', 'manual')`,
    );
    const links = () =>
      n(a.db, "SELECT count(*) AS n FROM tasks_external_task_links WHERE task_id = 'T901'");
    expect(links()).toBe(1);
    // B makes X a task (K cannot sit under it); C, later, makes it an epic again.
    publish(b, write(b, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'"));
    sync(c);
    publish(c, write(c, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    sync(a, published.length - 1);
    expect(row(a, 'k'), 'the refused insert stays rewound').toBeUndefined();
    expect(listHeldOps(a.db)).toEqual([expect.objectContaining({ uid: 'k', effect: 1 })]);
    expect(links(), 'the rewind removed the link with its task').toBe(0);
    // A later frame: the in-memory snapshot is gone; the held row's own comes back.
    sync(a);
    expect(row(a, 'k')).toBeDefined();
    expect(listHeldOps(a.db)).toEqual([]);
    expect(links(), 'the applied insert lost what its rewind kept').toBe(1);
    expect(ledgerBalanced(a)).toBe(0);
    publish(a, lk);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, lk)).toBe('applied');
    expect(links()).toBe(1);
    converged([a, b, c]);
  });

  it('what a held insert kept round-trips exactly: ±Infinity and 64-bit integers (T13272)', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    // A local table outside the sync set, cascading from tasks.
    a.db.exec(
      'CREATE TABLE local_measure (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks_tasks(id) ON DELETE CASCADE, r REAL, big INTEGER)',
    );
    write(a, addTask('T903', 'k', 'X'));
    a.db.exec(
      "INSERT INTO local_measure (id, task_id, r, big) VALUES (1, 'T903', 9e999, 9007199254740993), (2, 'T903', -9e999, -1)",
    );
    const measures = () => {
      const st = a.db.prepare('SELECT id, r, big FROM local_measure ORDER BY id');
      st.setReadBigInts(true);
      return (st.all() as Array<{ id: bigint; r: number; big: bigint }>).map((m) => ({
        id: Number(m.id),
        r: String(m.r),
        big: String(m.big),
      }));
    };
    const all = [
      { id: 1, r: 'Infinity', big: '9007199254740993' },
      { id: 2, r: '-Infinity', big: '-1' },
    ];
    expect(measures()).toEqual(all);
    publish(b, write(b, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'"));
    sync(c);
    publish(c, write(c, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    sync(a, published.length - 1);
    expect(measures(), 'held: its children went with the rewind').toEqual([]);
    sync(a);
    expect(measures(), 'the kept snapshot lost precision').toEqual(all);
  });

  it('one pull that holds a txn on one page and applies it on a later page does not report it held', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    write(a, addTask('T904', 'k', 'X'));
    publish(b, write(b, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'"));
    sync(c);
    publish(c, write(c, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    // One transaction per page: B's page holds the insert, C's page applies it.
    expect(sync(a, published.length, { pageOps: 1 })).toMatchObject({ held: [] });
    expect(row(a, 'k')).toBeDefined();
  });

  it("a held txn's echo is decided in a rebase even when the touch index lost its foreign touch", async () => {
    const [a, b] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    sync(a);
    sync(b);
    const lk = write(a, addTask('T902', 'k', 'X'));
    publish(b, write(b, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'"));
    sync(a);
    expect(listHeldOps(a.db)).toEqual([expect.objectContaining({ uid: 'k' })]);
    a.db.exec('DELETE FROM _sync_foreign_touch');
    publish(a, lk);
    expect(sync(a)).toMatchObject({ rebased: 1, void: 1 });
    expect(outcome(a, lk)).toBe('void');
    expect(listHeldOps(a.db)).toEqual([]);
    expect(ledgerBalanced(a)).toBe(0);
  });

  it('a rebased own insert leaves the ledger balanced (the rewind and the echo net to one row)', async () => {
    const [a, b] = await threeReplicas();
    const la = write(
      a,
      `${addTask('Z', 'z')}; UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'y'`,
    );
    expect(ledgerBalanced(a), 'before any sync').toBe(0);
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'y'"));
    sync(a);
    expect(ledgerBalanced(a)).toBe(0);
    publish(a, la);
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(ledgerBalanced(a)).toBe(0);
  });
});

describe('footprints widened by what guards read (R7-6)', () => {
  const untyped = (id: string, uid: string) =>
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', NULL, 'pending', 'medium', '${uid}', 'fp-${uid}')`;

  it('a parent cycle closed through rows neither txn names converges (parent chain)', async () => {
    const [a, b, c] = await threeReplicas();
    publish(
      a,
      write(
        a,
        `${untyped('TA', 'ta')}; ${untyped('TB', 'tb')}; ${untyped('TC', 'tc')}; ${untyped('TD', 'td')};
         UPDATE tasks_tasks SET parent_id = 'TC' WHERE id = 'TB';
         UPDATE tasks_tasks SET parent_id = 'TA' WHERE id = 'TD'`,
      ),
    );
    for (const r of [a, b, c]) sync(r);
    // A: TA under TB. B: TC under TD. Together: TA > TB > TC > TD > TA.
    const la = write(a, "UPDATE tasks_tasks SET parent_id = 'TB' WHERE id = 'TA'");
    publish(b, write(b, "UPDATE tasks_tasks SET parent_id = 'TD' WHERE id = 'TC'"));
    expect(sync(a), 'the foreign edge met the local one only through the chain').toMatchObject({
      rebased: 1,
    });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    converged([a, b, c]);
  });

  it('two inserts colliding on a UNIQUE key (idempotency_key) converge', async () => {
    const [a, b, c] = await threeReplicas();
    const keyed = (id: string, uid: string) =>
      `${addTask(id, uid)}; UPDATE tasks_tasks SET idempotency_key = 'same-request' WHERE id = '${id}'`;
    const la = write(a, keyed('TZ', 'tz'));
    publish(b, write(b, keyed('TW', 'tw')));
    expect(sync(a)).toMatchObject({ rebased: 1 });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    expect(row(a, 'tz')).toBeUndefined();
    converged([a, b, c]);
  });

  it('an append-only row in a rewound txn is never rewound or replayed', async () => {
    const [a, b, c] = await threeReplicas();
    publish(
      a,
      write(
        a,
        "INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, uid, birth_fp) VALUES ('AC1', 'X', 1, 'criterion', 'ac1', 'fp-ac1')",
      ),
    );
    for (const r of [a, b, c]) sync(r);
    const la = write(
      a,
      `INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason, uid, birth_fp, ac_uid) VALUES ('AC1', 'old', 'edit', 'h1', 'fp-h1', 'ac1');
       UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'y'`,
    );
    const rowid = () =>
      a.db
        .prepare("SELECT rowid AS r FROM tasks_task_acceptance_criteria_history WHERE uid = 'h1'")
        .get();
    const before = rowid();
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'y'"));
    expect(sync(a)).toMatchObject({ rebased: 1 });
    expect(rowid(), 'the append-only row was deleted and re-inserted').toEqual(before);
    const replayed = a.db
      .prepare(
        'SELECT tbl, values_json IS NOT NULL AS replayed FROM _sync_row_undo WHERE txn = ? ORDER BY idx',
      )
      .all(la) as Array<{ tbl: string; replayed: number }>;
    expect(replayed).toEqual([
      { tbl: 'tasks_task_acceptance_criteria_history', replayed: 0 },
      { tbl: 'tasks_tasks', replayed: 1 },
    ]);
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    converged([a, b, c]);
  });
});

describe('natural-key rows (T13273)', () => {
  it("a dependency insert's own echo applies on its origin and is sequenced", async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, `${addTask('TA', 'ta')}; ${addTask('TB', 'tb')}`));
    for (const r of [a, b, c]) sync(r);
    const la = write(
      a,
      "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TA', 'TB')",
    );
    publish(a, la);
    expect(sync(a), 'the echo of an unfilled natural row voided on its origin').toMatchObject({
      applied: 1,
      void: 0,
      conflicts: 0,
    });
    expect(outcome(a, la)).toBe('applied');
    const sealed = n(a.db, 'SELECT count(*) AS n FROM _sync_txn');
    seal(a);
    expect(n(a.db, 'SELECT count(*) AS n FROM _sync_txn'), 'filling the uid was journaled').toBe(
      sealed,
    );
    sync(b);
    sync(c);
    const deps = (r: Replica) =>
      r.db
        .prepare('SELECT task_id, depends_on, uid FROM tasks_task_dependencies ORDER BY 1, 2')
        .all();
    expect(deps(b)).toEqual(deps(a));
    expect(deps(c)).toEqual(deps(a));
  });

  it('a dependency cycle closed through edges neither txn names converges (closure)', async () => {
    const [a, b, c] = await threeReplicas();
    publish(
      a,
      write(
        a,
        `${addTask('TA', 'ta')}; ${addTask('TB', 'tb')}; ${addTask('TC', 'tc')}; ${addTask('TD', 'td')};
         INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TB', 'TC'), ('TD', 'TA')`,
      ),
    );
    for (const r of [a, b, c]) sync(r);
    const la = write(
      a,
      "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TA', 'TB')",
    );
    publish(
      b,
      write(b, "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TC', 'TD')"),
    );
    expect(sync(a), 'the foreign edge met the local one only through the closure').toMatchObject({
      rebased: 1,
    });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('void');
    const deps = (r: Replica) =>
      r.db.prepare('SELECT task_id, depends_on FROM tasks_task_dependencies ORDER BY 1, 2').all();
    expect(deps(b)).toEqual(deps(a));
    expect(deps(c)).toEqual(deps(a));
    converged([a, b, c]);
  });
});

describe('natural twins (D2)', () => {
  it('a local insert the stream also made is rewound to the stream row, not deleted', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, `${addTask('TA', 'ta')}; ${addTask('TB', 'tb')}`));
    for (const r of [a, b, c]) sync(r);
    const rel = (reason: string) =>
      `INSERT INTO tasks_task_relations (task_id, related_to, relation_type, reason, uid) VALUES ('TA', 'TB', 'blocks', '${reason}', 'rel-ab')`;
    // Relations journal under a stored uid; both replicas give the twin the same one.
    const la = write(a, rel('from A'));
    publish(b, write(b, rel('from B')));
    sync(a);
    publish(b, write(b, "UPDATE tasks_task_relations SET reason = 'B later' WHERE task_id = 'TA'"));
    expect(sync(a), 'the update of the twin row waits forever').toMatchObject({
      applied: 1,
      pending: 0,
    });
    const reason = (r: Replica) =>
      r.db.prepare("SELECT reason FROM tasks_task_relations WHERE task_id = 'TA'").get();
    expect(reason(a)).toEqual({ reason: 'B later' });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(reason(b)).toEqual(reason(a));
    expect(reason(c)).toEqual(reason(a));
  });
});

describe('pages (§3.5 Rule 3)', () => {
  const frames = (r: Replica) =>
    (
      r.db
        .prepare('SELECT seq, status, applied_frame AS f FROM _sync_inbox ORDER BY seq, txn_idx')
        .all() as Array<{
        seq: number;
        status: string;
        f: string | null;
      }>
    ).map((x) => ({ seq: Number(x.seq), status: x.status, f: x.f }));

  it('a replica applying one transaction per page converges with one applying a page', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    const lb = write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'x'");
    const lc = write(c, "UPDATE tasks_tasks SET title = 'from C' WHERE uid = 'y'");
    publish(b, lb);
    publish(c, lc);
    publish(a, la);
    expect(sync(a, published.length, { pageOps: 1 })).toMatchObject({ applied: 3, void: 0 });
    sync(b);
    sync(c, published.length, { pageOps: 1 });
    converged([a, b, c]);
    const fa = frames(a).slice(-3);
    expect(new Set(fa.map((x) => x.f)).size, 'one transaction per page').toBe(3);
    const fb = frames(b).slice(-3);
    expect(new Set(fb.map((x) => x.f)).size, 'one page').toBe(1);
  });

  it('a post-apply void inside a page rolls back that transaction only', async () => {
    const [a, b, c] = await threeReplicas();
    publish(a, write(a, "UPDATE tasks_tasks SET type = 'epic' WHERE uid = 'x'"));
    for (const r of [a, b, c]) sync(r);
    // C puts a task under X; B, not yet seeing it, retypes X; B edits Y.
    publish(c, write(c, addTask('TK', 'k', 'X')));
    const retype = write(b, "UPDATE tasks_tasks SET type = 'task' WHERE uid = 'x'");
    const title = write(b, "UPDATE tasks_tasks SET title = 'after' WHERE uid = 'y'");
    publish(b, retype, title);
    expect(sync(a)).toMatchObject({ applied: 2, void: 1 });
    const page = frames(a).slice(-2);
    expect(page.map((x) => x.status)).toEqual(['void', 'applied']);
    expect(page[0]?.f, 'one page, one frame').toBe(page[1]?.f);
    expect(row(a, 'y')).toMatchObject({ title: 'after' });
    expect(a.db.prepare("SELECT type FROM tasks_tasks WHERE uid = 'x'").get()).toEqual({
      type: 'epic',
    });
    for (const r of [a, b, c]) sync(r);
    converged([a, b, c]);
  });

  it('the time bound ends a page between transactions', async () => {
    const [a, b] = await threeReplicas();
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't1' WHERE uid = 'x'"));
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't2' WHERE uid = 'y'"));
    let t = Date.now();
    expect(sync(a, published.length, { pageMs: 0, now: () => (t += 5) })).toMatchObject({
      applied: 2,
    });
    const last2 = frames(a).slice(-2);
    expect(last2[0]?.f).not.toBe(last2[1]?.f);
  });

  it("the time bound counts applying, not the page's rewind (T13275)", async () => {
    const [a, b] = await threeReplicas();
    write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    for (const t of ['t1', 't2', 't3']) {
      publish(b, write(b, `UPDATE tasks_tasks SET title = '${t}' WHERE uid = 'x'`));
    }
    // Opening the page (its rewind) takes 100 ms; applying takes no time.
    const base = Date.now();
    const clock = () => (a.db.isTransaction ? base + 100 : base);
    expect(sync(a, published.length, { pageMs: 50, now: clock })).toMatchObject({
      applied: 3,
      rebased: 3,
    });
    const last3 = frames(a).slice(-3);
    expect(new Set(last3.map((x) => x.f)).size, 'the rewind used up the page budget').toBe(1);
  });

  it('a page breaks on an actor change and keeps a larger transaction whole', async () => {
    const [a, b] = await threeReplicas();
    publish(
      b,
      write(
        b,
        "UPDATE tasks_tasks SET title = 'one' WHERE uid = 'x'",
        JSON.stringify({ op: 'tasks.update' }),
      ),
    );
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'two' WHERE uid = 'y'"));
    expect(sync(a)).toMatchObject({ applied: 2 });
    const last2 = frames(a).slice(-2);
    expect(last2[0]?.f, 'two actors shared one frame').not.toBe(last2[1]?.f);
    // A two-op transaction under a one-op page is a page alone, never split.
    publish(b, write(b, "UPDATE tasks_tasks SET priority = 'low' WHERE uid IN ('x', 'y')"));
    expect(sync(a, published.length, { pageOps: 1 })).toMatchObject({ applied: 1 });
    expect(row(a, 'x')).toMatchObject({ priority: 'low' });
    expect(row(a, 'y')).toMatchObject({ priority: 'low' });
  });
});

describe('undo budget (§3.5 Rule 2, D5)', () => {
  it('warns from 80%, then persists the exceeded warning and keeps writing undo', async () => {
    const [a] = await threeReplicas();
    write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    const held = undoBudget(a.db).bytes;
    const imagesOnly = n(
      a.db,
      'SELECT sum(octet_length(tbl) + octet_length(rk) + coalesce(octet_length(uid), 0) + coalesce(octet_length(before_full), 0) + coalesce(octet_length(after_full), 0)) AS n FROM _sync_undo',
    );
    expect(held, 'the row undo snapshots count too').toBeGreaterThan(imagesOnly);
    // Under the budget, past 80%: a warning, nothing persisted.
    expect(
      sync(a, published.length, { undoBudgetBytes: Math.ceil(held / 0.85) }).undoBudget,
    ).toMatchObject({ state: 'warn', exceededAt: null });
    // Past the budget: the persistent warning every later pull carries.
    const over = sync(a, published.length, { undoBudgetBytes: held });
    expect(over.undoBudget).toMatchObject({ state: 'exceeded' });
    expect(over.undoBudget?.exceededAt).not.toBeNull();
    expect(sync(a).undoBudget, 'the warning is persistent until a rebind').toMatchObject({
      state: 'exceeded',
      exceededAt: over.undoBudget?.exceededAt,
    });
    // Undo is never stopped, and it is counted in UTF-8 bytes, not characters.
    write(a, "UPDATE tasks_tasks SET title = 'ééééé' WHERE uid = 'y'");
    const utf8 = (v: unknown) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 0);
    let expected = 0;
    for (const r of a.db
      .prepare('SELECT tbl, rk, uid, before_full, after_full FROM _sync_undo')
      .all() as Array<Record<string, unknown>>) {
      for (const v of Object.values(r)) expected += utf8(v);
    }
    for (const r of a.db
      .prepare('SELECT tbl, uid, meta_json, leave_json, values_json, kept_json FROM _sync_row_undo')
      .all() as Array<Record<string, unknown>>) {
      for (const v of Object.values(r)) expected += utf8(v);
    }
    expect(undoBudget(a.db).bytes).toBe(expected);
    expect(expected).toBeGreaterThan(held);
    // Status and the doctor report the same.
    expect((await readStoreSyncStream(a.db, 'project', null, 'cleo.db')).undo.state).toBe(
      'exceeded',
    );
    expect((await runSyncRepair(join(dir, 'aaaa'))).undo.state).toBe('exceeded');
    expect((await runSyncRepair(join(dir, 'aaaa'), { repair: true })).undo.state).toBe('exceeded');
  });
});

describe('segmented transactions (T12343 O-1)', () => {
  it('a local txn already packed into a segment is still rewound and replayed by a rebase', async () => {
    const [a, b, c] = await threeReplicas();
    const la = write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    const seg = buildSegment(a.db, {
      stream: STREAM,
      replica: a.id,
      project: null,
      sealer: (_seq, plaintext) => Buffer.from(plaintext),
      signTxn: (_stream, txn) => txn,
      nowIso: new Date().toISOString(),
    });
    // The test stream bypassed segments for the base txn, so it is packed too.
    expect(seg?.txns).toContain(la);
    publish(b, write(b, "UPDATE tasks_tasks SET title = 'from B' WHERE uid = 'x'"));
    expect(sync(a), 'the segmented txn fell out of the rebase').toMatchObject({ rebased: 1 });
    expect(
      n(a.db, "SELECT count(*) AS n FROM _sync_foreign_touch WHERE uid = 'x'"),
      'a segmented txn no longer counts as unsequenced for the touch index',
    ).toBe(1);
    expect(row(a, 'x')).toMatchObject({ title: 'from B', priority: 'high' });
    publish(a, la);
    for (const r of [a, b, c]) sync(r);
    expect(outcome(a, la)).toBe('applied');
    converged([a, b, c]);
  });
});

describe('foreign-touch index bounds (#1912 follow-ups)', () => {
  it('a restarted capture counter marks the index incomplete, so the fast path declines', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const la = write(a, addTask('X', 'x'));
    // Re-creating the capture table restarts its AUTOINCREMENT counter.
    a.db.prepare("DELETE FROM sqlite_sequence WHERE name = '_sync_capture'").run();
    publish(b, write(b, addTask('Q', 'q')));
    publish(a, la);
    // One page: B's insert and A's echo, rebased together.
    expect(sync(a), 'the fast path trusted a restarted counter').toMatchObject({ rebased: 2 });
    expect(
      n(a.db, 'SELECT count(*) AS n FROM _sync_meta WHERE key = ?', FOREIGN_TOUCH_INCOMPLETE_KEY),
    ).toBe(0);
  });

  it('keeps a running touch count instead of counting the index', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    publish(b, write(b, `${addTask('X', 'x')}; ${addTask('Y', 'y')}`));
    sync(a);
    const count = () =>
      Number(
        (
          a.db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(FOREIGN_TOUCH_COUNT_KEY) as
            | { value: string }
            | undefined
        )?.value ?? 0,
      );
    const la = write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't' WHERE uid = 'x'"));
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't' WHERE uid = 'y'"));
    sync(a);
    expect(count()).toBe(n(a.db, 'SELECT count(*) AS n FROM _sync_foreign_touch'));
    expect(count()).toBe(2);
    publish(a, la);
    sync(a);
    expect(count(), 'pruning the index did not adjust the count').toBe(0);
    expect(n(a.db, 'SELECT count(*) AS n FROM _sync_foreign_touch')).toBe(0);
  });

  it('pruning past the new oldest unsequenced txn lowers the running count', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    publish(b, write(b, `${addTask('X', 'x')}; ${addTask('Y', 'y')}; ${addTask('Z', 'z')}`));
    sync(a);
    const count = () =>
      Number(
        (
          a.db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(FOREIGN_TOUCH_COUNT_KEY) as
            | { value: string }
            | undefined
        )?.value ?? 0,
      );
    const l1 = write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't' WHERE uid = 'y'"));
    sync(a);
    write(a, "UPDATE tasks_tasks SET description = 'd' WHERE uid = 'x'");
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't' WHERE uid = 'z'"));
    sync(a);
    expect(count()).toBe(2);
    publish(a, l1);
    sync(a);
    // Y's touch sat before the next unsequenced txn and was pruned; Z's stays.
    expect(n(a.db, 'SELECT count(*) AS n FROM _sync_foreign_touch')).toBe(1);
    expect(count(), 'pruning did not lower the count').toBe(1);
  });

  it('marks the index incomplete once the running count passes the bound', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    publish(b, write(b, addTask('X', 'x')));
    sync(a);
    write(a, "UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'x'");
    a.db
      .prepare(
        "INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, '2026-10-05T00:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(FOREIGN_TOUCH_COUNT_KEY, String(FOREIGN_TOUCH_MAX));
    publish(b, write(b, "UPDATE tasks_tasks SET title = 't' WHERE uid = 'x'"));
    sync(a);
    expect(
      n(a.db, 'SELECT count(*) AS n FROM _sync_meta WHERE key = ?', FOREIGN_TOUCH_INCOMPLETE_KEY),
    ).toBe(1);
  });
});
