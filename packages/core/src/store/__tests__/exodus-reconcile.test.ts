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
    -- Pre-T9686-B2 release history (T12346): folded into tasks_releases.
    CREATE TABLE release_manifests (
      id TEXT PRIMARY KEY, version TEXT NOT NULL, status TEXT NOT NULL,
      tasks_json TEXT NOT NULL DEFAULT '[]', commit_sha TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO release_manifests VALUES
      ('rel-v2026-1-1', 'v2026.1.1', 'pushed', '[]', 'abc123', '2026-01-10T00:00:00Z');
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

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
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
    // release_manifests lands in the table the runtime reads, folded as T9686-B2 did.
    expect(
      scalar(liveDb, "SELECT merge_commit_sha FROM tasks_releases WHERE id='legacy:v2026.1.1'"),
    ).toBe('abc123');
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

  it('digests a NULL valid_at the way the copy fills it (verifier parity)', async () => {
    const { buildDigestExpr } = await import('../exodus/column-transforms.js');
    const expr = buildDigestExpr(
      'brain_observations',
      'valid_at',
      'TEXT',
      new Set(),
      { notnull: 1, dflt_value: "(datetime('now'))", type: 'text' },
      new Set(['valid_at', 'created_at']),
    );
    expect(expr).toBe(`COALESCE("valid_at", "created_at", (datetime('now')))`);
  });

  it('recovers rows found only in the unmigrated cleo.db bare task-core family, fresher version first', async () => {
    // Legacy tasks.db gains updated_at so versions are comparable.
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec('ALTER TABLE tasks ADD COLUMN updated_at TEXT');
    legacy.exec("UPDATE tasks SET updated_at = '2026-01-10T00:00:00Z'");
    legacy.close();
    // The live store still carries its pre-consolidation bare family: a label
    // no legacy FILE has, and a newer edit of T2.
    const live = new DatabaseSync(liveDb);
    live.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        priority TEXT NOT NULL, type TEXT, parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT);
      INSERT INTO tasks VALUES ('T2', 'renamed later', 'active', 'medium', 'task', 'T1',
        '2026-01-02T00:00:00Z', '2026-05-01T00:00:00Z');
      CREATE TABLE task_labels (task_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (task_id, label));
      INSERT INTO task_labels VALUES ('T1', 'only-in-cleo-db');
    `);
    live.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));

    expect(result.outcome).toBe('reconciled');
    expect(scalar(liveDb, "SELECT label FROM tasks_task_labels WHERE task_id='T1'")).toBe(
      'only-in-cleo-db',
    );
    expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T2'")).toBe('renamed later');
    // The bare family is untouched and a second run is a no-op.
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM task_labels')).toBe(1);
    const again = await reconcileSupersededStores(join(root, 'project'));
    expect(again.outcome).toBe('nothing-to-reconcile');
  });

  it('copies into a table whose FTS5 content-sync trigger the runtime installed', async () => {
    // proxmox/kodomeet: the runtime's brain FTS triggers write the derived index
    // on insert; the recovery authorizer used to refuse that as an untracked effect.
    const live = new DatabaseSync(liveDb);
    live.exec(`
      CREATE VIRTUAL TABLE brain_observations_fts
        USING fts5(id, title, narrative, content=brain_observations, content_rowid=rowid);
      CREATE TRIGGER brain_observations_ai AFTER INSERT ON brain_observations BEGIN
        INSERT INTO brain_observations_fts(rowid, id, title, narrative)
        VALUES (new.rowid, new.id, new.title, new.narrative);
      END;
    `);
    live.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));

    expect(result.outcome).toBe('reconciled');
    expect(
      scalar(
        liveDb,
        "SELECT COUNT(*) FROM brain_observations_fts WHERE brain_observations_fts MATCH 'dated'",
      ),
    ).toBe(1);
  });

  it('lands history where the RUNTIME reads it — proven through the runtime accessors', async () => {
    // Legacy lifecycle + audit history. The runtime binds lifecycle_* to the
    // prefixed tasks_lifecycle_* twins, but still reads audit_log BARE; a
    // reconcile that followed the consolidated map would hide the audit rows.
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec(`
      CREATE TABLE lifecycle_pipelines (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE lifecycle_stages (id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id),
        stage_name TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL, completed_at TEXT);
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL,
        task_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system', domain TEXT, operation TEXT,
        session_id TEXT, success INTEGER);
      INSERT INTO lifecycle_pipelines VALUES ('pipeline-T1', 'T1', 'active', '2026-01-01T00:00:00Z', 1);
      INSERT INTO lifecycle_stages VALUES
        ('stage-T1-research', 'pipeline-T1', 'research', 'completed', 1, '2026-01-02T00:00:00Z');
      INSERT INTO audit_log VALUES
        ('A1', '2026-01-03T00:00:00Z', 'task_created', 'T1', 'agent', 'tasks', 'add', 'S-legacy', 1);
    `);
    legacy.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));
    expect(result.outcome).toBe('reconciled');
    const target = (t: string) => result.before.find((c) => c.sourceTable === t)?.targetTable;
    expect(target('audit_log')).toBe('audit_log');
    expect(target('lifecycle_stages')).toBe('tasks_lifecycle_stages');

    // Read back through the real runtime paths, not sqlite counts.
    const { getLifecycleStatus } = await import('../../lifecycle/index.js');
    const status = await getLifecycleStatus(join(root, 'project'), { epicId: 'T1' });
    expect(status.initialized).toBe(true);
    expect(status.stages.find((s) => s.stage === 'research')?.status).toBe('completed');

    const { queryAudit } = await import('../../audit.js');
    const audit = await queryAudit({ sessionId: 'S-legacy' });
    expect(audit.map((a) => a.operation)).toEqual(['add']);
  });

  it('additive mode fills history for a live project, never touches its task graph, lists every conflict', async () => {
    // A project already running on cleo.db: its live task graph holds the
    // tasks, and a NEWER criterion occupies T2's first slot.
    const live = new DatabaseSync(liveDb);
    live.exec(`
      INSERT INTO tasks_tasks (id, title, status, priority, type, parent_id, created_at) VALUES
        ('T1', 'epic (live)', 'active', 'high', 'epic', NULL, '2026-01-01T00:00:00Z'),
        ('T2', 'task (live)', 'active', 'medium', 'task', 'T1', '2026-01-02T00:00:00Z');
      INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text, created_at)
        VALUES ('AC-live', 'T2', 1, 'text', 'rewritten after cutover', '2026-06-01T00:00:00Z');
    `);
    live.close();
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec(`
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL,
        task_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system', domain TEXT, operation TEXT,
        session_id TEXT, success INTEGER);
      INSERT INTO audit_log VALUES
        ('A1', '2026-01-03T00:00:00Z', 'task_created', 'T1', 'agent', 'tasks', 'add', 'S-legacy', 1);
    `);
    legacy.close();
    const liveBefore = (sql: string) => scalar(liveDb, sql);
    const titleBefore = liveBefore("SELECT title FROM tasks_tasks WHERE id='T1'");

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'), { additive: true });

    expect(result.outcome).toBe('reconciled');
    expect(result.mode).toBe('additive');
    // History landed where the runtime reads it …
    const { queryAudit } = await import('../../audit.js');
    expect((await queryAudit({ sessionId: 'S-legacy' })).map((a) => a.operation)).toEqual(['add']);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM brain_observations')).toBe(2);
    // … the live task graph was not written …
    expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T1'")).toBe(titleBefore);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(2);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_acceptance_criteria')).toBe(1);
    // … and every legacy row left behind is reported.
    const conflict = (t: string) => result.conflicts.find((c) => c.targetTable === t);
    expect(conflict('tasks_tasks')).toMatchObject({ rows: 3, reason: 'live-authoritative' });
    expect(conflict('tasks_task_acceptance_criteria')).toMatchObject({
      rows: 2,
      reason: 'live-authoritative',
    });
    expect(conflict('tasks_task_relations')).toMatchObject({ rows: 1 });
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
