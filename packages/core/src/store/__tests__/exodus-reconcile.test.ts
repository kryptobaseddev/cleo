/**
 * Superseded-store reconcile — the stranded-legacy-data repair (T12319).
 *
 * Measured 2026-09-24: projects ran on an EMPTY consolidated `cleo.db` while
 * their legacy `tasks.db` / `brain.db` held everything, and the copy engine
 * aborted on the shapes real legacy data has. This suite builds a small legacy
 * store containing EACH of those shapes and drives the REAL engine end to end
 * against a real consolidated `cleo.db` (real migrations, no chokepoint mocks):
 *
 *   - a `child_task` acceptance criterion whose table sorts before `tasks`
 *     (FK-order: E_CHILD_TASK_TARGET_CONTAINMENT under alphabetical copy);
 *   - a pre-T1408 `archive_reason = 'deleted'` (silently dropped by the CHECK);
 *   - a pre-T877 `done` task with no terminal `pipeline_stage` (trigger abort);
 *   - a task→task parent edge and a relation duplicating a parent edge
 *     (T10572 guards were created without a backfill — grandfathered);
 *   - brain observations with `valid_at IS NULL` (NOT NULL with a default).
 *
 * @task T12319
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Build a legacy project store carrying every shape that stranded real projects. */
function buildLegacyStore(cleoDir: string): void {
  const tasks = new DatabaseSync(join(cleoDir, 'tasks.db'));
  tasks.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium', type TEXT, parent_id TEXT REFERENCES tasks(id),
      pipeline_stage TEXT, archive_reason TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE task_acceptance_criteria (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
      target_task_id TEXT REFERENCES tasks(id), projection TEXT NOT NULL DEFAULT 'legacy'
    );
    CREATE TABLE task_relations (
      task_id TEXT NOT NULL REFERENCES tasks(id), related_to TEXT NOT NULL REFERENCES tasks(id),
      relation_type TEXT NOT NULL DEFAULT 'related', reason TEXT, PRIMARY KEY (task_id, related_to)
    );
    INSERT INTO tasks VALUES
      ('T1', 'epic',             'active',   'high',   'epic',    NULL, NULL, NULL,      '2026-01-01T00:00:00Z'),
      ('T2', 'task under epic',  'active',   'medium', 'task',    'T1', NULL, NULL,      '2026-01-02T00:00:00Z'),
      ('T3', 'task under task',  'pending',  'medium', 'task',    'T2', NULL, NULL,      '2026-01-03T00:00:00Z'),
      ('T4', 'done, no stage',   'done',     'low',    'subtask', 'T2', NULL, NULL,      '2026-01-04T00:00:00Z'),
      ('T5', 'deleted long ago', 'archived', 'low',    'task',    'T1', NULL, 'deleted', '2026-01-05T00:00:00Z');
    INSERT INTO task_acceptance_criteria VALUES
      ('AC1', 'T2', 1, 'child T4 done', '2026-01-02T00:00:00Z', 'child_task', 'T4', 'legacy'),
      ('AC2', 'T2', 2, 'plain text',    '2026-01-02T00:00:00Z', 'text',       NULL, 'legacy');
    INSERT INTO task_relations VALUES ('T2', 'T4', 'related', 'duplicates the parent edge');
  `);
  tasks.close();

  const brain = new DatabaseSync(join(cleoDir, 'brain.db'));
  brain.exec(`
    CREATE TABLE brain_observations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
      created_at TEXT NOT NULL, valid_at TEXT
    );
    INSERT INTO brain_observations VALUES
      ('O1', 'discovery', 'old memory, no valid_at', '2026-02-01 10:00:00', NULL),
      ('O2', 'discovery', 'dated memory',            '2026-02-02 10:00:00', '2026-02-02 10:00:00');
  `);
  brain.close();
}

/** Read-only scalar query against a DB file. */
function scalar(dbPath: string, sql: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

/** Content hash of a file — proves the legacy inputs are never modified. */
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('reconcileSupersededStores (T12319)', () => {
  let root: string;
  let cleoDir: string;
  let liveDb: string;
  const savedHome = process.env.CLEO_HOME;
  const savedDir = process.env.CLEO_DIR;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-t12319-'));
    cleoDir = join(root, 'project', '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    process.env.CLEO_HOME = join(root, 'cleo-home');
    // vitest.setup pins CLEO_DIR to a sandbox project; point it at this one.
    process.env.CLEO_DIR = cleoDir;
    buildLegacyStore(cleoDir);
    liveDb = join(cleoDir, 'cleo.db');
    // The stranded state: a migrated-but-empty consolidated store.
    const { openDualScopeDbAtPath } = await import('../dual-scope-db.js');
    (await openDualScopeDbAtPath('project', liveDb, undefined, { dedicated: true })).close();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = savedHome;
    if (savedDir === undefined) delete process.env.CLEO_DIR;
    else process.env.CLEO_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('orders parents before children by the SOURCE foreign keys', async () => {
    const { orderTablesForCopy } = await import('../exodus/migrate.js');
    const db = new DatabaseSync(join(cleoDir, 'tasks.db'), { readOnly: true });
    try {
      const order = orderTablesForCopy(db);
      expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('task_acceptance_criteria'));
      expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('task_relations'));
    } finally {
      db.close();
    }
  });

  it('dry-run reports the missing rows and writes nothing', async () => {
    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'), { dryRun: true });

    expect(result.outcome).toBe('planned');
    expect(result.before.find((t) => t.targetTable === 'tasks_tasks')?.missingInLive).toBe(5);
    expect(result.receiptPath).toBeNull();
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(0);
    expect(readdirSync(cleoDir).some((n) => n.startsWith('exodus-'))).toBe(false);
  });

  it('copies every legacy row, verifies by key, keeps legacy files, and is idempotent', async () => {
    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const legacy = ['tasks.db', 'brain.db'].map((f) => join(cleoDir, f));
    const before = legacy.map(digest);

    const result = await reconcileSupersededStores(join(root, 'project'));

    expect(result.outcome).toBe('reconciled');
    expect(result.after.every((t) => t.missingInLive === 0)).toBe(true);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(5);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_acceptance_criteria')).toBe(2);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_relations')).toBe(1);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM brain_observations')).toBe(2);
    // Normalizations mirror the legacy backfills (T1408, T877) and never stamp
    // migration time onto history.
    expect(scalar(liveDb, "SELECT archive_reason FROM tasks_tasks WHERE id='T5'")).toBe(
      'completed-unverified',
    );
    expect(scalar(liveDb, "SELECT pipeline_stage FROM tasks_tasks WHERE id='T4'")).toBe(
      'contribution',
    );
    expect(scalar(liveDb, "SELECT valid_at FROM brain_observations WHERE id='O1'")).toBe(
      '2026-02-01 10:00:00',
    );
    // The grandfathered guards are back in force after the copy.
    expect(
      scalar(
        liveDb,
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN " +
          "('tasks_tasks_parent_type_matrix_insert','tasks_task_relations_non_containment_insert'," +
          "'tasks_task_acceptance_child_target_insert')",
      ),
    ).toBe(3);
    // Legacy inputs are byte-identical; a receipt records before/after.
    expect(legacy.map(digest)).toEqual(before);
    expect(result.receiptPath).not.toBeNull();
    const receipt = JSON.parse(readFileSync(result.receiptPath ?? '', 'utf8')) as {
      outcome: string;
      before: unknown[];
      after: unknown[];
    };
    expect(receipt.outcome).toBe('reconciled');
    expect(receipt.after.length).toBe(receipt.before.length);

    const stagingDirs = readdirSync(cleoDir).filter((n) => n.startsWith('exodus-'));
    const again = await reconcileSupersededStores(join(root, 'project'));
    expect(again.outcome).toBe('nothing-to-reconcile');
    expect(again.rowsCopied).toBe(0);
    expect(readdirSync(cleoDir).filter((n) => n.startsWith('exodus-'))).toEqual(stagingDirs);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(5);
  });

  it('never overwrites a row already in cleo.db', async () => {
    const live = new DatabaseSync(liveDb);
    live
      .prepare(
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T1', 'written since', 'active', 'high', 'epic', '2026-09-01T00:00:00Z')",
      )
      .run();
    live.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));

    expect(result.outcome).toBe('reconciled');
    expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T1'")).toBe('written since');
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(5);
    expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(true);
  });
});
