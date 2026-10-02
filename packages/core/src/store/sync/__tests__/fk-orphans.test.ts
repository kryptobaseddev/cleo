/**
 * The D3 `fk_orphans` repair (journal spec §3.5 Rule 4 (a)(3); C3 T12821,
 * D3 T12826; T12986, S3c).
 *
 * Coverage:
 *   - pre-sync: report-only, nothing written, no seam called
 *   - parent live elsewhere: restored with capture suspended, nothing
 *     emitted, no conflict
 *   - parent tombstoned: a delete-with-live-children conflict, no write
 *   - parent unknown: tasks and subtasks re-parented to the sentinel, epics
 *     and sagas made roots (the Gate test: one child of every type), a
 *     NOT NULL child reported; conflicts in every case; the writes are a
 *     captured `repair` frame; no row is ever deleted
 *   - two replicas create the same sentinel row with the same uid
 *
 * @task T12986
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { naturalRowUid, ROW_IDENTITY_SYNCED_KEY } from '../../row-identity.js';
import { setCaptureEnabled } from '../capture.js';
import {
  FK_ORPHAN_SENTINEL_ID,
  FK_ORPHAN_SENTINEL_UID,
  type FkOrphanConflict,
  type FkOrphanRepairSeams,
  findFkOrphans,
  type ParentState,
  repairFkOrphans,
} from '../fk-orphans.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-fk-orphans-'));
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

async function store(name = 'a', opts: { synced?: boolean } = {}): Promise<DatabaseSync> {
  mkdirSync(join(dir, name, '.cleo'), { recursive: true });
  const handle = await openDualScopeDbAtPath('project', join(dir, name, '.cleo', 'cleo.db'));
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  if (opts.synced !== false) {
    db.prepare('INSERT INTO tasks_row_identity_meta (key, value) VALUES (?, ?)').run(
      ROW_IDENTITY_SYNCED_KEY,
      '1',
    );
  }
  db.exec('DELETE FROM _sync_capture');
  return db;
}

/** Insert with foreign keys off, the way an orphan reaches a store. */
function orphan(db: DatabaseSync, id: string, type: string, parent: string): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, parent_id)
       VALUES (?, ?, ?, 'pending', 'medium', ?, ?, ?)`,
    ).run(id, `title ${id}`, type, `uid-${id}`, `fp-${id}`, parent);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function seams(state: (key: string | number) => ParentState) {
  const conflicts: FkOrphanConflict[] = [];
  const restored: Array<[string, string]> = [];
  const s: FkOrphanRepairSeams = {
    parentState: (_t, _c, key) => state(key),
    restoreParent: (db, table, uid) => {
      restored.push([table, uid]);
      db.prepare(
        `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
         VALUES ('T999', 'restored', 'epic', 'pending', 'medium', ?, 'fp-T999')`,
      ).run(uid);
    },
    recordConflict: (c) => conflicts.push(c),
  };
  return { seams: s, conflicts, restored };
}

const parentOf = (db: DatabaseSync, id: string) =>
  (
    db.prepare('SELECT parent_id FROM tasks_tasks WHERE id = ?').get(id) as {
      parent_id: string | null;
    }
  ).parent_id;
const captures = (db: DatabaseSync) =>
  db.prepare('SELECT kind, tbl, op FROM _sync_capture ORDER BY seq').all() as Array<{
    kind: string | null;
    tbl: string;
    op: string;
  }>;
/** Drop the setup's own captures, so assertions see only the repair's. */
const settled = (db: DatabaseSync): DatabaseSync => {
  db.exec('DELETE FROM _sync_capture; DELETE FROM _sync_frame');
  return db;
};
const taskCount = (db: DatabaseSync) =>
  (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n;

describe('findFkOrphans', () => {
  it('lists single-column violations with the missing parent key', async () => {
    const db = await store();
    orphan(db, 'T2', 'task', 'T999');
    expect(findFkOrphans(db)).toEqual([
      expect.objectContaining({
        table: 'tasks_tasks',
        uid: 'uid-T2',
        column: 'parent_id',
        parentTable: 'tasks_tasks',
        parentColumn: 'id',
        parentKey: 'T999',
      }),
    ]);
  });
});

describe('repairFkOrphans', () => {
  it('pre-sync it is report-only: nothing written, no seam called', async () => {
    const db = await store('a', { synced: false });
    orphan(db, 'T2', 'task', 'T999');
    const call = vi.fn(() => ({ state: 'unknown' }) as const);
    const h = seams(call);
    const r = repairFkOrphans(settled(db), 'project', h.seams);
    expect(r.mode).toBe('report-only');
    expect(r.orphans.map((o) => o.outcome)).toEqual(['reported']);
    expect(call).not.toHaveBeenCalled();
    expect(h.conflicts).toEqual([]);
    expect(parentOf(db, 'T2')).toBe('T999');
    expect(captures(db)).toEqual([]);
  });

  it('a parent live elsewhere is restored with capture suspended: nothing emitted, no conflict', async () => {
    const db = await store();
    orphan(db, 'T2', 'task', 'T999');
    const h = seams(() => ({ state: 'live', uid: 'uid-T999' }));
    const r = repairFkOrphans(settled(db), 'project', h.seams);
    expect(r.orphans.map((o) => o.outcome)).toEqual(['restored']);
    expect(h.restored).toEqual([['tasks_tasks', 'uid-T999']]);
    expect(h.conflicts).toEqual([]);
    expect(parentOf(db, 'T2')).toBe('T999');
    expect(captures(db)).toEqual([]);
    expect(findFkOrphans(db)).toEqual([]);
  });

  it('a tombstoned parent gives a delete-with-live-children conflict and no write', async () => {
    const db = await store();
    orphan(db, 'T2', 'task', 'T999');
    orphan(db, 'T3', 'subtask', 'T999');
    const h = seams(() => ({ state: 'tombstoned', uid: 'uid-T999' }));
    const r = repairFkOrphans(settled(db), 'project', h.seams);
    expect(r.orphans.map((o) => o.outcome)).toEqual(['conflict', 'conflict']);
    expect(h.conflicts).toEqual([
      {
        kind: 'delete-with-live-children',
        parent: { table: 'tasks_tasks', column: 'id', key: 'T999', uid: 'uid-T999' },
        children: [
          { table: 'tasks_tasks', column: 'parent_id', uid: 'uid-T2' },
          { table: 'tasks_tasks', column: 'parent_id', uid: 'uid-T3' },
        ],
        resolution: 'none',
      },
    ]);
    expect(parentOf(db, 'T2')).toBe('T999');
    expect(captures(db)).toEqual([]);
  });

  it('an unknown parent: one child of every type is re-parented or made a root, never deleted', async () => {
    const db = await store();
    orphan(db, 'T2', 'task', 'T999');
    orphan(db, 'T3', 'subtask', 'T999');
    orphan(db, 'T4', 'epic', 'T998');
    orphan(db, 'T5', 'saga', 'T997');
    const before = taskCount(db);
    const h = seams(() => ({ state: 'unknown' }));
    const r = repairFkOrphans(settled(db), 'project', h.seams);

    expect(r.sentinelCreated).toBe(true);
    expect(Object.fromEntries(r.orphans.map((o) => [o.uid, o.outcome]))).toEqual({
      'uid-T2': 'sentinel',
      'uid-T3': 'sentinel',
      'uid-T4': 'nulled',
      'uid-T5': 'nulled',
    });
    expect(parentOf(db, 'T2')).toBe(FK_ORPHAN_SENTINEL_ID);
    expect(parentOf(db, 'T3')).toBe(FK_ORPHAN_SENTINEL_ID);
    expect(parentOf(db, 'T4')).toBeNull();
    expect(parentOf(db, 'T5')).toBeNull();
    expect(taskCount(db)).toBe(before + 1); // the sentinel; nothing deleted
    expect(
      db
        .prepare('SELECT uid, type, parent_id FROM tasks_tasks WHERE id = ?')
        .get(FK_ORPHAN_SENTINEL_ID),
    ).toEqual({ uid: FK_ORPHAN_SENTINEL_UID, type: 'epic', parent_id: null });
    expect(findFkOrphans(db)).toEqual([]);

    // A conflict record in every case.
    expect(h.conflicts.map((c) => [c.kind, c.parent.key, c.resolution, c.children.length])).toEqual(
      [
        ['fk-orphan', 'T999', 'sentinel', 2],
        ['fk-orphan', 'T998', 'null', 1],
        ['fk-orphan', 'T997', 'null', 1],
      ],
    );
    // The writes are an ordinary, captured repair frame.
    const caps = captures(db);
    expect(caps.length).toBeGreaterThan(0);
    expect(new Set(caps.map((c) => c.kind))).toEqual(new Set(['repair']));
    expect(caps.filter((c) => c.op === 'D')).toEqual([]);

    // A second pass finds nothing and reuses the sentinel.
    const again = repairFkOrphans(db, 'project', h.seams);
    expect(again.orphans).toEqual([]);
  });

  it('a conflict record that cannot be written rolls the repair back (D3, T13044)', async () => {
    const db = await store();
    orphan(db, 'T2', 'task', 'T999');
    const before = taskCount(db);
    const h = seams(() => ({ state: 'unknown' }));
    const failing = {
      ...h.seams,
      recordConflict: () => {
        throw new Error('conflict store unavailable');
      },
    };
    expect(() => repairFkOrphans(settled(db), 'project', failing)).toThrow(/conflict store/);
    // Nothing landed: no re-parent, no sentinel, no repair captures.
    expect(parentOf(db, 'T2')).toBe('T999');
    expect(taskCount(db)).toBe(before);
    expect(captures(db)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM _sync_frame').get()).toEqual({ n: 0 });
  });

  it('a NOT NULL child is reported with a conflict, and left in place', async () => {
    const db = await store();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, uid, birth_fp)
       VALUES ('AC1', 'T999', 1, 'x', 'uid-AC1', 'fp-AC1')`,
    ).run();
    db.exec('PRAGMA foreign_keys = ON');
    const h = seams(() => ({ state: 'unknown' }));
    const r = repairFkOrphans(settled(db), 'project', h.seams);
    expect(r.orphans.map((o) => [o.table, o.outcome])).toEqual([
      ['tasks_task_acceptance_criteria', 'reported'],
    ]);
    expect(h.conflicts.map((c) => c.resolution)).toEqual(['report']);
    expect(
      db.prepare("SELECT task_id FROM tasks_task_acceptance_criteria WHERE id = 'AC1'").get(),
    ).toEqual({ task_id: 'T999' });
  });

  it('a different row holding the sentinel id: falls back to NULL', async () => {
    const db = await store();
    db.prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES (?, 'someone else', 'epic', 'pending', 'medium', 'uid-other', 'fp-other')`,
    ).run(FK_ORPHAN_SENTINEL_ID);
    orphan(db, 'T2', 'task', 'T999');
    const r = repairFkOrphans(db, 'project', seams(() => ({ state: 'unknown' })).seams);
    expect(r.orphans.map((o) => o.outcome)).toEqual(['nulled']);
    expect(parentOf(db, 'T2')).toBeNull();
  });

  it('two replicas needing the sentinel create the same row, with one uid', async () => {
    const a = await store('a');
    const b = await store('b');
    orphan(a, 'T2', 'task', 'T999');
    orphan(b, 'T7', 'subtask', 'T555');
    repairFkOrphans(a, 'project', seams(() => ({ state: 'unknown' })).seams);
    repairFkOrphans(b, 'project', seams(() => ({ state: 'unknown' })).seams);
    const row = (db: DatabaseSync) =>
      db.prepare('SELECT * FROM tasks_tasks WHERE id = ?').get(FK_ORPHAN_SENTINEL_ID);
    expect(row(a)).toEqual(row(b));
    expect(FK_ORPHAN_SENTINEL_UID).toBe(
      naturalRowUid('project', 'tasks_tasks', ['fk-orphan-sentinel']),
    );
  });
});
