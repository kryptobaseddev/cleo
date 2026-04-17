/**
 * Tests for the T871 terminal-pipeline-stage backfill.
 *
 * Verifies:
 *   (a) Basic backfill: status=done rows get pipeline_stage=contribution,
 *       status=cancelled rows get pipeline_stage=cancelled.
 *   (b) Idempotency — second run is a no-op.
 *   (c) Tasks already at a terminal stage are left alone.
 *   (d) dryRun mode computes changes without writing.
 *   (e) force flag bypasses the idempotency guard.
 *   (f) NULL pipeline_stage rows are also fixed.
 *
 * Setup: inserts rows via DatabaseSync directly to mirror the real
 * pre-T871 data shape (status=done + pipeline_stage=research/etc).
 *
 * @task T871
 * @epic T870
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backfillTerminalPipelineStage,
  isTerminalPipelineStageBackfillDone,
  TERMINAL_BACKFILL_KEY,
} from '../backfill-terminal-pipeline-stage.js';

let testDir: string;
let cleoDir: string;

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/** Ensure a task row exists with the given status and pipeline_stage. */
async function insertTask(
  taskId: string,
  status: string,
  pipelineStage: string | null,
): Promise<void> {
  const { getDb, getNativeDb } = await import('../../store/sqlite.js');
  await getDb();
  getNativeDb()!
    .prepare(
      `INSERT OR REPLACE INTO tasks
         (id, title, status, priority, pipeline_stage, created_at)
       VALUES (?, ?, ?, 'medium', ?, datetime('now'))`,
    )
    .run(taskId, `Task ${taskId}`, status, pipelineStage);
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
    .prepare(`SELECT value FROM schema_meta WHERE key = '${TERMINAL_BACKFILL_KEY}'`)
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-backfill-term-'));
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

describe('backfillTerminalPipelineStage (T871)', () => {
  // -----------------------------------------------------------------------
  // (a) Basic backfill: status=done with non-terminal stage
  // -----------------------------------------------------------------------

  it('sets pipeline_stage to contribution for status=done + research', async () => {
    await insertTask('T001', 'done', 'research');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.alreadyRun).toBe(false);
    expect(result.tasksUpdated).toBe(1);
    expect(result.changes[0]).toMatchObject({
      taskId: 'T001',
      status: 'done',
      previousStage: 'research',
      newStage: 'contribution',
    });
    expect(await readPipelineStage('T001')).toBe('contribution');
  });

  it('sets pipeline_stage to contribution for status=done + implementation', async () => {
    await insertTask('T002', 'done', 'implementation');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(1);
    expect(await readPipelineStage('T002')).toBe('contribution');
  });

  it('sets pipeline_stage to contribution for status=done + release (T487 case)', async () => {
    await insertTask('T487', 'done', 'release');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(1);
    expect(await readPipelineStage('T487')).toBe('contribution');
  });

  // -----------------------------------------------------------------------
  // (b) status=cancelled rows
  // -----------------------------------------------------------------------

  it('sets pipeline_stage to cancelled for status=cancelled + research', async () => {
    await insertTask('T100', 'cancelled', 'research');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(1);
    expect(result.changes[0]).toMatchObject({
      taskId: 'T100',
      status: 'cancelled',
      newStage: 'cancelled',
    });
    expect(await readPipelineStage('T100')).toBe('cancelled');
  });

  // -----------------------------------------------------------------------
  // (c) NULL pipeline_stage rows
  // -----------------------------------------------------------------------

  it('sets pipeline_stage for status=done with NULL pipeline_stage', async () => {
    await insertTask('T200', 'done', null);

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(1);
    expect(await readPipelineStage('T200')).toBe('contribution');
  });

  // -----------------------------------------------------------------------
  // (d) Already-terminal rows are left alone
  // -----------------------------------------------------------------------

  it('does not modify tasks already at contribution', async () => {
    await insertTask('T300', 'done', 'contribution');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(0);
    expect(result.changes).toHaveLength(0);
    expect(await readPipelineStage('T300')).toBe('contribution');
  });

  it('does not modify tasks already at cancelled', async () => {
    await insertTask('T301', 'cancelled', 'cancelled');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(0);
    expect(await readPipelineStage('T301')).toBe('cancelled');
  });

  // -----------------------------------------------------------------------
  // (e) Non-terminal status rows are ignored
  // -----------------------------------------------------------------------

  it('ignores tasks with non-terminal status', async () => {
    await insertTask('T400', 'pending', 'research');
    await insertTask('T401', 'active', 'implementation');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(0);
    expect(await readPipelineStage('T400')).toBe('research');
    expect(await readPipelineStage('T401')).toBe('implementation');
  });

  // -----------------------------------------------------------------------
  // (f) Mixed fleet: exactly mirrors the owner's reported state
  // -----------------------------------------------------------------------

  it('backfills a mixed fleet of 28+ rows in one pass', async () => {
    // 10 done + research, 10 done + implementation, 5 done + release,
    // 3 cancelled + anywhere = 28 rows needing fix
    for (let i = 0; i < 10; i++) {
      await insertTask(`Tr${i}`, 'done', 'research');
    }
    for (let i = 0; i < 10; i++) {
      await insertTask(`Ti${i}`, 'done', 'implementation');
    }
    for (let i = 0; i < 5; i++) {
      await insertTask(`Tl${i}`, 'done', 'release');
    }
    for (let i = 0; i < 3; i++) {
      await insertTask(`Tc${i}`, 'cancelled', 'research');
    }
    // And 2 already-correct rows that should not show up in `changes`.
    await insertTask('Tok1', 'done', 'contribution');
    await insertTask('Tok2', 'cancelled', 'cancelled');

    const result = await backfillTerminalPipelineStage({}, testDir);

    expect(result.tasksUpdated).toBe(28);
    // Spot-check: both terminal targets appear in changes
    const stages = new Set(result.changes.map((c) => c.newStage));
    expect(stages.has('contribution')).toBe(true);
    expect(stages.has('cancelled')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (g) Idempotency
  // -----------------------------------------------------------------------

  it('is idempotent: second run returns alreadyRun=true', async () => {
    await insertTask('T500', 'done', 'research');
    const first = await backfillTerminalPipelineStage({}, testDir);
    expect(first.alreadyRun).toBe(false);
    expect(first.tasksUpdated).toBe(1);

    const second = await backfillTerminalPipelineStage({}, testDir);
    expect(second.alreadyRun).toBe(true);
    expect(second.tasksUpdated).toBe(0);
  });

  it('writes a schema_meta guard row on first success', async () => {
    await insertTask('T501', 'done', 'research');
    await backfillTerminalPipelineStage({}, testDir);
    const value = await readBackfillGuard();
    expect(value).not.toBeNull();
    expect(value).toContain('T871');
  });

  it('isTerminalPipelineStageBackfillDone returns true after a run', async () => {
    await insertTask('T502', 'done', 'research');
    expect(await isTerminalPipelineStageBackfillDone(testDir)).toBe(false);
    await backfillTerminalPipelineStage({}, testDir);
    expect(await isTerminalPipelineStageBackfillDone(testDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (h) dryRun mode
  // -----------------------------------------------------------------------

  it('dryRun reports changes without writing', async () => {
    await insertTask('T600', 'done', 'research');

    const result = await backfillTerminalPipelineStage({ dryRun: true }, testDir);

    expect(result.dryRun).toBe(true);
    expect(result.tasksUpdated).toBe(1);
    // No DB write happened
    expect(await readPipelineStage('T600')).toBe('research');
    // No guard written
    expect(await readBackfillGuard()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // (i) force mode
  // -----------------------------------------------------------------------

  it('force mode bypasses the idempotency guard', async () => {
    await insertTask('T700', 'done', 'research');
    await backfillTerminalPipelineStage({}, testDir);

    // Introduce new drift after the first run.
    await insertTask('T701', 'done', 'implementation');

    const result = await backfillTerminalPipelineStage({ force: true }, testDir);

    expect(result.alreadyRun).toBe(false);
    expect(result.tasksUpdated).toBe(1);
    expect(await readPipelineStage('T701')).toBe('contribution');
  });
});
