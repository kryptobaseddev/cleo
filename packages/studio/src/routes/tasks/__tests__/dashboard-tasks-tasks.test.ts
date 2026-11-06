/**
 * The /tasks dashboard reads the consolidated `tasks_tasks` table, not the
 * empty legacy `tasks` decoy, and counts `active` from the live claim lease
 * (T14330, T14268).
 *
 * The fixture holds both tables, as a live `cleo.db` does: `tasks_tasks`
 * carries the rows, bare `tasks` is empty. The dashboard stats, the epic
 * progress fallback and the explorer bundle must report the former.
 *
 * @task T14330
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '$lib/server/project-context.js';
import { loadExplorerBundle } from '$lib/server/tasks/explorer-loader.js';
import { _computeDashboardStats, _computeEpicProgress } from '../+page.server.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

let db: DatabaseSync;
let dir: string;
let ctx: ProjectContext;

const SCHEMA = `
  CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, type TEXT);
  CREATE TABLE tasks_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_by_session TEXT,
    lease_expires_at TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT,
    parent_id TEXT,
    phase TEXT,
    size TEXT,
    position INTEGER,
    position_version INTEGER DEFAULT 0,
    labels_json TEXT DEFAULT '[]',
    notes_json TEXT DEFAULT '[]',
    acceptance_json TEXT DEFAULT '[]',
    files_json TEXT DEFAULT '[]',
    origin TEXT,
    blocked_by TEXT,
    epic_lifecycle TEXT,
    no_auto_complete INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    verification_json TEXT,
    created_by TEXT,
    modified_by TEXT,
    session_id TEXT,
    pipeline_stage TEXT,
    assignee TEXT
  );
  CREATE TABLE tasks_task_dependencies (task_id TEXT NOT NULL, depends_on TEXT NOT NULL);
`;

function seed(
  id: string,
  status: string,
  extra: { type?: string; parent?: string; lease?: string; stage?: string } = {},
): void {
  db.prepare(
    `INSERT INTO tasks_tasks (id, title, status, type, parent_id, claimed_by_session, lease_expires_at, pipeline_stage, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `Task ${id}`,
    status,
    extra.type ?? 'task',
    extra.parent ?? null,
    extra.lease ? 'ses_20261106000000_aaaaaa' : null,
    extra.lease ?? null,
    extra.stage ?? null,
    '2026-11-06T00:00:00.000Z',
  );
}

describe('/tasks dashboard reads tasks_tasks (T14330)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-t14330-'));
    const dbPath = join(dir, 'cleo.db');
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    ctx = {
      projectId: 'p-t14330',
      name: 't14330',
      projectPath: dir,
      brainDbPath: dbPath,
      tasksDbPath: dbPath,
      brainDbExists: true,
      tasksDbExists: true,
    };
    seed('T001', 'pending', { type: 'epic' });
    // Stored pending with a live lease: reads active.
    seed('T002', 'pending', { parent: 'T001', lease: '2999-01-01T00:00:00.000Z' });
    // An older build's stored active whose lease lapsed: reads pending.
    seed('T003', 'active', { parent: 'T001', lease: '2000-01-01T00:00:00.000Z' });
    seed('T004', 'done', { parent: 'T001', stage: 'contribution' });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports non-zero counts, with active derived from the lease', async () => {
    expect(_computeDashboardStats(db)).toMatchObject({
      total: 4,
      active: 1,
      pending: 2,
      done: 1,
      epics: 1,
    });
    expect(_computeEpicProgress(db)).toEqual([
      expect.objectContaining({ id: 'T001', total: 3, active: 1, pending: 1, done: 1 }),
    ]);
    const bundle = await loadExplorerBundle({ projectCtx: ctx });
    expect(bundle.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T001', 'pending'],
      ['T002', 'active'],
      ['T003', 'pending'],
      ['T004', 'done'],
    ]);
  });
});
