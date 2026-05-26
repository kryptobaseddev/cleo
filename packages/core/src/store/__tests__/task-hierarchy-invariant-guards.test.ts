/**
 * Schema guardrails for T10572 task hierarchy invariants.
 *
 * PM-Core V2 keeps containment in `tasks.parent_id` and reserves
 * `task_relations` for secondary/non-containment graph edges. These tests lock
 * the raw SQLite triggers that Drizzle cannot model: direct SQL callers receive
 * stable, actionable errors for containment-in-relations, invalid parent type
 * matrices, child_task target containment, and containment cycles.
 *
 * @saga T10538
 * @task T10572
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
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function migrationSql(taskId: string): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((name) => name.includes(taskId.toLowerCase()));
  if (!folder) {
    throw new Error(`${taskId} migration folder not found under drizzle-tasks/`);
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

describe('T10572 migration SQL', () => {
  it('documents trigger-backed hierarchy guards with actionable error codes', () => {
    const sql = migrationSql('T10572');
    expect(sql).toContain('CREATE TRIGGER `task_relations_non_containment_insert`');
    expect(sql).toContain('CREATE TRIGGER `tasks_parent_type_matrix_insert`');
    expect(sql).toContain('CREATE TRIGGER `task_acceptance_child_target_insert`');
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain('E_TASK_RELATION_CONTAINMENT');
    expect(sql).toContain('E_CHILD_TASK_TARGET_CONTAINMENT');
    expect(sql).toContain('E_TASK_PARENT_TYPE_MATRIX');
    expect(sql).toContain('E_TASK_PARENT_CYCLE');
  });
});

describe('T10572 fresh migration apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10572-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('guards containment, parent type matrix, and cycle invariants at SQLite boundary', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const folder = migrationsDir();

    reconcileJournal(nativeDb, folder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder: folder })).not.toThrow();

    const triggerNames = new Set(
      (
        nativeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'tasks_parent_%' OR name LIKE 'task_relations_non_containment_%' OR name LIKE 'task_acceptance_child_target_%')",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    expect(triggerNames).toContain('task_relations_non_containment_insert');
    expect(triggerNames).toContain('task_relations_non_containment_update');
    expect(triggerNames).toContain('task_acceptance_child_target_insert');
    expect(triggerNames).toContain('task_acceptance_child_target_update');
    expect(triggerNames).toContain('tasks_parent_type_matrix_insert');
    expect(triggerNames).toContain('tasks_parent_type_matrix_update');
    expect(triggerNames).toContain('tasks_parent_cycle_guard_insert');
    expect(triggerNames).toContain('tasks_parent_cycle_guard_update');

    const insertTask = nativeDb.prepare(
      'INSERT INTO tasks (id, title, status, priority, type, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertTask.run('T100', 'Epic', 'pending', 'medium', 'epic', null);
    insertTask.run('T101', 'Task', 'pending', 'medium', 'task', 'T100');
    insertTask.run('T102', 'Subtask', 'pending', 'medium', 'subtask', 'T101');

    expect(() =>
      insertTask.run('T103', 'Epic under task', 'pending', 'medium', 'epic', 'T101'),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);
    expect(() =>
      insertTask.run('T104', 'Task under task', 'pending', 'medium', 'task', 'T101'),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);
    expect(() =>
      insertTask.run('T105', 'Child under subtask', 'pending', 'medium', 'subtask', 'T102'),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);

    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
        )
        .run('T100', 'T101', 'related', 'should use parent_id'),
    ).toThrow(/E_TASK_RELATION_CONTAINMENT/);

    // Non-containment relation still works once source/target are not parent-child.
    nativeDb
      .prepare(
        'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
      )
      .run('T100', 'T102', 'related', 'cross-level reference without direct containment');

    nativeDb
      .prepare(
        'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('AC100', 'T100', 1, 'child_task', 'child:T101', 'T101', 'Complete child T101');
    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'AC102',
          'T100',
          3,
          'text',
          'manual:T101',
          'T101',
          'Only child_task criteria may target children',
        ),
    ).toThrow(/E_CHILD_TASK_TARGET_CONTAINMENT/);

    // Cycle guard is intentionally independent of type matrix: older rows may be
    // untyped, so recursive containment safety still has to fire.
    insertTask.run('T200', 'Untyped A', 'pending', 'medium', null, null);
    insertTask.run('T201', 'Untyped B', 'pending', 'medium', null, 'T200');
    insertTask.run('T202', 'Untyped C', 'pending', 'medium', null, 'T201');
    expect(() =>
      nativeDb.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run('T202', 'T200'),
    ).toThrow(/E_TASK_PARENT_CYCLE/);

    nativeDb.close();
  });
});
