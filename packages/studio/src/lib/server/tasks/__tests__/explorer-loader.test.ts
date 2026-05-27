/**
 * Tests for T952 — shared Task Explorer data loader.
 *
 * Seeds a real tasks.db fixture (on-disk temp file) matching the production
 * schema, then asserts {@link loadExplorerBundle} returns the expected
 * nodes, edges, epic-progress rollups, labels, and caps.
 *
 * Uses `node:sqlite` directly for seeding so the test exercises the exact
 * same driver the loader uses in production (no mocks, no Drizzle).
 *
 * @task T952
 * @epic T949
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '../../project-context.js';
import {
  _collectDistinctLabels,
  _computeEpicProgressRollup,
  loadExplorerBundle,
} from '../explorer-loader.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal production-shaped schema for tasks + task_dependencies.
 *
 * Covers every column the loader reads, plus the T877 status/pipeline_stage
 * triggers so the fixture rejects obviously-malformed inserts the same way
 * the real DB does. Excludes indexes / FKs that aren't germane to the test.
 */
const CREATE_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
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
    archived_at TEXT,
    archive_reason TEXT,
    cycle_time_days INTEGER,
    verification_json TEXT,
    created_by TEXT,
    modified_by TEXT,
    session_id TEXT,
    pipeline_stage TEXT,
    assignee TEXT,
    ivtr_state TEXT,
    role TEXT NOT NULL DEFAULT 'work',
    scope TEXT NOT NULL DEFAULT 'feature',
    severity TEXT
  );

  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

interface SeedTask {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  parentId?: string | null;
  pipelineStage?: string | null;
  labels?: string[];
}

/** Minimal insert helper honouring the T877 pipeline_stage invariant. */
function insertTask(db: DatabaseSync, t: SeedTask): void {
  const status = t.status ?? 'pending';
  let pipelineStage = t.pipelineStage ?? null;
  if (pipelineStage === null) {
    if (status === 'done') pipelineStage = 'contribution';
    else if (status === 'cancelled') pipelineStage = 'cancelled';
  }
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, status, priority, type, parent_id,
        pipeline_stage, labels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.title ?? `Task ${t.id}`,
    t.description ?? `desc for ${t.id}`,
    status,
    t.priority ?? 'medium',
    t.type ?? 'task',
    t.parentId ?? null,
    pipelineStage,
    JSON.stringify(t.labels ?? []),
  );
}

function insertDep(db: DatabaseSync, taskId: string, dependsOn: string): void {
  db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(
    taskId,
    dependsOn,
  );
}

/**
 * Build a fixture project context pointing at a fresh on-disk tasks.db in a
 * tmp directory. Caller is responsible for cleaning the returned `tmpDir`.
 */
function seedFixture(seed: (db: DatabaseSync) => void): {
  ctx: ProjectContext;
  tmpDir: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cleo-explorer-loader-'));
  const tasksDbPath = join(tmpDir, 'tasks.db');
  const brainDbPath = join(tmpDir, 'brain.db');

  const db = new DatabaseSync(tasksDbPath, { open: true });
  try {
    db.exec(CREATE_SCHEMA);
    seed(db);
  } finally {
    db.close();
  }

  const ctx: ProjectContext = {
    projectId: 'test',
    name: 'explorer-loader-fixture',
    projectPath: tmpDir,
    brainDbPath,
    tasksDbPath,
    brainDbExists: false,
    tasksDbExists: true,
  };
  return { ctx, tmpDir };
}

// ---------------------------------------------------------------------------
// Seed shapes used across multiple tests
// ---------------------------------------------------------------------------

/**
 * Canonical fixture: 2 epics + 12 tasks + 3 deps + mixed statuses + labels.
 * Designed to exercise every rollup bucket and label aggregation.
 */
function standardSeed(db: DatabaseSync): void {
  // Epic E1 with 5 direct children (2 done, 1 cancelled, 1 active, 1 pending)
  insertTask(db, { id: 'E1', type: 'epic', status: 'active', labels: ['core', 'backend'] });
  insertTask(db, { id: 'T1', parentId: 'E1', status: 'done', labels: ['backend'] });
  insertTask(db, { id: 'T2', parentId: 'E1', status: 'done', labels: ['backend'] });
  insertTask(db, { id: 'T3', parentId: 'E1', status: 'cancelled', labels: ['backend'] });
  insertTask(db, { id: 'T4', parentId: 'E1', status: 'active', labels: ['core', 'urgent'] });
  insertTask(db, { id: 'T5', parentId: 'E1', status: 'pending', labels: ['core'] });

  // Epic E2 with 3 direct children (all pending); archived child MUST be
  // excluded from progress rollup when includeArchived=false.
  insertTask(db, { id: 'E2', type: 'epic', status: 'pending', labels: ['frontend'] });
  insertTask(db, { id: 'T6', parentId: 'E2', status: 'pending', labels: ['frontend'] });
  insertTask(db, { id: 'T7', parentId: 'E2', status: 'pending', labels: [] });
  insertTask(db, { id: 'T8', parentId: 'E2', status: 'pending' });
  insertTask(db, { id: 'T9', parentId: 'E2', status: 'archived' });

  // Orphan task (no parent, no type=epic) to verify unparented handling
  insertTask(db, { id: 'T10', status: 'pending', labels: ['misc'] });

  // Grand-child under T1 — MUST NOT count toward E1's progress (T874).
  insertTask(db, { id: 'G1', parentId: 'T1', status: 'pending' });

  // Dependency edges: T4 depends on T1; T5 depends on T4; T6 depends on T9
  // (archived target — gets filtered out when includeArchived=false).
  insertDep(db, 'T4', 'T1');
  insertDep(db, 'T5', 'T4');
  insertDep(db, 'T6', 'T9');
}

describe('loadExplorerBundle (T952)', () => {
  let cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup) {
      try {
        fn();
      } catch {
        // ignore cleanup failures
      }
    }
    cleanup = [];
  });

  it('loads tasks and deps correctly against an on-disk fixture', async () => {
    const { ctx, tmpDir } = seedFixture(standardSeed);
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const bundle = await loadExplorerBundle({ projectCtx: ctx });

    // 12 non-archived tasks (11 rows + grand-child G1, excluding T9 archived)
    const ids = bundle.tasks.map((t) => t.id).sort();
    expect(ids).toEqual(['E1', 'E2', 'G1', 'T1', 'T10', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);

    // Deps filtered to endpoints within the loaded set — T6->T9 is dropped
    // because T9 is archived.
    expect(bundle.deps).toEqual(
      expect.arrayContaining([
        { taskId: 'T4', dependsOn: 'T1' },
        { taskId: 'T5', dependsOn: 'T4' },
      ]),
    );
    expect(bundle.deps).toHaveLength(2);

    // CamelCase projection landed
    const t4 = bundle.tasks.find((t) => t.id === 'T4');
    expect(t4?.parentId).toBe('E1');
    expect(t4?.labels).toEqual(['core', 'urgent']);
  });

  it('epic progress rollup is accurate (direct-children semantics, T874)', async () => {
    const { ctx, tmpDir } = seedFixture(standardSeed);
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const bundle = await loadExplorerBundle({ projectCtx: ctx });

    // E1: 5 direct children (T1 done, T2 done, T3 cancelled, T4 active,
    //     T5 pending). Grand-child G1 MUST NOT be counted.
    expect(bundle.epicProgress['E1']).toEqual({
      total: 5,
      done: 2,
      cancelled: 1,
      active: 1,
    });

    // E2: 3 direct children (T6/T7/T8 all pending); T9 archived excluded
    // at the SQL layer.
    expect(bundle.epicProgress['E2']).toEqual({
      total: 3,
      done: 0,
      cancelled: 0,
      active: 0,
    });

    // Non-epic rows (T1, T10, etc.) are NOT included in epicProgress.
    expect(bundle.epicProgress['T1']).toBeUndefined();
    expect(bundle.epicProgress['T10']).toBeUndefined();
  });

  it('labels aggregation deduplicates and sorts', async () => {
    const { ctx, tmpDir } = seedFixture(standardSeed);
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const bundle = await loadExplorerBundle({ projectCtx: ctx });

    // Seeded labels: core, backend, urgent, frontend, misc (others are []).
    expect(bundle.labels).toEqual(['backend', 'core', 'frontend', 'misc', 'urgent']);

    // No duplicates — each label appears exactly once.
    const unique = new Set(bundle.labels);
    expect(unique.size).toBe(bundle.labels.length);
  });

  it('limit parameter caps output', async () => {
    const { ctx, tmpDir } = seedFixture((db) => {
      // Insert 15 standalone tasks
      for (let i = 0; i < 15; i++) {
        insertTask(db, { id: `T${i.toString().padStart(3, '0')}`, status: 'pending' });
      }
    });
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const bundle = await loadExplorerBundle({ projectCtx: ctx, limit: 5 });

    expect(bundle.tasks).toHaveLength(5);
    // ORDER BY id ASC makes this deterministic
    expect(bundle.tasks.map((t) => t.id)).toEqual(['T000', 'T001', 'T002', 'T003', 'T004']);
  });

  it('includeArchived flag toggles archived tasks in/out', async () => {
    const { ctx, tmpDir } = seedFixture((db) => {
      insertTask(db, { id: 'E1', type: 'epic', status: 'active' });
      insertTask(db, { id: 'T1', parentId: 'E1', status: 'done' });
      insertTask(db, { id: 'T2', parentId: 'E1', status: 'archived' });
      insertDep(db, 'T1', 'T2');
    });
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const defaultBundle = await loadExplorerBundle({ projectCtx: ctx });
    expect(defaultBundle.tasks.map((t) => t.id).sort()).toEqual(['E1', 'T1']);
    // T1->T2 edge dropped because T2 is filtered out.
    expect(defaultBundle.deps).toEqual([]);

    const withArchivedBundle = await loadExplorerBundle({
      projectCtx: ctx,
      includeArchived: true,
    });
    expect(withArchivedBundle.tasks.map((t) => t.id).sort()).toEqual(['E1', 'T1', 'T2']);
    expect(withArchivedBundle.deps).toEqual([{ taskId: 'T1', dependsOn: 'T2' }]);
  });

  it('loadedAt is set to a valid current ISO timestamp', async () => {
    const { ctx, tmpDir } = seedFixture((db) => {
      insertTask(db, { id: 'T1', status: 'pending' });
    });
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const before = Date.now();
    const bundle = await loadExplorerBundle({ projectCtx: ctx });
    const after = Date.now();

    // ISO 8601 shape (z-terminated)
    expect(bundle.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const parsed = Date.parse(bundle.loadedAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('returns empty bundle when tasks.db does not exist', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cleo-explorer-loader-empty-'));
    cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const ctx: ProjectContext = {
      projectId: 'missing',
      name: 'missing',
      projectPath: tmpDir,
      brainDbPath: join(tmpDir, 'brain.db'),
      tasksDbPath: join(tmpDir, 'tasks.db'),
      brainDbExists: false,
      tasksDbExists: false,
    };

    const bundle = await loadExplorerBundle({ projectCtx: ctx });
    expect(bundle.tasks).toEqual([]);
    expect(bundle.deps).toEqual([]);
    expect(bundle.epicProgress).toEqual({});
    expect(bundle.labels).toEqual([]);
    expect(bundle.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('_computeEpicProgressRollup (T952)', () => {
  it('returns empty object for empty task list', () => {
    expect(_computeEpicProgressRollup([])).toEqual({});
  });

  it('ignores tasks that are not epics', () => {
    const tasks = [
      {
        id: 'T1',
        title: 't1',
        description: 'd',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: 'now',
      },
    ] as Parameters<typeof _computeEpicProgressRollup>[0];
    expect(_computeEpicProgressRollup(tasks)).toEqual({});
  });

  it('reports zero-child epics with total=0', () => {
    const tasks = [
      {
        id: 'E1',
        title: 'e1',
        description: 'd',
        status: 'pending',
        priority: 'medium',
        type: 'epic',
        createdAt: 'now',
      },
    ] as Parameters<typeof _computeEpicProgressRollup>[0];
    expect(_computeEpicProgressRollup(tasks)).toEqual({
      E1: { total: 0, done: 0, cancelled: 0, active: 0 },
    });
  });
});

describe('_collectDistinctLabels (T952)', () => {
  it('returns empty array when no labels present', () => {
    const tasks = [
      {
        id: 'T1',
        title: 't1',
        description: 'd',
        status: 'pending',
        priority: 'medium',
        createdAt: 'now',
      },
    ] as Parameters<typeof _collectDistinctLabels>[0];
    expect(_collectDistinctLabels(tasks)).toEqual([]);
  });

  it('deduplicates across tasks and filters out empty strings', () => {
    const tasks = [
      { id: 'T1', labels: ['a', 'b', ''] },
      { id: 'T2', labels: ['b', 'c'] },
      { id: 'T3', labels: ['a'] },
    ] as unknown as Parameters<typeof _collectDistinctLabels>[0];
    expect(_collectDistinctLabels(tasks)).toEqual(['a', 'b', 'c']);
  });
});
