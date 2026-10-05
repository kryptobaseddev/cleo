/**
 * Echo subtraction by apply intents (journal spec §3.3; H1, N1; T12757).
 *
 * An apply frame's captures are sealed only for what the apply did NOT
 * write: fields without an intent, or written with a different value. The
 * store tests run a real project `cleo.db` through the chokepoint; the
 * intents are computed with the capture triggers' own `enc()`, as the apply
 * API does with `RETURNING`.
 *
 * @task T12757
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import {
  type ApplyIntent,
  INTENT_DELETE,
  INTENT_INSERT,
  INTENT_REKEY,
  type IntentCapture,
  loadFrameIntents,
  recordApplyIntents,
  SECRET_INTENT,
  subtractApplyIntents,
} from '../apply-intent.js';
import { enc, finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { sealPending } from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-apply-intent-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

let clock = T0;
const seal = (db: DatabaseSync) =>
  sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

function inFrame(
  db: DatabaseSync,
  kind: 'write' | 'apply' | 'rebase',
  fn: (frame: string) => void,
) {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, kind, 'test');
  fn(frame);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (db: DatabaseSync, id: string) =>
  db
    .prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
    )
    .run(id, `title ${id}`, `uid-${id}`, `fp-${id}`);

/** What the apply API records: the stored value's enc(), as RETURNING gives it. */
function storedIntents(db: DatabaseSync, id: string, cols: readonly string[]): ApplyIntent[] {
  return cols.map((col) => ({
    tbl: 'tasks_tasks',
    uid: `uid-${id}`,
    col,
    enc: (
      db.prepare(`SELECT ${enc(`"${col}"`)} AS e FROM tasks_tasks WHERE id = ?`).get(id) as {
        e: string;
      }
    ).e,
  }));
}

/** Every non-NULL column of the stored row, as the apply records an insert. */
function allStoredIntents(db: DatabaseSync, id: string): ApplyIntent[] {
  const cols = (
    db.prepare('SELECT name FROM pragma_table_info(?)').all('tasks_tasks') as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const row = db.prepare('SELECT * FROM tasks_tasks WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return storedIntents(
    db,
    id,
    cols.filter((c) => row[c] !== null && row[c] !== undefined),
  );
}

const sealedOps = (db: DatabaseSync) =>
  (
    db.prepare('SELECT o, body FROM _sync_op ORDER BY txn, idx').all() as Array<{
      o: string;
      body: string;
    }>
  ).map((r) => ({ o: r.o, ...(JSON.parse(r.body) as { a?: Record<string, unknown> }) }));

const n = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('sealer: apply frames seal only their residual (T12757)', () => {
  it('an insert the apply fully explains is never sealed, and the ledger still counts the row', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T0'));
    seal(db); // the ledger now has a row for tasks_tasks
    const txnsBefore = n(db, 'SELECT count(*) AS n FROM _sync_txn');

    inFrame(db, 'apply', (frame) => {
      addTask(db, 'T1');
      recordApplyIntents(db, frame, [
        { tbl: 'tasks_tasks', uid: 'uid-T1', col: INTENT_INSERT, enc: '' },
        ...allStoredIntents(db, 'T1'),
      ]);
    });
    const r = seal(db);
    expect(r).toMatchObject({ txns: 0, ops: 0 });
    expect(n(db, 'SELECT count(*) AS n FROM _sync_txn')).toBe(txnsBefore);
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_apply_intent')).toBe(0);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_frame')).toBe(0);
    expect(n(db, "SELECT live AS n FROM _sync_ledger WHERE tbl = 'tasks_tasks'")).toBe(
      n(db, 'SELECT count(*) AS n FROM tasks_tasks'),
    );
  });

  it('an interleaved write in an apply frame is sealed, field by field: only what the apply did not write', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    seal(db);

    inFrame(db, 'apply', (frame) => {
      // The apply writes the title (its intent); a side effect in the same
      // frame changes the priority, and another row is written raw.
      db.exec("UPDATE tasks_tasks SET title = 'remote title', priority = 'high' WHERE id = 'T1'");
      recordApplyIntents(db, frame, storedIntents(db, 'T1', ['title']));
      addTask(db, 'T2');
    });
    const r = seal(db);
    expect(r.txns).toBe(1);
    const ops = sealedOps(db).slice(-2);
    expect(ops[0]).toMatchObject({ o: 'U', a: { priority: 'high' } });
    expect(ops[0]?.a).not.toHaveProperty('title');
    expect(ops[1]).toMatchObject({ o: 'I', u: 'uid-T2' });
  });

  it('a field the apply wrote with a different value than it stored is residual', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    seal(db);
    inFrame(db, 'apply', (frame) => {
      db.exec("UPDATE tasks_tasks SET title = 'normalised' WHERE id = 'T1'");
      recordApplyIntents(db, frame, [
        { tbl: 'tasks_tasks', uid: 'uid-T1', col: 'title', enc: "'as received'" },
      ]);
    });
    seal(db);
    expect(sealedOps(db).at(-1)).toMatchObject({ o: 'U', a: { title: 'normalised' } });
  });

  it('the apply writes a field twice in a frame: nothing seals, the row holds the last value (review-p0 HIGH)', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    seal(db);
    const opsBefore = sealedOps(db).length;
    inFrame(db, 'apply', (frame) => {
      db.exec("UPDATE tasks_tasks SET title = 'remote v1' WHERE id = 'T1'");
      recordApplyIntents(db, frame, storedIntents(db, 'T1', ['title']));
      db.exec("UPDATE tasks_tasks SET title = 'remote v2' WHERE id = 'T1'");
      recordApplyIntents(db, frame, storedIntents(db, 'T1', ['title']));
    });
    expect(seal(db).txns).toBe(0);
    expect(sealedOps(db)).toHaveLength(opsBefore);
    expect(db.prepare("SELECT title FROM tasks_tasks WHERE id = 'T1'").get()).toEqual({
      title: 'remote v2',
    });
  });

  it("a local write then the apply's write of the same field: nothing seals (review-p0 HIGH)", async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    seal(db);
    const opsBefore = sealedOps(db).length;
    inFrame(db, 'apply', (frame) => {
      db.exec("UPDATE tasks_tasks SET title = 'local side' WHERE id = 'T1'");
      db.exec("UPDATE tasks_tasks SET title = 'remote' WHERE id = 'T1'");
      recordApplyIntents(db, frame, storedIntents(db, 'T1', ['title']));
    });
    expect(seal(db).txns).toBe(0);
    expect(sealedOps(db)).toHaveLength(opsBefore);
  });

  it("the apply's write then a local write of the same field: only the final value seals", async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    seal(db);
    inFrame(db, 'apply', (frame) => {
      db.exec("UPDATE tasks_tasks SET title = 'remote' WHERE id = 'T1'");
      recordApplyIntents(db, frame, storedIntents(db, 'T1', ['title']));
      db.exec("UPDATE tasks_tasks SET title = 'local final' WHERE id = 'T1'");
    });
    expect(seal(db).txns).toBe(1);
    expect(sealedOps(db).at(-1)).toMatchObject({ o: 'U', a: { title: 'local final' } });
  });

  it('an applied insert keeps the columns no intent names as residual (review-p0 MED-1)', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T0'));
    seal(db);
    inFrame(db, 'apply', (frame) => {
      addTask(db, 'T1');
      const all = allStoredIntents(db, 'T1').filter((i) => i.col !== 'priority');
      recordApplyIntents(db, frame, [
        { tbl: 'tasks_tasks', uid: 'uid-T1', col: INTENT_INSERT, enc: '' },
        ...all,
      ]);
    });
    expect(seal(db).txns).toBe(1);
    expect(sealedOps(db).at(-1)).toMatchObject({ o: 'U', u: 'uid-T1', a: { priority: 'medium' } });
  });

  it("a secret intent is bound to the capture the apply's write produced", async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'apply', 'test');
    db.exec("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'");
    const seq = (db.prepare('SELECT max(seq) AS s FROM _sync_capture').get() as { s: number }).s;
    recordApplyIntents(db, frame, [
      { tbl: 'tasks_tasks', uid: 'uid-T1', col: 'title', enc: SECRET_INTENT },
    ]);
    expect([...loadFrameIntents(db, frame).values()]).toEqual([`${SECRET_INTENT}@${seq}`]);
    finishCaptureFrame(db, frame);
    db.exec('ROLLBACK');
  });

  it('a secret intent binds to the capture that changed that column, past a same-row cascade and another column (review-p0 MED)', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'T1'));
    db.exec(`CREATE TRIGGER t12757_touch AFTER UPDATE OF title ON tasks_tasks
             BEGIN UPDATE tasks_tasks SET priority = 'high' WHERE id = NEW.id; END`);
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'apply', 'test');
    db.exec("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'"); // + the cascade's capture
    const titleSeq = (
      db
        .prepare(
          'SELECT max(seq) AS s FROM _sync_capture WHERE json_type(img, \'$."title"\') IS NOT NULL',
        )
        .get() as { s: number }
    ).s;
    db.exec("UPDATE tasks_tasks SET status = 'active' WHERE id = 'T1'"); // another column
    const newest = (db.prepare('SELECT max(seq) AS s FROM _sync_capture').get() as { s: number }).s;
    expect(newest).toBeGreaterThan(titleSeq);
    recordApplyIntents(db, frame, [
      { tbl: 'tasks_tasks', uid: 'uid-T1', col: 'title', enc: SECRET_INTENT },
    ]);
    expect([...loadFrameIntents(db, frame).values()]).toEqual([`${SECRET_INTENT}@${titleSeq}`]);
    finishCaptureFrame(db, frame);
    db.exec('ROLLBACK');
  });

  it('an applied delete is never sealed, and the ledger drops the row', async () => {
    const db = await store();
    inFrame(db, 'write', () => {
      addTask(db, 'T1');
      addTask(db, 'T2');
    });
    seal(db);
    const opsBefore = sealedOps(db).length;
    inFrame(db, 'apply', (frame) => {
      db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'");
      recordApplyIntents(db, frame, [
        { tbl: 'tasks_tasks', uid: 'uid-T1', col: INTENT_DELETE, enc: '' },
      ]);
    });
    expect(seal(db).txns).toBe(0);
    expect(sealedOps(db)).toHaveLength(opsBefore);
    expect(n(db, "SELECT live AS n FROM _sync_ledger WHERE tbl = 'tasks_tasks'")).toBe(1);
  });

  it('an apply frame with no intents seals whole, like a write', async () => {
    const db = await store();
    inFrame(db, 'apply', () => addTask(db, 'T1'));
    expect(seal(db).txns).toBe(1);
    expect(sealedOps(db)).toEqual([expect.objectContaining({ o: 'I', u: 'uid-T1' })]);
  });

  it('a rebase frame still waits for the S5 scoped rebase', async () => {
    const db = await store();
    inFrame(db, 'rebase', () => addTask(db, 'T1'));
    const r = seal(db);
    expect(r.txns).toBe(0);
    expect(r.pending[0]?.reason).toMatch(/rebase frames wait/);
  });

  it('a later intent for the same field replaces the earlier one', async () => {
    const db = await store();
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'apply', 'test');
    const intent = (e: string) => ({ tbl: 't', uid: 'u', col: 'c', enc: e });
    recordApplyIntents(db, frame, [intent("'a'")]);
    recordApplyIntents(db, frame, [intent("'b'")]);
    expect([...loadFrameIntents(db, frame).values()]).toEqual(["'b'"]);
    finishCaptureFrame(db, frame);
    db.exec('ROLLBACK');
  });
});

describe('subtractApplyIntents (T12757)', () => {
  const key = (col: string) => `t\u0000u1\u0000${col}`;
  const cap = (op: IntentCapture['op'], img: Record<string, unknown>, seq = 1): IntentCapture => ({
    seq,
    tbl: 't',
    op,
    img: JSON.stringify(img),
  });
  const run = (captures: IntentCapture[], intents: Record<string, string>) =>
    subtractApplyIntents(
      captures,
      new Map(Object.entries(intents).map(([c, e]) => [key(c), e])),
      () => 'u1',
    );

  it('compares a reference by its local key and a secret by its marker', () => {
    const r = run(
      [
        cap('U', {
          ref: [
            ["'old'", 'uid-x'],
            ["'L1'", 'uid-y'],
          ],
          sec: ['<changed>', '<changed>'],
        }),
      ],
      { ref: "'L1'", sec: SECRET_INTENT },
    );
    expect(r.removed).toHaveLength(1);
    expect(r.residual).toEqual([]);
  });

  it("a local secret write after the apply's write in the frame is residual (review-p0 MED-2)", () => {
    const applied = cap('U', { sec: ['<changed>', '<changed>'] }, 1);
    const local = cap('U', { sec: ['<changed>', '<changed>'] }, 2);
    const r = run([applied, local], { sec: `${SECRET_INTENT}@1` });
    expect(r.removed).toEqual([applied]);
    expect(r.residual.map((c) => c.seq)).toEqual([2]);
    expect(run([applied], { sec: `${SECRET_INTENT}@1` }).removed).toEqual([applied]);
    // A bare marker intent never swallows a column the frame changed twice.
    expect(run([applied, local], { sec: SECRET_INTENT }).residual.map((c) => c.seq)).toEqual([2]);
  });

  it('a secret bound to capture A is matched by A even when a later capture B changed only another column', () => {
    const a = cap('U', { sec: ['<changed>', '<changed>'] }, 1);
    const b = cap('U', { other: ["'x'", "'y'"] }, 2);
    const r = run([a, b], { sec: `${SECRET_INTENT}@1` });
    expect(r.removed).toEqual([a]);
    expect(r.residual.map((c) => c.seq)).toEqual([2]);
  });

  it('an insert with a mismatching column leaves an update from the intent value, and an unnamed column from NULL', () => {
    const r = run([cap('I', { a: "'x'", b: "'stored'", c: "'local default'" })], {
      [INTENT_INSERT]: '',
      a: "'x'",
      b: "'sent'",
    });
    expect(r.removed).toEqual([]);
    expect(r.residual[0]?.op).toBe('U');
    expect(JSON.parse(r.residual[0]?.img ?? '{}')).toEqual({
      b: ["'sent'", "'stored'"],
      c: ['NULL', "'local default'"],
    });
  });

  it('a re-key is removed only when the intent names the same new uid', () => {
    const k = cap('K', { uid: ["'u1'", "'u2'"] });
    expect(run([k], { [INTENT_REKEY]: 'u2' }).removed).toHaveLength(1);
    expect(run([k], { [INTENT_REKEY]: 'u3' }).residual).toHaveLength(1);
  });

  it('never removes a capture whose row has no intent, or whose uid is unknown', () => {
    expect(run([cap('D', {})], {}).residual).toHaveLength(1);
    const unknown = subtractApplyIntents(
      [cap('D', {})],
      new Map([[key(INTENT_DELETE), '']]),
      () => null,
    );
    expect(unknown.residual).toHaveLength(1);
  });
});

describe('merge groups travel whole (T13222)', () => {
  it('a status-only change is captured and sealed with its whole status group', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'G1'));
    seal(db);
    inFrame(db, 'write', () => {
      db.prepare("UPDATE tasks_tasks SET status = 'blocked' WHERE id = 'G1'").run();
    });
    seal(db);
    const u = sealedOps(db).filter((o) => o.o === 'U');
    expect(u).toHaveLength(1);
    expect(Object.keys(u[0]?.a ?? {}).sort()).toEqual([
      'cancellation_reason',
      'cancelled_at',
      'completed_at',
      'status',
    ]);
    // A loose column still travels alone.
    inFrame(db, 'write', () => {
      db.prepare("UPDATE tasks_tasks SET title = 'renamed' WHERE id = 'G1'").run();
    });
    seal(db);
    expect(Object.keys(sealedOps(db).filter((o) => o.o === 'U')[1]?.a ?? {})).toEqual(['title']);
  });

  it('one residual group member keeps the whole group in an apply frame', async () => {
    const db = await store();
    inFrame(db, 'write', () => addTask(db, 'G2'));
    seal(db);
    inFrame(db, 'apply', (frame) => {
      db.prepare("UPDATE tasks_tasks SET status = 'blocked' WHERE id = 'G2'").run();
      // The apply explains status only; a trigger-like local write sets a stamp.
      recordApplyIntents(db, frame, storedIntents(db, 'G2', ['status']));
      db.prepare("UPDATE tasks_tasks SET cancellation_reason = 'local' WHERE id = 'G2'").run();
    });
    seal(db);
    const u = sealedOps(db).filter((o) => o.o === 'U');
    expect(u).toHaveLength(1);
    expect(Object.keys(u[0]?.a ?? {}).sort()).toEqual([
      'cancellation_reason',
      'cancelled_at',
      'completed_at',
      'status',
    ]);
  });
});
