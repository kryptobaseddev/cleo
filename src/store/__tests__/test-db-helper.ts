/**
 * Shared test helper for initializing a tasks.db SQLite database.
 *
 * Replaces the legacy pattern of writing tasks.json fixtures.
 * Uses createSqliteDataAccessor to create a real SQLite database
 * with proper schema, then seeds test data via the accessor.
 *
 * @task T5244
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../data-accessor.js';
import { resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';

/** Result of creating a test database environment. */
export interface TestDbEnv {
  /** Temporary directory (the project root). */
  tempDir: string;
  /** Path to .cleo directory. */
  cleoDir: string;
  /** SQLite-backed DataAccessor. */
  accessor: DataAccessor;
  /** Clean up temp dir and close DB. */
  cleanup: () => Promise<void>;
}

/**
 * Create a temporary directory with an initialized tasks.db.
 *
 * Usage:
 * ```ts
 * let env: TestDbEnv;
 * beforeEach(async () => { env = await createTestDb(); });
 * afterEach(async () => { await env.cleanup(); });
 * ```
 */
export async function createTestDb(): Promise<TestDbEnv> {
  const tempDir = mkdtempSync(join(tmpdir(), 'cleo-test-'));
  // Reset singleton to avoid cross-test contamination
  resetDbState();

  const accessor = await createSqliteDataAccessor(tempDir);
  const cleoDir = join(tempDir, '.cleo');

  return {
    tempDir,
    cleoDir,
    accessor,
    cleanup: async () => {
      await accessor.close();
      resetDbState();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a TaskFile structure from a list of task partials.
 * Useful for seeding test data via accessor.saveTaskFile().
 */
export function makeTaskFile(tasks: Array<Partial<Task> & { id: string }>): TaskFile {
  const fullTasks: Task[] = tasks.map(
    (t) =>
      ({
        title: t.title ?? `Task ${t.id}`,
        description: t.description ?? undefined,
        status: t.status ?? 'pending',
        priority: t.priority ?? 'medium',
        createdAt: t.createdAt ?? new Date().toISOString(),
        ...t,
      }) as Task,
  );

  return {
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    tasks: fullTasks,
  };
}

/**
 * Seed tasks into the test database via the accessor.
 *
 * Uses a two-pass approach to avoid foreign key violations:
 * 1. First pass: upsert all tasks without dependencies
 * 2. Second pass: save full task file with dependencies (all FK targets now exist)
 */
export async function seedTasks(
  accessor: DataAccessor,
  tasks: Array<Partial<Task> & { id: string }>,
): Promise<void> {
  if (tasks.length === 0) {
    // Still save an empty task file to initialize metadata
    await accessor.saveTaskFile(makeTaskFile([]));
    return;
  }

  // Pass 1: Insert all tasks without dependencies so FK targets exist
  const tasksWithoutDeps = tasks.map((t) => ({ ...t, depends: undefined }));
  await accessor.saveTaskFile(makeTaskFile(tasksWithoutDeps));

  // Pass 2: Save again with full dependencies (all referenced tasks now exist)
  const hasDeps = tasks.some((t) => t.depends && t.depends.length > 0);
  if (hasDeps) {
    await accessor.saveTaskFile(makeTaskFile(tasks));
  }
}
