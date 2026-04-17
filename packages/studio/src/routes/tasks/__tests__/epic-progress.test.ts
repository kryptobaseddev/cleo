/**
 * Tests for T874 — Studio dashboard `_computeEpicProgress`.
 *
 * Verifies that numerator (done) and denominator (total) both come from
 * the same basis — direct children of the epic with status != 'archived'
 * — matching `cleo list --parent <epicId>` semantics.
 *
 * Uses an in-memory `node:sqlite` database seeded with the exact shape
 * that triggered the owner's reported 5/29 inconsistency on T487.
 *
 * @task T874
 * @epic T870
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _computeEpicProgress, type EpicProgressDbLike } from '../+page.server.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

let db: DatabaseSync;

/** Minimal tasks-table schema mirroring the real one. */
const CREATE_TASKS = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT,
    parent_id TEXT,
    pipeline_stage TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

function insertTask(row: {
  id: string;
  title?: string;
  status: string;
  type?: string;
  parent_id?: string | null;
  pipeline_stage?: string | null;
}): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, type, parent_id, pipeline_stage)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title ?? `Task ${row.id}`,
    row.status,
    row.type ?? 'task',
    row.parent_id ?? null,
    row.pipeline_stage ?? null,
  );
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(CREATE_TASKS);
});

afterEach(() => {
  db.close();
});

describe('_computeEpicProgress (T874)', () => {
  it('returns empty array when there are no epics', () => {
    const result = _computeEpicProgress(db as EpicProgressDbLike);
    expect(result).toEqual([]);
  });

  it('counts direct children only (no grand-children)', () => {
    // Epic with 5 direct children (all done) and 10 grandchildren that
    // should NOT be counted. This reproduces the owner-reported T487 shape
    // where the recursive query reported 29 but direct children were 5.
    insertTask({ id: 'E1', status: 'pending', type: 'epic' });
    for (let i = 0; i < 5; i++) {
      insertTask({ id: `C${i}`, status: 'done', parent_id: 'E1' });
      // Grand-children (children of the direct child) — MUST be ignored.
      for (let j = 0; j < 2; j++) {
        insertTask({ id: `G${i}-${j}`, status: 'pending', parent_id: `C${i}` });
      }
    }

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'E1',
      total: 5, // Only direct children
      done: 5,
      active: 0,
      pending: 0,
    });
    // Sanity: numerator equals denominator when every direct child is done.
    expect(result[0].done).toBe(result[0].total);
  });

  it('excludes archived direct children from both numerator and denominator', () => {
    insertTask({ id: 'E2', status: 'pending', type: 'epic' });
    insertTask({ id: 'A1', status: 'done', parent_id: 'E2' });
    insertTask({ id: 'A2', status: 'active', parent_id: 'E2' });
    insertTask({ id: 'A3', status: 'archived', parent_id: 'E2' });
    insertTask({ id: 'A4', status: 'archived', parent_id: 'E2' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result[0]).toMatchObject({
      id: 'E2',
      total: 2, // archived excluded
      done: 1,
      active: 1,
      pending: 0,
    });
  });

  it('mixed status bucket counts sum to total', () => {
    insertTask({ id: 'E3', status: 'pending', type: 'epic' });
    insertTask({ id: 'M1', status: 'done', parent_id: 'E3' });
    insertTask({ id: 'M2', status: 'done', parent_id: 'E3' });
    insertTask({ id: 'M3', status: 'active', parent_id: 'E3' });
    insertTask({ id: 'M4', status: 'pending', parent_id: 'E3' });
    insertTask({ id: 'M5', status: 'cancelled', parent_id: 'E3' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result[0]).toMatchObject({
      id: 'E3',
      total: 5,
      done: 2,
      active: 1,
      pending: 1,
    });
    // cancelled is in total but not exposed as its own EpicProgress field.
    expect(result[0].total).toBe(5);
    expect(result[0].done + result[0].active + result[0].pending).toBeLessThanOrEqual(
      result[0].total,
    );
  });

  it('excludes archived epics from the result list', () => {
    insertTask({ id: 'E4', status: 'archived', type: 'epic' });
    insertTask({ id: 'E5', status: 'pending', type: 'epic' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result.map((r) => r.id)).toEqual(['E5']);
  });

  it('handles epic with zero children', () => {
    insertTask({ id: 'E6', status: 'pending', type: 'epic' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result[0]).toMatchObject({
      id: 'E6',
      total: 0,
      done: 0,
      active: 0,
      pending: 0,
    });
  });

  it('numerator never exceeds denominator (consistency guarantee)', () => {
    // Property check: for every returned row, done/active/pending all sum
    // to <= total. Previously the recursive descendant query could make
    // total > (sum of buckets) which is OK, but the inverse would be a
    // data-integrity bug.
    for (let e = 0; e < 5; e++) {
      insertTask({ id: `PE${e}`, status: 'pending', type: 'epic' });
      const n = e + 1;
      for (let i = 0; i < n; i++) {
        const status = i % 3 === 0 ? 'done' : i % 3 === 1 ? 'active' : 'pending';
        insertTask({ id: `PC${e}-${i}`, status, parent_id: `PE${e}` });
      }
    }

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    for (const row of result) {
      const bucketSum = row.done + row.active + row.pending;
      expect(bucketSum).toBeLessThanOrEqual(row.total);
      expect(row.total).toBeGreaterThanOrEqual(0);
    }
  });
});
