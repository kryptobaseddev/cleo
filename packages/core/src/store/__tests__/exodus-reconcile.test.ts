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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

/**
 * Simulates a concurrent `cleo add` between the remap's id allocation and the
 * copy (review LOW-1): when set, the first remap's new id is taken in the live
 * store right after the remap is planned.
 */
const { takeRemappedId } = vi.hoisted(() => ({ takeRemappedId: { on: false } }));
vi.mock('../exodus/task-id-remap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exodus/task-id-remap.js')>();
  return {
    ...actual,
    remapCollidingTaskIds: (
      ...args: Parameters<typeof actual.remapCollidingTaskIds>
    ): ReturnType<typeof actual.remapCollidingTaskIds> => {
      const result = actual.remapCollidingTaskIds(...args);
      const first = result.remaps[0];
      if (takeRemappedId.on && first) {
        takeRemappedId.on = false;
        const live = new DatabaseSync(args[0]);
        live
          .prepare(
            "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES (?, 'raced', 'pending', 'medium', 'saga', '2026-10-04T00:00:00Z')",
          )
          .run(first.newId);
        live.close();
      }
      return result;
    },
  };
});

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
    -- A legacy dependency cycle (T12886): the guard trigger postdates it.
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, depends_on)
    );
    INSERT INTO task_dependencies VALUES ('T2', 'T3'), ('T3', 'T2');
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

/**
 * Every case runs with the exodus-on-open kill switch BOTH set and unset,
 * explicitly: a developer machine that exports CLEO_DISABLE_EXODUS_ON_OPEN
 * (the owner's did) must not mask what CI — where it is unset — does (T12355).
 */
const KILL_SWITCH_MODES = [
  ['unset', undefined],
  ['set', '1'],
] as const;

describe.each(
  KILL_SWITCH_MODES,
)('reconcileSupersededStores (T12319) — CLEO_DISABLE_EXODUS_ON_OPEN %s', (_mode, killSwitch) => {
  const savedKillSwitch = process.env.CLEO_DISABLE_EXODUS_ON_OPEN;

  let root: string;
  let cleoDir: string;
  let liveDb: string;
  const savedHome = process.env.CLEO_HOME;
  const savedDir = process.env.CLEO_DIR;

  beforeEach(async () => {
    if (killSwitch === undefined) delete process.env.CLEO_DISABLE_EXODUS_ON_OPEN;
    else process.env.CLEO_DISABLE_EXODUS_ON_OPEN = killSwitch;
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
    takeRemappedId.on = false;
    if (savedKillSwitch === undefined) delete process.env.CLEO_DISABLE_EXODUS_ON_OPEN;
    else process.env.CLEO_DISABLE_EXODUS_ON_OPEN = savedKillSwitch;
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
    // The legacy dependency cycle is copied verbatim (T12886).
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_dependencies')).toBe(2);
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
          "'tasks_task_acceptance_child_target_insert','tasks_task_dependencies_cycle_guard_insert')",
      ),
    ).toBe(4);
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

  it('a reconciled store whose twin rows are deleted later is not refused by sync (T13319)', async () => {
    // A full strand in the live store's own bare family.
    const live = new DatabaseSync(liveDb);
    live.exec(`
      DROP TABLE IF EXISTS task_labels;
      CREATE TABLE task_labels (task_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (task_id, label));
      INSERT INTO task_labels VALUES ('T1', 'bare-label');
      DROP TABLE IF EXISTS task_dependencies;
      CREATE TABLE task_dependencies (task_id TEXT NOT NULL, depends_on TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on));
      INSERT INTO task_dependencies VALUES ('T4', 'T1');
    `);
    live.close();
    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));
    expect(result.outcome, result.reason).toBe('reconciled');
    expect(result.accounted?.map((a) => a.table)).toEqual(
      expect.arrayContaining(['task_labels', 'task_dependencies']),
    );

    // Normal use then removes a carried dependency and the carried label.
    const after = new DatabaseSync(liveDb);
    after.exec(
      "DELETE FROM tasks_task_dependencies; DELETE FROM tasks_task_labels WHERE label = 'bare-label'",
    );
    after.close();

    const { legacyStrands, setSyncFlag } = await import('../sync/flags.js');
    const { sealPending } = await import('../sync/sealer.js');
    const db = new DatabaseSync(liveDb);
    try {
      expect(legacyStrands(db)).toEqual([]);
      expect(() => setSyncFlag(db, 'sync.seal', true, { allowUnreleased: true })).not.toThrow();
      const sealed = sealPending(db, {
        scope: 'project',
        replica: '01929a3e-7f00-7000-8000-000000000001',
        env: {},
        allowUnreleased: true,
      });
      expect(sealed.refused ?? '').not.toMatch(/legacy-only/);
      // The record lives in the store, not in the receipt beside it.
      rmSync(result.stagingDir ?? '', { recursive: true, force: true });
      expect(legacyStrands(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a restored pre-reconcile snapshot is refused again: the record travels with the store (T13320)', async () => {
    const live = new DatabaseSync(liveDb);
    live.exec(`
      DROP TABLE IF EXISTS task_labels;
      CREATE TABLE task_labels (task_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (task_id, label));
      INSERT INTO task_labels VALUES ('T1', 'bare-label');
    `);
    const snapshot = join(root, 'pre-reconcile.db');
    live.exec(`VACUUM INTO '${snapshot}'`);
    live.close();
    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));
    expect(result.outcome, result.reason).toBe('reconciled');

    // Restore the snapshot taken before the reconcile; its receipt stays in .cleo.
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    const { _resetDualScopeDbCache } = await import('../dual-scope-db.js');
    _resetDualScopeDbCache();
    for (const side of ['-wal', '-shm']) rmSync(`${liveDb}${side}`, { force: true });
    copyFileSync(snapshot, liveDb);

    const { legacyStrands, setSyncFlag, LegacyOnlyStoreError } = await import('../sync/flags.js');
    const db = new DatabaseSync(liveDb);
    try {
      expect(legacyStrands(db).length).toBeGreaterThan(0);
      expect(() => setSyncFlag(db, 'sync.seal', true, { allowUnreleased: true })).toThrow(
        LegacyOnlyStoreError,
      );
    } finally {
      db.close();
    }
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

  it('additive mode fills legacy token rows into tasks_token_usage, the table the runtime reads (T13111)', async () => {
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec(`
      CREATE TABLE token_usage (id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'unknown', transport TEXT NOT NULL DEFAULT 'unknown',
        gateway TEXT, domain TEXT, operation TEXT, session_id TEXT, total_tokens INTEGER NOT NULL DEFAULT 0,
        method TEXT NOT NULL DEFAULT 'heuristic', confidence TEXT NOT NULL DEFAULT 'coarse',
        metadata_json TEXT NOT NULL DEFAULT '{}');
      INSERT INTO token_usage (id, created_at, transport, gateway, domain, operation, session_id, total_tokens)
        VALUES ('TU-legacy', '2026-01-03 00:00:00', 'cli', 'mutate', 'tasks', 'add', 'S-legacy', 42);
    `);
    legacy.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'), { additive: true });

    expect(result.outcome).toBe('reconciled');
    // Append-only history: filled in, never a live-authoritative conflict.
    expect(result.conflicts.find((c) => c.targetTable === 'tasks_token_usage')).toBeUndefined();
    const { listTokenUsage } = await import('../../metrics/token-service.js');
    const listed = await listTokenUsage(join(root, 'project'), { sessionId: 'S-legacy' });
    expect(listed.records.map((r) => [r.id, r.totalTokens])).toEqual([['TU-legacy', 42]]);
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM token_usage')).toBe(0);
  });

  it.skipIf(killSwitch !== undefined)(
    'converges with exodus-on-open whichever runs first (on-open first → reconcile has nothing to do)',
    async () => {
      const { openDualScopeDb, _resetDualScopeDbCache } = await import('../dual-scope-db.js');
      // An ARMED open with the kill switch unset migrates and archives the legacy files.
      await openDualScopeDb('project', join(root, 'project'));
      _resetDualScopeDbCache('project');
      expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(false);
      const counts = {
        tasks: scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks'),
        criteria: scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_acceptance_criteria'),
        observations: scalar(liveDb, 'SELECT COUNT(*) FROM brain_observations'),
        releases: scalar(liveDb, 'SELECT COUNT(*) FROM tasks_releases'),
      };
      // The same placement a reconcile-first run produces (see the tests above).
      expect(counts).toEqual({ tasks: 5, criteria: 2, observations: 2, releases: 1 });

      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));
      expect(result.outcome).toBe('nothing-to-reconcile');
    },
  );

  it.skipIf(killSwitch !== undefined)(
    'converges with exodus-on-open whichever runs first (reconcile first → on-open skips)',
    async () => {
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      expect((await reconcileSupersededStores(join(root, 'project'))).outcome).toBe('reconciled');
      const { openDualScopeDb, _resetDualScopeDbCache } = await import('../dual-scope-db.js');
      await openDualScopeDb('project', join(root, 'project'));
      _resetDualScopeDbCache('project');
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(5);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_releases')).toBe(1);
      // on-open found a populated store and left the legacy files in place.
      expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(true);
    },
  );

  it('suppresses exodus-on-open for the store being reconciled, and only that store', async () => {
    const { withExodusOnOpenSuppressed, maybeRunExodusOnOpen } = await import(
      '../exodus/on-open.js'
    );
    const live = new DatabaseSync(liveDb);
    try {
      const inside = await withExodusOnOpenSuppressed(liveDb, () =>
        maybeRunExodusOnOpen('project', liveDb, live, join(root, 'project')),
      );
      expect(inside.outcome).toBe('skipped');
      expect(inside.reason).toMatch(/reconcile of this store is in progress/);
    } finally {
      live.close();
    }
  });

  it('verifies live rows unchanged even when the run WIDENS a target table (claude-todo regression)', async () => {
    // The live store carries its bare family at the INITIAL lineage schema with
    // a high-water journal (initial + a late migration) — the claude-todo shape.
    // The reconcile's tasks-domain step then migrates that family forward,
    // adding `idempotency_key` to the bare `audit_log` — which is also a copy
    // target (the runtime reads it bare). The
    // unchanged-row proof used `SELECT * … EXCEPT SELECT *` and died with
    // "SELECTs to the left and right of EXCEPT do not have the same number of
    // result columns" after the data had landed.
    const { resolveMigrationsFolder } = await import('../sqlite.js');
    const migrations = readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() });
    const initial = migrations[0];
    const late = migrations.find((m) => m.name?.includes('t10277-saga-tasktype'));
    if (initial === undefined || late === undefined) throw new Error('fixture migrations missing');
    const live = new DatabaseSync(liveDb);
    for (const stmt of initial.sql) if (stmt.trim()) live.exec(stmt);
    live.exec(
      "INSERT INTO audit_log (id, timestamp, action, task_id, actor) VALUES ('A-live', '2026-03-01T00:00:00Z', 'task_created', 'T1', 'agent')",
    );
    const journal = live.prepare(
      'INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES (?, ?, ?)',
    );
    journal.run(initial.hash, initial.folderMillis, initial.name ?? null);
    journal.run(late.hash, late.folderMillis, late.name ?? null);
    const colsBefore = (
      live.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('audit_log')").get() as {
        n: number;
      }
    ).n;
    live.close();
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec(`
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL,
        task_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system');
      INSERT INTO audit_log VALUES ('A-legacy', '2026-02-01T00:00:00Z', 'task_updated', 'T2', 'agent');
    `);
    legacy.close();

    const { reconcileSupersededStores } = await import('../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));

    expect(result.reason).not.toMatch(/EXCEPT|verification failed|changed in/);
    expect(result.outcome).toBe('reconciled');
    // The table really was widened, the pre-existing row survived it, and the
    // legacy row landed where the runtime reads it.
    expect(scalar(liveDb, "SELECT COUNT(*) FROM pragma_table_info('audit_log')")).toBeGreaterThan(
      colsBefore,
    );
    expect(scalar(liveDb, "SELECT action FROM audit_log WHERE id='A-live'")).toBe('task_created');
    expect(scalar(liveDb, "SELECT action FROM audit_log WHERE id='A-legacy'")).toBe('task_updated');
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
    // T13172: the legacy T1 is recovered under a new id, never dropped, and
    // its children follow it instead of attaching to the live T1.
    expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(6);
    expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T006'")).toBe('epic');
    expect(scalar(liveDb, "SELECT parent_id FROM tasks_tasks WHERE id='T2'")).toBe('T006');
    expect(result.remaps.map((r) => `${r.legacyId}->${r.newId}`)).toEqual(['T1->T006']);
    expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(true);
  });

  describe('scenario B review fixes (T13172)', () => {
    /** Replace the legacy tasks.db with `sql`, and write `liveSql` into the live store. */
    function stage(sql: string, liveSql: string): void {
      rmSync(join(cleoDir, 'tasks.db'), { force: true });
      const tasks = new DatabaseSync(join(cleoDir, 'tasks.db'));
      tasks.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL DEFAULT 'medium', type TEXT, parent_id TEXT REFERENCES tasks(id),
          pipeline_stage TEXT, archive_reason TEXT, created_at TEXT NOT NULL
        );
        ${sql}
      `);
      tasks.close();
      const live = new DatabaseSync(liveDb);
      live.exec(liveSql);
      live.close();
    }
    const POST_DEFERRAL_T001 =
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T001', 'Written after deferral', 'pending', 'medium', 'saga', '2026-10-03T00:00:00Z');";

    it('re-derives task-derived criterion ids and rewrites session JSON refs (review HIGH)', async () => {
      const { buildAcRowId } = await import('../../tasks/ac-table.js');
      const legacyAc = buildAcRowId('T001', 'tests pass');
      stage(
        `CREATE TABLE task_acceptance_criteria (
           id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
           text TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
           target_task_id TEXT REFERENCES tasks(id), projection TEXT NOT NULL DEFAULT 'legacy'
         );
         CREATE TABLE sessions (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ended',
           scope_json TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL,
           tasks_completed_json TEXT
         );
         INSERT INTO tasks VALUES
           ('T001', 'legacy epic', 'done', 'high', 'epic', NULL, 'contribution', NULL, '2026-01-01T00:00:00Z');
         INSERT INTO task_acceptance_criteria VALUES
           ('${legacyAc}', 'T001', 1, 'tests pass', '2026-01-01T00:00:00Z', 'text', NULL, 'legacy');
         INSERT INTO sessions VALUES
           ('ses_legacy', 'legacy session', 'ended', '{"type":"global"}', '2026-01-01T00:00:00Z', '["T001"]');`,
        `${POST_DEFERRAL_T001}
         INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, created_at, kind)
           VALUES ('${legacyAc}', 'T001', 1, 'tests pass', '2026-10-03T00:00:00Z', 'text');`,
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('reconciled');
      expect(result.remaps.map((r) => `${r.legacyId}->${r.newId}`)).toEqual(['T001->T002']);
      expect(
        scalar(liveDb, "SELECT id FROM tasks_task_acceptance_criteria WHERE task_id = 'T002'"),
      ).toBe(buildAcRowId('T002', 'tests pass'));
      expect(
        scalar(
          liveDb,
          "SELECT COUNT(*) FROM tasks_task_acceptance_criteria WHERE task_id = 'T001'",
        ),
      ).toBe(1);
      expect(
        scalar(liveDb, "SELECT tasks_completed_json FROM tasks_sessions WHERE id = 'ses_legacy'"),
      ).toBe('["T002"]');
      expect(result.reason).toContain('free text');
    });

    it('pairs legacy twins with distinct recovered tasks and never reuses a legacy id (review MED-1)', async () => {
      stage(
        `INSERT INTO tasks VALUES
           ('T001', 'Imported', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
           ('T002', 'Imported', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01T00:00:00Z');`,
        `${POST_DEFERRAL_T001}
         INSERT INTO tasks_tasks (id, title, status, priority, type, created_at)
           VALUES ('T002', 'Imported', 'pending', 'medium', 'saga', '2026-01-01T00:00:00Z');`,
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('reconciled');
      expect(result.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T003', alreadyRecovered: false }),
      ]);
      expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id = 'T003'")).toBe('Imported');
      const again = await reconcileSupersededStores(join(root, 'project'));
      expect(again.outcome).toBe('nothing-to-reconcile');
      expect(again.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T003', alreadyRecovered: true }),
      ]);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(3);
    });

    it('an unparseable creation time withholds the task graph, dependents included (review MED-2)', async () => {
      stage(
        `CREATE TABLE task_acceptance_criteria (
           id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
           text TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
           target_task_id TEXT REFERENCES tasks(id), projection TEXT NOT NULL DEFAULT 'legacy'
         );
         CREATE TABLE task_dependencies (
           task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id),
           PRIMARY KEY (task_id, depends_on)
         );
         INSERT INTO tasks VALUES
           ('T001', 'legacy epoch task', 'pending', 'medium', 'saga', NULL, NULL, NULL, '1735689600000'),
           ('T002', 'legacy child', 'pending', 'medium', 'epic', 'T001', NULL, NULL, '2026-01-02T00:00:00Z');
         INSERT INTO task_acceptance_criteria VALUES
           ('ACX', 'T001', 1, 'legacy-only criterion', '2026-01-01T00:00:00Z', 'text', NULL, 'legacy');
         INSERT INTO task_dependencies VALUES ('T002', 'T001');`,
        POST_DEFERRAL_T001,
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const plan = await reconcileSupersededStores(join(root, 'project'), { dryRun: true });
      expect(plan.reason).toContain('the task graph was NOT copied');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.remaps).toEqual([]);
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'id-collision-undecided', ids: ['T001'], rows: 1 }),
          expect.objectContaining({ reason: 'withheld-undecided', targetTable: 'tasks_tasks' }),
          expect.objectContaining({
            reason: 'withheld-undecided',
            targetTable: 'tasks_task_acceptance_criteria',
          }),
          expect.objectContaining({
            reason: 'withheld-undecided',
            targetTable: 'tasks_task_dependencies',
          }),
        ]),
      );
      expect(result.reason).not.toContain('every legacy row');
      expect(result.reason).toContain('Correct the legacy created_at of T001');
      // Nothing attached to the live T001.
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(1);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_acceptance_criteria')).toBe(0);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_task_dependencies')).toBe(0);
    });

    it('a withheld run copies history from the original legacy files, not the renumbered copy (review LOW)', async () => {
      stage(
        `INSERT INTO tasks VALUES
           ('T001', 'legacy epoch task', 'pending', 'medium', 'saga', NULL, NULL, NULL, '1735689600000'),
           ('T002', 'legacy decided', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-02T00:00:00Z');`,
        `${POST_DEFERRAL_T001}
         INSERT INTO tasks_tasks (id, title, status, priority, type, created_at)
           VALUES ('T002', 'live other', 'pending', 'medium', 'saga', '2026-10-03T00:00:00Z');`,
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.remaps).toEqual([]);
      expect(result.stagingDir).not.toBeNull();
      expect(readdirSync(result.stagingDir ?? '')).not.toContain('tasks.remapped.db');
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(2);
    });

    it('twins whose instant is spelled two ways share one candidate pool (review LOW)', async () => {
      stage(
        `INSERT INTO tasks VALUES
           ('T001', 'Imported', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
           ('T002', 'Imported', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01 00:00:00');`,
        `${POST_DEFERRAL_T001}
         INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES
           ('T002', 'Other', 'pending', 'medium', 'saga', '2026-10-03T00:00:00Z'),
           ('T005', 'Imported', 'pending', 'medium', 'saga', '2026-01-01T00:00:00Z');`,
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('reconciled');
      expect(result.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T005', alreadyRecovered: true }),
        expect.objectContaining({ legacyId: 'T002', newId: 'T006', alreadyRecovered: false }),
      ]);
      expect(scalar(liveDb, "SELECT COUNT(*) FROM tasks_tasks WHERE title = 'Imported'")).toBe(2);
    });

    it('one instant spelled two ways is the same task, not a collision (review MED-2)', async () => {
      stage(
        `INSERT INTO tasks VALUES
           ('T001', 'same task', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01 00:00:00');`,
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T001', 'same task', 'pending', 'medium', 'saga', '2026-01-01T00:00:00Z');",
      );
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.remaps).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(1);
    });

    it('a recovered id taken by a concurrent write refuses and reverts (review LOW-1)', async () => {
      stage(
        `INSERT INTO tasks VALUES
           ('T001', 'legacy epic', 'pending', 'medium', 'saga', NULL, NULL, NULL, '2026-01-01T00:00:00Z');`,
        POST_DEFERRAL_T001,
      );
      takeRemappedId.on = true;
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('refused');
      expect(result.reason).toContain('a concurrent write took the id of a recovered task');
      expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id = 'T002'")).toBe('raced');
      expect(scalar(liveDb, "SELECT COUNT(*) FROM tasks_tasks WHERE title = 'legacy epic'")).toBe(
        0,
      );
    });
  });

  describe('a legacy task whose id a post-deferral task reused (T13172, scenario B)', () => {
    /** Legacy T001-T003 (T002/T003 under T001) and a post-deferral live saga T001. */
    function stageScenarioB(): void {
      rmSync(join(cleoDir, 'tasks.db'), { force: true });
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
        CREATE TABLE task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id),
          PRIMARY KEY (task_id, depends_on)
        );
        INSERT INTO tasks VALUES
          ('T001', 'legacy epic',  'active',  'high',   'epic', NULL,   NULL, NULL, '2026-01-01T00:00:00Z'),
          ('T002', 'legacy child', 'pending', 'medium', 'task', 'T001', NULL, NULL, '2026-01-02T00:00:00Z'),
          ('T003', 'legacy dep',   'pending', 'medium', 'task', 'T001', NULL, NULL, '2026-01-03T00:00:00Z');
        INSERT INTO task_acceptance_criteria VALUES
          ('AC1', 'T001', 1, 'epic criterion', '2026-01-01T00:00:00Z', 'text', NULL, 'legacy');
        INSERT INTO task_dependencies VALUES ('T002', 'T003'), ('T003', 'T001');
      `);
      tasks.close();
      const live = new DatabaseSync(liveDb);
      live
        .prepare(
          "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T001', 'Written after deferral', 'pending', 'medium', 'saga', '2026-10-03T00:00:00Z')",
        )
        .run();
      live.close();
    }

    it('the dry-run names the collision and counts the legacy task as missing', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const plan = await reconcileSupersededStores(join(root, 'project'), { dryRun: true });

      expect(plan.outcome).toBe('planned');
      expect(plan.before.find((t) => t.targetTable === 'tasks_tasks')?.missingInLive).toBe(3);
      expect(plan.remaps).toEqual([
        expect.objectContaining({
          legacyId: 'T001',
          newId: 'T004',
          legacyTitle: 'legacy epic',
          liveTitle: 'Written after deferral',
          alreadyRecovered: false,
        }),
      ]);
      expect(plan.reason).toContain('legacy T001 ("legacy epic") -> T004');
      expect(plan.sourcePaths).toContain(join(cleoDir, 'tasks.db'));
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(1);
    });

    it('recovers it under a new id with children, dependencies and criteria re-pointed', async () => {
      stageScenarioB();
      const legacyDigest = digest(join(cleoDir, 'tasks.db'));
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('reconciled');
      expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T001'")).toBe(
        'Written after deferral',
      );
      expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T004'")).toBe('legacy epic');
      expect(scalar(liveDb, "SELECT COUNT(*) FROM tasks_tasks WHERE parent_id='T004'")).toBe(2);
      expect(scalar(liveDb, "SELECT COUNT(*) FROM tasks_tasks WHERE parent_id='T001'")).toBe(0);
      expect(
        scalar(liveDb, "SELECT task_id FROM tasks_task_acceptance_criteria WHERE id='AC1'"),
      ).toBe('T004');
      expect(
        scalar(liveDb, "SELECT depends_on FROM tasks_task_dependencies WHERE task_id='T003'"),
      ).toBe('T004');
      expect(result.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T004', referencesRepointed: 4 }),
      ]);
      expect(result.reason).toContain('recovered under new ids');
      const receipt = JSON.parse(readFileSync(result.receiptPath ?? '', 'utf8')) as {
        remaps: unknown[];
      };
      expect(receipt.remaps).toHaveLength(1);
      expect(digest(join(cleoDir, 'tasks.db'))).toBe(legacyDigest);
      // The next allocation never reuses a recovered id.
      const { allocateNextTaskId } = await import('../../sequence/index.js');
      expect(await allocateNextTaskId(join(root, 'project'))).toBe('T005');
    });

    it('a second run recognises the recovered task and copies nothing', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      await reconcileSupersededStores(join(root, 'project'));
      const again = await reconcileSupersededStores(join(root, 'project'));

      expect(again.outcome).toBe('nothing-to-reconcile');
      expect(again.rowsCopied).toBe(0);
      expect(again.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T004', alreadyRecovered: true }),
      ]);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(4);
    });

    it('a recovered task retitled before the next run is recognised from the receipt (T13183)', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const first = await reconcileSupersededStores(join(root, 'project'));
      expect(first.outcome).toBe('reconciled');
      // The receipt is the durable record of the recovery.
      const receipt = JSON.parse(readFileSync(first.receiptPath ?? '', 'utf8')) as {
        remaps: Array<{ legacyId: string; newId: string }>;
      };
      expect(receipt.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T004' }),
      ]);

      // The user renames the recovered task; the title no longer matches the legacy row.
      const live = new DatabaseSync(liveDb);
      live.prepare("UPDATE tasks_tasks SET title = 'renamed since' WHERE id = 'T004'").run();
      live.close();

      const again = await reconcileSupersededStores(join(root, 'project'));
      expect(again.outcome).toBe('nothing-to-reconcile');
      expect(again.rowsCopied).toBe(0);
      expect(again.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T004', alreadyRecovered: true }),
      ]);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM tasks_tasks')).toBe(4);
    });

    it('cleo show <legacy id> says where the recovered legacy task went (T13183)', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      await reconcileSupersededStores(join(root, 'project'));
      const { drainWarnings } = await import('../../output.js');
      drainWarnings();
      const { taskShowOperation } = await import('../../tasks/show.js');
      const shown = await taskShowOperation(join(root, 'project'), { taskId: 'T001' });

      expect(shown.success).toBe(true);
      expect(drainWarnings()).toEqual([
        expect.objectContaining({
          code: 'W_LEGACY_ID_RECOVERED',
          message: expect.stringContaining('recovered as T004'),
        }),
      ]);
    });

    it('reads earlier receipts from the resolved .cleo even when the legacy file lives elsewhere (review LOW-1)', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      await reconcileSupersededStores(join(root, 'project'));
      // The same legacy file, read from another directory: only the resolved
      // .cleo (where the receipt is) can tell the remap that T001 was recovered.
      const elsewhere = mkdtempSync(join(tmpdir(), 'cleo-legacy-elsewhere-'));
      try {
        const legacyCopy = join(elsewhere, 'tasks.db');
        const { copyFileSync } = await import('node:fs');
        copyFileSync(join(cleoDir, 'tasks.db'), legacyCopy);
        const live = new DatabaseSync(liveDb);
        live.prepare("UPDATE tasks_tasks SET title = 'renamed since' WHERE id = 'T004'").run();
        live.close();
        const { remapCollidingTaskIds } = await import('../exodus/task-id-remap.js');
        const result = remapCollidingTaskIds(
          liveDb,
          [{ name: 'tasks', path: legacyCopy, targetScope: 'project' }],
          elsewhere,
          cleoDir,
        );
        expect(result.remaps).toEqual([
          expect.objectContaining({ legacyId: 'T001', newId: 'T004', alreadyRecovered: true }),
        ]);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('a receipt aimed at a same-instant task of another type is not trusted (review LOW)', async () => {
      stageScenarioB();
      // A hand-edited receipt claims legacy T001 was recovered as T009, a live
      // task created at the same instant but of another type.
      const forged = join(cleoDir, 'exodus-reconcile-2026-01-01T000000Z');
      mkdirSync(forged, { recursive: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(forged, 'reconcile-receipt.json'),
        JSON.stringify({
          outcome: 'reconciled',
          mode: 'full',
          remaps: [{ legacyId: 'T001', newId: 'T009' }],
        }),
      );
      const live = new DatabaseSync(liveDb);
      live
        .prepare(
          "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T009', 'unrelated import', 'pending', 'medium', 'saga', '2026-01-01T00:00:00Z')",
        )
        .run();
      live.close();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      const result = await reconcileSupersededStores(join(root, 'project'));

      expect(result.outcome).toBe('reconciled');
      expect(result.remaps).toEqual([
        expect.objectContaining({ legacyId: 'T001', newId: 'T010', alreadyRecovered: false }),
      ]);
      expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id = 'T010'")).toBe('legacy epic');
    });

    it('cleo show <legacy id> says nothing once the recovered task is gone (review LOW-2)', async () => {
      stageScenarioB();
      const { reconcileSupersededStores } = await import('../exodus/index.js');
      await reconcileSupersededStores(join(root, 'project'));
      const live = new DatabaseSync(liveDb);
      live.exec('PRAGMA foreign_keys = OFF');
      live.prepare("DELETE FROM tasks_tasks WHERE id = 'T004'").run();
      live.close();
      const { closeDb } = await import('../sqlite.js');
      closeDb();
      const { drainWarnings } = await import('../../output.js');
      drainWarnings();
      const { taskShowOperation } = await import('../../tasks/show.js');
      await taskShowOperation(join(root, 'project'), { taskId: 'T001' });

      expect(drainWarnings() ?? []).not.toContainEqual(
        expect.objectContaining({ code: 'W_LEGACY_ID_RECOVERED' }),
      );
    });

    it('the read-only survey never calls tasks.db safe to archive while T001 is shadowed', async () => {
      stageScenarioB();
      const { scanSupersededStores } = await import('../../doctor/superseded-store.js');
      const tasksEntry = () =>
        scanSupersededStores(join(root, 'project')).entries.find((e) => e.name === 'tasks.db');
      // Copy only the non-colliding rows, as a pre-T13172 reconcile did.
      const live = new DatabaseSync(liveDb);
      live
        .prepare(
          "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T002', 'legacy child', 'pending', 'medium', 'task', '2026-01-02T00:00:00Z'), ('T003', 'legacy dep', 'pending', 'medium', 'task', '2026-01-03T00:00:00Z')",
        )
        .run();
      live.close();
      const { utimesSync } = await import('node:fs');
      utimesSync(join(cleoDir, 'tasks.db'), new Date(2026, 0, 1), new Date(2026, 0, 1));

      const entry = tasksEntry();
      expect(entry?.missingInLive).toBe(1);
      expect(entry?.safeToArchive).toBe(false);
      expect(entry?.reason).toContain('a different live task now holds');
    });
  });
});
