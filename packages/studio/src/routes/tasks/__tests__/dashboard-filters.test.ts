/**
 * Tests for T878 (T900) — Studio dashboard deferred/archived filter toggles.
 *
 * Verifies that `_computeEpicProgress` respects the `includeDeferred`
 * option by:
 *   (a) Excluding cancelled epics by default (matches the owner's
 *       "stop showing T513 DEFERRED LOW on the dashboard" feedback).
 *   (b) Including cancelled epics when `includeDeferred: true`.
 *   (c) Always excluding archived epics.
 *   (d) Surfacing the epic's `status` and `cancelled` bucket on every
 *       returned row so the UI can render a Deferred badge.
 *
 * @task T878
 * @epic T876 (owner-labelled T900)
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

describe('_computeEpicProgress — T878 deferred filter', () => {
  it('hides cancelled epics by default (owner-flagged T513 / T631 case)', () => {
    insertTask({ id: 'E_OK', status: 'pending', type: 'epic' });
    insertTask({ id: 'E_CANC', status: 'cancelled', type: 'epic' });
    // Archived always hidden regardless of toggle.
    insertTask({ id: 'E_ARCH', status: 'archived', type: 'epic' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result.map((r) => r.id)).toEqual(['E_OK']);
  });

  it('includes cancelled epics when includeDeferred=true', () => {
    insertTask({ id: 'E_OK', status: 'pending', type: 'epic' });
    insertTask({ id: 'E_CANC', status: 'cancelled', type: 'epic' });
    insertTask({ id: 'E_ARCH', status: 'archived', type: 'epic' });

    const result = _computeEpicProgress(db as EpicProgressDbLike, { includeDeferred: true });

    // Archived still excluded. Cancelled now shown.
    expect(result.map((r) => r.id).sort()).toEqual(['E_CANC', 'E_OK'].sort());
  });

  it('returns status on every row so the UI can render a Deferred badge', () => {
    insertTask({ id: 'E_PEND', status: 'pending', type: 'epic' });
    insertTask({ id: 'E_CANC', status: 'cancelled', type: 'epic' });

    const result = _computeEpicProgress(db as EpicProgressDbLike, { includeDeferred: true });

    const byId = Object.fromEntries(result.map((r) => [r.id, r]));
    expect(byId['E_PEND']?.status).toBe('pending');
    expect(byId['E_CANC']?.status).toBe('cancelled');
  });

  it('surfaces the cancelled bucket in child counts', () => {
    insertTask({ id: 'E_MIX', status: 'pending', type: 'epic' });
    insertTask({ id: 'C1', status: 'done', parent_id: 'E_MIX' });
    insertTask({ id: 'C2', status: 'cancelled', parent_id: 'E_MIX' });
    insertTask({ id: 'C3', status: 'cancelled', parent_id: 'E_MIX' });
    insertTask({ id: 'C4', status: 'active', parent_id: 'E_MIX' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result[0]).toMatchObject({
      id: 'E_MIX',
      total: 4,
      done: 1,
      active: 1,
      cancelled: 2,
    });
  });

  it('numerator/denominator stay consistent when cancelled children are present (no 5/29 drift)', () => {
    // Reproduces the T487-like case: all direct children accounted for,
    // including cancelled, with no mismatch between numerator and denom.
    insertTask({ id: 'E1', status: 'pending', type: 'epic' });
    for (let i = 0; i < 3; i++) insertTask({ id: `D${i}`, status: 'done', parent_id: 'E1' });
    for (let i = 0; i < 2; i++) insertTask({ id: `X${i}`, status: 'cancelled', parent_id: 'E1' });

    const result = _computeEpicProgress(db as EpicProgressDbLike);

    expect(result[0].total).toBe(5);
    expect(result[0].done + result[0].active + result[0].pending + result[0].cancelled).toBe(
      result[0].total,
    );
  });
});
