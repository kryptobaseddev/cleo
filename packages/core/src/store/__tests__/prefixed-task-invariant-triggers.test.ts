/**
 * Schema guardrails for T11884 — task invariant + handoff triggers on the
 * PREFIXED tables (`tasks_tasks`, `tasks_task_relations`,
 * `tasks_task_acceptance_criteria`, `tasks_session_handoff_entries`).
 *
 * The T11578 dual-scope cutover repointed the runtime drizzle symbols onto the
 * domain-prefixed tables but never recreated the 12 SQLite invariant/handoff
 * triggers there, so the task invariants were silently unenforced on the live
 * write path and the session-handoff mirror was dead. This locks the restored
 * guards: direct SQL callers receive the same stable error codes regardless of
 * which physical table fired, and the handoff `handoff_json` mirror works.
 *
 * Mirrors {@link ./task-hierarchy-invariant-guards.test.ts} (the legacy
 * bare-table version) against the `drizzle-cleo-project` migration set.
 *
 * @saga T11242
 * @epic T11883
 * @task T11884
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-cleo-project');
}

function migrationSql(taskId: string): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((name) => name.includes(taskId.toLowerCase()));
  if (!folder) {
    throw new Error(`${taskId} migration folder not found under drizzle-cleo-project/`);
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

describe('T11884 migration SQL', () => {
  it('recreates the hierarchy + handoff guards on the prefixed tables with stable error codes', () => {
    const sql = migrationSql('T11884');
    // Guards fire on the prefixed tables.
    expect(sql).toContain('CREATE TRIGGER `tasks_tasks_parent_cycle_guard_insert`');
    expect(sql).toContain('CREATE TRIGGER `tasks_tasks_parent_type_matrix_insert`');
    expect(sql).toContain('CREATE TRIGGER `trg_tasks_tasks_status_pipeline_insert`');
    expect(sql).toContain('CREATE TRIGGER `tasks_task_relations_non_containment_insert`');
    expect(sql).toContain('CREATE TRIGGER `tasks_task_acceptance_child_target_insert`');
    expect(sql).toContain('CREATE TRIGGER `trg_tasks_session_handoff_mirror`');
    expect(sql).toContain('CREATE TRIGGER `trg_tasks_session_handoff_no_update`');
    // Bodies reference the prefixed tables, never the bare ones.
    expect(sql).toContain('FROM `tasks_tasks` parent');
    expect(sql).toContain('UPDATE `tasks_sessions`');
    expect(sql).not.toMatch(/FROM `tasks` (parent|child)\b/);
    expect(sql).not.toContain('UPDATE `sessions`');
    // Stable error codes preserved.
    expect(sql).toContain('E_TASK_PARENT_CYCLE');
    expect(sql).toContain('E_TASK_PARENT_TYPE_MATRIX');
    expect(sql).toContain('T877_INVARIANT_VIOLATION');
    expect(sql).toContain('E_TASK_RELATION_CONTAINMENT');
    expect(sql).toContain('E_CHILD_TASK_TARGET_CONTAINMENT');
    expect(sql).toContain('T1609_HANDOFF_IMMUTABLE');
  });
});

describe('T11884 fresh migration apply (drizzle-cleo-project)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t11884-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('enforces hierarchy, status/pipeline, and handoff invariants on the prefixed tables', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'cleo.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const folder = migrationsDir();

    // The cleo-project set creates the prefixed tables; the existence sentinel
    // is tasks_tasks (matches dual-scope-db.ts existenceTable('project')).
    reconcileJournal(nativeDb, folder, 'tasks_tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder: folder })).not.toThrow();

    const triggerNames = new Set(
      (
        nativeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('tasks_tasks','tasks_task_relations','tasks_task_acceptance_criteria','tasks_session_handoff_entries')",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const name of [
      'tasks_tasks_parent_cycle_guard_insert',
      'tasks_tasks_parent_cycle_guard_update',
      'tasks_tasks_parent_type_matrix_insert',
      'tasks_tasks_parent_type_matrix_update',
      'trg_tasks_tasks_status_pipeline_insert',
      'trg_tasks_tasks_status_pipeline_update',
      'tasks_task_relations_non_containment_insert',
      'tasks_task_relations_non_containment_update',
      'tasks_task_acceptance_child_target_insert',
      'tasks_task_acceptance_child_target_update',
      'trg_tasks_session_handoff_mirror',
      'trg_tasks_session_handoff_no_update',
    ]) {
      expect(triggerNames).toContain(name);
    }

    const insertTask = nativeDb.prepare(
      'INSERT INTO tasks_tasks (id, title, status, priority, type, parent_id, pipeline_stage) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertTask.run('T100', 'Epic', 'pending', 'medium', 'epic', null, null);
    insertTask.run('T101', 'Task', 'pending', 'medium', 'task', 'T100', null);
    insertTask.run('T102', 'Subtask', 'pending', 'medium', 'subtask', 'T101', null);

    // Parent type-matrix is enforced on tasks_tasks.
    expect(() =>
      insertTask.run('T103', 'Epic under task', 'pending', 'medium', 'epic', 'T101', null),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);
    expect(() =>
      insertTask.run('T104', 'Task under task', 'pending', 'medium', 'task', 'T101', null),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);

    // Status/pipeline (T877) invariant is enforced on tasks_tasks.
    expect(() =>
      insertTask.run('T110', 'Done w/o stage', 'done', 'medium', 'task', 'T100', null),
    ).toThrow(/T877_INVARIANT_VIOLATION/);
    // A terminal task with a valid pipeline_stage is accepted.
    insertTask.run('T111', 'Done OK', 'done', 'medium', 'task', 'T100', 'contribution');
    expect(() =>
      nativeDb
        .prepare('UPDATE tasks_tasks SET status = ?, pipeline_stage = ? WHERE id = ?')
        .run('cancelled', 'contribution', 'T111'),
    ).toThrow(/T877_INVARIANT_VIOLATION/);

    // Non-containment guard on tasks_task_relations.
    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO tasks_task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
        )
        .run('T100', 'T101', 'related', 'should use parent_id'),
    ).toThrow(/E_TASK_RELATION_CONTAINMENT/);
    // A non-containment relation still works.
    nativeDb
      .prepare(
        'INSERT INTO tasks_task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
      )
      .run('T100', 'T102', 'related', 'cross-level reference without direct containment');

    // Acceptance child_target containment guard on tasks_task_acceptance_criteria.
    nativeDb
      .prepare(
        'INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('AC100', 'T100', 1, 'child_task', 'child:T101', 'T101', 'Complete child T101');
    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'AC101',
          'T100',
          2,
          'child_task',
          'child:T102',
          'T102',
          'Grandchild is not a direct child',
        ),
    ).toThrow(/E_CHILD_TASK_TARGET_CONTAINMENT/);

    // Cycle guard fires independently of the type matrix (untyped rows).
    insertTask.run('T200', 'Untyped A', 'pending', 'medium', null, null, null);
    insertTask.run('T201', 'Untyped B', 'pending', 'medium', null, 'T200', null);
    insertTask.run('T202', 'Untyped C', 'pending', 'medium', null, 'T201', null);
    expect(() =>
      nativeDb.prepare('UPDATE tasks_tasks SET parent_id = ? WHERE id = ?').run('T202', 'T200'),
    ).toThrow(/E_TASK_PARENT_CYCLE/);

    // Session-handoff mirror + write-once on the prefixed tables.
    nativeDb
      .prepare('INSERT INTO tasks_sessions (id, name, status) VALUES (?, ?, ?)')
      .run('ses_t11884', 'T11884 test session', 'active');
    nativeDb
      .prepare('INSERT INTO tasks_session_handoff_entries (session_id, handoff_json) VALUES (?, ?)')
      .run('ses_t11884', '{"note":"first handoff"}');
    const mirrored = nativeDb
      .prepare('SELECT handoff_json FROM tasks_sessions WHERE id = ?')
      .get('ses_t11884') as { handoff_json: string | null };
    expect(mirrored.handoff_json).toBe('{"note":"first handoff"}');
    // Handoff entries are write-once.
    expect(() =>
      nativeDb
        .prepare('UPDATE tasks_session_handoff_entries SET handoff_json = ? WHERE session_id = ?')
        .run('{"note":"mutated"}', 'ses_t11884'),
    ).toThrow(/T1609_HANDOFF_IMMUTABLE/);

    nativeDb.close();
  });
});
