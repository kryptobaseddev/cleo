/**
 * Tests for the T869 pipeline-stage backfill migration.
 *
 * Verifies:
 *   (a) Migration runs once and backfills correctly.
 *   (b) Idempotency — running a second time is a no-op.
 *   (c) Tasks that are already in sync are not touched.
 *   (d) dryRun mode computes changes without writing.
 *   (e) force flag bypasses the idempotency guard.
 *
 * Setup: inserts raw SQL rows via DatabaseSync so we can reproduce the
 * pre-T832 state where lifecycle_stages advanced but tasks.pipeline_stage
 * was not updated.
 *
 * @task T869
 * @adr ADR-051 Decision 5
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKFILL_KEY,
  backfillPipelineStageFromLifecycle,
  isPipelineStageBackfillDone,
} from '../backfill-pipeline-stage.js';

let testDir: string;
let cleoDir: string;

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/** Ensure a task row exists with the given pipeline_stage (default: 'research'). */
async function insertTask(
  taskId: string,
  pipelineStage: string | null = 'research',
): Promise<void> {
  const { getDb, getNativeDb } = await import('../../store/sqlite.js');
  await getDb();
  getNativeDb()!
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status, priority, pipeline_stage, created_at)
       VALUES (?, ?, 'pending', 'medium', ?, datetime('now'))`,
    )
    .run(taskId, `Task ${taskId}`, pipelineStage);
}

/** Insert a lifecycle_pipelines row for the given task. Returns the pipeline id. */
async function insertPipeline(taskId: string, currentStageId: string): Promise<string> {
  const pipelineId = `pipe-${taskId}`;
  const { getDb, getNativeDb } = await import('../../store/sqlite.js');
  await getDb();
  getNativeDb()!
    .prepare(
      `INSERT OR IGNORE INTO lifecycle_pipelines
         (id, task_id, status, current_stage_id, started_at)
       VALUES (?, ?, 'active', ?, datetime('now'))`,
    )
    .run(pipelineId, taskId, currentStageId);
  return pipelineId;
}

/**
 * Insert a lifecycle_stages row representing a specific stage at a given
 * status (e.g. 'completed').
 *
 * @param pipelineId - The parent lifecycle pipeline id.
 * @param stageName  - One of the canonical PIPELINE_STAGES names.
 * @param sequence   - Numeric order (1-based, must match STAGE_ORDER).
 * @param status     - 'completed' | 'in_progress' | 'skipped' | 'not_started' etc.
 */
async function insertStage(
  pipelineId: string,
  stageName: string,
  sequence: number,
  status: string,
): Promise<void> {
  const stageId = `stg-${pipelineId}-${stageName}`;
  const { getDb, getNativeDb } = await import('../../store/sqlite.js');
  await getDb();
  getNativeDb()!
    .prepare(
      `INSERT OR IGNORE INTO lifecycle_stages
         (id, pipeline_id, stage_name, status, sequence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(stageId, pipelineId, stageName, status, sequence);
}

/** Read the current pipeline_stage for a task directly from SQLite. */
async function readPipelineStage(taskId: string): Promise<string | null> {
  const { getNativeDb } = await import('../../store/sqlite.js');
  const row = getNativeDb()!.prepare('SELECT pipeline_stage FROM tasks WHERE id = ?').get(taskId) as
    | { pipeline_stage: string | null }
    | undefined;
  return row?.pipeline_stage ?? null;
}

/** Read the schema_meta backfill guard directly from SQLite. */
async function readBackfillGuard(): Promise<string | null> {
  const { getNativeDb } = await import('../../store/sqlite.js');
  const row = getNativeDb()!
    .prepare(`SELECT value FROM schema_meta WHERE key = '${BACKFILL_KEY}'`)
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-backfill-ps-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'off';
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['LIFECYCLE_ENFORCEMENT_MODE'];
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillPipelineStageFromLifecycle (T869)', () => {
  // -----------------------------------------------------------------------
  // (a) Basic backfill: lifecycle ahead of task.pipeline_stage
  // -----------------------------------------------------------------------

  it('backfills task.pipeline_stage from highest completed lifecycle stage', async () => {
    // Simulate a pre-T832 epic: lifecycle_stages has 'release' completed but
    // task.pipeline_stage is still the default 'research'.
    await insertTask('T861', 'research');
    const pipelineId = await insertPipeline('T861', 'release');
    await insertStage(pipelineId, 'research', 1, 'completed');
    await insertStage(pipelineId, 'specification', 4, 'completed');
    await insertStage(pipelineId, 'implementation', 6, 'completed');
    await insertStage(pipelineId, 'release', 9, 'completed');

    const result = await backfillPipelineStageFromLifecycle({}, testDir);

    expect(result.alreadyRun).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.tasksUpdated).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      taskId: 'T861',
      previousStage: 'research',
      newStage: 'release',
    });

    // Verify the DB was actually updated.
    expect(await readPipelineStage('T861')).toBe('release');
  });

  // -----------------------------------------------------------------------
  // (b) Idempotency: second run is a no-op
  // -----------------------------------------------------------------------

  it('is idempotent: second call returns alreadyRun=true without any changes', async () => {
    await insertTask('T862', 'research');
    const pipelineId = await insertPipeline('T862', 'implementation');
    await insertStage(pipelineId, 'implementation', 6, 'in_progress');

    // First run — applies the backfill.
    const first = await backfillPipelineStageFromLifecycle({}, testDir);
    expect(first.alreadyRun).toBe(false);
    expect(first.tasksUpdated).toBe(1);

    // Second run — guard fires, no work done.
    const second = await backfillPipelineStageFromLifecycle({}, testDir);
    expect(second.alreadyRun).toBe(true);
    expect(second.tasksUpdated).toBe(0);
    expect(second.tasksScanned).toBe(0);

    // DB value unchanged from first run.
    expect(await readPipelineStage('T862')).toBe('implementation');
  });

  // -----------------------------------------------------------------------
  // (c) Already-synced task is not touched
  // -----------------------------------------------------------------------

  it('does not touch tasks whose pipeline_stage already matches lifecycle', async () => {
    // Task with pipeline_stage='implementation' and lifecycle at implementation.
    await insertTask('T863', 'implementation');
    const pipelineId = await insertPipeline('T863', 'implementation');
    await insertStage(pipelineId, 'implementation', 6, 'completed');

    const result = await backfillPipelineStageFromLifecycle({}, testDir);

    expect(result.tasksUpdated).toBe(0);
    expect(result.changes).toHaveLength(0);
    // Stage unchanged.
    expect(await readPipelineStage('T863')).toBe('implementation');
  });

  // -----------------------------------------------------------------------
  // (d) dryRun mode: changes computed but not written
  // -----------------------------------------------------------------------

  it('dryRun mode returns changes without writing to DB', async () => {
    await insertTask('T864', 'research');
    const pipelineId = await insertPipeline('T864', 'testing');
    await insertStage(pipelineId, 'testing', 8, 'in_progress');

    const result = await backfillPipelineStageFromLifecycle({ dryRun: true }, testDir);

    expect(result.dryRun).toBe(true);
    expect(result.tasksUpdated).toBe(1);
    expect(result.changes[0]).toMatchObject({ taskId: 'T864', newStage: 'testing' });

    // DB must NOT be updated in dry-run mode.
    expect(await readPipelineStage('T864')).toBe('research');

    // Guard must NOT be written in dry-run mode.
    expect(await readBackfillGuard()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // (e) force flag bypasses the idempotency guard
  // -----------------------------------------------------------------------

  it('force flag re-runs even after guard is present', async () => {
    await insertTask('T865', 'research');
    const pipelineId = await insertPipeline('T865', 'consensus');
    await insertStage(pipelineId, 'consensus', 2, 'completed');

    // First run — sets the guard.
    await backfillPipelineStageFromLifecycle({}, testDir);
    expect(await readPipelineStage('T865')).toBe('consensus');

    // Manually reset pipeline_stage to simulate regression.
    const { getNativeDb: getNativeDb2 } = await import('../../store/sqlite.js');
    getNativeDb2()!.prepare(`UPDATE tasks SET pipeline_stage = 'research' WHERE id = 'T865'`).run();
    expect(await readPipelineStage('T865')).toBe('research');

    // Force re-run — guard ignored, backfill applied again.
    const result = await backfillPipelineStageFromLifecycle({ force: true }, testDir);
    expect(result.alreadyRun).toBe(false);
    expect(result.tasksUpdated).toBe(1);
    expect(await readPipelineStage('T865')).toBe('consensus');
  });

  // -----------------------------------------------------------------------
  // (f) Multiple tasks: mixes updated and already-synced
  // -----------------------------------------------------------------------

  it('handles multiple tasks — updates only those that diverge', async () => {
    // T866: diverged — lifecycle at 'specification' (order 4), task at 'research' (order 1)
    await insertTask('T866', 'research');
    const pipe1 = await insertPipeline('T866', 'specification');
    await insertStage(pipe1, 'research', 1, 'completed');
    await insertStage(pipe1, 'specification', 4, 'completed');

    // T867: already synced — both at 'implementation'
    await insertTask('T867', 'implementation');
    const pipe2 = await insertPipeline('T867', 'implementation');
    await insertStage(pipe2, 'implementation', 6, 'in_progress');

    // T868: null pipeline_stage (never set), lifecycle at 'consensus'
    await insertTask('T868', null);
    const pipe3 = await insertPipeline('T868', 'consensus');
    await insertStage(pipe3, 'consensus', 2, 'completed');

    const result = await backfillPipelineStageFromLifecycle({}, testDir);

    expect(result.tasksUpdated).toBe(2); // T866 and T868
    expect(result.tasksScanned).toBe(3);

    const updatedIds = result.changes.map((c) => c.taskId).sort();
    expect(updatedIds).toEqual(['T866', 'T868'].sort());

    expect(await readPipelineStage('T866')).toBe('specification');
    expect(await readPipelineStage('T867')).toBe('implementation'); // unchanged
    expect(await readPipelineStage('T868')).toBe('consensus');
  });

  // -----------------------------------------------------------------------
  // (g) isPipelineStageBackfillDone helper
  // -----------------------------------------------------------------------

  it('isPipelineStageBackfillDone returns false before and true after', async () => {
    await insertTask('T869', 'research');
    const pipelineId = await insertPipeline('T869', 'research');
    await insertStage(pipelineId, 'research', 1, 'completed');

    expect(await isPipelineStageBackfillDone(testDir)).toBe(false);

    await backfillPipelineStageFromLifecycle({}, testDir);

    expect(await isPipelineStageBackfillDone(testDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (h) Guard metadata is persisted correctly
  // -----------------------------------------------------------------------

  it('writes backfill guard with task reference to schema_meta', async () => {
    await insertTask('T870', 'research');
    const pipelineId = await insertPipeline('T870', 'validation');
    await insertStage(pipelineId, 'validation', 7, 'completed');

    await backfillPipelineStageFromLifecycle({}, testDir);

    const guardRaw = await readBackfillGuard();
    expect(guardRaw).not.toBeNull();

    const guard = JSON.parse(guardRaw!);
    expect(guard).toMatchObject({
      task: 'T869',
      tasksUpdated: 1,
    });
    expect(typeof guard.ranAt).toBe('string');
  });
});
