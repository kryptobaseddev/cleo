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
import { LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { stageTxns } from '../../inbox.js';
import { sealPending } from '../../sealer.js';
import {
  FOREIGN_TOUCH_COUNT_KEY,
  FOREIGN_TOUCH_INCOMPLETE_KEY,
  FOREIGN_TOUCH_MAX,
} from '../../sequencing.js';
import { type ApplyReport, applyStagedTxns } from '../applier.js';

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
function write(r: Replica, sql: string): string {
  r.db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(r.db, 'write', null);
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
    const t = r.db.prepare('SELECT txn, hlc, via, kind FROM _sync_txn WHERE txn = ?').get(id) as {
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
        r.db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(t.txn) as Array<{
          body: string;
        }>
      ).map((o) => LedgerOp.parse(JSON.parse(o.body))),
      sig: '',
    };
  });
  published.push({ replicaId: r.id, txns });
}

/** Stage every segment this replica has not seen, then apply. */
function sync(r: Replica): ApplyReport {
  for (; r.cursor < published.length; r.cursor++) {
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

describe('foreign-touch index bounds (#1912 follow-ups)', () => {
  it('a restarted capture counter marks the index incomplete, so the fast path declines', async () => {
    const a = await replica(RA);
    const b = await replica(RB);
    const la = write(a, addTask('X', 'x'));
    // Re-creating the capture table restarts its AUTOINCREMENT counter.
    a.db.prepare("DELETE FROM sqlite_sequence WHERE name = '_sync_capture'").run();
    publish(b, write(b, addTask('Q', 'q')));
    publish(a, la);
    expect(sync(a), 'the fast path trusted a restarted counter').toMatchObject({ rebased: 1 });
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
