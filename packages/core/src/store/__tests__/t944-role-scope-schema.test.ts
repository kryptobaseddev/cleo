/**
 * T944 tests — role/scope/severity axes + experiments side-table.
 *
 * Verifies the additive schema changes required for the owner-approved
 * orthogonal-axes design from Round 2 RCASD:
 *   - `role` defaults to 'work', CHECK rejects invalid values
 *   - `scope` defaults to 'feature', CHECK rejects invalid values
 *   - `severity` is nullable, CHECK rejects invalid values AND any non-NULL
 *     value when role != 'bug' (prompt-injection P0 defense)
 *   - role/scope/role+status indexes exist
 *   - backfill UPDATE statements land legacy type → scope mapping correctly
 *   - `experiments` side-table exists with cascade FK on tasks.id
 *
 * @task T944
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfoRow {
  name: string;
}

let tempDir: string;

/**
 * Read PRAGMA table_info for the given table as a name → column map.
 */
function readTableInfo(db: DatabaseSync, table: string): Map<string, TableInfoRow> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as TableInfoRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * List all non-autoindex index names from sqlite_master.
 */
function readIndexNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
    .all() as IndexInfoRow[];
  return new Set(rows.map((r) => r.name));
}

describe('T944 role/scope/severity schema', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t944-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('adds role/scope/severity columns with correct types and defaults', async () => {
    const { getDb } = await import('../sqlite.js');
    await getDb();
    const { getNativeTasksDb } = await import('../sqlite.js');
    const nativeDb = getNativeTasksDb();
    expect(nativeDb, 'native tasks.db must be initialized').toBeTruthy();
    if (!nativeDb) return;

    const info = readTableInfo(nativeDb, 'tasks');
    const role = info.get('role');
    const scope = info.get('scope');
    const severity = info.get('severity');

    expect(role, 'tasks.role column must exist').toBeDefined();
    expect(scope, 'tasks.scope column must exist').toBeDefined();
    expect(severity, 'tasks.severity column must exist').toBeDefined();

    // Type + NOT NULL + DEFAULT checks
    expect(role?.type).toBe('TEXT');
    expect(role?.notnull).toBe(1);
    expect(role?.dflt_value).toBe("'work'");

    expect(scope?.type).toBe('TEXT');
    expect(scope?.notnull).toBe(1);
    expect(scope?.dflt_value).toBe("'feature'");

    expect(severity?.type).toBe('TEXT');
    expect(severity?.notnull).toBe(0);
    expect(severity?.dflt_value).toBeNull();
  });

  it('creates idx_tasks_role, idx_tasks_scope, and idx_tasks_role_status indexes', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const indexes = readIndexNames(nativeDb);
    expect(indexes.has('idx_tasks_role')).toBe(true);
    expect(indexes.has('idx_tasks_scope')).toBe(true);
    expect(indexes.has('idx_tasks_role_status')).toBe(true);
  });

  it('CHECK constraint on tasks.role rejects invalid enum values', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    // Insert a baseline row with an explicit invalid role — CHECK must reject.
    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insert.run(
        'T_BAD_ROLE',
        'Bad role',
        'Invalid role value',
        'pending',
        'medium',
        'not-a-role',
        'feature',
        now,
      ),
    ).toThrowError(/CHECK|constraint/i);

    // Control: valid role should succeed.
    insert.run(
      'T_OK_ROLE',
      'Good role',
      'Valid role',
      'pending',
      'medium',
      'research',
      'feature',
      now,
    );
    const row = nativeDb.prepare('SELECT role FROM tasks WHERE id = ?').get('T_OK_ROLE') as {
      role: string;
    };
    expect(row.role).toBe('research');
  });

  it('CHECK constraint on tasks.scope rejects invalid enum values', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insert.run(
        'T_BAD_SCOPE',
        'Bad scope',
        'Invalid scope value',
        'pending',
        'medium',
        'work',
        'nonsense',
        now,
      ),
    ).toThrowError(/CHECK|constraint/i);
  });

  it('CHECK constraint rejects severity when role is not "bug"', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // P0 severity with role='work' MUST be rejected — this is the
    // prompt-injection defense the owner mandated.
    expect(() =>
      insert.run(
        'T_SEV_NO_BUG',
        'Severity without bug',
        'Should fail',
        'pending',
        'medium',
        'work',
        'feature',
        'P0',
        now,
      ),
    ).toThrowError(/CHECK|constraint/i);

    // Control: severity + role='bug' MUST succeed.
    insert.run(
      'T_SEV_BUG',
      'Bug with severity',
      'Valid pairing',
      'pending',
      'medium',
      'bug',
      'feature',
      'P0',
      now,
    );
    const row = nativeDb
      .prepare('SELECT role, severity FROM tasks WHERE id = ?')
      .get('T_SEV_BUG') as { role: string; severity: string };
    expect(row.role).toBe('bug');
    expect(row.severity).toBe('P0');
  });

  it('CHECK constraint on tasks.severity rejects invalid severity values', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insert.run(
        'T_BAD_SEV',
        'Bad severity',
        'Invalid severity value',
        'pending',
        'medium',
        'bug',
        'feature',
        'P9',
        now,
      ),
    ).toThrowError(/CHECK|constraint/i);
  });

  it('NULL severity is allowed for non-bug roles (default path)', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    // Inserting WITHOUT severity (i.e. relying on NULL default) must succeed
    // for non-bug roles. This guards against a CHECK mistake that would
    // reject all legacy rows.
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'T_NULL_SEV',
      'Null severity OK',
      'Non-bug roles should allow NULL severity',
      'pending',
      'medium',
      'work',
      'feature',
      now,
    );

    const row = nativeDb.prepare('SELECT severity FROM tasks WHERE id = ?').get('T_NULL_SEV') as {
      severity: string | null;
    };
    expect(row.severity).toBeNull();
  });

  it('backfill populates scope based on legacy type', async () => {
    // This test simulates the production migration path: insert rows with
    // legacy `type` values, then run the T944 backfill statements. We use a
    // fresh DB (schema already created by drizzle-kit migrate) and then
    // manually re-run the scope UPDATE statements to verify mapping.
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    // Simulate a "legacy" row pattern: insert with type but default scope.
    // (On a fresh DB the backfill has already run, but re-running the
    // UPDATE is idempotent — it's the mapping itself we want to assert.)
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, type, role, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'T_EPIC',
      'Legacy epic',
      'Epic row',
      'pending',
      'medium',
      'epic',
      'work',
      'feature', // intentionally wrong — backfill should correct to 'project'
      now,
    );
    insert.run(
      'T_TASK',
      'Legacy task',
      'Task row',
      'pending',
      'medium',
      'task',
      'work',
      'unit', // intentionally wrong — backfill should correct to 'feature'
      now,
    );
    insert.run(
      'T_SUB',
      'Legacy subtask',
      'Subtask row',
      'pending',
      'medium',
      'subtask',
      'work',
      'feature', // intentionally wrong — backfill should correct to 'unit'
      now,
    );

    // Replay the backfill statements from the T944 migration.
    nativeDb.exec("UPDATE tasks SET scope = 'project' WHERE type = 'epic'");
    nativeDb.exec("UPDATE tasks SET scope = 'feature' WHERE type = 'task' OR type IS NULL");
    nativeDb.exec("UPDATE tasks SET scope = 'unit' WHERE type = 'subtask'");

    const rows = nativeDb
      .prepare("SELECT id, scope FROM tasks WHERE id IN ('T_EPIC','T_TASK','T_SUB') ORDER BY id")
      .all() as Array<{ id: string; scope: string }>;
    const byId = new Map(rows.map((r) => [r.id, r.scope]));
    expect(byId.get('T_EPIC')).toBe('project');
    expect(byId.get('T_TASK')).toBe('feature');
    expect(byId.get('T_SUB')).toBe('unit');
  });

  it('experiments side-table exists with correct columns and FK cascade', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const info = readTableInfo(nativeDb, 'experiments');
    expect(info.size).toBeGreaterThan(0);
    expect(info.has('task_id')).toBe(true);
    expect(info.has('sandbox_branch')).toBe(true);
    expect(info.has('baseline_commit')).toBe(true);
    expect(info.has('merged_at')).toBe(true);
    expect(info.has('receipt_id')).toBe(true);
    expect(info.has('metrics_delta_json')).toBe(true);
    expect(info.has('created_at')).toBe(true);
    expect(info.has('updated_at')).toBe(true);

    // task_id must be primary key
    const taskId = info.get('task_id');
    expect(taskId?.pk).toBe(1);

    // idx_experiments_merged must exist
    const indexes = readIndexNames(nativeDb);
    expect(indexes.has('idx_experiments_merged')).toBe(true);

    // Verify FK + cascade by PRAGMA foreign_key_list
    const fks = nativeDb.prepare('PRAGMA foreign_key_list("experiments")').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(fks.length).toBeGreaterThan(0);
    const taskFk = fks.find((fk) => fk.table === 'tasks');
    expect(taskFk).toBeDefined();
    expect(taskFk?.from).toBe('task_id');
    expect(taskFk?.to).toBe('id');
    expect(taskFk?.on_delete.toUpperCase()).toBe('CASCADE');
  });

  it('experiments row is deleted when owning task is deleted (FK cascade)', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    // Foreign keys must be ON for cascade to fire.
    nativeDb.exec('PRAGMA foreign_keys = ON');

    const now = new Date().toISOString();
    nativeDb
      .prepare(
        `INSERT INTO tasks (id, title, description, status, priority, role, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'T_EXP',
        'Experiment owner',
        'Owns an experiment row',
        'pending',
        'medium',
        'experiment',
        'feature',
        now,
      );

    nativeDb
      .prepare(
        `INSERT INTO experiments (task_id, sandbox_branch, baseline_commit)
         VALUES (?, ?, ?)`,
      )
      .run('T_EXP', 'feat/T_EXP-sandbox', 'deadbeef');

    const beforeCount = nativeDb
      .prepare('SELECT COUNT(*) AS c FROM experiments WHERE task_id = ?')
      .get('T_EXP') as { c: number };
    expect(beforeCount.c).toBe(1);

    // Delete the owning task; the experiments row MUST cascade.
    nativeDb.prepare('DELETE FROM tasks WHERE id = ?').run('T_EXP');

    const afterCount = nativeDb
      .prepare('SELECT COUNT(*) AS c FROM experiments WHERE task_id = ?')
      .get('T_EXP') as { c: number };
    expect(afterCount.c).toBe(0);
  });

  it('valid role enum values all insert cleanly', async () => {
    const { getDb, getNativeTasksDb } = await import('../sqlite.js');
    await getDb();
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('native tasks.db not initialized');

    const now = new Date().toISOString();
    const insert = nativeDb.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, role, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const roles = ['work', 'research', 'experiment', 'bug', 'spike', 'release'];
    roles.forEach((role, i) => {
      insert.run(
        `T_ROLE_${i}`,
        `Role ${role}`,
        `Canonical role ${role}`,
        'pending',
        'medium',
        role,
        'feature',
        now,
      );
    });
    const count = nativeDb
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE id LIKE 'T_ROLE_%'")
      .get() as { c: number };
    expect(count.c).toBe(roles.length);
  });
});
