/**
 * No sync-class change bypasses the outbox (T12343 AC2; journal spec §2.3,
 * §2.3a, §3.2 "FK actions").
 *
 * A cross-check outside the capture machinery: snapshot every sync-set table
 * (each row's local key and full captured image, through the same SQL the
 * repair diff uses) before and after a workload, and require every changed
 * row to be accounted for by one of:
 * - a live capture of that row (`_sync_capture.rk`), which the sealer turns
 *   into an op;
 * - its table marked `suspect:`, which the repair diff re-emits (§2.3a rule 3).
 * FK actions (a cascaded child delete, a SET NULL) fire the child table's
 * capture triggers too, so they are captured like any write. What the sealer
 * then makes of each capture is Gate B's to prove (strict replay,
 * journal-gate-b), not this check's.
 * A deliberate bypass (a write with capture suspended and no suspect mark)
 * is caught, so the check is not vacuous.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { createSqliteDataAccessor } from '../../sqlite-data-accessor.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  repairImageSql,
  setCaptureEnabled,
  syncSetTables,
} from '../capture.js';
import { markSuspect, withSyncTriggersSuspended } from '../structural.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-outbox-xcheck-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'p', '.cleo', 'cleo.db')),
  );
  db.exec('PRAGMA foreign_keys = ON');
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

/** table -> local key (rk) -> full captured image, plus the capture high-water mark. */
interface Snapshot {
  readonly rows: Map<string, Map<string, string>>;
  readonly captureSeq: number;
}

function snapshot(db: DatabaseSync): Snapshot {
  const out = new Map<string, Map<string, string>>();
  for (const table of syncSetTables('project')) {
    const def = captureTableDef(db, 'project', table);
    if (!def) continue;
    const img = repairImageSql(def, 'x');
    const rows = db
      .prepare(`SELECT ${img.rk} AS rk, ${img.insert} AS image FROM main."${table}" x`)
      .all() as Array<{ rk: string; image: string }>;
    out.set(table, new Map(rows.map((r) => [r.rk, r.image])));
  }
  const seq = db.prepare('SELECT coalesce(max(seq), 0) AS s FROM _sync_capture').get() as {
    s: number;
  };
  return { rows: out, captureSeq: Number(seq.s) };
}

interface Change {
  readonly table: string;
  readonly rk: string;
  readonly kind: 'insert' | 'delete' | 'update';
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

function diff(a: Snapshot, b: Snapshot): Change[] {
  const out: Change[] = [];
  for (const [table, after] of b.rows) {
    const before = a.rows.get(table) ?? new Map<string, string>();
    for (const [rk, img] of after) {
      const old = before.get(rk);
      if (old === undefined) {
        out.push({ table, rk, kind: 'insert', before: null, after: JSON.parse(img) });
      } else if (old !== img) {
        out.push({ table, rk, kind: 'update', before: JSON.parse(old), after: JSON.parse(img) });
      }
    }
    for (const [rk, img] of before) {
      if (!after.has(rk))
        out.push({ table, rk, kind: 'delete', before: JSON.parse(img), after: null });
    }
  }
  return out;
}

/** The changes no capture made by the workload, and no suspect mark, accounts for. */
function uncovered(db: DatabaseSync, since: Snapshot, changes: readonly Change[]): Change[] {
  // Only captures the workload made count: an older capture of a row proves nothing.
  const captured = new Set(
    (
      db.prepare('SELECT tbl, rk FROM _sync_capture WHERE seq > ?').all(since.captureSeq) as Array<{
        tbl: string;
        rk: string;
      }>
    ).map((c) => `${c.tbl}\u0000${c.rk}`),
  );
  const suspect = new Set(
    (
      db.prepare("SELECT key FROM _sync_meta WHERE key LIKE 'suspect:%'").all() as Array<{
        key: string;
      }>
    ).map((r) => r.key.slice('suspect:'.length)),
  );
  return changes.filter((c) => !captured.has(`${c.table}\u0000${c.rk}`) && !suspect.has(c.table));
}

function framed(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const task = (id: string, uid: string, extra = '') =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp${extra ? ', parent_id' : ''}) VALUES ('${id}', 'title ${id}', ${extra ? "'task'" : "'epic'"}, 'pending', 'medium', '${uid}', 'fp-${uid}'${extra ? `, '${extra}'` : ''})`;

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: 'pending',
    priority: 'medium',
    type: 'epic',
    createdAt: new Date().toISOString(),
  } as Task;
}

describe('every sync-class change reaches the outbox (T12343 AC2)', () => {
  it('raw SQL, framed and unframed writes, natural-key rows and FK actions are all accounted for', async () => {
    const db = await store();
    framed(db, `${task('EP', 'ep')}; ${task('TA', 'ta', 'EP')}; ${task('TB', 'tb', 'EP')}`);
    const before = snapshot(db);
    // Framed and unframed edits, a natural-key edge, then a parent delete
    // whose FK actions null the children's parent and cascade the edge.
    framed(db, "UPDATE tasks_tasks SET title = 'renamed' WHERE uid = 'ta'");
    db.exec("UPDATE tasks_tasks SET priority = 'high' WHERE uid = 'tb'");
    framed(db, "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TA', 'TB')");
    framed(db, "DELETE FROM tasks_tasks WHERE uid = 'tb'");
    framed(db, "DELETE FROM tasks_tasks WHERE uid = 'ep'");
    const changes = diff(before, snapshot(db));
    // Net of the workload: TA edited (and its parent nulled by the FK action),
    // TB and EP deleted; the edge was inserted and cascaded away within it.
    expect(changes.map((c) => `${c.kind}`).sort()).toEqual(['delete', 'delete', 'update']);
    expect(uncovered(db, before, changes)).toEqual([]);
  });

  it('writes through the task accessor are captured', async () => {
    const db = await store();
    const before = snapshot(db);
    const accessor = await createSqliteDataAccessor(join(dir, 'p'));
    // The accessor shares the store's connection: leave it open (the test cache resets it).
    await accessor.upsertSingleTask(makeTask('T501'));
    await accessor.upsertSingleTask({ ...makeTask('T501'), title: 'edited through the accessor' });
    const changes = diff(before, snapshot(db));
    expect(changes.some((c) => c.table === 'tasks_tasks')).toBe(true);
    expect(uncovered(db, before, changes)).toEqual([]);
  });

  it('an uncaptured rewrite that marks its tables suspect is accounted for by the repair diff', async () => {
    const db = await store();
    framed(db, task('EP', 'ep'));
    const before = snapshot(db);
    withSyncTriggersSuspended(db, 'project', () => {
      db.exec("UPDATE tasks_tasks SET title = 'rewritten uncaptured' WHERE uid = 'ep'");
      markSuspect(db, 'project', ['tasks_tasks']);
    });
    expect(uncovered(db, before, diff(before, snapshot(db)))).toEqual([]);
  });

  it('catches a bypass: a write with capture suspended and no suspect mark', async () => {
    const db = await store();
    framed(db, task('EP', 'ep'));
    const before = snapshot(db);
    withSyncTriggersSuspended(db, 'project', () => {
      db.exec("UPDATE tasks_tasks SET title = 'silently rewritten' WHERE uid = 'ep'");
    });
    expect(uncovered(db, before, diff(before, snapshot(db)))).toEqual([
      expect.objectContaining({ table: 'tasks_tasks', kind: 'update' }),
    ]);
  });
});
