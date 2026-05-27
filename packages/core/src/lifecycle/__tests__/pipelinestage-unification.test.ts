/**
 * Regression tests for T832 / T835 — `recordStageProgress` MUST keep
 * `tasks.pipeline_stage` in sync with `lifecycle_stages` + `lifecycle_pipelines.currentStageId`.
 *
 * Without this unification, `cleo lifecycle complete` advances the lifecycle
 * table but leaves `tasks.pipelineStage` stale, causing the parent-epic gate
 * in `taskCompleteStrict` to continue rejecting child completions even after
 * a correct lifecycle advancement.
 *
 * Also covers T929 — stage alias resolution so shorthand names like 'architecture'
 * are accepted in place of the full canonical name 'architecture_decision'.
 *
 * @task T832
 * @task T835
 * @task T929
 * @adr ADR-051 Decision 5
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordStageProgress, resolveStageAlias } from '../index.js';

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
    await recordStageProgress(testDir, { taskId: 'T900', stage: 'research', status: 'completed' });
    const stage = await readTaskPipelineStage('T900');
    expect(stage).toBe('research');
  });

  it('writes tasks.pipeline_stage on in_progress status', async () => {
    await recordStageProgress(testDir, {
      taskId: 'T901',
      stage: 'consensus',
      status: 'in_progress',
    });
    const stage = await readTaskPipelineStage('T901');
    expect(stage).toBe('consensus');
  });

  it('does NOT overwrite tasks.pipeline_stage on skipped status', async () => {
    // First, mark research in_progress → task.pipelineStage = 'research'.
    await recordStageProgress(testDir, {
      taskId: 'T902',
      stage: 'research',
      status: 'in_progress',
    });
    const first = await readTaskPipelineStage('T902');
    expect(first).toBe('research');
    // Now skip consensus — skipped must NOT advance tasks.pipeline_stage.
    await recordStageProgress(testDir, { taskId: 'T902', stage: 'consensus', status: 'skipped' });
    const second = await readTaskPipelineStage('T902');
    expect(second).toBe('research');
  });

  it('advances through multiple stages atomically', async () => {
    await recordStageProgress(testDir, { taskId: 'T903', stage: 'research', status: 'completed' });
    expect(await readTaskPipelineStage('T903')).toBe('research');
    await recordStageProgress(testDir, { taskId: 'T903', stage: 'consensus', status: 'completed' });
    expect(await readTaskPipelineStage('T903')).toBe('consensus');
    await recordStageProgress(testDir, {
      taskId: 'T903',
      stage: 'specification',
      status: 'completed',
    });
    expect(await readTaskPipelineStage('T903')).toBe('specification');
    await recordStageProgress(testDir, {
      taskId: 'T903',
      stage: 'implementation',
      status: 'in_progress',
    });
    expect(await readTaskPipelineStage('T903')).toBe('implementation');
  });
});

// =============================================================================
// T929 — stage alias resolution
// =============================================================================

describe('resolveStageAlias (T929)', () => {
  it('resolves "architecture" to "architecture_decision"', () => {
    expect(resolveStageAlias('architecture')).toBe('architecture_decision');
  });

  it('resolves "adr" to "architecture_decision"', () => {
    expect(resolveStageAlias('adr')).toBe('architecture_decision');
  });

  it('resolves "spec" to "specification"', () => {
    expect(resolveStageAlias('spec')).toBe('specification');
  });

  it('resolves "decompose" to "decomposition"', () => {
    expect(resolveStageAlias('decompose')).toBe('decomposition');
  });

  it('resolves "implement" to "implementation"', () => {
    expect(resolveStageAlias('implement')).toBe('implementation');
  });

  it('resolves "verify" / "validate" to "validation"', () => {
    expect(resolveStageAlias('verify')).toBe('validation');
    expect(resolveStageAlias('validate')).toBe('validation');
  });

  it('resolves "test" to "testing"', () => {
    expect(resolveStageAlias('test')).toBe('testing');
  });

  it('returns canonical names unchanged', () => {
    const canonicals = [
      'research',
      'consensus',
      'architecture_decision',
      'specification',
      'decomposition',
      'implementation',
      'validation',
      'testing',
      'release',
    ];
    for (const s of canonicals) {
      expect(resolveStageAlias(s)).toBe(s);
    }
  });

  it('returns unknown names unchanged (caller validates separately)', () => {
    expect(resolveStageAlias('unknown_stage')).toBe('unknown_stage');
  });
});

describe('recordStageProgress accepts stage aliases (T929)', () => {
  it('accepts "architecture" shorthand for architecture_decision', async () => {
    await recordStageProgress(testDir, { taskId: 'T910', stage: 'research', status: 'completed' });
    await recordStageProgress(testDir, { taskId: 'T910', stage: 'consensus', status: 'completed' });
    await recordStageProgress(testDir, {
      taskId: 'T910',
      stage: 'architecture' as 'research',
      status: 'completed',
    });
    const stage = await readTaskPipelineStage('T910');
    expect(stage).toBe('architecture_decision');
  });

  it('accepts "spec" shorthand for specification', async () => {
    await recordStageProgress(testDir, { taskId: 'T911', stage: 'research', status: 'completed' });
    await recordStageProgress(testDir, { taskId: 'T911', stage: 'consensus', status: 'completed' });
    await recordStageProgress(testDir, {
      taskId: 'T911',
      stage: 'architecture_decision',
      status: 'completed',
    });
    await recordStageProgress(testDir, {
      taskId: 'T911',
      stage: 'spec' as 'research',
      status: 'completed',
    });
    const stage = await readTaskPipelineStage('T911');
    expect(stage).toBe('specification');
  });

  it('advances full RCASD chain using shorthand stage names (T929 regression)', async () => {
    // Mirrors the bug report: research→consensus→architecture→specification→decomposition
    // All using shorthand names as a user would type them on the CLI.
    await recordStageProgress(testDir, { taskId: 'T912', stage: 'research', status: 'completed' });
    expect(await readTaskPipelineStage('T912')).toBe('research');

    await recordStageProgress(testDir, { taskId: 'T912', stage: 'consensus', status: 'completed' });
    expect(await readTaskPipelineStage('T912')).toBe('consensus');

    await recordStageProgress(testDir, {
      taskId: 'T912',
      stage: 'architecture' as 'research',
      status: 'completed',
    });
    expect(await readTaskPipelineStage('T912')).toBe('architecture_decision');

    await recordStageProgress(testDir, {
      taskId: 'T912',
      stage: 'spec' as 'research',
      status: 'completed',
    });
    expect(await readTaskPipelineStage('T912')).toBe('specification');

    await recordStageProgress(testDir, {
      taskId: 'T912',
      stage: 'decompose' as 'research',
      status: 'completed',
    });
    expect(await readTaskPipelineStage('T912')).toBe('decomposition');
  });
});
