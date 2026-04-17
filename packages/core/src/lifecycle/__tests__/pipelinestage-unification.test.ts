/**
 * Regression tests for T832 / T835 — `recordStageProgress` MUST keep
 * `tasks.pipeline_stage` in sync with `lifecycle_stages` + `lifecycle_pipelines.currentStageId`.
 *
 * Without this unification, `cleo lifecycle complete` advances the lifecycle
 * table but leaves `tasks.pipelineStage` stale, causing the parent-epic gate
 * in `taskCompleteStrict` to continue rejecting child completions even after
 * a correct lifecycle advancement.
 *
 * @task T832
 * @task T835
 * @adr ADR-051 Decision 5
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordStageProgress } from '../index.js';

let testDir: string;
let cleoDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-pipeline-sync-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'rcasd', 'T900'), { recursive: true });
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

async function readTaskPipelineStage(taskId: string): Promise<string | null> {
  const { getNativeDb } = await import('../../store/sqlite.js');
  const db = getNativeDb()!;
  const row = db.prepare('SELECT pipeline_stage FROM tasks WHERE id = ?').get(taskId) as
    | { pipeline_stage: string | null }
    | undefined;
  return row?.pipeline_stage ?? null;
}

describe('recordStageProgress keeps tasks.pipelineStage in sync (T835)', () => {
  it('writes tasks.pipeline_stage on completed status', async () => {
    await recordStageProgress('T900', 'research', 'completed');
    const stage = await readTaskPipelineStage('T900');
    expect(stage).toBe('research');
  });

  it('writes tasks.pipeline_stage on in_progress status', async () => {
    await recordStageProgress('T901', 'consensus', 'in_progress');
    const stage = await readTaskPipelineStage('T901');
    expect(stage).toBe('consensus');
  });

  it('does NOT overwrite tasks.pipeline_stage on skipped status', async () => {
    // First, mark research in_progress → task.pipelineStage = 'research'.
    await recordStageProgress('T902', 'research', 'in_progress');
    const first = await readTaskPipelineStage('T902');
    expect(first).toBe('research');
    // Now skip consensus — skipped must NOT advance tasks.pipeline_stage.
    await recordStageProgress('T902', 'consensus', 'skipped');
    const second = await readTaskPipelineStage('T902');
    expect(second).toBe('research');
  });

  it('advances through multiple stages atomically', async () => {
    await recordStageProgress('T903', 'research', 'completed');
    expect(await readTaskPipelineStage('T903')).toBe('research');
    await recordStageProgress('T903', 'consensus', 'completed');
    expect(await readTaskPipelineStage('T903')).toBe('consensus');
    await recordStageProgress('T903', 'specification', 'completed');
    expect(await readTaskPipelineStage('T903')).toBe('specification');
    await recordStageProgress('T903', 'implementation', 'in_progress');
    expect(await readTaskPipelineStage('T903')).toBe('implementation');
  });
});
