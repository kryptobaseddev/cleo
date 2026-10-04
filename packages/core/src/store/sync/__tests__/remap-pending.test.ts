/**
 * Uid remaps propagate to pending captures and unsegmented ops (journal spec
 * §3.3 G; T12779).
 *
 * @task T12779
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rekeyRowUid } from '../../display-id-alias.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { enc, finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { encText, refreshPendingBirthFps, remapCapture, remapPending } from '../remap.js';
import { sealPending } from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-remap-pending-'));
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

function framed(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  fn();
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (db: DatabaseSync, id: string, parent: string | null = null) =>
  db
    .prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, parent_id)
       VALUES (?, ?, ?, 'pending', 'medium', ?, ?, ?)`,
    )
    .run(id, `title ${id}`, parent === null ? 'epic' : 'task', `uid-${id}`, `fp-${id}`, parent);

const ops = (db: DatabaseSync) =>
  (db.prepare('SELECT body FROM _sync_op ORDER BY txn, idx').all() as Array<{ body: string }>).map(
    (r) => JSON.parse(r.body) as { o: string; t: string; u: string; a?: Record<string, unknown> },
  );

const uidOf = (db: DatabaseSync, id: string) =>
  (db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(id) as { uid: string }).uid;

describe('remapped referenced rows (T12779)', () => {
  it('a K dropped into its insert also rewrites a reference another row captured to the old uid', async () => {
    const db = await store();
    framed(db, () => {
      addTask(db, 'T1');
      addTask(db, 'T2', 'T1'); // captures parent_id as [T1, uid-T1]
      rekeyRowUid(db, 'tasks_tasks', 'uid-T1', { loserBirthFp: 'fp-T1', winnerBirthFp: 'fp-T0' });
    });
    seal(db);
    const now = uidOf(db, 'T1');
    expect(now).not.toBe('uid-T1');
    const child = ops(db).find((o) => o.u === 'uid-T2');
    expect(child?.a?.parent_id).toBe(now);
    expect(JSON.stringify(ops(db))).not.toContain('uid-T1');
  });
});

describe('remapPending (T12779)', () => {
  const remap = { table: 'tasks_tasks', oldUid: 'uid-T1', newUid: 'uid-T1b', newBfp: 'fp-T1b' };

  it('rewrites live captures and unsegmented ops, never a segmented transaction', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db); // the I of uid-T1, sealed and unsegmented
    db.exec(`INSERT INTO _sync_txn (txn, local_seq, replica, hlc, scope, via, kind, op_count, state, sealed_at_ms)
             VALUES ('r:old', 999, 'r', 'h', 'project', 'local', 'write', 1, 'segmented', 0)`);
    db.prepare(
      'INSERT INTO _sync_op (txn, idx, tbl, uid, o, hlc, body) VALUES (?, 0, ?, ?, ?, ?, ?)',
    ).run(
      'r:old',
      'tasks_tasks',
      'uid-T1',
      'U',
      'h',
      JSON.stringify({ o: 'U', t: 'tasks_tasks', u: 'uid-T1', a: { title: 'x' } }),
    );
    framed(db, () => addTask(db, 'T2', 'T1')); // a live capture: parent_id [T1, uid-T1]

    const report = remapPending(db, remap);
    expect(report).toEqual({ captures: 1, ops: 1 });
    const img = (
      db.prepare("SELECT img FROM _sync_capture WHERE uid = 'uid-T2'").get() as { img: string }
    ).img;
    expect(JSON.parse(img).parent_id[1]).toBe('uid-T1b');
    const sealed = JSON.parse(
      (db.prepare("SELECT body FROM _sync_op WHERE txn != 'r:old'").get() as { body: string }).body,
    );
    expect(sealed).toMatchObject({ u: 'uid-T1b', bfp: 'fp-T1b' });
    const history = JSON.parse(
      (db.prepare("SELECT body FROM _sync_op WHERE txn = 'r:old'").get() as { body: string }).body,
    );
    expect(history.u).toBe('uid-T1');
  });

  it("rewrites the row's own I capture identity, and leaves a K's own pair alone", () => {
    const own = remapCapture(
      {
        tbl: 'tasks_tasks',
        op: 'I',
        uid: 'uid-T1',
        img: JSON.stringify({ uid: encText('uid-T1'), birth_fp: encText('fp-T1'), title: "'t'" }),
      },
      remap,
    );
    expect(own.uid).toBe('uid-T1b');
    expect(JSON.parse(own.img)).toEqual({ uid: "'uid-T1b'", birth_fp: "'fp-T1b'", title: "'t'" });
    const k = {
      tbl: 'tasks_tasks',
      op: 'K' as const,
      uid: 'uid-T1',
      img: JSON.stringify({ uid: ["'uid-T1'", "'uid-T1b'"] }),
    };
    expect(JSON.parse(remapCapture(k, remap).img)).toEqual({ uid: ["'uid-T1'", "'uid-T1b'"] });
    const other = {
      tbl: 'tasks_tasks',
      op: 'U' as const,
      uid: 'uid-T9',
      img: JSON.stringify({ title: ["'a'", "'b'"] }),
    };
    expect(remapCapture(other, remap)).toBe(other);
  });
});

describe('intents use the stored value (T12779 F)', () => {
  it('an INTEGER column stores the text 5 as 5: only the stored enc matches the capture', async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db);
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', 'test');
    db.exec("UPDATE tasks_tasks SET position = '5' WHERE id = 'T1'"); // sent as text
    const stored = (
      db.prepare(`SELECT ${enc('position')} AS e FROM tasks_tasks WHERE id = 'T1'`).get() as {
        e: string;
      }
    ).e;
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    const captured = JSON.parse(
      (
        db
          .prepare(
            "SELECT img FROM _sync_capture WHERE tbl = 'tasks_tasks' AND op = 'U' ORDER BY seq DESC LIMIT 1",
          )
          .get() as { img: string }
      ).img,
    ).position[1];
    expect(stored).toBe('5'); // enc of the INTEGER 5, not the text '5'
    expect(captured).toBe(stored);
    expect(captured).not.toBe(encText('5'));
  });
});

describe('refreshPendingBirthFps (T12779)', () => {
  it("points pending captures and unsegmented ops at the row's current birth_fp", async () => {
    const db = await store();
    framed(db, () => addTask(db, 'T1'));
    seal(db); // sealed I carries bfp fp-T1
    framed(db, () => addTask(db, 'T2')); // live I capture carries birth_fp fp-T2
    // A refill re-derives both fingerprints, uncaptured.
    db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')");
    db.exec("UPDATE tasks_tasks SET birth_fp = 'fp-' || id || '-v2'");
    db.exec('DELETE FROM cleo_trigger_suspend');
    expect(refreshPendingBirthFps(db, 'project')).toEqual({ captures: 1, ops: 1 });
    const sealed = JSON.parse(
      (db.prepare('SELECT body FROM _sync_op').get() as { body: string }).body,
    );
    expect(sealed.bfp).toBe('fp-T1-v2');
    const img = JSON.parse(
      (db.prepare("SELECT img FROM _sync_capture WHERE uid = 'uid-T2'").get() as { img: string })
        .img,
    );
    expect(img.birth_fp).toBe(encText('fp-T2-v2'));
    expect(refreshPendingBirthFps(db, 'project')).toEqual({ captures: 0, ops: 0 });
  });
});
