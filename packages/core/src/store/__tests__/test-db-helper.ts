/**
 * Shared test helper for initializing a tasks.db SQLite database.
 *
 * Replaces the legacy pattern of writing tasks.json fixtures.
 * Uses createSqliteDataAccessor to create a real SQLite database
 * with proper schema, then seeds test data via the accessor.
 *
 * @task T5244
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
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

  // Write test config that disables session enforcement and lifecycle enforcement
  // so unit tests don't require active sessions or pipeline stage validation.
  const cleoDir = join(tempDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const configContent = JSON.stringify({
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
    lifecycle: { mode: 'off' },
    verification: { enabled: false },
  });
  writeFileSync(join(cleoDir, 'config.json'), configContent);
  // Verify write succeeded
  const { readdirSync } = await import('node:fs');
  const contents = readdirSync(cleoDir);
  if (!contents.includes('config.json')) {
    throw new Error(
      `createTestDb: config.json not found in ${cleoDir} after write (contents: ${JSON.stringify(contents)})`,
    );
  }

  const accessor = await createSqliteDataAccessor(tempDir);

  // Verify config.json still exists after DB initialization
  const { readdirSync: readdirSync2 } = await import('node:fs');
  const contentsAfterDb = readdirSync2(cleoDir);
  if (!contentsAfterDb.includes('config.json')) {
    throw new Error(
      `createTestDb: config.json DELETED by createSqliteDataAccessor! ${cleoDir}: ${JSON.stringify(contentsAfterDb)}`,
    );
  }

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
 * Build full Task objects from a list of task partials.
 * Useful for seeding test data via accessor.upsertSingleTask().
 *
 * T877: pipeline_stage is auto-defaulted based on status so test fixtures
 * satisfy the structural invariant enforced by the SQLite trigger
 * `trg_tasks_status_pipeline_insert`:
 *   - status='done'       → pipeline_stage='contribution'
 *   - status='cancelled'  → pipeline_stage='cancelled'
 *   - otherwise           → whatever the caller supplied (default null)
 * Explicit pipelineStage on the partial always wins.
 */
export function makeTasks(tasks: Array<Partial<Task> & { id: string }>): Task[] {
  return tasks.map((t) => {
    const status = t.status ?? 'pending';
    // Derive a terminal pipelineStage when caller left it unset but chose a
    // terminal status — keeps fixtures compatible with T877 triggers without
    // forcing every seed site to know about the invariant.
    let pipelineStage: string | null | undefined = t.pipelineStage;
    if (pipelineStage === undefined || pipelineStage === null) {
      if (status === 'done') pipelineStage = 'contribution';
      else if (status === 'cancelled') pipelineStage = 'cancelled';
      else pipelineStage = t.pipelineStage ?? undefined;
    }

    return {
      title: t.title ?? `Task ${t.id}`,
      description: t.description ?? undefined,
      status,
      priority: t.priority ?? 'medium',
      createdAt: t.createdAt ?? new Date().toISOString(),
      ...t,
      pipelineStage,
    } as Task;
  });
}

/**
 * Seed tasks into the test database via the accessor.
 *
 * Uses a two-pass approach to avoid foreign key violations:
 * 1. First pass: upsert all tasks without dependencies so FK targets exist
 * 2. Second pass: upsert tasks again with dependencies (all FK targets now exist)
 * 3. Initialize metadata for the test environment
 */
export async function seedTasks(
  accessor: DataAccessor,
  tasks: Array<Partial<Task> & { id: string }>,
): Promise<void> {
  // Initialize metadata even for empty task sets
  await accessor.setMetaValue('schema_version', '2.10.0');

  if (tasks.length === 0) {
    return;
  }

  // Build full Task objects from partials
  const fullTasks = makeTasks(tasks);

  // Pass 1: Upsert all tasks without dependencies so FK targets exist
  for (const task of fullTasks) {
    await accessor.upsertSingleTask({ ...task, depends: undefined });
  }

  // Pass 2: Upsert tasks again with dependencies (all FK targets now exist)
  const hasDeps = tasks.some((t) => t.depends && t.depends.length > 0);
  if (hasDeps) {
    for (const task of fullTasks) {
      if (task.depends && task.depends.length > 0) {
        await accessor.upsertSingleTask(task);
      }
    }
  }
}
