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
        ...storedIntents(db, 'T1', ['title', 'status', 'priority']),
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

  it('an insert with a mismatching column leaves an update from the intent value', () => {
    const r = run([cap('I', { a: "'x'", b: "'stored'" })], {
      [INTENT_INSERT]: '',
      a: "'x'",
      b: "'sent'",
    });
    expect(r.removed).toEqual([]);
    expect(r.residual[0]?.op).toBe('U');
    expect(JSON.parse(r.residual[0]?.img ?? '{}')).toEqual({ b: ["'sent'", "'stored'"] });
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
